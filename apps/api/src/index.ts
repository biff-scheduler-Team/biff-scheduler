import { hasImportableData } from "@biff/contracts/import";
import { isReactionEmoji } from "@biff/contracts/reactions";
import { and, eq, lt, notExists, sql } from "drizzle-orm";
import { database } from "./db";
import { accountImport, appSession, festivalDocument, oauthPending } from "./db/schema";
import { pickFilmKeysFromRecords, wantWeightFor } from "./want-stats";
import { DEFAULT_EDITION, EDITIONS, isEdition } from "@biff/contracts/edition";
import { LOOKUP_RATE_LIMIT, PING_RATE_LIMIT, createRateLimiter } from "./rate-limit";
import { readWantCounts, replaceContributorWants } from "./want-store";
import { MAX_FILM_KEY_LENGTH, MAX_VOTES_PER_PING, normalizeVotes } from "./film-vote-stats";
import {
  ANON_PREFIX,
  auditVoteRows,
  claimContributorVotes,
  exposeVoteRows,
  MAX_VOTE_ROWS,
  readVoteCounts,
  readVoteRows,
  removeContributorVote,
  replaceContributorVotes,
} from "./film-vote-store";
import { isAdminSubject } from "./admin";
import {
  normalizeFeedbackBody,
  writeAuthError,
} from "./feedback";
import { MAX_SCREENING_CODES_PER_PING, SCREENING_CODE_MAX_LENGTH } from "./screening-stats";
import {
  MAX_TICKET_ENTRIES_PER_PING,
  TICKET_STATES,
  normalizeTicketEntries,
} from "./ticket-stats";
import { readTicketCounts, replaceContributorTickets } from "./ticket-stats-store";
import {
  MAX_HITS_PER_TARGET,
  MAX_TELEMETRY_ENTRIES_PER_PING,
  TELEMETRY_KINDS,
  TELEMETRY_TARGET_MAX_LENGTH,
  normalizeTelemetryEntries,
} from "./telemetry-stats";
import { applyContributorTelemetry, readTelemetryCounts } from "./telemetry-store";
import {
  clearAnonContributions,
  readScreeningCounts,
  replaceContributorScreenings,
} from "./screening-stats-store";
import { normalizeDiscussionPost } from "./screening-discussion";
import {
  createScreeningPost,
  deleteScreeningPost,
  listDiscussionPosts,
  listScreeningPosts,
  parseDiscussionCursor,
  parseDiscussionLimit,
  readDiscussionCounts,
  toggleScreeningReaction,
} from "./screening-discussion-store";
import {
  createFeedbackPost,
  deleteFeedbackPost,
  listFeedbackPosts,
  parseFeedbackCursor,
  parseFeedbackLimit,
  toggleFeedbackReaction,
} from "./feedback-store";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import * as oauth from "oauth4webapi";
import { accountUserIdSchema, type AccountProfile, type LoginFailureCode } from "@biff/contracts/account";
import { canonical } from "@biff/contracts/canonical";
import { authCallback } from "./auth-callback";
import { configuration } from "./config";
import {
  kakaoConfigured,
  lookupKakao,
  lookupNaver,
  lookupSecrets,
  naverConfigured,
  type PlaceHit,
} from "./place-lookup";
import { randomToken, hash, seal } from "./crypto";
import {
  AUTH_FLOW_TIMEOUT_MS,
  provider,
  scopes,
  cookieOptions,
  pendingCookieName,
  sessionCookieName,
  sessionFor,
  resolveIdentity,
  type SessionLookup,
} from "./oauth";

type AppEnv = {
  Bindings: Env;
  Variables: {
    session: NonNullable<SessionLookup["session"]>;
    profile: AccountProfile;
  };
};
const app = new Hono<AppEnv>();

/* ---------------- 通用闸门（2026-09-23，PLAN-20260923111748，B2） ---------------- */

const pingLimiter = createRateLimiter(PING_RATE_LIMIT);
const lookupLimiter = createRateLimiter(LOOKUP_RATE_LIMIT);

/** 限流中间件。键 = 路径 + 来源 IP（`cf-connecting-ip` 由 Cloudflare 注入，客户端改不了）。
 *  ⚠ 只是**第一道闸门**：计数器在 isolate 内存里，跨 isolate / 冷启动会重置，
 *    不能替代 CF 的 Rate Limiting Rules —— 边界详见 `rate-limit.ts` 文件头。 */
function limited(limiter: ReturnType<typeof createRateLimiter>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const decision = limiter.check(`${c.req.path}\u0000${c.req.header("cf-connecting-ip") ?? "unknown"}`);
    if (!decision.allowed) {
      c.header("Retry-After", String(decision.retryAfterSeconds));
      return c.json({ error: "RATE_LIMITED" }, 429);
    }
    await next();
  };
}

/** `edition` 收口为白名单枚举（此前只校验长度，任意 ≤64 的串都会被当成一个届次）。 */
function editionParam(raw: string | undefined): string | null {
  const edition = raw && raw.length > 0 ? raw : DEFAULT_EDITION;
  return isEdition(edition) ? edition : null;
}

/**
 * 公开读端点用的**可选**会话：身份服务出问题时降级成匿名继续返回内容。
 *
 * `sessionFor` 在 access token 临期且上游抖动 / 并发刷新抢不到租约时会抛 `HTTPException(503)`，
 * 此前它会一路冒泡到 `onError` —— 于是 `/api/feedback`、`/api/discussions` 这类**纯公开**内容
 * 会因为「账号系统暂时连不上」而整页打不开（最坏还要等满 `REFRESH_WAIT_MS`）。
 * 公开内容不依赖会话，降级即可；只有 `requireIdentity` 那条路径才该让 503 冒泡。
 */
