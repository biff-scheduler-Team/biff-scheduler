/**
 * 抢票结果的读写：贡献表 + 预聚合表的差分维护（抢票分析模块，2026-09-20，PLAN-20260920161837）。
 *
 * 形状与 `screening-stats-store.ts` 完全同构 —— 那边按场次 code 记「在不在行程里」，
 * 这边按场次 code 记「最后抢到没有」。**唯一的差别是聚合表有四列**（got / transfer / missed /
 * dropped），故增删都要先定位那一列（不像那边只有一个 `weight_sum` 可以直接加减）。
 * ⚠ 聚合表的改法在 `stat-batch.ts`（SQL 端原子算术 + 一次分批 batch）——
 *   此前是「读出来在 JS 里加减再写回」，两人同时标同一场会丢数且永不自愈。
 *
 * ⚠ 语义是**整份替换**而不是增量：前端每次都把「我标记过的那些场次」全量发上来，
 *   这样断网 / 换设备之后重新上报一次就能把服务端校正回一致，本地不需要「待同步队列」。
 */

import { and, eq, sql } from "drizzle-orm";
import { database } from "./db";
import { screeningTicketContribution, screeningTicketStat } from "./db/schema";
import { SCREENING_CODE_MAX_LENGTH } from "./screening-stats";
import {
  clampAddText,
  flushStatBatch,
  isNonPositiveText,
  wouldGoNegativeText,
  type StatWrite,
} from "./stat-batch";
import { diffOutcomes, formatTicketCounts, isTicketOutcome, type TicketOutcome } from "./ticket-stats";

type Db = ReturnType<typeof database>;
type TicketStatTable = typeof screeningTicketStat;

function parseWeight(raw: string | number | null | undefined): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 「结果 → 聚合列」的唯一映射处（四列都靠它定位，避免各处手写列名漏改）。 */
function statColumn(table: TicketStatTable, outcome: TicketOutcome) {
  switch (outcome) {
    case "got":
      return table.got_sum;
    case "transfer":
      return table.transfer_sum;
    case "missed":
      return table.missed_sum;
    case "dropped":
      return table.dropped_sum;
  }
}

/** 钳零写入的 SET 子句（显式 switch 展开：不用 computed key，避免 `as never` 那类类型逃逸）。 */
function clampedSet(table: TicketStatTable, outcome: TicketOutcome, delta: number, now: number) {
  const value = clampAddText(statColumn(table, outcome), delta);
  switch (outcome) {
    case "got":
      return { got_sum: value, updated_at: now };
    case "transfer":
      return { transfer_sum: value, updated_at: now };
    case "missed":
      return { missed_sum: value, updated_at: now };
    case "dropped":
      return { dropped_sum: value, updated_at: now };
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
  const writes: StatWrite[] = [];

  const statKey = (code: string) =>
    and(eq(screeningTicketStat.edition, edition), eq(screeningTicketStat.code, code));

  /** 四列全 ≤ 0 → 归零删行（不留 0 行把读取撑大）。 */
  const zeroKey = (code: string) =>
    and(
      statKey(code),
      isNonPositiveText(screeningTicketStat.got_sum),
      isNonPositiveText(screeningTicketStat.transfer_sum),
      isNonPositiveText(screeningTicketStat.missed_sum),
      isNonPositiveText(screeningTicketStat.dropped_sum),
    );

  /** 一行插入用的初值：命中那一列 = delta，其余列 = "0"（与旧实现的 `if (row) … else insert` 同形）。 */
  const initialValues = (code: string, outcome: TicketOutcome, delta: number) => ({
    edition,
    code,
    got_sum: outcome === "got" ? String(delta) : "0",
    transfer_sum: outcome === "transfer" ? String(delta) : "0",
    missed_sum: outcome === "missed" ? String(delta) : "0",
    dropped_sum: outcome === "dropped" ? String(delta) : "0",
    updated_at: now,
  });

  /** 某一列 +delta：`delta > 0` 走「插入或原地加」，`delta < 0` 走三件套（探测 / 钳零 / 删行）。 */
  const adjust = (code: string, outcome: TicketOutcome, delta: number) => {
    if (delta === 0) return;
    const key = statKey(code);
    if (delta > 0) {
      writes.push({
        statement: db
          .insert(screeningTicketStat)
          .values(initialValues(code, outcome, delta))
          // UPSERT 的 SET 里表名限定的列指**原行**：已存在就原地加，不存在就用上面的初值。
          .onConflictDoUpdate({
            target: [screeningTicketStat.edition, screeningTicketStat.code],
            set: clampedSet(screeningTicketStat, outcome, delta, now),
          }),
      });
      return;
    }
    writes.push({
      statement: db
        .update(screeningTicketStat)
        .set({ updated_at: sql`${screeningTicketStat.updated_at}` })
        .where(and(key, wouldGoNegativeText(statColumn(screeningTicketStat, outcome), delta))),
      drift: `${edition}/${code}`,
    });
    writes.push({
      statement: db.update(screeningTicketStat).set(clampedSet(screeningTicketStat, outcome, delta, now)).where(key),
    });
    writes.push({ statement: db.delete(screeningTicketStat).where(zeroKey(code)) });
  };

  // 1) 贡献行落定（改结果同时进 removed / added，故这里 upsert 能正确处理「改状态」）
  for (const entry of removed) {
    writes.push({
      statement: db
        .delete(screeningTicketContribution)
        .where(
          and(
            eq(screeningTicketContribution.edition, edition),
            eq(screeningTicketContribution.code, entry.code),
            eq(screeningTicketContribution.contributor, contributor),
          ),
        ),
    });
  }
  for (const entry of added) {
    writes.push({
      statement: db
        .insert(screeningTicketContribution)
        .values({ edition, code: entry.code, contributor, outcome: entry.outcome, weight: weightLabel, updated_at: now })
        .onConflictDoUpdate({
          target: [
            screeningTicketContribution.edition,
            screeningTicketContribution.code,
            screeningTicketContribution.contributor,
          ],
          set: { outcome: entry.outcome, weight: weightLabel, updated_at: now },
        }),
    });
  }

  // 2) 聚合表：先撤旧的（按**旧权重**），再加新的
  for (const entry of removed) adjust(entry.code, entry.outcome, -previousWeight);
  for (const entry of added) adjust(entry.code, entry.outcome, weight);

  // 3) 仍在集合里但权重变了（匿名 → 登录）：补一个差值，别重算全表
  if (existing.length && Math.abs(previousWeight - weight) > 1e-9) {
    const delta = weight - previousWeight;
    for (const [code, outcome] of next) {
      if (previous.get(code) !== outcome) continue;
      writes.push({
        statement: db
          .update(screeningTicketContribution)
          .set({ weight: weightLabel, updated_at: now })
          .where(
            and(
              eq(screeningTicketContribution.edition, edition),
              eq(screeningTicketContribution.code, code),
              eq(screeningTicketContribution.contributor, contributor),
            ),
          ),
      });
      adjust(code, outcome, delta);
    }
  }

  if (writes.length === 0) return;
  await flushStatBatch(db, writes);
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
