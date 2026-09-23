/**
 * 按天分桶的读写（2026-09-23，PLAN-20260923142546，批 1）。
 *
 * 由来：五张 `*_stat` 只记「当前累计」，**没有时间维度**，趋势图无从画起。这张表补上「每天变了多少」。
 *
 * ★ 两条不能破的约束：
 *   ① **增量语义**：一次上报只记**它的差分**（新增 / 撤销），绝不能把整份状态写进来 ——
 *      否则同一天会被重复计数，而且第二天再上报一次又会记一遍。差分从哪来：
 *      `replaceContributor*` 里本来就有（`diffFilmKeys` / `diffVotes` / `diffCodes`）。
 *   ② 写语句必须并进调用方**同一个 `flushStatBatch`**：另起一批会让
 *      `tests/stat-atomicity.test.ts` 的往返次数断言变红（那断言正是为此存在的），
 *      并且真的会把每次上报的 D1 往返翻倍。
 *
 * ⚠ 与 `telemetry-store.ts::applyContributorTelemetry` 的写法刻意同形（增量 + 负漂移探测 +
 *   归零删行）—— 那边是「每 (kind,target) 一行」，这边是「每 (metric,target,day) 一行」。
 */

import { and, asc, eq, gte, sql } from "drizzle-orm";
import { database } from "./db";
import { statDaily } from "./db/schema";
import { clampAddText, isNonPositiveText, weightText, wouldGoNegativeText } from "./stat-batch";
import type { StatWrite } from "./stat-batch";

type Db = ReturnType<typeof database>;

/** 记日桶的指标白名单。**新增指标必须在这里登记** —— 读侧靠它收口（未知 metric 一律拒）。 */
export const DAILY_METRICS = ["want", "vote", "screening", "ticket", "telemetry"] as const;

export type DailyMetric = (typeof DAILY_METRICS)[number];

export function isDailyMetric(value: unknown): value is DailyMetric {
  return typeof value === "string" && (DAILY_METRICS as readonly string[]).includes(value);
}

/** 一次增量。`weightDelta` 是主计数（想看 / 行程 / 票务的加权和，红黑票则是 ±1 票数）；
 *  `hitsDelta` 只对 telemetry 有意义（「用了多少次」的加权和），其余指标留 0。 */
export interface DailyDelta {
  edition: string;
  /** `YYYY-MM-DD`，由 `day.ts::kstDay()` 算出（**不接受调用方传外部输入**） */
  day: string;
  metric: DailyMetric;
  target: string;
  weightDelta?: number;
  hitsDelta?: number;
}

/**
 * 一次增量 → 一到三条待执行语句。
 *
 * 纯增量（两个 delta 都 ≥ 0）只需一条 UPSERT；只要有一个是负数，就要按
 * 「负漂移探测 → 钳零写入 → 归零删行」三步走（顺序不可换，理由与 `film-vote-store.ts::removeVote`
 * 和 `telemetry-store.ts` 一致：先探测再钳零，探不到就说明正常）。
 */
export function dailyBucketWrites(db: Db, delta: DailyDelta, now = Date.now()): StatWrite[] {
  const { edition, day, metric, target } = delta;
  const weightDelta = delta.weightDelta ?? 0;
  const hitsDelta = delta.hitsDelta ?? 0;
  const key = and(
    eq(statDaily.edition, edition),
    eq(statDaily.day, day),
    eq(statDaily.metric, metric),
    eq(statDaily.target, target),
  );
  if (weightDelta >= 0 && hitsDelta >= 0) {
    return [
      {
        statement: db
          .insert(statDaily)
          .values({
            edition,
            day,
            metric,
            target,
            weight_sum: weightText(weightDelta),
            hits_sum: weightText(hitsDelta),
            updated_at: now,
          })
          // UPSERT 的 SET 里表名限定的列指**原行**：已存在就原地加，不存在就用上面的初值。
          .onConflictDoUpdate({
            target: [statDaily.edition, statDaily.day, statDaily.metric, statDaily.target],
            set: {
              weight_sum: clampAddText(statDaily.weight_sum, weightDelta),
              hits_sum: clampAddText(statDaily.hits_sum, hitsDelta),
              updated_at: now,
            },
          }),
      },
    ];
  }
  return [
    {
      statement: db
        .update(statDaily)
        .set({ updated_at: sql`${statDaily.updated_at}` })
        .where(
          and(
            key,
            sql`(${wouldGoNegativeText(statDaily.weight_sum, weightDelta)} OR ${wouldGoNegativeText(statDaily.hits_sum, hitsDelta)})`,
          ),
        ),
      drift: `${edition}/${day}/${metric}|${target}`,
    },
    {
      statement: db
        .update(statDaily)
        .set({
          weight_sum: clampAddText(statDaily.weight_sum, weightDelta),
          hits_sum: clampAddText(statDaily.hits_sum, hitsDelta),
          updated_at: now,
        })
        .where(key),
    },
    {
      statement: db
        .delete(statDaily)
        .where(and(key, isNonPositiveText(statDaily.weight_sum), isNonPositiveText(statDaily.hits_sum))),
    },
  ];
}