async function optionalSession(c: Context<AppEnv>) {
  const config = configuration(c.env);
  try {
    const { session } = await sessionFor(
      c.env,
      getCookie(c, sessionCookieName(config)),
      c.req.header("cf-connecting-ip"),
    );
    return session;
  } catch (error) {
    console.warn("public_read_session_degraded", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

const recordsSchema = z
  .record(
    z
      .string()
      .max(1024)
      .regex(/^(pick:|plan:|local:biff\.|raw:biff\.)/),
    z
      .string()
      .max(64 * 1024)
      .refine((value) => {
        try {
          JSON.parse(value);
          return true;
        } catch {
          return false;
        }
      }),
  )
  .refine((value) => Object.keys(value).length <= 10000);
const syncSchema = z
  .object({
    subject: accountUserIdSchema,
    revision: z.number().int().nonnegative(),
    operationId: z.uuid(),
    records: recordsSchema,
  })
  .strict();
const profileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    bio: z.string().trim().max(500),
    expectedVersion: z.number().int().nonnegative().optional(),
  })
  .strict();
app.use(
  "/api/*",
  (c, next) => bodyLimit({ maxSize: c.req.path === "/api/account/import" ? 1024 * 1024 : 512 * 1024, onError: (c) => c.json({ error: "PAYLOAD_TOO_LARGE" }, 413) })(c, next),
);
app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  const config = configuration(c.env);
  const origin = new URL(c.req.url).origin;
  if (!config.origins.includes(origin)) return c.json({ error: "INVALID_HOST" }, 403);
  if (!["GET", "HEAD"].includes(c.req.method) && c.req.header("origin") !== origin)
    return c.json({ error: "FORBIDDEN_ORIGIN" }, 403);
  await next();
});
app.get("/api/health", async (c) => {
  await database(c.env.DB).get(sql`SELECT 1`);
  return c.json({ status: "ok" });
});
app.get("/api/auth/login", async (c) => {
  // 登录流程的预算见 `oauth.ts::AUTH_FLOW_TIMEOUT_MS`(与刷新链路那 3 秒刻意分开:
  // 后者被租约不变量绑着,调大会让并发刷新互相踩)。
  const p = provider(c.env, c.req.header("cf-connecting-ip"), new URL(c.req.url).origin, {
    timeoutMs: AUTH_FLOW_TIMEOUT_MS,
  });
  // 「点了登录什么都没发生 / 只看到一张错误页」也必须有可读原因:旧实现让异常直接冒泡,
  // 用户拿到的是 500 页面,分不清是「账号系统连不上」还是「服务端写不了临时记录」
  // (见 PLAN-20260916215100)。
  let step: LoginFailureCode = "upstream_unreachable";
  try {
    const as = await p.metadata();
    if (!as.authorization_endpoint || !as.code_challenge_methods_supported?.includes("S256"))
      throw new Error("Provider must support PKCE S256");
    const url = new URL(as.authorization_endpoint);
    if (url.origin !== p.config.IFFDAY_ORIGIN) throw new Error("Unexpected authorization endpoint");
    const state = oauth.generateRandomState();
    const nonce = oauth.generateRandomNonce();
    const verifier = oauth.generateRandomCodeVerifier();
    const cookie = randomToken();
    const cookieHash = await hash(cookie);
    const payload = await seal(
      { state, nonce, verifier },
      p.config.SESSION_SECRET,
      `oauth:${cookieHash}`,
    );
    const db = database(c.env.DB);
    step = "pending_store_failed";
    await db.batch([
      db.delete(oauthPending).where(lt(oauthPending.expires_at, Date.now())),
      db.delete(appSession).where(lt(appSession.expires_at, Date.now())),
      db
        .insert(oauthPending)
        .values({ cookie_hash: cookieHash, payload, expires_at: Date.now() + 600_000 }),
    ]);
    setCookie(c, pendingCookieName(p.config), cookie, cookieOptions(p.config, 600));
    for (const [key, value] of Object.entries({
      client_id: p.client.client_id,
      response_type: "code",
      redirect_uri: p.redirectUri,
      scope: scopes,
      state,
      nonce,
      code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      resource: p.resource,
    }))
      url.searchParams.set(key, value);
    if (c.req.query("prompt") === "login") url.searchParams.set("prompt", "login");
    return c.redirect(url.toString());
  } catch (error) {
    console.warn("oidc_login_failed", step, error instanceof Error ? error.name : "UnknownError");
    return c.redirect(`/?account_error=${step}`);
  }
});
// 回调的失败步骤分诊在 `auth-callback.ts`(它按步骤给出可区分、用户可见的 `account_error`,
// 见 PLAN-20260916215100)。放在这里就只是闭包里的一团,没有办法单测。
app.get("/api/auth/callback", authCallback);
/** 与 /api/account/* 相同：会话 + IFFDAY profile；反馈写路径复用。 */
const requireIdentity: MiddlewareHandler<AppEnv> = async (c, next) => {
  const config = configuration(c.env);
  const cookie = getCookie(c, sessionCookieName(config));
  const { session, failure } = await sessionFor(c.env, cookie, c.req.header("cf-connecting-ip"));
  // 把**具体原因**回给前端:线上「cookie 还在、行没了」至少有三条完全不同的成因,
  // 只回一句 UNAUTHENTICATED 的话,用户和我们只能靠猜(见 PLAN-20260916104514)。
  if (!session) return c.json({ error: failure ?? "UNAUTHENTICATED" }, 401);
  // cookie 一并传下去:上游若拒了这份 token,`resolveIdentity` 会强制换一份再验一次。
  const outcome = await resolveIdentity(c.env, cookie, c.req.header("cf-connecting-ip"), session);
  if ("failure" in outcome)
    // 上游暂时不可用(503)与身份被拒(401)必须分开 —— 前者前端会按可重试处理并自动恢复。
    return c.json(
      { error: outcome.failure },
      outcome.failure === "IDENTITY_UNAVAILABLE" ? 503 : 401,
    );
  c.set("session", outcome.session);
  c.set("profile", outcome.profile);
  await next();
};
app.use("/api/account/*", requireIdentity);
app.get("/api/account/me", (c) => {
  const { row, tokens } = c.get("session");
  return c.json({
    user: { id: row.subject, email: tokens.email, emailVerified: tokens.emailVerified },
    profile: c.get("profile"),
    // 这个会话能不能自动续期 = 登录时上游有没有给 refresh token。没有它,access token 一过期
    // (15 分钟)会话就必然被判失效 —— 以前这件事只能靠等服务端删行后看 401,现在**登录后立刻**
    // 就能读出来(PLAN-20260916104514)。前端据此在账号面板给出说明。
    renewable: Boolean(tokens.refreshToken),
  });
});
app.patch("/api/account/profile", async (c) => {
  const body = profileSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "INVALID_PROFILE" }, 422);
  const config = configuration(c.env);
  const response = await c.env.IFFDAY_API.fetch(
    new Request(`${config.IFFDAY_ORIGIN}/api/v1/profile`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${c.get("session").tokens.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body.data),
    }),
  );
  return new Response(response.body, {
    status: response.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
});
app.on(["PUT", "DELETE"], "/api/account/avatar", async (c) => {
  if (c.req.method === "PUT" && c.req.header("content-type") !== "image/jpeg")
    return c.json({ error: "JPEG_REQUIRED" }, 415);
  const config = configuration(c.env);
  const response = await c.env.IFFDAY_API.fetch(
    new Request(`${config.IFFDAY_ORIGIN}/api/v1/profile/avatar`, {
      method: c.req.method,
      headers: {
        Authorization: `Bearer ${c.get("session").tokens.accessToken}`,
        "Content-Type": "image/jpeg",
      },
      body: c.req.method === "PUT" ? await c.req.arrayBuffer() : undefined,
    }),
  );
  return new Response(response.body, {
    status: response.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
});
app.post("/api/account/logout", async (c) => {
  const p = provider(c.env, c.req.header("cf-connecting-ip"), new URL(c.req.url).origin);
  const { row, tokens } = c.get("session");
  await database(c.env.DB).delete(appSession).where(eq(appSession.token_hash, row.token_hash)).run();
  deleteCookie(c, sessionCookieName(p.config), cookieOptions(p.config, 0));
  c.executionCtx.waitUntil(
    (async () => {
      const as = await p.metadata();
      if (tokens.refreshToken)
        await oauth.revocationRequest(as, p.client, p.auth, tokens.refreshToken, p.options);
    })().catch(() => console.warn("oidc_revocation_unavailable")),
  );
  return c.json({ success: true });
});
app.get("/api/account/sync/biff-2026", async (c) => {
  const subject = c.get("session").row.subject;
  const imported = await database(c.env.DB).select().from(accountImport).where(eq(accountImport.subject, subject)).get();
  const row = await database(c.env.DB).select().from(festivalDocument)
    .where(and(eq(festivalDocument.subject, subject), eq(festivalDocument.edition, "biff-2026"))).get();
  return c.json(
    row
      ? {
          subject,
          importedAt: imported?.imported_at ?? null,
          revision: row.revision,
          records: JSON.parse(row.records),
          updatedAt: row.updated_at,
        }
      : { subject, importedAt: imported?.imported_at ?? null, revision: 0, records: {}, updatedAt: 0 },
  );
});
// 原子地保存合并后的工作区并标记账号已导入 —— D1 的 batch 是事务性的。
app.post("/api/account/import", async (c) => {
  const parsed = syncSchema.extend({ sourceRecords: recordsSchema }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "INVALID_SYNC_DOCUMENT" }, 422);
  const { subject, revision, operationId, records, sourceRecords } = parsed.data;
  if (subject !== c.get("session").row.subject) return c.json({ error: "ACCOUNT_CHANGED" }, 409);
  if (!hasImportableData(sourceRecords)) return c.json({ error: "EMPTY_IMPORT" }, 422);
  const serialized = canonical(records);
  if (new TextEncoder().encode(serialized).byteLength > 450 * 1024)
    return c.json({ error: "SYNC_TOO_LARGE" }, 413);
  const db = database(c.env.DB);
  const identity = and(eq(festivalDocument.subject, subject), eq(festivalDocument.edition, "biff-2026"));
  const unclaimed = notExists(db.select().from(accountImport).where(eq(accountImport.subject, subject)));
  const now = Date.now();
  const commitId = randomToken();
  await db.batch([
    db.insert(festivalDocument).values({ subject, edition: "biff-2026", updated_at: now }).onConflictDoNothing(),
    db.update(festivalDocument).set({
      revision: sql`${festivalDocument.revision} + 1`, records: serialized,
      last_operation: commitId, updated_at: now,
    }).where(and(identity, eq(festivalDocument.revision, revision), unclaimed)),
    db.insert(accountImport).select(db.select({
      subject: festivalDocument.subject,
      operation_id: sql<string>`${operationId}`.as("operation_id"),
      imported_at: sql<number>`${now}`.as("imported_at"),
    }).from(festivalDocument).where(and(identity,
      eq(festivalDocument.last_operation, commitId), eq(festivalDocument.revision, revision + 1), unclaimed,
    ))).onConflictDoNothing(),
  ]);
  const imported = await db.select().from(accountImport).where(eq(accountImport.subject, subject)).get();
  if (!imported) return c.json({ error: "REVISION_CONFLICT" }, 409);
  const row = await db.select().from(festivalDocument).where(identity).get();
  const importedRecords = row ? JSON.parse(row.records) as Record<string, string> : {};
  c.executionCtx.waitUntil(
    applyWantFromRecords(c.env, "biff-2026", subject, importedRecords).catch((error) =>
      console.warn("want_stat_import_failed", error instanceof Error ? error.name : "UnknownError"),
    ),
  );
  return c.json({
    imported: imported.operation_id === operationId,
    subject, importedAt: imported.imported_at,
    revision: row?.revision ?? 0, records: importedRecords, updatedAt: row?.updated_at ?? 0,
  });
});
app.put("/api/account/sync/biff-2026", async (c) => {
  const parsed = syncSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "INVALID_SYNC_DOCUMENT" }, 422);
  const { subject, revision, operationId, records } = parsed.data;
  if (subject !== c.get("session").row.subject) return c.json({ error: "ACCOUNT_CHANGED" }, 409);
  const db = database(c.env.DB);
  const identity = and(eq(festivalDocument.subject, subject), eq(festivalDocument.edition, "biff-2026"));
  const previous = await db.select().from(festivalDocument).where(identity).get();
  if (previous?.last_operation === operationId) {
    if (previous.records !== canonical(records))
      return c.json({ error: "OPERATION_ID_REUSED" }, 409);
    return c.json({ revision: previous.revision });
  }
  const serialized = canonical(records);
  if (new TextEncoder().encode(serialized).byteLength > 450 * 1024)
    return c.json({ error: "SYNC_TOO_LARGE" }, 413);
  const now = Date.now();
  const [result] = revision === 0
    ? await db.insert(festivalDocument).values({
        subject, edition: "biff-2026", revision: 1,
        records: serialized, last_operation: operationId, updated_at: now,
      }).onConflictDoNothing().returning({ revision: festivalDocument.revision })
    : await db.update(festivalDocument).set({
        revision: sql`${festivalDocument.revision} + 1`,
        records: serialized, last_operation: operationId, updated_at: now,
      }).where(and(identity, eq(festivalDocument.revision, revision)))
        .returning({ revision: festivalDocument.revision });
  if (!result) return c.json({ error: "REVISION_CONFLICT" }, 409);
  c.executionCtx.waitUntil(
    applyWantFromRecords(c.env, "biff-2026", subject, records).catch((error) =>
      console.warn("want_stat_sync_failed", error instanceof Error ? error.name : "UnknownError"),
    ),
  );
  return c.json({ revision: result.revision });
});

