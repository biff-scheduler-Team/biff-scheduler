/**
 * 计数聚合的**原子写入口**（2026-09-23，PLAN-20260923111748，B1）。
 *
 * 为什么必须是这一处：五个 store（want / screening-attendance / film-vote / ticket / telemetry）
 * 都用「贡献表 + 预聚合表」维护同一个东西。此前它们的聚合表都是
 * 「SELECT 旧值 → JS 里加减 → UPDATE 写回」——D1 **没有跨语句事务**（只有 `batch` 是原子的），
 * 两个用户同时上报同一部片时，双方都读到旧值、各自写回，**丢掉的量永远不会自愈**
 * （`replaceContributor*` 只在「贡献行有差分」时修正聚合，缺的那部分再也不会被补上）。
 *
 * 两条结构约束由此落地（见 PLAN 的「架构设计」）：
 *   ① 聚合只允许用 SQL 端算术改（`clampAddText` / `clampAddInt`），不允许再读出来在 JS 里加减；
 *   ② 写路径一律走 `flushStatBatch`（一次往返、一个事务），不允许逐条 `await ... .run()`。
 *
 * ⚠ 为什么仍然按块（`STAT_BATCH_SIZE`）而不是一次全塞进去：单次上报最多 500 条
 *   （与客户端截断上限同量级），一次拼一条几百语句的 batch 会让 SQL 文本与绑定参数
 *   一起膨胀；按 40 条分块后往返次数仍与条数无关的常数级（`N/40 + 1` 次）。
 */

import { sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import * as schema from "./db/schema";

type Db = DrizzleD1Database<typeof schema>;

/** drizzle 交给 D1 `batch()` 的单条语句（insert / update / delete 都算）。 */
export type StatStatement = Parameters<Db["batch"]>[0][number];

/** 一条待执行语句 + 它的用途标记。 */
export interface StatWrite {
  statement: StatStatement;
  /**
   * 非空 = 「负漂移探测」语句。它是一条**只改自身列**的 UPDATE，
   * 命中行数 > 0 说明这次减法把聚合减过头了（正常路径永远为 0）。
   */
  drift?: string;
}

/** 每批语句条数：一次 `batch()` 往返里最多执行多少条。 */
export const STAT_BATCH_SIZE = 40;

/**
 * 数值 → 与 `String(Number(x.toFixed(2)))` 同形的文本（整数不带 `.0`）。
 *
 * ⚠ SQLite 的 `CAST(1.0 AS TEXT)` 是 `'1.0'`，而项目既有写法是 `"1"` / `"0.75"`
 *   （`telemetry-store.ts::fmt` 与各 store 的 `String(weight)` 都是这个形状）。
 *   读侧虽然全靠解析、`'1.0'` 也不会算错，但**文本口径只能有一种** —— 否则
 *   同一列里一半 `"1"` 一半 `"1.0"`，对表和排障都是噪声。
 */
function normalizedText(expr: SQL): SQL {
  return sql`CASE WHEN CAST(${expr} AS TEXT) LIKE '%.0'
                  THEN substr(CAST(${expr} AS TEXT), 1, length(CAST(${expr} AS TEXT)) - 2)
                  ELSE CAST(${expr} AS TEXT) END`;
}

/**
 * 文本列上的原子加减，结果钳到非负并规范成文本。
 *
 * ⚠ 必须先 `CAST` 成 REAL 再算、算完再写回文本：这几个列以文本存 `"0.75"` / `"1"`
 *   （见 `db/schema.ts` 的说明，为的是避开 SQLite 浮点漂移）；若直接把 REAL 结果写回，
 *   读侧就会一半是字符串一半是数字，`parseWeight` 那类解析迟早分叉。
 *   `ROUND(...,2)` 是安全网：`toFixed(2)` 的口径与它一致，权重最多两位小数。
 */
export function clampAddText(column: AnySQLiteColumn, delta: number): SQL {
  return normalizedText(sql`ROUND(max(0, CAST(${column} AS REAL) + ${delta}), 2)`);
}

/** 整型列上的原子加减（票数那几张表用 INTEGER，不需要 CAST）。 */
export function clampAddInt(column: AnySQLiteColumn, delta: number): SQL {
  return sql`max(0, ${column} + ${delta})`;
}

/** 「这一减会减成负数」的判定 —— 必须**在写入之前**求值（钳零之后再判就恒真了）。 */
export function wouldGoNegativeText(column: AnySQLiteColumn, delta: number): SQL {
  return sql`CAST(${column} AS REAL) + ${delta} < 0`;
}

/** 见 `wouldGoNegativeText`，整型列版本。 */
export function wouldGoNegativeInt(column: AnySQLiteColumn, delta: number): SQL {
  return sql`${column} + ${delta} < 0`;
}

/** 文本列 ≤ 0 的判定（「归零即删行」用：不留 0 行把读取撑大）。 */
export function isNonPositiveText(column: AnySQLiteColumn): SQL {
  return sql`CAST(${column} AS REAL) <= 0`;
}

/** 整型列 ≤ 0 的判定。 */
export function isNonPositiveInt(column: AnySQLiteColumn): SQL {
  return sql`${column} <= 0`;
}

/** 按固定条数切块（纯函数，便于单测钉住「往返次数与条数的关系」）。 */
export function chunkStatements<T>(items: readonly T[], size = STAT_BATCH_SIZE): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

/** 从 D1 的批量结果里取影响行数（垫片与线上都返回 `meta.changes`）。 */
function changesOf(result: unknown): number {
  const meta = (result as { meta?: { changes?: unknown } } | undefined)?.meta;
  const value = Number(meta?.changes ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/**
 * 执行一批聚合写（按块下发，块内原子）。
 *
 * `db.batch` 的入参类型是非空元组，故这里的断言是「至少一条」——
 * 调用方在 `writes` 为空时不会走到这里（各 store 都有 `if (!writes.length) return`）。
 */
export async function flushStatBatch(db: Db, writes: readonly StatWrite[]): Promise<void> {
  for (const group of chunkStatements(writes)) {
    const tuple = group.map((write) => write.statement) as unknown as [StatStatement, ...StatStatement[]];
    const results = await db.batch(tuple);
    group.forEach((write, index) => {
      if (!write.drift) return;
      const changes = changesOf(results[index]);
      // 正常路径恒为 0：减法把聚合减过头只可能来自并发丢更新 / 人工改库，
      // 静默钳零会让它永远查不出来，所以这里必须留痕。
      if (changes > 0) console.warn(`stat_drift ${write.drift} changes=${changes}`);
    });
  }
}