/** 某天某指标某个目标的当前值（读回来看写入是否落对；也供测试与对账用）。 */
export async function readDailyBucket(
  db: Db,
  edition: string,
  day: string,
  metric: DailyMetric,
  target: string,
): Promise<{ weight: number; hits: number } | null> {
  const row = await db
    .select({ weight_sum: statDaily.weight_sum, hits_sum: statDaily.hits_sum })
    .from(statDaily)
    .where(
      and(
        eq(statDaily.edition, edition),
        eq(statDaily.day, day),
        eq(statDaily.metric, metric),
        eq(statDaily.target, target),
      ),
    )
    .get();
  if (!row) return null;
  return { weight: Number(row.weight_sum) || 0, hits: Number(row.hits_sum) || 0 };
}

/** 一个指标一天的合计（跨所有 target）—— 趋势图上的一个点。 */
export interface DailyPoint {
  day: string;
  weight: number;
  hits: number;
}

/**
 * 时间序列：`fromDay` 起（含）按天升序。
 *
 * ⚠ **没有数据的日期不会补 0**：图表要自己按 `fromDay..今天` 补齐 —— 在 SQL 里造一张日期表
 *   代价远大于在展示层补（而且补 0 的口径属于展示层：`null`「那天没人用」与 `0`「用了但被撤光」
 *   在趋势上不是一回事，本函数不做这个判断）。
 */
export async function readDailySeries(
  db: Db,
  options: { edition: string; metric: DailyMetric; fromDay: string; target?: string },
): Promise<DailyPoint[]> {
  const where = options.target
    ? and(
        eq(statDaily.edition, options.edition),
        eq(statDaily.metric, options.metric),
        eq(statDaily.target, options.target),
        gte(statDaily.day, options.fromDay),
      )
    : and(
        eq(statDaily.edition, options.edition),
        eq(statDaily.metric, options.metric),
        gte(statDaily.day, options.fromDay),
      );
  const rows = await db
    .select({
      day: statDaily.day,
      // 列以文本存（见 schema 说明），求和要显式 CAST 成 REAL
      weight: sql<number>`SUM(CAST(${statDaily.weight_sum} AS REAL))`,
      hits: sql<number>`SUM(CAST(${statDaily.hits_sum} AS REAL))`,
    })
    .from(statDaily)
    .where(where)
    .groupBy(statDaily.day)
    .orderBy(asc(statDaily.day))
    .all();
  return rows.map((row) => ({
    day: row.day,
    weight: round2(row.weight),
    hits: round2(row.hits),
  }));
}

/** 日桶里最早的一天（**不回填历史**，所以它就是「趋势从哪天开始」的唯一口径）。 */
export async function readEarliestDay(db: Db, edition: string): Promise<string | null> {
  const row = await db
    .select({ day: sql<string | null>`min(${statDaily.day})` })
    .from(statDaily)
    .where(eq(statDaily.edition, edition))
    .get();
  return row?.day ?? null;
}

/** 浮点求和后收到 2 位（0.75 的整数倍最多两位小数，多余的是累加误差）。 */
function round2(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}