const wantPingSchema = z
  .object({
    edition: z.enum(EDITIONS).optional().default(DEFAULT_EDITION),
    films: z.array(z.string().min(1).max(128)).max(500),
  })
  .strict();
const wantAnonCookie = (config: ReturnType<typeof configuration>) =>
  config.APP_ENV === "production" ? "__Host-biff.want" : "biff.want";

async function applyWantFromRecords(
  env: Env,
  edition: string,
  subject: string,
  records: Record<string, string>,
) {
  const db = database(env.DB);
  await replaceContributorWants(
    db,
    edition,
    subject,
    wantWeightFor(true),
    pickFilmKeysFromRecords(records),
  );
}



app.get("/api/feedback", async (c) => {
  // 公开内容：会话拿不到（或刷新失败）就按匿名返回，不因为账号系统抖动而整页打不开
  const session = await optionalSession(c);
  const result = await listFeedbackPosts(database(c.env.DB), {
    limit: parseFeedbackLimit(c.req.query("limit")),
    cursor: parseFeedbackCursor(c.req.query("cursor")),
    mySubject: session?.row.subject ?? null,
  });
  return c.json(result);
});
app.post("/api/feedback", requireIdentity, async (c) => {
  if (writeAuthError(c.get("session"))) return c.json({ error: "UNAUTHENTICATED" }, 401);
  const payload = await c.req.json().catch(() => null);
  const body = normalizeFeedbackBody(payload && typeof payload === "object" ? (payload as { body?: unknown }).body : null);
  if (!body) return c.json({ error: "INVALID_BODY" }, 422);
  const profile = c.get("profile");
  const post = await createFeedbackPost(database(c.env.DB), {
    subject: c.get("session").row.subject,
    displayName: profile.displayName,
    body,
  });
  return c.json(post, 201);
});
app.delete("/api/feedback/:id", requireIdentity, async (c) => {
  const id = c.req.param("id");
  const subject = c.get("session").row.subject;
  const result = await deleteFeedbackPost(database(c.env.DB), id, subject);
  if (result.status === "missing") return c.json({ error: "NOT_FOUND" }, 404);
  if (result.status === "forbidden") return c.json({ error: "FORBIDDEN" }, 403);
  return c.json({ ok: true });
});
app.post("/api/feedback/:id/reactions", requireIdentity, async (c) => {
  const payload = await c.req.json().catch(() => null);
  const emoji = payload && typeof payload === "object" ? (payload as { emoji?: unknown }).emoji : null;
  if (typeof emoji !== "string" || !isReactionEmoji(emoji))
    return c.json({ error: "INVALID_EMOJI" }, 422);
  const result = await toggleFeedbackReaction(database(c.env.DB), {
    postId: c.req.param("id"),
    subject: c.get("session").row.subject,
    emoji,
  });
  if (result.status === "missing") return c.json({ error: "NOT_FOUND" }, 404);
  return c.json({
    active: result.active,
    reactionCounts: result.reactionCounts,
    myReactions: result.myReactions,
  });
});

