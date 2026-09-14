/**
 * 场次讨论:发帖载荷校验 + 分页上限(纯函数,供路由与单测共用)。
 *
 * 分类白名单与正文长度在 `@biff/contracts/screening`(前后端唯一来源),这里只做**组合校验**。
 */

import {
  isDiscussionCategory,
  normalizeDiscussionBody,
  type DiscussionCategory,
} from "@biff/contracts/screening";

/** 一页默认 20 条:场次讨论通常只有几条,首屏不必拉满。 */
export const DISCUSSION_LIMIT_DEFAULT = 20;
export const DISCUSSION_LIMIT_MAX = 50;

/** 解析发帖载荷 `{ category, body }`;任一不合法返回 null(与反馈的 normalize 同风格)。 */
export function normalizeDiscussionPost(
  raw: unknown,
): { category: DiscussionCategory; body: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const { category, body } = raw as { category?: unknown; body?: unknown };
  if (typeof category !== "string" || !isDiscussionCategory(category)) return null;
  const normalized = normalizeDiscussionBody(body);
  if (!normalized) return null;
  return { category, body: normalized };
}
