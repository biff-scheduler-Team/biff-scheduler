/**
 * 抢票结果的读写：贡献表 + 预聚合表的差分维护（抢票分析模块，2026-09-20，PLAN-20260920161837）。
 *
 * 形状与 `screening-stats-store.ts` 完全同构 —— 那边按场次 code 记「在不在行程里」，
 * 这边按场次 code 记「最后抢到没有」。**唯一的差别是聚合表有四列**（got / transfer / missed /
 * dropped），故增删都要先读那一行再改对应的一列（不像那边只有一个 `weight_sum` 可以直接加减）。
 *
 * ⚠ 语义是**整份替换**而不是增量：前端每次都把「我标记过的那些场次」全量发上来，
 *   这样断网 / 换设备之后重新上报一次就能把服务端校正回一致，本地不需要「待同步队列」。
 */

import { and, eq } from "drizzle-orm";
import { database } from "./db";
import { screeningTicketContribution, screeningTicketStat } from "./db/schema";
import { SCREENING_CODE_MAX_LENGTH } from "./screening-stats";
import {
  diffOutcomes,
  formatTicketCounts,
  isTicketOutcome,
  type TicketOutcome,
} from "./ticket-stats";

type Db = ReturnType<typeof database>;

function parseWeight(raw: string | number | null | undefined): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 按一项增减聚合行；四项都归零时**删行**，免得表里堆一堆 0 行把读取撑大。 */
async function adjustStat(
  db: Db,
  edition: string,
  code: string,
  outcome: TicketOutcome,
  delta: number,
  now: number,
): Promise<void> {
  const where = and(eq(screeningTicketStat.edition, edition), eq(screeningTicketStat.code, code));
  const row = await db.select().from(screeningTicketStat).where(where).get();
  const sums: Record<TicketOutcome, number> = {
    got: parseWeight(row?.got_sum),
    transfer: parseWeight(row?.transfer_sum),
    missed: parseWeight(row?.missed_sum),
    dropped: parseWeight(row?.dropped_sum),
  };
  sums[outcome] = Math.max(0, sums[outcome] + delta);
  if (sums.got <= 0 && sums.transfer <= 0 && sums.missed <= 0 && sums.dropped <= 0) {
    if (row) await db.delete(screeningTicketStat).where(where).run();
    return;
  }
  const values = {
    got_sum: String(sums.got),
    transfer_sum: String(sums.transfer),
    missed_sum: String(sums.missed),
    dropped_sum: String(sums.dropped),
    updated_at: now,
  };
  if (row) {
    await db.update(screeningTicketStat).set(values).where(where).run();
  } else {
    await db.insert(screeningTicketStat).values({ edition, code, ...values }).run();
  }
}

/** 用「这位贡献者最新的一次上报」替换他此前的全部结果，并同步聚合表。
 *
 * ⚠ 顺序要紧：先把贡献行落定，再动聚合 —— 中途失败时聚合顶多短暂偏小，不会多算
 *   （与 `screening-stats-store` / `film-vote-store` 同一条理由）。 */
export async function replaceContributorTickets(
  db: Db,
  edition: string,
  contributor: string,
  weight: number,
  outcomes: ReadonlyMap<string, TicketOutcome>,
): Promise<void> {
  const next = new Map<string, TicketOutcome>();
  for (const [code, outcome] of outcomes) {
    if (!code || code.length > SCREENING_CODE_MAX_LENGTH) continue;
    if (!isTicketOutcome(outcome)) continue;
    next.set(code, outcome);
  }

  const existing = await db
    .select({
      code: screeningTicketContribution.code,
      outcome: screeningTicketContribution.outcome,
      weight: screeningTicketContribution.weight,
    })
    .from(screeningTicketContribution)
    .where(
      and(
        eq(screeningTicketContribution.edition, edition),
        eq(screeningTicketContribution.contributor, contributor),
      ),
    )
    .all();

  const previous = new Map<string, TicketOutcome>();
  for (const row of existing) {
    // 未知取值（被人工改过的坏行）直接丢掉：它没有对应的聚合列可减，留在 previous 里只会减错列
    if (isTicketOutcome(row.outcome)) previous.set(row.code, row.outcome);
  }
  const previousWeight = existing[0] ? parseWeight(existing[0].weight) : weight;
  const { removed, added } = diffOutcomes(previous, next);
  const now = Date.now();
  const weightLabel = String(weight);

  // 1) 贡献行落定（改结果同时进 removed / added，故这里 upsert 能正确处理「改状态」）
  for (const entry of removed) {
    await db
      .delete(screeningTicketContribution)
      .where(
        and(
          eq(screeningTicketContribution.edition, edition),
          eq(screeningTicketContribution.code, entry.code),
          eq(screeningTicketContribution.contributor, contributor),
        ),
      )
      .run();
  }
  for (const entry of added) {
    await db
      .insert(screeningTicketContribution)
      .values({ edition, code: entry.code, contributor, outcome: entry.outcome, weight: weightLabel, updated_at: now })
      .onConflictDoUpdate({
        target: [
          screeningTicketContribution.edition,
          screeningTicketContribution.code,
          screeningTicketContribution.contributor,
        ],
        set: { outcome: entry.outcome, weight: weightLabel, updated_at: now },
      })
      .run();
  }

  // 2) 聚合表：先撤旧的（按**旧权重**），再加新的
  for (const entry of removed) await adjustStat(db, edition, entry.code, entry.outcome, -previousWeight, now);
  for (const entry of added) await adjustStat(db, edition, entry.code, entry.outcome, weight, now);

  // 3) 仍在集合里但权重变了（匿名 → 登录）：补一个差值，别重算全表
  if (existing.length && Math.abs(previousWeight - weight) > 1e-9) {
    const delta = weight - previousWeight;
    for (const [code, outcome] of next) {
      if (previous.get(code) !== outcome) continue;
      await db
        .update(screeningTicketContribution)
        .set({ weight: weightLabel, updated_at: now })
        .where(
          and(
            eq(screeningTicketContribution.edition, edition),
            eq(screeningTicketContribution.code, code),
            eq(screeningTicketContribution.contributor, contributor),
          ),
        )
        .run();
      await adjustStat(db, edition, code, outcome, delta, now);
    }
  }
}

/** 撤掉这位贡献者的全部结果（登出、或匿名身份升级为登录身份时调用）。 */
export async function clearContributorTickets(db: Db, edition: string, contributor: string): Promise<void> {
  await replaceContributorTickets(db, edition, contributor, 0, new Map());
}

/** 读取：一次拿到这个 edition 下所有带结果的场次（≤ 场次数行）。 */
export async function readTicketCounts(db: Db, edition: string) {
  const rows = await db
    .select({
      code: screeningTicketStat.code,
      got_sum: screeningTicketStat.got_sum,
      transfer_sum: screeningTicketStat.transfer_sum,
      missed_sum: screeningTicketStat.missed_sum,
      dropped_sum: screeningTicketStat.dropped_sum,
    })
    .from(screeningTicketStat)
    .where(eq(screeningTicketStat.edition, edition))
    .all();
  return formatTicketCounts(rows);
}
