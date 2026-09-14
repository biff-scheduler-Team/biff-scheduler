import { hasImportableData } from "@biff/contracts/import";
import { isReactionEmoji } from "@biff/contracts/reactions";
import { and, eq, gt, lt, notExists, sql } from "drizzle-orm";
import { database } from "./db";
import { accountImport, appSession, festivalDocument, oauthPending } from "./db/schema";
import {
  DEFAULT_WANT_EDITION,
  pickFilmKeysFromRecords,
  wantWeightFor,
} from "./want-stats";
import { readWantCounts, replaceContributorWants } from "./want-store";
import {
  normalizeFeedbackBody,
  writeAuthError,
} from "./feedback";
import { MAX_SCREENING_CODES_PER_PING } from "./screening-stats";
import {
  clearAnonContributions,
  readScreeningCounts,
  replaceContributorScreenings,
} from "./screening-stats-store";
import { normalizeDiscussionPost } from "./screening-discussion";
import {
  createScreeningPost,
  deleteScreeningPost,
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
import { Hono, type MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import * as oauth from "oauth4webapi";
import { accountProfileSchema, type AccountProfile } from "@biff/contracts/account";
import { canonical } from "@biff/contracts/canonical";
import { configuration } from "./config";
import { randomToken, hash, seal, unseal } from "./crypto";
import {
  provider,
  scopes,
  cookieOptions,
  pendingCookieName,
  sessionCookieName,
  sessionFor,
  sessionMaxAge,
  SESSION_TTL_MS,
  type SessionTokens,
} from "./oauth";

type AppEnv = {
  Bindings: Env;
  Variables: {
    session: NonNullable<Awaited<ReturnType<typeof sessionFor>>>;
    profile: AccountProfile;
  };
};
const app = new Hono<AppEnv>();
const pendingSchema = z.object({ state: z.string(), nonce: z.string(), verifier: z.string() });
const subjectSchema = z.string().regex(/^user_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
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
    subject: subjectSchema,
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
  const p = provider(c.env, c.req.header("cf-connecting-ip"), new URL(c.req.url).origin);
  const as = await p.metadata();
  if (!as.authorization_endpoint || !as.code_challenge_methods_supported?.includes("S256"))
    throw new Error("Provider must support PKCE S256");
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
  await db.batch([
    db.delete(oauthPending).where(lt(oauthPending.expires_at, Date.now())),
    db.delete(appSession).where(lt(appSession.expires_at, Date.now())),
    db.insert(oauthPending).values({ cookie_hash: cookieHash, payload, expires_at: Date.now() + 600_000 }),
  ]);
  setCookie(c, pendingCookieName(p.config), cookie, cookieOptions(p.config, 600));
  const url = new URL(as.authorization_endpoint);
  if (url.origin !== p.config.IFFDAY_ORIGIN) throw new Error("Unexpected authorization endpoint");
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
});
app.get("/api/auth/callback", async (c) => {
  const p = provider(c.env, c.req.header("cf-connecting-ip"), new URL(c.req.url).origin);
  const cookie = getCookie(c, pendingCookieName(p.config));
  deleteCookie(c, pendingCookieName(p.config), cookieOptions(p.config, 0));
  if (!cookie) {
    console.warn("oidc_pending_cookie_missing");
    return c.redirect("/?account_error=expired");
  }
  const cookieHash = await hash(cookie);
  const [pending] = await database(c.env.DB).delete(oauthPending)
    .where(and(eq(oauthPending.cookie_hash, cookieHash), gt(oauthPending.expires_at, Date.now())))
    .returning({ payload: oauthPending.payload });
  if (!pending) {
    console.warn("oidc_pending_record_missing");
    return c.redirect("/?account_error=expired");
  }
  try {
    const transaction = pendingSchema.parse(
      await unseal(pending.payload, p.config.SESSION_SECRET, `oauth:${cookieHash}`),
    );
    const as = await p.metadata();
    const parameters = oauth.validateAuthResponse(
      as,
      p.client,
      new URL(c.req.url),
      transaction.state,
    );
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
    await oauth.validateApplicationLevelSignature(as, response, p.options);
    const claims = oauth.getValidatedIdTokenClaims(result);
    const subject = subjectSchema.parse(claims?.sub);
    // 同 session_token_refreshed:只记寿命与「有没有 RT」,不记 token。
    console.log(
      "oidc_token_issued",
      result.expires_in ?? "unset",
      result.refresh_token ? "rt" : "no-rt",
    );
    // 没有 refresh token 的会话撑不过第一个 access token 窗口(15 分钟),
    // 之后必然「cookie 还在、行没了」的永久 401。宁可这次登录失败,也不建一个注定短命的会话。
    const refreshToken = result.refresh_token;
    if (!refreshToken) {
      console.warn("oidc_missing_refresh_token");
      return c.redirect("/?account_error=no_refresh_token");
    }
    const infoResponse = await oauth.userInfoRequest(as, p.client, result.access_token, p.options);
    const info = await oauth.processUserInfoResponse(as, p.client, subject, infoResponse);
    const tokens: SessionTokens = {
      accessToken: result.access_token,
      refreshToken,
      idToken: result.id_token,
      email: z.email().parse(info.email),
      emailVerified: info.email_verified === true,
    };
    const sessionToken = randomToken();
    const tokenHash = await hash(sessionToken);
    const db = database(c.env.DB);
    await db.insert(appSession).values({
      token_hash: tokenHash,
      subject,
      payload: await seal(tokens, p.config.SESSION_SECRET, `session:${tokenHash}`),
      expires_at: Date.now() + SESSION_TTL_MS,
      token_expires_at: Date.now() + (result.expires_in ?? 900) * 1000,
    }).run();
    const oldCookie = getCookie(c, sessionCookieName(p.config));
    if (oldCookie)
      await db.delete(appSession).where(eq(appSession.token_hash, await hash(oldCookie))).run();
    setCookie(
      c,
      sessionCookieName(p.config),
      sessionToken,
      cookieOptions(p.config, sessionMaxAge(Date.now() + SESSION_TTL_MS)),
    );
    return c.redirect("/?account=connected");
  } catch (error) {
    console.warn("oidc_callback_failed", error instanceof Error ? error.name : "UnknownError");
    return c.redirect("/?account_error=authorization");
  }
});
/** 与 /api/account/* 相同：会话 + IFFDAY profile；反馈写路径复用。 */
const requireIdentity: MiddlewareHandler<AppEnv> = async (c, next) => {
  const config = configuration(c.env);
  const cookie = getCookie(c, sessionCookieName(config));
  // 三种 401 的成因完全不同(NO_COOKIE = 浏览器压根没存住 cookie,多半是登录回调没走到写 cookie;
  // NO_SESSION = cookie 有但服务端会话已不在;IDENTITY_REJECTED = 会话在,上游不认这个 token),
  // 统一回 UNAUTHENTICATED 会让「重新登录也没用」无从下手。先分诊,前端只认 401。
  if (!cookie) return c.json({ error: "NO_COOKIE" }, 401);
  const session = await sessionFor(c.env, cookie, c.req.header("cf-connecting-ip"));
  if (!session) return c.json({ error: "NO_SESSION" }, 401);
  const identity = await c.env.IFFDAY_API.fetch(
    new Request(`${config.IFFDAY_ORIGIN}/api/v1/profile`, {
      headers: { Authorization: `Bearer ${session.tokens.accessToken}` },
    }),
  );
  if (!identity.ok) {
    // 上游说 token 无效时**不再立刻删行**。一次上游抖动(或刷新出来的 token 丢了 audience)
    // 就会把健康会话变成「cookie 还在、行没了」的永久 401,此后每个请求都是 401,只能重新登录。
    // 改成只记日志放行:会话本身靠 1 天滑窗自然过期,上游恢复后无需重新登录。
    // 带上上游的原话(截断),否则只能看到 401 却不知道是 token 过期、audience 不对还是端点变了。
    const detail = (await identity.text().catch(() => "")).slice(0, 200);
    console.warn("identity_rejected", identity.status, detail, session.row.subject);
    return c.json(
      { error: identity.status === 401 ? "IDENTITY_REJECTED" : "IDENTITY_UNAVAILABLE" },
      identity.status === 401 ? 401 : 503,
    );
  }
  const profile = accountProfileSchema.parse(await identity.json());
  if (profile.userId !== session.row.subject) return c.json({ error: "IDENTITY_MISMATCH" }, 401);
  // 滑动续期:cookie 的 maxAge 要跟 D1 会话一起往后推,否则活跃用户会被浏览器先一步踢掉。
  setCookie(
    c,
    sessionCookieName(config),
    cookie,
    cookieOptions(config, sessionMaxAge(session.row.expires_at)),
  );
  c.set("session", session);
  c.set("profile", profile);
  await next();
};
/**
 * 401 分诊端点。**临时**排查工具:Cloudflare 日志这边看不到,靠它一次请求就能分清
 * 「浏览器没 cookie」「cookie 有但会话没了」「会话在但上游不认 token」。只回状态与秒数,
 * 不回 token 本身。定位完会删。
 */
app.get("/api/account/debug", async (c) => {
  const config = configuration(c.env);
  const cookie = getCookie(c, sessionCookieName(config));
  if (!cookie) return c.json({ cookie: false, session: false, profile: null });
  let session: Awaited<ReturnType<typeof sessionFor>> = null;
  let sessionError: string | null = null;
  try {
    session = await sessionFor(c.env, cookie, c.req.header("cf-connecting-ip"));
  } catch (error) {
    sessionError = error instanceof Error ? error.message : "unknown";
  }
  if (!session) return c.json({ cookie: true, session: false, sessionError });
  const identity = await c.env.IFFDAY_API.fetch(
    new Request(`${config.IFFDAY_ORIGIN}/api/v1/profile`, {
      headers: { Authorization: `Bearer ${session.tokens.accessToken}` },
    }),
  );
  const body = await identity.text();
  return c.json({
    cookie: true,
    session: true,
    sessionError,
    sessionExpiresInSec: Math.round((session.row.expires_at - Date.now()) / 1000),
    tokenExpiresInSec: Math.round((session.row.token_expires_at - Date.now()) / 1000),
    hasRefreshToken: Boolean(session.tokens.refreshToken),
    profileStatus: identity.status,
    profileBody: body.slice(0, 200),
  });
});
app.use("/api/account/*", requireIdentity);
app.get("/api/account/me", (c) => {
  const { row, tokens } = c.get("session");
  return c.json({
    user: { id: row.subject, email: tokens.email, emailVerified: tokens.emailVerified },
    profile: c.get("profile"),
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
// Atomically save the merged workspace and mark the account imported. D1 batch is transactional.
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
    edition: z.string().min(1).max(64).optional().default(DEFAULT_WANT_EDITION),
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
  const config = configuration(c.env);
  const session = await sessionFor(
    c.env,
    getCookie(c, sessionCookieName(config)),
    c.req.header("cf-connecting-ip"),
  );
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
  const edition = c.req.query("edition") || DEFAULT_WANT_EDITION;
  if (edition.length > 64) return c.json({ error: "INVALID_EDITION" }, 422);
  const counts = await readWantCounts(database(c.env.DB), edition);
  return c.json({ edition, counts });
});
app.post("/api/stats/want-ping", async (c) => {
  const parsed = wantPingSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "INVALID_WANT_PING" }, 422);
  const { edition, films } = parsed.data;
  const config = configuration(c.env);
  const db = database(c.env.DB);
  const session = await sessionFor(
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

/* ---------------- 同场观影人数(2026-09-14,PLAN-20260914164050) ----------------
 * 口径:该场次出现在多少人的行程里,**不看票务状态**;权重与「想看人数」同源
 * (登录 1.0 / 匿名 0.75,见 want-stats.ts)。只回聚合数字,不回名单 —— 呼应「保护个人隐私」。 */

app.get("/api/stats/screening-counts", async (c) => {
  const edition = c.req.query("edition") || DEFAULT_WANT_EDITION;
  if (edition.length > 64) return c.json({ error: "INVALID_EDITION" }, 422);
  const db = database(c.env.DB);
  const [attendance, discussions] = await Promise.all([
    readScreeningCounts(db, edition),
    readDiscussionCounts(db, edition),
  ]);
  return c.json({ edition, attendance, discussions });
});

const screeningPingSchema = z
  .object({
    edition: z.string().min(1).max(64).optional().default(DEFAULT_WANT_EDITION),
    codes: z.array(z.string().min(1).max(64)).max(MAX_SCREENING_CODES_PER_PING),
  })
  .strict();

app.post("/api/stats/screening-attendance-ping", async (c) => {
  const parsed = screeningPingSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "INVALID_SCREENING_PING" }, 422);
  const { edition, codes } = parsed.data;
  const config = configuration(c.env);
  const db = database(c.env.DB);
  const session = await sessionFor(
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

/* ---------------- 场次讨论(2026-09-14,PLAN-20260914164050) ----------------
 * 公开读 + 登录写 + 作者可删 + emoji 反应 toggle;与 /api/feedback 同一套形状,
 * 但按「场次 code + edition」收窄。分类白名单在 `@biff/contracts/screening`。 */

app.get("/api/screenings/:code/discussion", async (c) => {
  const code = c.req.param("code");
  if (!code || code.length > 64) return c.json({ error: "INVALID_SCREENING" }, 422);
  const edition = c.req.query("edition") || DEFAULT_WANT_EDITION;
  if (edition.length > 64) return c.json({ error: "INVALID_EDITION" }, 422);
  const config = configuration(c.env);
  const session = await sessionFor(
    c.env,
    getCookie(c, sessionCookieName(config)),
    c.req.header("cf-connecting-ip"),
  );
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
  const edition =
    typeof rawEdition === "string" && rawEdition.length > 0 && rawEdition.length <= 64
      ? rawEdition
      : DEFAULT_WANT_EDITION;
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
  const result = await deleteScreeningPost(
    database(c.env.DB),
    c.req.param("id"),
    c.get("session").row.subject,
  );
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