app.get("/api/stats/want-counts", async (c) => {
  const edition = editionParam(c.req.query("edition"));
  if (!edition) return c.json({ error: "INVALID_EDITION" }, 422);
  const counts = await readWantCounts(database(c.env.DB), edition);
  return c.json({ edition, counts });
});
app.post("/api/stats/want-ping", limited(pingLimiter), async (c) => {
  const parsed = wantPingSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "INVALID_WANT_PING" }, 422);
  const { edition, films } = parsed.data;
  const config = configuration(c.env);
  const db = database(c.env.DB);
  const { session } = await sessionFor(
    c.env,
    getCookie(c, sessionCookieName(config)),
    c.req.header("cf-connecting-ip"),
  );
  let contributor: string;
  let weight: number;
  if (session) {
    contributor = session.row.subject;
    weight = wantWeightFor(true);
    const anon = getCookie(c, wantAnonCookie(config));
    if (anon) {
      // 两张贡献表都要清(见 clearAnonContributions):只清 want 的话,
      // 同一人会以「匿名 0.75 + 登录 1.0」被同场观影人数算两次。
      await clearAnonContributions(db, edition, `anon:${await hash(anon)}`);
      deleteCookie(c, wantAnonCookie(config), cookieOptions(config, 0));
    }
  } else {
    weight = wantWeightFor(false);
    let anon = getCookie(c, wantAnonCookie(config));
    if (!anon) {
      anon = randomToken();
      setCookie(c, wantAnonCookie(config), anon, cookieOptions(config, 180 * 86400));
    }
    contributor = `anon:${await hash(anon)}`;
  }
  await replaceContributorWants(db, edition, contributor, weight, films);
  return c.json({ ok: true, weight, count: films.length });
});

