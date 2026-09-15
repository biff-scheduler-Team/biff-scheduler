/**
 * 场次讨论客户端(公开读 / 登录写)。
 *
 * 复用 `account-sync.ts::api()`(同源 + 12s 超时 + 非 2xx 抛 `ApiFailure`),不自己再写一套 fetch 口径。
 * 分类白名单与正文长度只在 `@biff/contracts/screening` 定义,这里只负责搬运。
 * 另外收着「帖子时间怎么显示」这一个纯展示口径(讨论区与讨论弹层共用)。
 */

import type { ReactionEmoji } from "@biff/contracts/reactions";
import type { DiscussionCategory } from "@biff/contracts/screening";
import { api } from "./account-sync";
import { EDITION } from "./edition";

export interface DiscussionPost {
  id: string;
  code: string;
  subject: string;
  displayName: string;
  category: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  reactionCounts: Record<string, number>;
  myReactions: string[];
}

export interface DiscussionPage {
  posts: DiscussionPost[];
  nextCursor: string | null;
}

function endpoint(code: string): string {
  return `/api/screenings/${encodeURIComponent(code)}/discussion`;
}

/** 帖子时间的展示口径 —— 讨论区方格墙与场次讨论弹层**共用这一份**
 *  (同一条帖子在两个视图里必须显示同一个时间,各写一份必然漂移)。 */
export function formatDiscussionTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return String(ms);
  }
}

export async function fetchDiscussion(
  code: string,
  cursor: string | null,
): Promise<DiscussionPage> {
  const query = new URLSearchParams({ edition: EDITION });
  if (cursor) query.set("cursor", cursor);
  const response = await api(`${endpoint(code)}?${query}`);
  return (await response.json()) as DiscussionPage;
}

/** 讨论区:全站帖子墙的一页(时间倒序)——不走 `endpoint(code)`,与单场讨论同一个返回形状。 */
export async function fetchDiscussionBoard(
  cursor: string | null,
): Promise<DiscussionPage> {
  const query = new URLSearchParams({ edition: EDITION });
  if (cursor) query.set("cursor", cursor);
  const response = await api(`/api/discussions?${query}`);
  return (await response.json()) as DiscussionPage;
}

export async function createDiscussion(
  code: string,
  category: DiscussionCategory,
  body: string,
): Promise<DiscussionPost> {
  const response = await api(endpoint(code), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ edition: EDITION, category, body }),
  });
  return (await response.json()) as DiscussionPost;
}

export async function removeDiscussion(code: string, id: string): Promise<void> {
  await api(`${endpoint(code)}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function toggleDiscussionReaction(
  code: string,
  id: string,
  emoji: ReactionEmoji,
): Promise<{ active: boolean; reactionCounts: Record<string, number>; myReactions: string[] }> {
  const response = await api(`${endpoint(code)}/${encodeURIComponent(id)}/reactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emoji }),
  });
  return (await response.json()) as {
    active: boolean;
    reactionCounts: Record<string, number>;
    myReactions: string[];
  };
}
