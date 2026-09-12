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

export function provider(env: Env, clientIp?: string) {
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
      return env.IFFDAY_API.fetch(new Request(url, { ...init, headers }));
    },
  };
  return {
    config,
    issuer,
    client,
    options,
    auth: oauth.ClientSecretBasic(config.OIDC_CLIENT_SECRET),
    resource: `${config.IFFDAY_ORIGIN}/api/v1/profile`,
    redirectUri: `${config.APP_ORIGIN}/api/auth/callback`,
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
  for (let attempt = 0; attempt < 12; attempt++) {
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
    const lease = await db.update(appSession).set({ refresh_until: Date.now() + 15_000 })
      .where(and(eq(appSession.token_hash, tokenHash), lt(appSession.refresh_until, Date.now()), eq(appSession.payload, row.payload)))
      .run();
    if (!lease.meta.changes) {
      await new Promise((resolve) => setTimeout(resolve, 200));
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
      await db.update(appSession).set({
        payload, token_expires_at: Date.now() + (result.expires_in ?? 900) * 1000, refresh_until: 0,
      }).where(and(eq(appSession.token_hash, tokenHash), eq(appSession.payload, row.payload))).run();
    } catch (error) {
      if (error instanceof oauth.ResponseBodyError && error.error === "invalid_grant") {
        await db.delete(appSession).where(eq(appSession.token_hash, tokenHash)).run();
        return null;
      }
      await db.update(appSession).set({ refresh_until: 0 }).where(eq(appSession.token_hash, tokenHash)).run();
      throw new HTTPException(503, { message: "Identity service unavailable" });
    }
  }
  throw new HTTPException(503, { message: "Session refresh in progress" });
}
