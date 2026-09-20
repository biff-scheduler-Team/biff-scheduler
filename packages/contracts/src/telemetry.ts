/**
 * 事件流水的共享契约（2026-09-20，第 3 轮，PLAN-20260920203010 修订 2）。
 *
 * ★ 为什么放在 contracts 而不是各写一份：这一组常量**前后端必须逐字一致**，
 *   漏一个就会出现「客户端发了、服务端不认」或反过来的静默丢数据。
 *   仓库已有的共享形状（reactions / screening / account）都在这里，本轮沿用同一处置。
 *
 * ★ 这份白名单存在的理由（用户本轮的两条决定）：
 *   ① 「直接上报，不需要提示」→ 没有 consent 兜底，服务端就必须自己收得住；
 *   ② 「搜索完全不进统计」→ **没有 search 这一类**，且 `target` 只接受固定 slug / 路径形状，
 *      自由文本（搜索词、片名、人名）在结构上就进不来。
 */

/** 只有这两类。**刻意没有 search** —— 不是「暂时不做」，是明确排除。 */
export const TELEMETRY_KINDS = ["page", "click"] as const;

export type TelemetryKind = (typeof TELEMETRY_KINDS)[number];

/**
 * 允许被埋点的入口 slug。**前后端共用这一份**：
 * 客户端用它过滤 DOM 上的 `data-track`（手写的，写错宁可不发），
 * 服务端用它挡伪造请求（否则任意 slug 都能灌进榜单，把表撑成随机长尾）。
 *
 * ⚠ 新增一个入口 = 改这一处 + 在 `rush-traffic.ts::CLICK_LABELS` 补一个中文名。
 */
export const CLICK_TARGET_SLUGS = ["screening", "film", "ticket", "export"] as const;

export type ClickTargetSlug = (typeof CLICK_TARGET_SLUGS)[number];

/** 单个 target 的最大长度（防超长串；形状白名单另在服务端做）。 */
export const TELEMETRY_TARGET_MAX_LENGTH = 64;

/** 一次 ping 里单条 target 允许的最大次数 —— 一次报十万次是伪造的特征。 */
export const MAX_HITS_PER_TARGET = 100;

/** 一次 ping 最多带多少条 (kind, target)。 */
export const MAX_TELEMETRY_ENTRIES_PER_PING = 200;

/** slug 白名单判定（前后端同一份实现）。 */
export function isClickTargetSlug(value: unknown): value is ClickTargetSlug {
  return typeof value === "string" && (CLICK_TARGET_SLUGS as readonly string[]).includes(value);
}

export function isTelemetryKind(value: unknown): value is TelemetryKind {
  return typeof value === "string" && (TELEMETRY_KINDS as readonly string[]).includes(value);
}
