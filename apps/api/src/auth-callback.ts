import { and, eq, gt } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as oauth from "oauth4webapi";
import { z } from "zod";
import { accountUserIdSchema, loginFailureParam, type LoginFailureCode } from "@biff/contracts/account";
import { hash, randomToken, seal, unseal } from "./crypto";
import { database } from "./db";
import { appSession, oauthPending } from "./db/schema";
import {
  AUTH_FLOW_TIMEOUT_MS,
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
  // 登录流程用 10 秒预算,并且给**整条流程**一个总 deadline —— 回调要串行调 4 次上游
  // (发现文档 → 换 token → JWKS → userinfo),单次上限乘 4 会把用户晾在半分钟里
  // (见 `oauth.ts::AUTH_FLOW_TIMEOUT_MS` / PLAN-20260916220942 修订 1)。
  const p = provider(c.env, c.req.header("cf-connecting-ip"), new URL(c.req.url).origin, {
    timeoutMs: AUTH_FLOW_TIMEOUT_MS,
    deadline: AbortSignal.timeout(AUTH_FLOW_TIMEOUT_MS),
  });
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
  // 失败那一步**自己**耗时多少 —— 这是回答「是不是我们等上游等到超时」的唯一判据。
  // 用闭包变量而**不是**模块级变量:同一个 isolate 上的并发请求会互相串扰
  // (上一轮已经因为同样的理由否掉过模块级方案,见 PLAN-20260916104514 §方案取舍)。
  let stepMs = 0;
  const timed = async <T>(run: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      return await run();
    } finally {
      stepMs = Date.now() - started;
    }
  };
  try {
    step = "pending_unreadable";
    const transaction = pendingSchema.parse(
      await unseal(pending.payload, p.config.SESSION_SECRET, `oauth:${cookieHash}`),
    );
    const query = new URL(c.req.url).searchParams;

    step = "upstream_unreachable";
    const as = await timed(() => p.metadata());
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
    const response = await timed(() =>
      oauth.authorizationCodeGrantRequest(
        as,
        p.client,
        p.auth,
        parameters,
        p.redirectUri,
        transaction.verifier,
        { ...p.options, additionalParameters: new URLSearchParams({ resource: p.resource }) },
      ),
    );
    const result = await oauth.processAuthorizationCodeResponse(as, p.client, response, {
      expectedNonce: transaction.nonce,
      requireIdToken: true,
    });

    step = "id_token_invalid";
    await timed(() => oauth.validateApplicationLevelSignature(as, response, p.options));
    const claims = oauth.getValidatedIdTokenClaims(result);

    // sub 的形态是本地白名单(与 syncSchema 共用 `accountUserIdSchema`)。上游换了身份 ID 的
    // 生成方式时,这一条会**在登录这一刻**就暴露,而不是等到同步阶段才报 422。
    step = "subject_invalid";
    const subject = accountUserIdSchema.parse(claims?.sub);

    step = "userinfo_failed";
    const infoResponse = await timed(() =>
      oauth.userInfoRequest(as, p.client, result.access_token, p.options),
    );
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
    await timed(async () =>
      db
        .insert(appSession)
        .values({
          token_hash: tokenHash,
          subject,
          payload: await seal(tokens, p.config.SESSION_SECRET, `session:${tokenHash}`),
          expires_at: Date.now() + 7 * 86400_000,
          token_expires_at: Date.now() + (result.expires_in ?? 900) * 1000,
        })
        .run(),
    );
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
    // 步骤 / 本步耗时 / 错误类名 / 上游给的 OAuth error 码 —— 异常里可能裹着含 token 的响应体,
    // 所以**只有**白名单化的 `failureDetail()` 允许回传给浏览器(见 PLAN-20260916220942)。
    console.warn("oidc_callback_failed", step, stepMs, describeError(error));
    return c.redirect(
      `/?account_error=${loginFailureParam(step, failureDetail(error))}&account_ms=${stepMs}`,
    );
  }
}

/**
 * 失败细节(白名单后才允许进 URL / DOM):把三件不同的事分开 ——
 * 「上游明确拒绝」(会给出 `invalid_grant` 这类 OAuth error 码)、
 * 「我们连不上 / 被中断」(`network_*`)、「上游应答不成形」(`unexpected_response`)。
 * 旧实现里这三件都只叫「登录未完成」,无法区分。
 */
function failureDetail(error: unknown): string {
  if (error instanceof oauth.ResponseBodyError || error instanceof oauth.AuthorizationResponseError)
    return error.error;
  if (error instanceof oauth.OperationProcessingError) return "unexpected_response";
  if (error instanceof Error) return NETWORK_DETAILS[error.name] ?? "unexpected_error";
  return "unexpected_error";
}

/** 只映射**已知**的错误名;其余一律 `unexpected_error` —— 不回显任意错误名/消息。 */
const NETWORK_DETAILS: Record<string, string> = {
  TimeoutError: "network_timeout",
  AbortError: "network_aborted",
  TypeError: "network_error",
};

/** 日志用的那一行:**不含敏感内容**的错误类名 + OAuth 规范里的 error 码。 */
function describeError(error: unknown): string {
  if (error instanceof oauth.ResponseBodyError || error instanceof oauth.AuthorizationResponseError)
    return `${error.name}:${error.error}`;
  return error instanceof Error ? error.name : "UnknownError";
}
