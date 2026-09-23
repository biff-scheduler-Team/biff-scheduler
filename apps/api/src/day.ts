/**
 * 「按天分桶」的日界口径（2026-09-23，PLAN-20260923142546，批 1）。
 *
 * 为什么是 **KST（UTC+9）**：这是釜山电影节的站，用户与「一天」的心智都在韩国时区；
 * 用 UTC 会让「昨晚」的投票掉进「今天」，用浏览器本地时区则同一个人跨时区出差就换了桶。
 *
 * ⚠ 日界**只能由服务端算**（`Date.now()` → KST 日期）。让客户端传日期 = 把「我这一天算哪天」
 *   交给可伪造的输入，趋势图会被挪到任意一天。
 * ⚠ 这与「午夜场 `29:35` 不取模」那条口径**不是一回事**：那条管**放映时刻的表达**，
 *   这条管**统计桶的归属**。两者唯一的共同点是「时间口径只允许一处定义」——所以换算只在本文件。
 */

/** KST 相对 UTC 的固定偏移。韩国不实行夏令时，所以是常量而不是查表。 */
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const DAY_MS = 86_400_000;

/** 某一时刻（毫秒时间戳）落在 KST 的哪一天，`YYYY-MM-DD`。
 *  做法是「把时间轴整体平移 +9h，再按 UTC 取日期」——等价于 KST 墙上时钟的日历日。 */
export function kstDay(at: number): string {
  return new Date(at + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 某天往前数 `days` 天（`0` 即当天）—— 趋势查询的起点用它。
 *  ⚠ 固定 86_400_000 是安全的：KST 无夏令时，不存在「某天 23 小时」的边界。 */
export function kstDayMinus(days: number, at: number): string {
  return kstDay(at - days * DAY_MS);
}