/* ---------------- 红黑榜投票(2026-09-16,PLAN-20260916102339) ----------------
 * 口径与「想看人数」**刻意不同**:这里是**一人一部一票(红 / 黑)**,不做 0.75 / 1.0 加权 ——
 * 贴纸是离散的实体隐喻,3 个人贴了红就该显示 3(见 `film-vote-stats.ts` 的说明)。
 * 读公开(榜单本来就是给大家看的),写匿名也可用(身份口径与 want-ping 完全一致)。 */

const filmVotePingSchema = z
  .object({
    edition: z.enum(EDITIONS).optional().default(DEFAULT_EDITION),
    votes: z
      .array(z.object({ key: z.string().min(1).max(128), vote: z.enum(["red", "black"]) }).strict())
      .max(MAX_VOTES_PER_PING),
  })
  .strict();

app.get("/api/stats/film-votes", async (c) => {
  const edition = editionParam(c.req.query("edition"));
  if (!edition) return c.json({ error: "INVALID_EDITION" }, 422);
  const votes = await readVoteCounts(database(c.env.DB), edition);
  return c.json({ edition, votes });
});

app.post("/api/stats/film-votes-ping", limited(pingLimiter), async (c) => {
  const parsed = filmVotePingSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "INVALID_FILM_VOTE_PING" }, 422);
  const { edition, votes } = parsed.data;
  const config = configuration(c.env);
  const db = database(c.env.DB);
  const { session } = await sessionFor(
    c.env,
    getCookie(c, sessionCookieName(config)),
    c.req.header("cf-connecting-ip"),
  );
  let contributor: string;
  if (session) {
    contributor = session.row.subject;
    const anon = getCookie(c, wantAnonCookie(config));
    if (anon) {
      // 与 want / screening 同一条:不清匿名行的话,同一人会以「匿名 + 登录」被算成两票
      // (注释详见 screening-stats-store.ts::clearAnonContributions)
      await clearAnonContributions(db, edition, `anon:${await hash(anon)}`);
      deleteCookie(c, wantAnonCookie(config), cookieOptions(config, 0));
    }
  } else {
    let anon = getCookie(c, wantAnonCookie(config));
    if (!anon) {
      anon = randomToken();
      setCookie(c, wantAnonCookie(config), anon, cookieOptions(config, 180 * 86400));
    }
    contributor = `anon:${await hash(anon)}`;
  }
  // 归一化兜一层:zod 挡结构,这里挡「同一部片发了两条」这类语义重复(以最后一条为准)
  const normalized = normalizeVotes(votes);
  await replaceContributorVotes(db, edition, contributor, normalized);
  return c.json({ ok: true, count: normalized.size });
});

/* ---------------- 红黑榜投票行自查(2026-09-23,PLAN-20260923124402) ----------------
 * 由来:线上贴纸只能看到聚合数,**查不出「这枚是不是我贴的」** —— 而登录态丢失后同一人会以
 * 「subject + 匿名」两个身份各占一行(且匿名行在 cookie 丢失后永远撤不掉,见 PLAN)。
 * 本接口给「当事人自查」开一条只读路径,挂 `/api/account/*` 下 = 继承 `requireIdentity`
 * (未登录 401),不新造鉴权。
 * ⚠ **不回 contributor 原文**:公开统计「只回聚合、不回名单」这条口径不因为自查而放宽,
 *   见 `film-vote-store.ts::VoteAuditRow`。它回答的是「哪些行是我的 / 是不是本机贴的」。 */
app.get("/api/account/film-vote-contributions", async (c) => {
  const edition = editionParam(c.req.query("edition"));
  if (!edition) return c.json({ error: "INVALID_EDITION" }, 422);
  const config = configuration(c.env);
  const cookie = getCookie(c, wantAnonCookie(config));
  const rows = await readVoteRows(database(c.env.DB), edition);
  return c.json({
    edition,
    // ⚠ 截断必须**显式说明**:这是给人下结论用的接口,静默少给几行会让人把「没看到」读成「不存在」
    truncated: rows.length >= MAX_VOTE_ROWS,
    ...auditVoteRows(rows, {
      subject: c.get("session").row.subject,
      // ⚠ 只用**本次请求带来的**匿名 cookie 算 hash —— 让接口收任意 hash 去试探别人的行,
      //   才是真正把「谁投了什么」变成可枚举的东西
      anonContributor: cookie ? `${ANON_PREFIX}${await hash(cookie)}` : null,
    }),
  });
});

/* ---------------- 管理端(2026-09-23,PLAN-20260923140943) ----------------
 * 由来:上面那条自查接口**刻意不回 `contributor`**,于是「这两枚匿名死贴纸到底是谁的」查不出来;
 * 而本服务原本**没有任何管理员概念**(`accountProfileSchema` 里没有角色字段,见 PLAN)。
 * 这里补上两层门禁 + 读 / 删 / 认领迁移。
 *
 * ⚠ 门禁是**两层**,少一层就等于把全站「谁投了什么」的名单挂到公网上:
 *   ① `requireIdentity`(未登录 401)② subject ∈ `admin.ts::ADMIN_SUBJECTS`(否则 403)。
 * ⚠ 白名单校验的是**已登录会话的身份**,不是凭据 —— 见 `admin.ts` 的说明。 */
app.use("/api/admin/*", requireIdentity);
app.use("/api/admin/*", async (c, next) => {
  if (!isAdminSubject(c.get("session").row.subject)) return c.json({ error: "FORBIDDEN" }, 403);
  await next();
});

/** 管理端读:列出该 edition 的**全部**投票行,含 `contributor` 原文。 */
app.get("/api/admin/film-vote-contributions", async (c) => {
  const edition = editionParam(c.req.query("edition"));
  if (!edition) return c.json({ error: "INVALID_EDITION" }, 422);
  const rows = await readVoteRows(database(c.env.DB), edition);
  return c.json({
    edition,
    // 与自查接口同一条:静默截断会让人把「没看到」读成「不存在」
    truncated: rows.length >= MAX_VOTE_ROWS,
    rows: exposeVoteRows(rows),
  });
});

/** 管理端删除:`?contributor=…&filmKey=…` 精确删掉一行(匿名死贴纸的出口)。
 *  命中 200、未命中 404 —— 不静默成功,否则「我删了」可能只是参数写错。 */
