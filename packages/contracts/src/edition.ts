/**
 * 届次（edition）白名单 —— **前后端唯一来源**（2026-09-23，PLAN-20260923111748，B2）。
 *
 * 为什么收成枚举：服务端此前只校验 `edition.length <= 64`，于是任何 ≤64 字符的串都会被当成
 * 一个「届次」——写路径（五个 ping）能在聚合表里凭空造出不受任何页面引用的届次
 * （把榜单 / 统计撑成随机长尾），读路径也能被用来试探别的届次。届次本来就是**有限已知集合**。
 *
 * ⚠ 新增一届 = 改这一处。前端 `apps/web/src/edition.ts::EDITION` 目前仍是自己的字面量，
 *   两处相同是巧合而不是约束 —— 后续把它也改成从这里取（本轮不动前端，避免扩大改动面）。
 * ⚠ `apps/api/src/want-stats.ts::DEFAULT_WANT_EDITION` 已改为 re-export 本文件的 `DEFAULT_EDITION`。
 */

/** 已知届次。2026-09-23 全仓检索确认只有 `biff-2026`（不存在 `biff-2025` 的数据或引用）。 */
export const EDITIONS = ["biff-2026"] as const;

export type Edition = (typeof EDITIONS)[number];

/** 缺省届次（未带 `edition` 参数时用）。 */
export const DEFAULT_EDITION: Edition = "biff-2026";

export function isEdition(value: unknown): value is Edition {
  return typeof value === "string" && (EDITIONS as readonly string[]).includes(value);
}
