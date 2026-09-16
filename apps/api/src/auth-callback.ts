import { and, eq, gt } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as oauth from "oauth4webapi";
import { z } from "zod";
import { accountUserIdSchema, type LoginFailureCode } from "@biff/contracts/account";
import { hash, randomToken, seal, unseal } from "./crypto";
import { database } from "./db";
import { appSession, oauthPending } from "./db/schema";
import {
  cookieOptions,
  pendingCookieName,
  provider,
  sessionCookieName,
  type SessionTokens,
} from "./oauth";

const pendingSchema = z.object({ state: z.string(), nonce: z.string(), verifier: z.string() });

type CallbackEnv = { Bindings: Env };

/**
 * 把一次登录失败的**步骤**变成可区分、可回传给用户的码。
 *
 * 唯一口径是 `@biff/contracts` 的 `loginFailureCodeSchema`：这里写出表外的码会编译不过，
 * 前端 `apps/web/src/account-errors.ts` 漏写某个码的文案也会编译不过。
 *
 * 以前 catch 一律回 `account_error=authorization`，7 条失败路径里有 6 条长得一模一样，
 * 线上「点了登录、跳回来提示登录未完成」只能靠猜（见 PLAN-20260916215100）。
 */
export async function authCallback(c: Context<CallbackEnv>): Promise<Response> {
  const p = provider(c.env, c.req.header("cf-connecting-ip"), new URL(c.req.url).origin);
  const cookie = getCookie(c, pendingCookieName(p.config));
  deleteCookie(c, pendingCookieName(p.config), cookieOptions(p.config, 0));
  // 浏览器没带回这次的临时凭证:多半换了窗口 / 禁了 Cookie —— 重开一次登录即可。
  if (!cookie) {
    console.warn("oidc_callback_failed", "pending_cookie_missing");
    return c.redirect("/?account_error=pending_cookie_missing");
  }
  const cookieHash = await hash(cookie);
  // 临时记录**取用即删**(一次性):超过 10 分钟、或同一浏览器先后开了两次登录,都会落到这里。
  const [pending] = await database(c.env.DB)
    .delete(oauthPending)
    .where(and(eq(oauthPending.cookie_hash, cookieHash), gt(oauthPending.expires_at, Date.now())))
    .returning({ payload: oauthPending.payload });
  if (!pending) {
    console.warn("oidc_callback_failed", "pending_expired");
    return c.redirect("/?account_error=pending_expired");
  }
  // 每一步「危险调用」之前先写好自己的失败码:catch 时用当前步骤作为用户可见的原因。
  let step: LoginFailureCode = "authorization";
  try {
    step = "pending_unreadable";
    const transaction = pendingSchema.parse(
      await unseal(pending.payload, p.config.SESSION_SECRET, `oauth:${cookieHash}`),
    );
    const query = new URL(c.req.url).searchParams;

    step = "upstream_unreachable";
    const as = await p.metadata();
    // 上游在授权环节就拒绝时(access_denied / consent_required…)**不会给我们 code**。
    // 旧实现把它和「换 token 被拒」压成同一个 authorization,线上无法区分。
    const upstreamError = query.get("error");
    if (upstreamError) {
      console.warn("oidc_authorize_error", upstreamError, query.get("error_description") ?? "");
      return c.redirect("/?account_error=authorize_denied");
    }
    // state 是本次登录的 CSRF 凭证,由 D1 里那条一次性记录比对。不匹配最常见的成因是
    // **同一浏览器先后发起了两次登录** —— 第二次的临时记录把第一次的 state 顶掉了。
    if (query.get("state") !== transaction.state) {
      console.warn("oidc_callback_failed", "state_mismatch");
      return c.redirect("/?account_error=state_mismatch");
    }

    // 走到这里之前,「上游对这次授权请求的应答本身不成形」(缺 code / iss 不符 / 其他未预期形态)
    // 还没有更具体的名字 —— 归入兜底码,而不是硬塞进上面任意一条。
    step = "authorization";
    const parameters = oauth.validateAuthResponse(
      as,
      p.client,
      new URL(c.req.url),
      transaction.state,
    );
    step = "token_rejected";
    const response = await oauth.authorizationCodeGrantRequest(
      as,
      p.client,
      p.auth,
      parameters,
      p.redirectUri,
      transaction.verifier,
      { ...p.options, additionalParameters: new URLSearchParams({ resource: p.resource }) },
    );
    const result = await oauth.processAuthorizationCodeResponse(as, p.client, response, {
      expectedNonce: transaction.nonce,
      requireIdToken: true,
    });

    step = "id_token_invalid";
    await oauth.validateApplicationLevelSignature(as, response, p.options);
    const claims = oauth.getValidatedIdTokenClaims(result);

    // sub 的形态是本地白名单(与 syncSchema 共用 `accountUserIdSchema`)。上游换了身份 ID 的
    // 生成方式时,这一条会**在登录这一刻**就暴露,而不是等到同步阶段才报 422。
    step = "subject_invalid";
    const subject = accountUserIdSchema.parse(claims?.sub);

    step = "userinfo_failed";
    const infoResponse = await oauth.userInfoRequest(as, p.client, result.access_token, p.options);
    const info = await oauth.processUserInfoResponse(as, p.client, subject, infoResponse);
    const tokens: SessionTokens = {
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      idToken: result.id_token,
      email: z.email().parse(info.email),
      emailVerified: info.email_verified === true,
    };

    step = "session_store_failed";
    const sessionToken = randomToken();
    const tokenHash = await hash(sessionToken);
    const db = database(c.env.DB);
    await db
      .insert(appSession)
      .values({
        token_hash: tokenHash,
        subject,
        payload: await seal(tokens, p.config.SESSION_SECRET, `session:${tokenHash}`),
        expires_at: Date.now() + 7 * 86400_000,
        token_expires_at: Date.now() + (result.expires_in ?? 900) * 1000,
      })
      .run();
    const oldCookie = getCookie(c, sessionCookieName(p.config));
    if (oldCookie)
      await db.delete(appSession).where(eq(appSession.token_hash, await hash(oldCookie))).run();
    setCookie(c, sessionCookieName(p.config), sessionToken, cookieOptions(p.config, 7 * 86400));
    // 登录这一刻「有没有 RT」决定这个会话能不能自动续期(PLAN-20260916104514 成因 A)。
    // 只记寿命与有无,不打 token。
    console.log(
      "oidc_token_issued",
      result.expires_in ?? "unset",
      result.refresh_token ? "rt" : "no-rt",
    );
    return c.redirect("/?account=connected");
  } catch (error) {
    // 只记步骤 / 错误类名 / 上游给的 OAuth error 码 —— 异常里可能裹着含 token 的响应体。
    console.warn("oidc_callback_failed", step, describeError(error));
    return c.redirect(`/?account_error=${step}`);
  }
}

/** 把异常压成**不含敏感内容**的一行:错误类名 + OAuth 规范里的 error 码。 */
function describeError(error: unknown): string {
  if (error instanceof oauth.ResponseBodyError || error instanceof oauth.AuthorizationResponseError)
    return `${error.name}:${error.error}`;
  return error instanceof Error ? error.name : "UnknownError";
}