const adminVoteRowQuerySchema = z
  .object({
    edition: z.enum(EDITIONS).optional().default(DEFAULT_EDITION),
    contributor: z.string().min(1).max(200),
    filmKey: z.string().min(1).max(MAX_FILM_KEY_LENGTH),
  })
  .strict();

app.delete("/api/admin/film-vote-contributions", async (c) => {
  const parsed = adminVoteRowQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "INVALID_ADMIN_QUERY" }, 422);
  const { edition, contributor, filmKey } = parsed.data;
  const removed = await removeContributorVote(database(c.env.DB), edition, contributor, filmKey);
  if (!removed) return c.json({ error: "NOT_FOUND" }, 404);
  return c.json({ ok: true, edition, contributor, filmKey, removed: 1 });
});

/** 管理端认领迁移:把某个匿名身份的票整份并到指定账号名下。
 *  ⚠ `from` 限 `anon:` 前缀:本轮只做「匿名 → 账号」;账号间合并是新语义,不在范围里(见 PLAN)。
 *    `to` 用共享契约的 `accountUserIdSchema` 校验,免得把票并到一个拼错的 subject 上。 */
const claimVotesSchema = z
  .object({
    edition: z.enum(EDITIONS).optional().default(DEFAULT_EDITION),
    from: z.string().min(1).max(200).startsWith(ANON_PREFIX),
    to: accountUserIdSchema,
    dryRun: z.boolean().optional().default(false),
  })
  .strict();

app.post("/api/admin/film-vote-contributions/claim", async (c) => {
  const parsed = claimVotesSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "INVALID_CLAIM" }, 422);
  const { edition, from, to, dryRun } = parsed.data;
  return c.json(await claimContributorVotes(database(c.env.DB), edition, from, to, { dryRun }));
});

/* ---------------- 同场观影人数(2026-09-14,PLAN-20260914164050) ----------------
 * 口径:该场次出现在多少人的行程里,**不看票务状态**;权重与「想看人数」同源
 * (登录 1.0 / 匿名 0.75,见 want-stats.ts)。只回聚合数字,不回名单 —— 呼应「保护个人隐私」。 */

app.get("/api/stats/screening-counts", async (c) => {
  const edition = editionParam(c.req.query("edition"));
  if (!edition) return c.json({ error: "INVALID_EDITION" }, 422);
  const db = database(c.env.DB);
  const [attendance, discussions] = await Promise.all([
    readScreeningCounts(db, edition),
    readDiscussionCounts(db, edition),
  ]);
  return c.json({ edition, attendance, discussions });
});

const screeningPingSchema = z
  .object({
    edition: z.enum(EDITIONS).optional().default(DEFAULT_EDITION),
    codes: z.array(z.string().min(1).max(64)).max(MAX_SCREENING_CODES_PER_PING),
  })
  .strict();

app.post("/api/stats/screening-attendance-ping", limited(pingLimiter), async (c) => {
  const parsed = screeningPingSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "INVALID_SCREENING_PING" }, 422);
  const { edition, codes } = parsed.data;
  const config = configuration(c.env);
  const db = database(c.env.DB);
  const { session } = await sessionFor(
    c.env,
    getCookie(c, sessionCookieName(config)),
    c.req.header("cf-connecting-ip"),
  );
  let contributor: string;
  let weight: number;
  if (session) {
    contributor = session.row.subject;
    weight = wantWeightFor(true);
    const anon = getCookie(c, wantAnonCookie(config));
    if (anon) {
      await clearAnonContributions(db, edition, `anon:${await hash(anon)}`);
      deleteCookie(c, wantAnonCookie(config), cookieOptions(config, 0));
    }
  } else {
    weight = wantWeightFor(false);
    let anon = getCookie(c, wantAnonCookie(config));
    if (!anon) {
      anon = randomToken();
      setCookie(c, wantAnonCookie(config), anon, cookieOptions(config, 180 * 86400));
    }
    contributor = `anon:${await hash(anon)}`;
  }
  await replaceContributorScreenings(db, edition, contributor, weight, codes);
  return c.json({ ok: true, weight, count: codes.length });
});

/* ---------------- 抢票结果(2026-09-20,PLAN-20260920161837) ----------------
 * 「数据分析」页的结果面:把用户自述的三态(已抢到 / 没抢到 / 放弃)与「转票补入」聚合起来,
 * 让「这场整体多难抢」有一个实测答案(需求人数只回答「多少人想抢」)。
 *
 * 口径与 want / screening **完全一致**:权重 登录 1.0 / 匿名 0.75,身份走同一枚匿名 cookie,
 * 登录时调同一个 `clearAnonContributions` 去重;读公开(聚合数字本来就是给大家看的)、
 * 只回计数不回名单 —— 隐私边界与 want-ping 同一条。
 *
 * ⚠ 请求体只有 `{edition, entries:[{code, state, via?}]}`,**绝不含备注 / 片单 / 身份**。 */

const ticketPingSchema = z
  .object({
    edition: z.enum(EDITIONS).optional().default(DEFAULT_EDITION),
    entries: z
      .array(
        z
          .object({
            code: z.string().min(1).max(SCREENING_CODE_MAX_LENGTH),
            state: z.enum(TICKET_STATES),
            via: z.enum(["self", "transfer"]).optional(),
          })
          .strict(),
      )
      .max(MAX_TICKET_ENTRIES_PER_PING),
  })
  .strict();

app.get("/api/stats/ticket-counts", async (c) => {
  const edition = editionParam(c.req.query("edition"));
  if (!edition) return c.json({ error: "INVALID_EDITION" }, 422);
  const tickets = await readTicketCounts(database(c.env.DB), edition);
  return c.json({ edition, tickets });
});

