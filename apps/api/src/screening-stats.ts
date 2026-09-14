/**
 * 同场观影人数的口径 —— **与「想看人数」共用同一套权重**(登录 1.0 / 匿名 0.75,
 * 见 `want-stats.ts`),不另立一套「人」的算法:两处都走同一个 `roundWantCount`。
 *
 * 本模块只放与**场次 code** 相关的纯函数;读写库在 `screening-stats-store.ts`。
 */

import { roundWantCount } from "./want-stats";

/** 场次 code 上限(官方是 3 位数字,这里留足余量防脏数据撑爆主键)。 */
export const SCREENING_CODE_MAX_LENGTH = 64;

/** 单次 ping 最多上报多少场次(与 want-ping 的 500 同量级)。 */
export const MAX_SCREENING_CODES_PER_PING = 500;

/** 权重和四舍五入成展示用整数;<= 0 不输出(与 `formatWantCounts` 同一口径)。 */
export function formatAttendanceCounts(
  rows: Iterable<{ code: string; weight_sum: string | number }>,
): Record<string, number> {
  const counts: Record<string, number> = Object.create(null);
  for (const row of rows) {
    const sum = typeof row.weight_sum === "number" ? row.weight_sum : Number(row.weight_sum);
    if (!Number.isFinite(sum) || sum <= 0) continue;
    counts[row.code] = roundWantCount(sum);
  }
  return counts;
}
