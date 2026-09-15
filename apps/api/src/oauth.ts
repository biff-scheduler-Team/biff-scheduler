import { and, eq, gt, lt } from "drizzle-orm";
import { database } from "./db";
import { appSession } from "./db/schema";
import * as oauth from "oauth4webapi";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { configuration, type Configuration } from "./config";
import { hash, seal, unseal } from "./crypto";

export const scopes = "openid profile email offline_access profile:write";
const tokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  idToken: z.string().optional(),
  email: z.email(),
  emailVerified: z.boolean(),
});
export type SessionTokens = z.infer<typeof tokensSchema>;
export const sessionCookieName = (config: Configuration) =>
  config.APP_ENV === "production" ? "__Host-biff.session" : "biff.session";
export const pendingCookieName = (config: Configuration) =>
  config.APP_ENV === "production" ? "__Host-biff.oauth" : "biff.oauth";
export const cookieOptions = (config: Configuration, maxAge: number) => ({
  httpOnly: true,
  secure: config.APP_ENV === "production",
  sameSite: "Lax" as const,
  path: "/",
  maxAge,
});

/**
 * 单次上游调用的硬上限。没有它,上游挂死会把请求拖到 isolate 被回收 ——
 * 那时 `sessionFor` 的 `catch` 不会执行,`refresh_until` 租约会残留最长一个窗口,
 * 该会话在此期间每个请求都是 503。有了超时,失败就变成「可捕获的 503」而不是「被回收」。
 */
export const IDENTITY_TIMEOUT_MS = 3_000;

/**
 * 刷新 access token 时在 D1 上持有的租约时长。
 * **必须 >= 2 × `IDENTITY_TIMEOUT_MS`**:持有者要顺序跑完 discovery + refresh 两次上游调用,
 * 租约若短于这个上限,持有者还没跑完租约就过期,别的请求会接管租约并**用同一个 refresh token**
 * 再刷一次 —— 上游的重用检测会撤销**整个 token family**,两边一起废。
 */
export const REFRESH_LEASE_MS = 8_000;

/**
 * 等待别人刷新完成的上限。**必须 >= `REFRESH_LEASE_MS`**。
 * 旧实现固定 12 × 200ms = 2.4s,比租约短 6 倍 —— 持有者只要慢过 2.4s,
 * 等待者就抛 503,而那次刷新其实会成功(纯噪声失败)。
 * 同时必须**小于前端 `account-sync.ts::api()` 的 12s abort**,否则客户端先断开,
 * 用户看到的是网络错误而不是可重试的 503。
 */
export const REFRESH_WAIT_MS = 10_000;

/** 轮询租约的间隔。 */
const REFRESH_POLL_MS = 200;

export function provider(env: Env, clientIp?: string, origin?: string) {
  const config = configuration(env);
  const issuer = new URL(`${config.IFFDAY_ORIGIN}/api/v1/auth`);
  const client: oauth.Client = { client_id: config.OIDC_CLIENT_ID };
  const options = {
    [oauth.allowInsecureRequests]: config.APP_ENV === "local",
    [oauth.customFetch]: async (input: string, init: RequestInit) => {
      const url = new URL(input);
      if (url.origin !== config.IFFDAY_ORIGIN || !url.pathname.startsWith("/api/v1/auth/"))
        throw new Error("Unexpected identity endpoint");
      const headers = new Headers(init.headers);
      if (clientIp) headers.set("cf-connecting-ip", clientIp);
      const timeout = AbortSignal.timeout(IDENTITY_TIMEOUT_MS);
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      return env.IFFDAY_API.fetch(new Request(url, { ...init, headers, signal }));
    },
  };
  return {
    config,
    issuer,
    client,
    options,
    auth: oauth.ClientSecretBasic(config.OIDC_CLIENT_SECRET),
    resource: `${config.IFFDAY_ORIGIN}/api/v1/profile`,
    // Callback must return to the exact host the user started from, otherwise
    // the browser is sent to a different origin and the pending cookie is lost.
    redirectUri: `${origin ?? config.origins[0]}/api/auth/callback`,
    async metadata() {
      return oauth.processDiscoveryResponse(issuer, await oauth.discoveryRequest(issuer, options));
    },
  };
}