app.post("/api/stats/ticket-results-ping", limited(pingLimiter), async (c) => {
  const parsed = ticketPingSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "INVALID_TICKET_PING" }, 422);
  const { edition, entries } = parsed.data;
  const config = configuration(c.env);
  const db = database(c.env.DB);
  const { session } = await sessionFor(
    c.env,
    getCookie(c, sessionCookieName(config)),
    c.req.header("cf-connecting-ip"),
  );
  let contributor: string;
  let weight: number;
  if (session) {
    contributor = session.row.subject;
    weight = wantWeightFor(true);
    const anon = getCookie(c, wantAnonCookie(config));
    if (anon) {
      // 与 want / screening / film-votes 同一条:不清匿名行的话,同一人会以「匿名 + 登录」被算两次
      // (注释详见 screening-stats-store.ts::clearAnonContributions)
      await clearAnonContributions(db, edition, `anon:${await hash(anon)}`);
      deleteCookie(c, wantAnonCookie(config), cookieOptions(config, 0));
    }
  } else {
    weight = wantWeightFor(false);
    let anon = getCookie(c, wantAnonCookie(config));
    if (!anon) {
      anon = randomToken();
      setCookie(c, wantAnonCookie(config), anon, cookieOptions(config, 180 * 86400));
    }
    contributor = `anon:${await hash(anon)}`;
  }
  // 归一化兜一层:zod 挡结构,这里挡「同一场发了两条」这类语义重复(以最后一条为准),
  // 并把 got+transfer 摘成独立的 transfer(见 ticket-stats.ts)
  const normalized = normalizeTicketEntries(entries);
  await replaceContributorTickets(db, edition, contributor, weight, normalized);
  return c.json({ ok: true, weight, count: normalized.size });
});

/* ---------------- 事件流水(2026-09-20,PLAN-20260920203010 修订 2) ----------------
 * 「哪些页面 / 哪些入口真的被用了」。第 3 轮的一个分析分组吃它。
 *
 * ★ 与其它 ping 的三处不同，都要知情：
 *   ① **增量语义**：请求体是 `hits`（这一批看到了几次），服务端累加。状态式的
 *      「重发覆盖」在这里是错的 —— 次数无法从任何状态里恢复。
 *   ② **只有 page / click 两类**，**没有 search**：用户明确「搜索完全不进统计」。
 *      `target` 必须匹配 `^[a-z0-9\-/:]+$`（见 telemetry-stats.ts）——
 *      这道形状校验就是「搜索词 / 人名这类自由文本灌不进来」的实现。
 *   ③ 用户明确**默认直接上报、不加提示、不加不追踪开关**，所以这里没有 consent 字段；
 *      也正因如此，上面那条服务端形状收口不能省。
 *
 * 身份与权重与其它 ping **完全一致**（匿名 0.75 / 登录 1.0，登录时清匿名行）。 */

const telemetryPingSchema = z
  .object({
    edition: z.enum(EDITIONS).optional().default(DEFAULT_EDITION),
    events: z
      .array(
        z
          .object({
            kind: z.enum(TELEMETRY_KINDS),
            target: z.string().min(1).max(TELEMETRY_TARGET_MAX_LENGTH),
            hits: z.number().int().positive().max(MAX_HITS_PER_TARGET),
          })
          .strict(),
      )
      .max(MAX_TELEMETRY_ENTRIES_PER_PING),
  })
  .strict();

app.get("/api/stats/telemetry-counts", async (c) => {
  const edition = editionParam(c.req.query("edition"));
  if (!edition) return c.json({ error: "INVALID_EDITION" }, 422);
  const counts = await readTelemetryCounts(database(c.env.DB), edition);
  return c.json({ edition, counts });
});

app.post("/api/stats/telemetry-ping", limited(pingLimiter), async (c) => {
  const parsed = telemetryPingSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "INVALID_TELEMETRY_PING" }, 422);
  const { edition, events } = parsed.data;
  const config = configuration(c.env);
  const db = database(c.env.DB);
  const { session } = await sessionFor(
    c.env,
    getCookie(c, sessionCookieName(config)),
    c.req.header("cf-connecting-ip"),
  );
  let contributor: string;
  let weight: number;
  if (session) {
    contributor = session.row.subject;
    weight = wantWeightFor(true);
    const anon = getCookie(c, wantAnonCookie(config));
    if (anon) {
      await clearAnonContributions(db, edition, `anon:${await hash(anon)}`);
      deleteCookie(c, wantAnonCookie(config), cookieOptions(config, 0));
    }
  } else {
    weight = wantWeightFor(false);
    let anon = getCookie(c, wantAnonCookie(config));
    if (!anon) {
      anon = randomToken();
      setCookie(c, wantAnonCookie(config), anon, cookieOptions(config, 180 * 86400));
    }
    contributor = `anon:${await hash(anon)}`;
  }
  const deltas = normalizeTelemetryEntries(events);
  await applyContributorTelemetry(db, edition, contributor, weight, deltas);
  return c.json({ ok: true, weight, count: deltas.size });
});

/* ---------------- 场次讨论(2026-09-14,PLAN-20260914164050) ----------------
 * 公开读 + 登录写 + 作者可删 + emoji 反应 toggle;与 /api/feedback 同一套形状,
 * 但按「场次 code + edition」收窄。分类白名单在 `@biff/contracts/screening`。 */

/* 讨论区聚合读(2026-09-15,PLAN-20260915233816):全站帖子墙 —— 与单场讨论同一套分页 / 反应口径,
 * 差别只在「不按场次 code 收窄」。公开读,登录时额外回自己的 myReactions。 */
app.get("/api/discussions", async (c) => {
  const edition = editionParam(c.req.query("edition"));
  if (!edition) return c.json({ error: "INVALID_EDITION" }, 422);
  const session = await optionalSession(c);
  const result = await listDiscussionPosts(database(c.env.DB), {
    edition,
    limit: parseDiscussionLimit(c.req.query("limit")),
    cursor: parseDiscussionCursor(c.req.query("cursor")),
    mySubject: session?.row.subject ?? null,
  });
  return c.json(result);
});

app.get("/api/screenings/:code/discussion", async (c) => {
  const code = c.req.param("code");
  if (!code || code.length > 64) return c.json({ error: "INVALID_SCREENING" }, 422);
  const edition = editionParam(c.req.query("edition"));
  if (!edition) return c.json({ error: "INVALID_EDITION" }, 422);
  const session = await optionalSession(c);
  const result = await listScreeningPosts(database(c.env.DB), {
    edition,
    code,
    limit: parseDiscussionLimit(c.req.query("limit")),
    cursor: parseDiscussionCursor(c.req.query("cursor")),
    mySubject: session?.row.subject ?? null,
  });
  return c.json(result);
});

