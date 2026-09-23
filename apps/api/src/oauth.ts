import { and, eq, gt, lt } from "drizzle-orm";
import { database } from "./db";
import { appSession } from "./db/schema";
import * as oauth from "oauth4webapi";
import { accountProfileSchema, type AccountProfile } from "@biff/contracts/account";
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

/**
 * 会话不可用的**可区分原因**。
 *
 * 以前所有失败都塌成「401 UNAUTHENTICATED」,前端只能统一显示「登录已过期」——
 * 而线上「cookie 还在、行没了」至少有三条成因(登录没拿到 refresh token / 上游拒绝刷新 /
 * 上游拒绝身份校验),不分开就只能靠猜。见 `PLAN-20260916104514`。
 */
export type SessionFailure =
  | "SESSION_NO_COOKIE"
  | "SESSION_NOT_FOUND"
  | "SESSION_NO_REFRESH_TOKEN"
  | "SESSION_REFRESH_REJECTED";

export type SessionRow = typeof appSession.$inferSelect;

/**
 * `sessionFor()` 的返回值:命中给会话,未命中给**原因**(而不是笼统的 `null`)。
 *
 * 可选取登录的调用点只关心 `session`(cookie 缺失本来就是「访客」的正常语义),
 * 只有 `requireIdentity` 需要 `failure` 把它变成可读的错误码。
 */
export interface SessionLookup {
  session: { row: SessionRow; tokens: SessionTokens } | null;
  failure: SessionFailure | null;
}

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
 * 单次上游调用的**期望**上限。
 *
 * 设计意图:没有它,上游挂死会把请求拖到 isolate 被回收 —— 那时 `sessionFor` 的 `catch`
 * 不会执行,`refresh_until` 租约会残留最长一个窗口,该会话在此期间每个请求都是 503。
 *
 * ⚠ 2026-09-16 实测:这个 `AbortSignal.timeout` 在 **service binding**(`IFFDAY_API`)这条路上
 * **没有观察到真正中断过请求** —— `/api/auth/login`(内部只调一次发现文档)10 次里有 1 次
 * 花了 **4.39 秒却仍然成功**;若上限真生效,它应在第 3 秒被中断并回 `upstream_unreachable`。
 * ⚠ 但**尚未坐实**:那 4.39 秒里还含一次 D1 批量写(2 删 1 插),两段没有分开计时。
 * 所以在动这个值(包括把它换成真正可中断的写法)之前,**必须先把上游调用与 D1 分开计时** ——
 * callback 回传 `account_ms`(失败那一步自己的耗时)就是为这件事准备的,见 PLAN-20260916220942。
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

/**
 * **登录流程**(`/api/auth/login` + `/api/auth/callback`)给上游的预算:10 秒。
 *
 * 刻意与 `IDENTITY_TIMEOUT_MS` 分开:**那条 3 秒被上面三条不变量绑着**
 * (`REFRESH_LEASE_MS >= 2 × IDENTITY_TIMEOUT_MS` 等),刷新链路上任何一个会话请求都会用到它,
 * 从调用点随手调大会让租约提前过期、两个并发刷新拿同一个 refresh token 去换 → 上游撤销整个 token family。
 * 登录流程则**没有租约、也不在 `sessionFor` 的请求路径上**,可以放宽。
 *
 * 为什么是 10 秒:2026-09-16 实测账号系统**单次**发现文档就要 1.8–4.4 秒(本机直连 2.4s,
 * 经 service binding 同样),而登录 + 回调会**串行调 4 次**(发现文档 → 换 token → JWKS → userinfo)。
 * 3 秒这种单步上限正好压在正常延迟的上沿,等于随机掐断合法登录(见 PLAN-20260916220942 修订 1)。
 */
export const AUTH_FLOW_TIMEOUT_MS = 10_000;

/** `provider()` 的上游预算:默认值与刷新链路一致,只有登录流程显式放宽。 */
export interface ProviderBudget {
  /** 单次上游调用的上限,默认 `IDENTITY_TIMEOUT_MS`。 */
  timeoutMs?: number;
  /** 整条流程共享的总预算(可选):避免「4 步 × 单步上限」把用户晾在半分钟里。 */
  deadline?: AbortSignal;
}

