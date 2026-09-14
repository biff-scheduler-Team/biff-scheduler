/** 建议反馈：白名单 / 正文校验 / 反应 toggle 判定（纯函数，供路由与单测共用）。 */

export const FEEDBACK_EMOJIS = ["👍", "❤️", "🎉", "💡", "👀"] as const;
export type FeedbackEmoji = (typeof FEEDBACK_EMOJIS)[number];

export const FEEDBACK_BODY_MIN = 1;
export const FEEDBACK_BODY_MAX = 2000;

const emojiSet = new Set<string>(FEEDBACK_EMOJIS);

export function isAllowedEmoji(value: string): value is FeedbackEmoji {
  return emojiSet.has(value);
}

/** trim 后长度须在 1–2000；非法返回 null。 */
export function normalizeFeedbackBody(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const body = raw.trim();
  if (body.length < FEEDBACK_BODY_MIN || body.length > FEEDBACK_BODY_MAX) return null;
  return body;
}

/** 无会话 → 写操作应 401。 */
export function writeAuthError(session: unknown): "UNAUTHENTICATED" | null {
  return session ? null : "UNAUTHENTICATED";
}

/** 仅作者可删本帖。 */
export function canDeleteFeedbackPost(postSubject: string, sessionSubject: string): boolean {
  return postSubject === sessionSubject;
}

/** 已有行再点 → 取消；否则插入。 */
export function decideReactionToggle(alreadyActive: boolean): "add" | "remove" {
  return alreadyActive ? "remove" : "add";
}

/** 把反应行聚合成 counts + 当前用户的 myReactions。 */
export function aggregateReactions(
  rows: Array<{ emoji: string; subject: string }>,
  mySubject: string | null,
): { counts: Record<string, number>; myReactions: FeedbackEmoji[] } {
  const counts: Record<string, number> = {};
  const mine: FeedbackEmoji[] = [];
  for (const row of rows) {
    if (!isAllowedEmoji(row.emoji)) continue;
    counts[row.emoji] = (counts[row.emoji] ?? 0) + 1;
    if (mySubject && row.subject === mySubject) mine.push(row.emoji);
  }
  return { counts, myReactions: mine };
}
