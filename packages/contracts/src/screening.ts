/**
 * 场次讨论:分类白名单 / 正文长度 —— **前后端唯一来源**。
 *
 * 前端据此渲染分类 chips 与字数上限,后端据此校验写入;任何一侧另写一份都会漂移。
 */

export const DISCUSSION_CATEGORIES = [
  { key: "gift", label: "无料交换" },
  { key: "swap", label: "物品互换" },
  { key: "buddy", label: "临时约伴" },
  { key: "other", label: "其他" },
] as const;

export type DiscussionCategory = (typeof DISCUSSION_CATEGORIES)[number]["key"];

export const DISCUSSION_BODY_MIN = 1;
export const DISCUSSION_BODY_MAX = 2000;

const categorySet = new Set<string>(DISCUSSION_CATEGORIES.map((category) => category.key));

export function isDiscussionCategory(value: string): value is DiscussionCategory {
  return categorySet.has(value);
}

/** 分类中文标签;未知 key 原样返回(旧数据 / 将来删分类时的兜底,不抛错)。 */
export function discussionCategoryLabel(key: string): string {
  return DISCUSSION_CATEGORIES.find((category) => category.key === key)?.label ?? key;
}

/** trim 后长度须在 1–2000;非法返回 null(与 `normalizeFeedbackBody` 同一口径)。 */
export function normalizeDiscussionBody(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const body = raw.trim();
  if (body.length < DISCUSSION_BODY_MIN || body.length > DISCUSSION_BODY_MAX) return null;
  return body;
}
