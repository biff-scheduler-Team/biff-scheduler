/**
 * 反应 emoji 白名单 —— **前后端唯一来源**。
 *
 * 建议反馈(`/feedback`)与场次讨论(`/api/screenings/:code/discussion`)共用同一套 emoji:
 * 前端据此渲染 chip、后端据此校验写入。以前这条白名单只写在 `apps/api/src/feedback.ts`,
 * 前端在 `FeedbackPage.tsx` 又手抄了一份 —— 两处会漂移,故上提到契约层。
 *
 * ⚠ `👎` 是**「点踩」**,也是全站唯一的负反馈手段(2026-09-14 用户决定):此前做过的
 *   「举报 + 管理员后台」已整体移除 —— 维护一套后台的成本高于收益,点踩足够表达「这条不好」。
 *   所以「看到不良信息怎么办」的答案就是**点踩**,而不是举报。
 */

export const REACTION_EMOJIS = ["👍", "❤️", "🎉", "💡", "👀", "👎"] as const;

export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

const reactionEmojiSet = new Set<string>(REACTION_EMOJIS);

/** 白名单判定(含类型收窄)。注意不做 trim —— `"👍 "` 不是合法 emoji。 */
export function isReactionEmoji(value: string): value is ReactionEmoji {
  return reactionEmojiSet.has(value);
}
