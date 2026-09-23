/** 「想看」权重：登录 1.0、匿名 0.75；展示时按 Math.round 四舍五入。 */

export const WANT_WEIGHT_AUTH = 1;
export const WANT_WEIGHT_ANON = 0.75;
/** 缺省届次 —— 改为从白名单的同一处取（2026-09-23，PLAN-20260923111748，B2）：
 *  此前这里与 `apps/web/src/edition.ts` 各写一份 `"biff-2026"`，两处相同只是巧合。 */
export { DEFAULT_EDITION as DEFAULT_WANT_EDITION } from "@biff/contracts/edition";

export function roundWantCount(weightSum: number): number {
  return Math.round(weightSum);
}

export function wantWeightFor(authenticated: boolean): number {
  return authenticated ? WANT_WEIGHT_AUTH : WANT_WEIGHT_ANON;
}

/** 从 festival_document 形态的记录里取出片键（形如 pick:<filmKey>）。 */
export function pickFilmKeysFromRecords(records: Record<string, string>): Set<string> {
  const keys = new Set<string>();
  for (const key of Object.keys(records)) {
    if (key.startsWith("pick:") && key.length > 5) keys.add(key.slice(5));
  }
  return keys;
}

/** 求两个片键集合的差集 → 得出该贡献者要移除 / 新增的项。 */
export function diffFilmKeys(previous: Iterable<string>, next: Iterable<string>) {
  const prev = new Set(previous);
  const nxt = new Set(next);
  const removed: string[] = [];
  const added: string[] = [];
  for (const key of prev) if (!nxt.has(key)) removed.push(key);
  for (const key of nxt) if (!prev.has(key)) added.push(key);
  return { removed, added };
}

export function formatWantCounts(
  rows: Iterable<{ film_key: string; weight_sum: string | number }>,
): Record<string, number> {
  const counts: Record<string, number> = Object.create(null);
  for (const row of rows) {
    const sum = typeof row.weight_sum === "number" ? row.weight_sum : Number(row.weight_sum);
    if (!Number.isFinite(sum) || sum <= 0) continue;
    counts[row.film_key] = roundWantCount(sum);
  }
  return counts;
}