export async function sessionFor(env: Env, cookie: string | undefined, clientIp?: string) {
  if (!cookie) return null;
  const config = configuration(env);
  const tokenHash = await hash(cookie);
  const db = database(env.DB);
  const deadline = Date.now() + REFRESH_WAIT_MS;
  const maxAttempts = Math.ceil(REFRESH_WAIT_MS / REFRESH_POLL_MS) + 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const row = await db.select().from(appSession)
      .where(and(eq(appSession.token_hash, tokenHash), gt(appSession.expires_at, Date.now()))).get();
    if (!row) return null;
    const tokens = tokensSchema.parse(
      await unseal(row.payload, config.SESSION_SECRET, `session:${tokenHash}`),
    );
    if (row.token_expires_at > Date.now() + 30_000) return { row, tokens };
    if (!tokens.refreshToken) {
      await db.delete(appSession).where(eq(appSession.token_hash, tokenHash)).run();
      return null;
    }
    const leaseUntil = Date.now() + REFRESH_LEASE_MS;
    const lease = await db.update(appSession).set({ refresh_until: leaseUntil })
      .where(and(eq(appSession.token_hash, tokenHash), lt(appSession.refresh_until, Date.now()), eq(appSession.payload, row.payload)))
      .run();
    if (!lease.meta.changes) {
      // 别人正在刷新:等它写完再重读。等到超过等待窗口才认输(旧实现只等 2.4s,比租约短 6 倍)。
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, REFRESH_POLL_MS));
      continue;
    }
    try {
      const p = provider(env, clientIp);
      const as = await p.metadata();
      const response = await oauth.refreshTokenGrantRequest(
        as,
        p.client,
        p.auth,
        tokens.refreshToken,
        {
          ...p.options,
          additionalParameters: new URLSearchParams({ resource: p.resource }),
        },
      );
      const result = await oauth.processRefreshTokenResponse(as, p.client, response);
      if (result.id_token) {
        await oauth.validateApplicationLevelSignature(as, response, p.options);
        if (oauth.getValidatedIdTokenClaims(result)?.sub !== row.subject)
          throw new Error("Identity changed during refresh");
      }
      const fresh: SessionTokens = {
        ...tokens,
        accessToken: result.access_token,
        refreshToken: result.refresh_token ?? tokens.refreshToken,
        idToken: result.id_token ?? tokens.idToken,
      };
      const payload = await seal(fresh, config.SESSION_SECRET, `session:${tokenHash}`);
      const saved = await db.update(appSession).set({
        payload, token_expires_at: Date.now() + (result.expires_in ?? 900) * 1000, refresh_until: 0,
      }).where(and(eq(appSession.token_hash, tokenHash), eq(appSession.payload, row.payload))).run();
      // 命中 0 行 = 另一个并发刷新已经写入了更新的 payload,我们这次拿到的 token 已被轮换取代。
      // 不能当成成功继续用(会带着可能已作废的 token 往下走),回到循环重读、采用胜者的 token。
      if (!saved.meta.changes) console.warn("session_refresh_superseded");
    } catch (error) {
      if (error instanceof oauth.ResponseBodyError && error.error === "invalid_grant") {
        // 只有「我们读到的 payload 仍是当前行」时才认定会话失效。
        // 否则说明胜者已经写入新 token,我们这次失败只是「拿已作废的 refresh token 重试」——
        // 无条件按 token_hash 删行会把胜者刚建立的好会话一起删掉,用户就被无谓地踢出登录。
        const removed = await db.delete(appSession)
          .where(and(eq(appSession.token_hash, tokenHash), eq(appSession.payload, row.payload)))
          .run();
        if (removed.meta.changes) return null;
        console.warn("session_refresh_invalid_grant_superseded");
        continue;
      }
      // 只释放**自己那次**租约:无条件归零会踩掉别人刚拿到的租约,让并发刷新互相踩。
      await db.update(appSession).set({ refresh_until: 0 })
        .where(and(eq(appSession.token_hash, tokenHash), eq(appSession.refresh_until, leaseUntil)))
        .run();
      // 只记错误码 / 错误名 —— 异常里可能裹着上游响应体(含 token),不能整条打出去。
      console.warn(
        "session_refresh_failed",
        error instanceof oauth.ResponseBodyError
          ? error.error
          : error instanceof Error
            ? error.name
            : "UnknownError",
      );
      throw new HTTPException(503, { message: "Identity service unavailable" });
    }
  }
  console.warn("session_refresh_in_progress");
  throw new HTTPException(503, { message: "Session refresh in progress" });
}
