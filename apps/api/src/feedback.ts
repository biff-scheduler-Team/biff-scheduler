/**
 * 建议反馈:正文校验 / 写权限(纯函数,供路由与单测共用)。
 *
 * ⚠ 反应(emoji)相关判定已于 2026-09-14 **上提**:白名单在 `@biff/contracts/reactions`
 *   (前后端唯一来源),服务端判定在 `./reactions` —— 因为「场次讨论」要用同一套,
 *   留在这里就会被迫复制第二份。
 */

export const FEEDBACK_BODY_MIN = 1;
export const FEEDBACK_BODY_MAX = 2000;

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