app.post("/api/screenings/:code/discussion", requireIdentity, async (c) => {
  if (writeAuthError(c.get("session"))) return c.json({ error: "UNAUTHENTICATED" }, 401);
  const code = c.req.param("code");
  if (!code || code.length > 64) return c.json({ error: "INVALID_SCREENING" }, 422);
  const payload = await c.req.json().catch(() => null);
  const post = normalizeDiscussionPost(payload);
  if (!post) return c.json({ error: "INVALID_POST" }, 422);
  const rawEdition = payload && typeof payload === "object" ? (payload as { edition?: unknown }).edition : null;
  const edition = isEdition(rawEdition) ? rawEdition : DEFAULT_EDITION;
  const created = await createScreeningPost(database(c.env.DB), {
    edition,
    code,
    subject: c.get("session").row.subject,
    displayName: c.get("profile").displayName,
    category: post.category,
    body: post.body,
  });
  return c.json(created, 201);
});

app.delete("/api/screenings/:code/discussion/:id", requireIdentity, async (c) => {
  const code = c.req.param("code");
  if (!code || code.length > 64) return c.json({ error: "INVALID_SCREENING" }, 422);
  const result = await deleteScreeningPost(database(c.env.DB), {
    id: c.req.param("id"),
    code,
    subject: c.get("session").row.subject,
  });
  if (result.status === "missing") return c.json({ error: "NOT_FOUND" }, 404);
  if (result.status === "forbidden") return c.json({ error: "FORBIDDEN" }, 403);
  return c.json({ ok: true });
});

app.post("/api/screenings/:code/discussion/:id/reactions", requireIdentity, async (c) => {
  const payload = await c.req.json().catch(() => null);
  const emoji = payload && typeof payload === "object" ? (payload as { emoji?: unknown }).emoji : null;
  if (typeof emoji !== "string" || !isReactionEmoji(emoji))
    return c.json({ error: "INVALID_EMOJI" }, 422);
  const result = await toggleScreeningReaction(database(c.env.DB), {
    postId: c.req.param("id"),
    subject: c.get("session").row.subject,
    emoji,
  });
  if (result.status === "missing") return c.json({ error: "NOT_FOUND" }, 404);
  return c.json({
    active: result.active,
    reactionCounts: result.reactionCounts,
    myReactions: result.myReactions,
  });
});

/* ---------------- 吃喝:地图数据源代理(2026-09-16,PLAN-20260916232230 修订 1) ----------------
 * 公开读、只读不写。密钥走 `wrangler secret put`(**刻意不进 wrangler.jsonc** —— 仓库不留密钥);
 * 一个都没配就返回 503,前端自动退回「三个搜索链接」,功能不缺失(见 `eats.ts::lookupPlaces`)。
 *
 * ⚠ 缓存只在本 isolate 的内存里:本项目此前没有任何 `caches.default` / KV 用法,
 *   为这一个端点新增绑定不划算。冷 isolate 只是多打一次上游 —— 额度是 25,000 / 100,000 每天。
 *   客户端另有一层会话内缓存(`eats.ts`),响应也带 `private, max-age`,重开页面基本不再打上游。 */
const LOOKUP_CACHE = new Map<string, { at: number; hit: PlaceHit | null }>();
const LOOKUP_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOOKUP_CACHE_MAX = 500;

async function cachedLookup(key: string, run: () => Promise<PlaceHit | null>): Promise<PlaceHit | null> {
  const now = Date.now();
  const cached = LOOKUP_CACHE.get(key);
  if (cached && now - cached.at < LOOKUP_CACHE_TTL_MS) return cached.hit;
  const hit = await run();
  // 满了就整体清空:条目少、清空成本低,比实现 LRU 划算
  if (LOOKUP_CACHE.size >= LOOKUP_CACHE_MAX) LOOKUP_CACHE.clear();
  LOOKUP_CACHE.set(key, { at: now, hit });
  return hit;
}

app.get("/api/eats/lookup", limited(lookupLimiter), async (c) => {
  const name = (c.req.query("name") ?? "").trim();
  const address = (c.req.query("address") ?? "").trim();
  if (!name || name.length > 80 || address.length > 160)
    return c.json({ error: "INVALID_QUERY" }, 422);
  const secrets = lookupSecrets(c.env);
  if (!naverConfigured(secrets) && !kakaoConfigured(secrets)) {
    // 前端据此**静默降级**:卡片保持搜索链接,不显示任何「定位失败」噪声
    return c.json({ error: "LOOKUP_DISABLED" }, 503);
  }
  const wanted = c.req.query("provider");
  // Naver 优先(韩国店收录最全);显式点名 kakao 时反过来
  const order: PlaceHit["provider"][] = wanted === "kakao" ? ["kakao", "naver"] : ["naver", "kakao"];
  const cacheKey = `${name}\u0000${address}`;
  for (const provider of order) {
    const configured = provider === "naver" ? naverConfigured(secrets) : kakaoConfigured(secrets);
    if (!configured) continue;
    const hit = await cachedLookup(`${provider}:${cacheKey}`, () =>
      provider === "naver" ? lookupNaver(secrets, name, address) : lookupKakao(secrets, name, address),
    );
    if (hit) {
      c.header("Cache-Control", "private, max-age=86400");
      return c.json({ hit });
    }
  }
  // 查不到也缓存(空结果),免得反复为一个搜不到的店打上游
  c.header("Cache-Control", "private, max-age=86400");
  return c.json({ hit: null });
});

app.all("/api/*", (c) => c.json({ error: "NOT_FOUND" }, 404));
app.notFound((c) => c.json({ error: "NOT_FOUND" }, 404));
app.onError((error, c) => {
  if (error instanceof HTTPException)
    return c.json(
      { error: error.status === 503 ? "SERVICE_UNAVAILABLE" : "REQUEST_FAILED" },
      error.status,
    );
  console.error("account_request_failed", error.name);
  return c.json({ error: "INTERNAL_ERROR" }, 500);
});
export default app;
