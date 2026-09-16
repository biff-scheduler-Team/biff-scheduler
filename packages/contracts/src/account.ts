import { z } from "zod";
export const accountUserIdSchema = z.string().regex(/^user_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
export const accountProfileSchema = z.object({
  userId: accountUserIdSchema,
  displayName: z.string(),
  bio: z.string(),
  website: z.string(),
  avatarUrl: z.url().nullable(),
  updatedAt: z.string(),
  version: z.number().int().nonnegative(),
});
export const accountSchema = z.object({
  user: z.object({ id: accountUserIdSchema, email: z.email(), emailVerified: z.boolean() }),
  profile: accountProfileSchema,
});
export type Account = z.infer<typeof accountSchema>;
export type AccountProfile = z.infer<typeof accountProfileSchema>;

/**
 * 登录失败（`/?account_error=<code>`）的**可区分原因** —— 唯一口径。
 *
 * 2026-09-16 之前，callback 的 7 条失败路径里有 6 条都塌成同一个 `authorization`，
 * 前端又把 `account_error` 的具体值丢掉，于是「点了登录 → 跳回来提示登录未完成」
 * 在生产上**没有任何可观察手段**（CF 日志 / D1 本机都够不着）。这与 401 分诊
 * （PLAN-20260916104514）是同一类问题，见 PLAN-20260916215100。
 *
 * 放在共享契约里是为了让两边都**编译期**收口：服务端写出表外的码要报错，
 * 前端（`apps/web/src/account-errors.ts`）漏写某个码的文案也要报错。
 */
export const loginFailureCodeSchema = z.enum([
  /** 浏览器没带回 `__Host-biff.oauth`：换窗口 / 禁 Cookie / 跨浏览器。 */
  "pending_cookie_missing",
  /** `oauth_pending` 里没有这一行：>10 分钟、或同一浏览器连开了两次登录。 */
  "pending_expired",
  /** `unseal` / 临时记录解析失败，多半是 `SESSION_SECRET` 变更过。 */
  "pending_unreadable",
  /** 发现文档 3s 超时，或上游不支持 PKCE S256。 */
  "upstream_unreachable",
  /** 上游在授权环节直接拒绝（`?error=access_denied` 等），不会给我们 code。 */
  "authorize_denied",
  /** 回调 state ≠ 本次登录 state：与「连开两次登录」形态一致。 */
  "state_mismatch",
  /** 换 token 被拒（`invalid_grant` 等）。 */
  "token_rejected",
  /** ID token 验签 / nonce / iss / aud 不过。 */
  "id_token_invalid",
  /** `sub` 不合 `accountUserIdSchema` 白名单（上游换了身份 ID 生成方式会在这里暴露）。 */
  "subject_invalid",
  /** userinfo 调用 / 解析失败（含邮箱缺失）。 */
  "userinfo_failed",
  /** 写 `app_session` 失败。 */
  "session_store_failed",
  /** 登录一开始写 `oauth_pending` 就失败。 */
  "pending_store_failed",
  /** 兜底：授权应答本身不成形（缺 code / iss 不符）或未预期异常。仍然不与上面任意一条混用。 */
  "authorization",
]);
export type LoginFailureCode = z.infer<typeof loginFailureCodeSchema>;
