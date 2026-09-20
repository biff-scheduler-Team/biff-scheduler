/**
 * 事件流水的读写（2026-09-20，第 3 轮，PLAN-20260920203010 修订 2）。
 *
 * ★ 与其它四个 store 的**根本差别：这里是增量，不是整份替换**。
 *   想看 / 行程 / 票务那几套发的是「当前状态」（谁选了哪些片），所以重发一次就该覆盖；
 *   而「这一页被打开了 7 次」无法从任何状态里恢复 —— 客户端只能发增量。
 *   于是同一 (kind, target, contributor) 的行是**累加**的，`clearContributorTelemetry`
 *   也必须按行把加权和**减回去**（不能像状态表那样「置空就算清」）。
 *
 * ★ 两个加权和一起维护：
 *   `viewer_weight_sum`（多少人用过，只在**首次**出现该 target 时加）
 *   `hits_weight_sum`（总共用了多少次，每次增量都加）。
 *   两者用同一份权重，故「匿名 0.75」在两处一致。
 *
 * ⚠ 权重变化（匿名 0.75 → 登录 1.0）只可能发生在**同一浏览器**先后上报时：
 *   此时该贡献者的历史 hits 权重也要跟着改，否则「登录一次，历史访问就少算 25%」。
 */

import { and, eq } from "drizzle-orm";
import { database } from "./db";
import { telemetryContribution, telemetryStat } from "./db/schema";
import {
  isNormalizedTarget,
  isTelemetryKind,
  planTelemetryDelta,
  roundCount,
  type TelemetryCounts,
  type TelemetryDelta,
  type TelemetryKind,
} from "./telemetry-stats";

type Db = ReturnType<typeof database>;

/** 加权和存成文本（与 `film_want_contribution` 的 `"0.75"` 同口径）。
 *  截到 2 位小数：0.75 的整数倍最多两位，多余的小数只可能是浮点误差。 */
function fmt(value: number): string {
  return String(Number(Math.max(0, value).toFixed(2)));
}

function parse(raw: string | number | null | undefined): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 按一项增减聚合行；两个和都归零时**删行**（不留 0 行把读取撑大）。 */
async function adjustStat(
  db: Db,
  edition: string,
  kind: TelemetryKind,
  target: string,
  viewerDelta: number,
  hitsDelta: number,
  now: number,
): Promise<void> {
  const where = and(
    eq(telemetryStat.edition, edition),
    eq(telemetryStat.kind, kind),
    eq(telemetryStat.target, target),
  );
  const row = await db.select().from(telemetryStat).where(where).get();
  const viewers = parse(row?.viewer_weight_sum) + viewerDelta;
  const hits = parse(row?.hits_weight_sum) + hitsDelta;
  if (viewers <= 0 && hits <= 0) {
    if (row) await db.delete(telemetryStat).where(where).run();
    return;
  }
  const values = {
    viewer_weight_sum: fmt(viewers),
    hits_weight_sum: fmt(hits),
    updated_at: now,
  };
  if (row) await db.update(telemetryStat).set(values).where(where).run();
  else await db.insert(telemetryStat).values({ edition, kind, target, ...values }).run();
}

/** 落一批增量。`deltas` 的键是 `kind|target`（见 `normalizeTelemetryEntries`）。 */
export async function applyContributorTelemetry(
  db: Db,
  edition: string,
  contributor: string,
  weight: number,
  deltas: ReadonlyMap<string, TelemetryDelta>,
): Promise<void> {
  if (deltas.size === 0) return;
  const now = Date.now();
  const weightLabel = String(weight);

  const existingRows = await db
    .select({
      kind: telemetryContribution.kind,
      target: telemetryContribution.target,
      hits: telemetryContribution.hits,
      weight: telemetryContribution.weight,
    })
    .from(telemetryContribution)
    .where(
      and(
        eq(telemetryContribution.edition, edition),
        eq(telemetryContribution.contributor, contributor),
      ),
    )
    .all();
  const existing = new Map(
    existingRows
      .filter((row) => isTelemetryKind(row.kind) && isNormalizedTarget(row.kind, row.target))
      .map((row) => [`${row.kind}|${row.target}`, row]),
  );

  for (const [key, delta] of deltas) {
    const row = existing.get(key);
    // 三个数的算法在 `telemetry-stats.ts::planTelemetryDelta`（纯函数，含「权重变化」那一条
    // 只有真实会话才走得到的分支 —— 抽出去才测得了）。
    const plan = planTelemetryDelta(
      row ? { hits: row.hits, weight: parse(row.weight) } : null,
      delta.hits,
      weight,
    );
    await db
      .insert(telemetryContribution)
      .values({
        edition,
        kind: delta.kind,
        target: delta.target,
        contributor,
        hits: plan.nextHits,
        weight: weightLabel,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: [
          telemetryContribution.edition,
          telemetryContribution.kind,
          telemetryContribution.target,
          telemetryContribution.contributor,
        ],
        set: { hits: plan.nextHits, weight: weightLabel, updated_at: now },
      })
      .run();

    await adjustStat(db, edition, delta.kind, delta.target, plan.viewerDelta, plan.hitsDelta, now);
  }
}

/** 撤掉这位贡献者的**全部**事件（登录时清匿名身份，或登出）。
 *
 *  ⚠ 必须先读贡献行再逐条减回去 —— 计数型数据没有「置空」这种操作，
 *    直接删行会让聚合表永远留着那位贡献者贡献过的那部分数字。 */
export async function clearContributorTelemetry(db: Db, edition: string, contributor: string): Promise<void> {
  const rows = await db
    .select({
      kind: telemetryContribution.kind,
      target: telemetryContribution.target,
      hits: telemetryContribution.hits,
      weight: telemetryContribution.weight,
    })
    .from(telemetryContribution)
    .where(
      and(
        eq(telemetryContribution.edition, edition),
        eq(telemetryContribution.contributor, contributor),
      ),
    )
    .all();
  if (rows.length === 0) return;
  const now = Date.now();
  for (const row of rows) {
    if (!isTelemetryKind(row.kind) || !isNormalizedTarget(row.kind, row.target)) continue;
    const weight = parse(row.weight);
    await adjustStat(db, edition, row.kind, row.target, -weight, -weight * row.hits, now);
  }
  await db
    .delete(telemetryContribution)
    .where(
      and(
        eq(telemetryContribution.edition, edition),
        eq(telemetryContribution.contributor, contributor),
      ),
    )
    .run();
}

/** 读取：一次拿到这个 edition 下所有 (kind, target) 的两个加权和（≤ 页面数 + 入口数行）。 */
export async function readTelemetryCounts(db: Db, edition: string): Promise<TelemetryCounts> {
  const rows = await db
    .select({
      kind: telemetryStat.kind,
      target: telemetryStat.target,
      viewer_weight_sum: telemetryStat.viewer_weight_sum,
      hits_weight_sum: telemetryStat.hits_weight_sum,
    })
    .from(telemetryStat)
    .where(eq(telemetryStat.edition, edition))
    .all();
  const out: TelemetryCounts = {};
  for (const row of rows) {
    if (!isTelemetryKind(row.kind) || !isNormalizedTarget(row.kind, row.target)) continue;
    const bucket = out[row.kind] ?? {};
    bucket[row.target] = {
      viewers: roundCount(row.viewer_weight_sum),
      hits: roundCount(row.hits_weight_sum),
    };
    out[row.kind] = bucket;
  }
  return out;
}
