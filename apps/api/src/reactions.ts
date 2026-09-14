/**
 * 反应(emoji)纯函数 —— 建议反馈与场次讨论**共用同一套实现**。
 *
 * 白名单在 `@biff/contracts/reactions`(前后端唯一来源);这里只放服务端判定,
 * 供路由与单测共用。以前这三件事写在 `feedback.ts` 里,场次讨论若照抄一份就会漂移。
 */

import { isReactionEmoji, type ReactionEmoji } from "@biff/contracts/reactions";

/** 已有行再点 → 取消；否则插入。 */
export function decideReactionToggle(alreadyActive: boolean): "add" | "remove" {
  return alreadyActive ? "remove" : "add";
}

/** 把反应行聚合成 counts + 当前用户的 myReactions。 */
export function aggregateReactions(
  rows: Array<{ emoji: string; subject: string }>,
  mySubject: string | null,
): { counts: Record<string, number>; myReactions: ReactionEmoji[] } {
  const counts: Record<string, number> = {};
  const mine: ReactionEmoji[] = [];
  for (const row of rows) {
    if (!isReactionEmoji(row.emoji)) continue;
    counts[row.emoji] = (counts[row.emoji] ?? 0) + 1;
    if (mySubject && row.subject === mySubject) mine.push(row.emoji);
  }
  return { counts, myReactions: mine };
}