export function provider(
  env: Env,
  clientIp?: string,
  origin?: string,
  budget: ProviderBudget = {},
) {
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
      const timeout = AbortSignal.timeout(budget.timeoutMs ?? IDENTITY_TIMEOUT_MS);
      // 调用方自己的 signal 与整条流程的 deadline 一起拼进去:谁先到算谁。
      const extra = [init.signal, budget.deadline].filter(
        (value): value is AbortSignal => value instanceof AbortSignal,
      );
      const signal = extra.length ? AbortSignal.any([timeout, ...extra]) : timeout;
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
    // 回调必须回到用户出发时的那个主机，否则浏览器会被送到另一个源、
    // 登录途中那枚 pending cookie 就丢了。
    redirectUri: `${origin ?? config.origins[0]}/api/auth/callback`,
    async metadata() {
      return oauth.processDiscoveryResponse(issuer, await oauth.discoveryRequest(issuer, options));
    },
  };
}

export async function sessionFor(
  env: Env,
  cookie: string | undefined,
  clientIp?: string,
  options: { force?: boolean } = {},
): Promise<SessionLookup> {
  if (!cookie) return { session: null, failure: "SESSION_NO_COOKIE" };
  const config = configuration(env);
  const tokenHash = await hash(cookie);
  const db = database(env.DB);
  const deadline = Date.now() + REFRESH_WAIT_MS;
  const maxAttempts = Math.ceil(REFRESH_WAIT_MS / REFRESH_POLL_MS) + 2;
  // `force` 只对**第一次**读到的行生效:若我们是等别人刷完再重读,别人的成果就是我们要的东西,
  // 再强制换一次只会白白多烧一轮 refresh token。
  let force = options.force === true;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // 「抢不到租约」与「invalid_grant 被别人抢先」两条路径都会 `continue` —— 统一在这里卡
    // deadline,任何路径都不允许空转到 `maxAttempts`(旧实现的 superseded 分支绕过了它)。
    if (attempt > 0 && Date.now() >= deadline) break;
    const row = await db.select().from(appSession)
      .where(and(eq(appSession.token_hash, tokenHash), gt(appSession.expires_at, Date.now()))).get();
    if (!row) return { session: null, failure: "SESSION_NOT_FOUND" };
    const tokens = tokensSchema.parse(
      await unseal(row.payload, config.SESSION_SECRET, `session:${tokenHash}`),
    );
    const stillValid = row.token_expires_at > Date.now() + 30_000;
    if (stillValid && !force) return { session: { row, tokens }, failure: null };
    force = false;
    if (!tokens.refreshToken) {
      // 登录时上游没给 refresh token 的会话,撑不过第一个 access token 窗口(15 分钟)——
      // 到点必然走到这里删行,用户只看到「登录已过期」而线上不留痕迹。打点是为了让这条
      // 路径可被观察,并与「上游拒绝刷新」区分开(PLAN-20260916104514 成因 A)。
      // 不再打 `subject`（账号 ID 属可识别信息，CF 日志里没必要留）——只留事件名。
      console.warn("session_without_refresh_token");
      await db.delete(appSession).where(eq(appSession.token_hash, tokenHash)).run();
      return { session: null, failure: "SESSION_NO_REFRESH_TOKEN" };
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
        // 必须用 `||`:上游回 `refresh_token: ""` 时 `??` 会放行空串,空串进了会话之后,
        // 下一次刷新命中 `!tokens.refreshToken` → 删行踢人,而错误码还会把这误报成
        // 「登录时上游就没给 RT」。空串与「没给」要当成同一件事。
        refreshToken: result.refresh_token || tokens.refreshToken,
        idToken: result.id_token ?? tokens.idToken,
      };
      // 只记寿命与「是否轮换」,绝不记 token —— 上游到底有没有下发 RT 是本次故障的关键疑点,
      // 有了这一行,下次拿到生产日志就能直接判。
      console.log(
        "session_token_refreshed",
        result.expires_in ?? "unset",
        result.refresh_token ? "rt-rotated" : "rt-reused",
      );
      const tokenExpiresAt = Date.now() + (result.expires_in ?? 900) * 1000;
      const payload = await seal(fresh, config.SESSION_SECRET, `session:${tokenHash}`);
      const saved = await db.update(appSession).set({
        payload, token_expires_at: tokenExpiresAt, refresh_until: 0,
      }).where(and(eq(appSession.token_hash, tokenHash), eq(appSession.payload, row.payload))).run();
      if (!saved.meta.changes) {
        // 命中 0 行 = 另一个并发刷新已经写入了更新的 payload,我们这次拿到的 token 已被轮换取代。
        // 不能当成成功继续用(会带着可能已作废的 token 往下走),回到循环重读、采用胜者的 token。
        console.warn("session_refresh_superseded");
        continue;
      }
      // 直接返回刚写入的会话。**不要**回到循环重读:上游若只给很短的有效期(比如 10 秒),
      // 重读会立刻再次满足「该刷新」的条件 → 同一个请求里连环刷新,每次都拿刚得到的 RT
      // 再去上游换一次 —— 开了轮换 + 重用检测的上游很容易把这判成异常。
      return {
        session: {
          row: { ...row, payload, token_expires_at: tokenExpiresAt, refresh_until: 0 },
          tokens: fresh,
        },
        failure: null,
      };
    } catch (error) {
      if (error instanceof oauth.ResponseBodyError && error.error === "invalid_grant") {
        // 只有「我们读到的 payload 仍是当前行」时才认定会话失效。
        // 否则说明胜者已经写入新 token,我们这次失败只是「拿已作废的 refresh token 重试」——
        // 无条件按 token_hash 删行会把胜者刚建立的好会话一起删掉,用户就被无谓地踢出登录。
        const removed = await db.delete(appSession)
          .where(and(eq(appSession.token_hash, tokenHash), eq(appSession.payload, row.payload)))
          .run();
        if (removed.meta.changes) {
          console.warn("session_invalid_grant");
          return { session: null, failure: "SESSION_REFRESH_REJECTED" };
        }
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

/** 调上游 profile。口径必须与 `provider().customFetch` 一致:硬超时 + 转发真实客户端 IP。
 *
 *  少了超时,上游挂死会把请求拖到 isolate 被回收 —— 那时连 catch 都不会执行;
 *  少了 IP,上游的风控 / 限流看到的是一个没有来源的请求。 */
async function requestProfile(env: Env, accessToken: string, clientIp?: string) {
  const config = configuration(env);
  const headers = new Headers({ Authorization: `Bearer ${accessToken}` });
  if (clientIp) headers.set("cf-connecting-ip", clientIp);
  return env.IFFDAY_API.fetch(
    new Request(`${config.IFFDAY_ORIGIN}/api/v1/profile`, {
      headers,
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
    }),
  );
}

/** 身份验证结果。`failure` 的取值直接作为响应的 `error` 回给前端。 */
export type IdentityOutcome =
  | { session: NonNullable<SessionLookup["session"]>; profile: AccountProfile }
  | {
      failure:
        | "IDENTITY_REJECTED"
        | "IDENTITY_UNAVAILABLE"
        | "IDENTITY_MISMATCH"
        | "UNAUTHENTICATED"
        | SessionFailure;
    };

/**
 * 验证会话身份,并在上游拒绝时**先救一次再判死**。
 *
 * 上游回 401 的成因不止「会话失效」:本地 `token_expires_at` 是按「收到响应那一刻 + expires_in」
 * 算的(比上游签发时刻晚一个网络往返),边界上就可能拿着刚过期的 token 过去;上游瞬时故障、
 * 限流也会回 401。旧实现一律按 `token_hash` 删行 —— 一次抖动 = 永久登出(cookie 还在、行没了),
 * 用户只能重新登录,而且看起来像「登录已过期」。
 *
 * 所以改为:先强制换一份 token 再验一次。刷新成功即自愈;刷新失败(上游明确回 invalid_grant)
 * 说明会话真的没了 —— 那时删会话、让用户重新登录才是对的判定。
 */
export async function resolveIdentity(
  env: Env,
  cookie: string | undefined,
  clientIp: string | undefined,
  session: NonNullable<SessionLookup["session"]>,
): Promise<IdentityOutcome> {
  let current = session;
  let response = await requestProfile(env, current.tokens.accessToken, clientIp);
  if (response.status === 401) {
    const retry = await sessionFor(env, cookie, clientIp, { force: true });
    if (!retry.session) return { failure: retry.failure ?? "UNAUTHENTICATED" };
    current = retry.session;
    response = await requestProfile(env, current.tokens.accessToken, clientIp);
  }
  if (!response.ok) {
    if (response.status === 401)
      await database(env.DB)
        .delete(appSession)
        .where(eq(appSession.token_hash, current.row.token_hash))
        .run();
    return { failure: response.status === 401 ? "IDENTITY_REJECTED" : "IDENTITY_UNAVAILABLE" };
  }
  // ⚠ 用 `safeParse` 而不是 `parse`（2026-09-23，PLAN-20260923111748，B2）：
  //   上游返回 200 但字段不合契约（或压根不是 JSON）时，`parse` / `json()` 抛出的异常会冒泡成
  //   500 `INTERNAL_ERROR` —— 前端会当成「服务端 bug」而不是可重试的「身份服务暂时不可用」。
  const parsed = accountProfileSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    console.warn("identity_profile_malformed");
    return { failure: "IDENTITY_UNAVAILABLE" };
  }
  if (parsed.data.userId !== current.row.subject) return { failure: "IDENTITY_MISMATCH" };
  return { session: current, profile: parsed.data };
}
