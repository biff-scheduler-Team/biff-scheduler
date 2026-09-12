import { and, eq, gt, lt, sql } from "drizzle-orm";
import { database } from "./db";
import { appSession, festivalDocument, oauthPending } from "./db/schema";
import { Hono } from "hono";
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
  bodyLimit({ maxSize: 512 * 1024, onError: (c) => c.json({ error: "PAYLOAD_TOO_LARGE" }, 413) }),
);
app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  const config = configuration(c.env);
  if (new URL(c.req.url).origin !== config.APP_ORIGIN)
    return c.json({ error: "INVALID_HOST" }, 403);
  if (!["GET", "HEAD"].includes(c.req.method) && c.req.header("origin") !== config.APP_ORIGIN)
    return c.json({ error: "FORBIDDEN_ORIGIN" }, 403);
  await next();
});
app.get("/api/health", async (c) => {
  await database(c.env.DB).get(sql`SELECT 1`);
  return c.json({ status: "ok" });
});
app.get("/api/auth/login", async (c) => {
  const p = provider(c.env, c.req.header("cf-connecting-ip"));
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
  const p = provider(c.env, c.req.header("cf-connecting-ip"));
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
    const infoResponse = await oauth.userInfoRequest(as, p.client, result.access_token, p.options);
    const info = await oauth.processUserInfoResponse(as, p.client, subject, infoResponse);
    const tokens: SessionTokens = {
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
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
      expires_at: Date.now() + 7 * 86400_000,
      token_expires_at: Date.now() + (result.expires_in ?? 900) * 1000,
    }).run();
    const oldCookie = getCookie(c, sessionCookieName(p.config));
    if (oldCookie)
      await db.delete(appSession).where(eq(appSession.token_hash, await hash(oldCookie))).run();
    setCookie(c, sessionCookieName(p.config), sessionToken, cookieOptions(p.config, 7 * 86400));
    return c.redirect("/?account=connected");
  } catch (error) {
    console.warn("oidc_callback_failed", error instanceof Error ? error.name : "UnknownError");
    return c.redirect("/?account_error=authorization");
  }
});
app.use("/api/account/*", async (c, next) => {
  const config = configuration(c.env);
  const session = await sessionFor(
    c.env,
    getCookie(c, sessionCookieName(config)),
    c.req.header("cf-connecting-ip"),
  );
  if (!session) return c.json({ error: "UNAUTHENTICATED" }, 401);
  const identity = await c.env.IFFDAY_API.fetch(
    new Request(`${config.IFFDAY_ORIGIN}/api/v1/profile`, {
      headers: { Authorization: `Bearer ${session.tokens.accessToken}` },
    }),
  );
  if (!identity.ok) {
    if (identity.status === 401)
      await database(c.env.DB).delete(appSession).where(eq(appSession.token_hash, session.row.token_hash)).run();
    return c.json(
      { error: identity.status === 401 ? "UNAUTHENTICATED" : "IDENTITY_UNAVAILABLE" },
      identity.status === 401 ? 401 : 503,
    );
  }
  const profile = accountProfileSchema.parse(await identity.json());
  if (profile.userId !== session.row.subject) return c.json({ error: "IDENTITY_MISMATCH" }, 401);
  c.set("session", session);
  c.set("profile", profile);
  await next();
});
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
  const p = provider(c.env, c.req.header("cf-connecting-ip"));
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
  const row = await database(c.env.DB).select().from(festivalDocument)
    .where(and(eq(festivalDocument.subject, subject), eq(festivalDocument.edition, "biff-2026"))).get();
  return c.json(
    row
      ? {
          subject,
          revision: row.revision,
          records: JSON.parse(row.records),
          updatedAt: row.updated_at,
        }
      : { subject, revision: 0, records: {}, updatedAt: 0 },
  );
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
  return c.json({ revision: result.revision });
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
