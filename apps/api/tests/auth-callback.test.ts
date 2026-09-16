import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import * as oauth from "oauth4webapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authCallback } from "../src/auth-callback";
import { hash, seal } from "../src/crypto";

// 「点登录 → 跳回首页提示登录未完成」以前在生产上**无法定位**:callback 的 7 条失败路径里有 6 条
// 都塌成同一个 `account_error=authorization`,前端又把具体值丢掉。生产 CF 日志 / D1 本机都够不着,
// 所以只能把失败步骤变成**用户可见的码**(见 PLAN-20260916215100)。
//
// 这个测试守的就是「可区分」这一件事:每条路径都必须给出自己的码。改动前跑一次,13 条路径全都会
// 得到 `authorization` / `expired`,本文件里除了那两条之外的断言**全部先红**。

vi.mock("oauth4webapi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("oauth4webapi")>();
  return {
    ...actual,
    discoveryRequest: vi.fn(),
    processDiscoveryResponse: vi.fn(),
    validateAuthResponse: vi.fn(),
    authorizationCodeGrantRequest: vi.fn(),
    processAuthorizationCodeResponse: vi.fn(),
    validateApplicationLevelSignature: vi.fn(),
    getValidatedIdTokenClaims: vi.fn(),
    userInfoRequest: vi.fn(),
    processUserInfoResponse: vi.fn(),
  };
});

const SUBJECT = "user_00000000000000000000000001";
const SESSION_SECRET = "unit-test-session-secret-at-least-32-chars";
const PENDING_COOKIE = "browser-pending-cookie";
const PENDING_COOKIE_NAME = "__Host-biff.oauth"; // production 环境的前缀
const STATE = "state-from-login";
const discovery = {
  issuer: "https://account.iff.day/api/v1/auth",
  authorization_endpoint: "https://account.iff.day/api/v1/auth/oauth2/authorize",
  token_endpoint: "https://account.iff.day/api/v1/auth/oauth2/token",
  jwks_uri: "https://account.iff.day/api/v1/auth/jwks",
  userinfo_endpoint: "https://account.iff.day/api/v1/auth/oauth2/userinfo",
};

/** 把上游替身恢复到「一路顺利」;每条用例只覆盖自己要触发的那一步。 */
function happyUpstream() {
  vi.mocked(oauth.discoveryRequest).mockResolvedValue(new Response("{}", { status: 200 }));
  vi.mocked(oauth.processDiscoveryResponse).mockReturnValue(discovery as never);
  vi.mocked(oauth.validateAuthResponse).mockReturnValue(new URLSearchParams({ code: "code-1" }));
  vi.mocked(oauth.authorizationCodeGrantRequest).mockResolvedValue(
    new Response("{}", { status: 200 }),
  );
  vi.mocked(oauth.processAuthorizationCodeResponse).mockReturnValue({
    access_token: "at-1",
    refresh_token: "rt-1",
    id_token: "id-1",
    expires_in: 900,
  } as never);
  vi.mocked(oauth.validateApplicationLevelSignature).mockResolvedValue(undefined);
  vi.mocked(oauth.getValidatedIdTokenClaims).mockReturnValue({ sub: SUBJECT } as never);
  vi.mocked(oauth.userInfoRequest).mockResolvedValue(new Response("{}", { status: 200 }));
  vi.mocked(oauth.processUserInfoResponse).mockReturnValue({
    sub: SUBJECT,
    email: "viewer@example.com",
    email_verified: true,
  } as never);
}

/** 最小 D1 接口垫片(与 `oauth-session.test.ts` 同一套口径)。`faults.sessionInsert` 用来打
 *  「写会话失败」那条路径:它是最后一步,没有别的办法让它单独失败。 */
function createD1(sqlite: DatabaseSync, faults: { sessionInsert?: boolean } = {}): D1Database {
  const meta = (changes: number) => ({
    changes,
    last_row_id: 0,
    duration: 0,
    rows_read: 0,
    rows_written: changes,
    size_after: 0,
  });
  const statement = (query: string, params: unknown[]) => ({
    bind: (...next: unknown[]) => statement(query, next),
    run: async () => {
      if (faults.sessionInsert && /insert\s+into\s+"?app_session"?/i.test(query))
        throw new Error("D1 write failed");
      const info = sqlite.prepare(query).run(...(params as never[]));
      return { success: true, results: [], meta: meta(Number(info.changes)) };
    },
    all: async () => ({
      success: true,
      results: sqlite.prepare(query).all(...(params as never[])),
      meta: meta(0),
    }),
    // drizzle 的 `.get()` / `.returning()` 走 `values()` → `raw()`,要的是「按列顺序的数组的数组」。
    raw: async () =>
      (sqlite.prepare(query).all(...(params as never[])) as Record<string, unknown>[]).map((row) =>
        Object.values(row),
      ),
  });
  return {
    prepare: (query: string) => statement(query, []),
    batch: async (statements: { run(): Promise<unknown> }[]) => {
      const results = [];
      for (const item of statements) results.push(await item.run());
      return results;
    },
    exec: async (query: string) => {
      sqlite.exec(query);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
}

function createSchema(sqlite: DatabaseSync) {
  sqlite.exec(`
    CREATE TABLE oauth_pending (
      cookie_hash TEXT PRIMARY KEY NOT NULL,
      payload TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE app_session (
      token_hash TEXT PRIMARY KEY NOT NULL,
      subject TEXT NOT NULL,
      payload TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      token_expires_at INTEGER NOT NULL,
      refresh_until INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function environment(sqlite: DatabaseSync, faults: { sessionInsert?: boolean } = {}): Env {
  return {
    APP_ENV: "production",
    APP_ORIGIN: "https://biff.lcandy.co",
    IFFDAY_ORIGIN: "https://account.iff.day",
    OIDC_CLIENT_ID: "biff-scheduler",
    OIDC_CLIENT_SECRET: "s".repeat(32),
    SESSION_SECRET,
    DB: createD1(sqlite, faults),
    IFFDAY_API: { fetch: vi.fn() },
  } as unknown as Env;
}

const app = new Hono<{ Bindings: Env }>().get("/api/auth/callback", authCallback);

/** 走一遍 callback,返回 302 的 Location(以及要看的响应头)。 */
async function callback(
  sqlite: DatabaseSync,
  query = `code=code-1&state=${STATE}`,
  options: { cookie?: string | null; faults?: { sessionInsert?: boolean } } = {},
) {
  const cookie = options.cookie === undefined ? PENDING_COOKIE : options.cookie;
  return app.request(
    `http://localhost/api/auth/callback?${query}`,
    { headers: cookie ? { cookie: `${PENDING_COOKIE_NAME}=${cookie}` } : {} },
    environment(sqlite, options.faults),
  );
}

/** 写一行有效的登录临时记录(与登录接口同口径:seal + `oauth:<cookieHash>`)。 */
async function seedPending(sqlite: DatabaseSync) {
  const cookieHash = await hash(PENDING_COOKIE);
  const payload = await seal({ state: STATE, nonce: "nonce-1", verifier: "verifier-1" }, SESSION_SECRET, `oauth:${cookieHash}`);
  sqlite
    .prepare("INSERT INTO oauth_pending (cookie_hash, payload, expires_at) VALUES (?, ?, ?)")
    .run(cookieHash, payload, Date.now() + 600_000);
}

function callbackQuery(response: Response): URLSearchParams {
  return new URL(response.headers.get("location") ?? "", "https://biff.lcandy.co").searchParams;
}

/** Location 里 `account_error` 的**原始值**（可能带 `:<上游细节>`）。 */
async function failureParam(response: Response): Promise<string> {
  return callbackQuery(response).get("account_error") ?? "";
}

/** 只取步骤码（冒号前那一段）。 */
async function failureCode(response: Response): Promise<string> {
  return (await failureParam(response)).split(":")[0] ?? "";
}

/** 冒号后那一段（未给细节时为 null）。 */
async function failureDetail(response: Response): Promise<string | null> {
  return (await failureParam(response)).split(":")[1] ?? null;
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  happyUpstream();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("callback 的失败必须可区分", () => {
  it("浏览器没带回临时 cookie → pending_cookie_missing", async () => {
    const sqlite = new DatabaseSync(":memory:");
    createSchema(sqlite);
    expect(await failureCode(await callback(sqlite, `code=x&state=${STATE}`, { cookie: null }))).toBe(
      "pending_cookie_missing",
    );
  });

  it("服务端没有这条临时记录(超时 / 重复登录)→ pending_expired", async () => {
    const sqlite = new DatabaseSync(":memory:");
    createSchema(sqlite);
    expect(await failureCode(await callback(sqlite))).toBe("pending_expired");
  });

  it("没走到上游的失败不带 account_ms —— 那个数专指「失败那一步的上游耗时」", async () => {
    const sqlite = new DatabaseSync(":memory:");
    createSchema(sqlite);
    const response = await callback(sqlite, `code=x&state=${STATE}`, { cookie: null });
    expect(await failureCode(response)).toBe("pending_cookie_missing");
    expect(callbackQuery(response).get("account_ms")).toBeNull();
  });

  it("上游在授权环节直接拒绝 → authorize_denied(旧实现只给 authorization)", async () => {
    const sqlite = new DatabaseSync(":memory:");
    createSchema(sqlite);
    await seedPending(sqlite);
    const response = await callback(sqlite, "error=access_denied&state=" + STATE);
    expect(await failureCode(response)).toBe("authorize_denied");
    expect(warn).toHaveBeenCalledWith("oidc_authorize_error", "access_denied", "");
  });

  it("回调 state 与本次登录对不上 → state_mismatch", async () => {
    const sqlite = new DatabaseSync(":memory:");
    createSchema(sqlite);
    await seedPending(sqlite);
    expect(await failureCode(await callback(sqlite, "code=code-1&state=someone-elses"))).toBe(
      "state_mismatch",
    );
  });

  it("发现文档拿不到 → upstream_unreachable", async () => {
    const sqlite = new DatabaseSync(":memory:");
    createSchema(sqlite);
    await seedPending(sqlite);
    vi.mocked(oauth.discoveryRequest).mockRejectedValueOnce(new Error("timeout"));
    expect(await failureCode(await callback(sqlite))).toBe("upstream_unreachable");
  });

  it("换 token 被上游拒 → token_rejected + 上游错误码 + 本步耗时(并记下步骤,不打 token)", async () => {
    const sqlite = new DatabaseSync(":memory:");
    createSchema(sqlite);
    await seedPending(sqlite);
    vi.mocked(oauth.authorizationCodeGrantRequest).mockRejectedValueOnce(
      new oauth.ResponseBodyError("invalid_grant", {
        cause: { error: "invalid_grant" },
        response: new Response("{}", { status: 400 }),
      }),
    );
    const response = await callback(sqlite);
    expect(await failureCode(response)).toBe("token_rejected");
    // 「上游明确拒绝」与「我们等到超时」的分界线就在这个细节码上(PLAN-20260916220942)。
    expect(await failureDetail(response)).toBe("invalid_grant");
    const ms = Number(callbackQuery(response).get("account_ms"));
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(warn).toHaveBeenCalledWith(
      "oidc_callback_failed",
      "token_rejected",
      expect.any(Number),
      "ResponseBodyError:invalid_grant",
    );
  });

  it("换 token 时连不上上游 → token_rejected:network_timeout(与「被拒」分开)", async () => {
    const sqlite = new DatabaseSync(":memory:");
    createSchema(sqlite);
    await seedPending(sqlite);
    const timedOut = new Error("the operation was aborted due to timeout");
    timedOut.name = "TimeoutError";
    vi.mocked(oauth.authorizationCodeGrantRequest).mockRejectedValueOnce(timedOut);
    const response = await callback(sqlite);
    expect(await failureCode(response)).toBe("token_rejected");
    expect(await failureDetail(response)).toBe("network_timeout");
  });

  it("上游细节码不合白名单时整段丢掉,不得原样进 URL", async () => {
    const sqlite = new DatabaseSync(":memory:");
    createSchema(sqlite);
    await seedPending(sqlite);
    vi.mocked(oauth.authorizationCodeGrantRequest).mockRejectedValueOnce(
      new oauth.ResponseBodyError("INVALID GRANT!", {
        cause: { error: "INVALID GRANT!" },
        response: new Response("{}", { status: 400 }),
      }),
    );
    const response = await callback(sqlite);
    expect(await failureCode(response)).toBe("token_rejected");
    expect(await failureDetail(response)).toBeNull();
    expect(await failureParam(response)).toBe("token_rejected");
  });

  it("ID token 验签不过 → id_token_invalid", async () => {
    const sqlite = new DatabaseSync(":memory:");
    createSchema(sqlite);
    await seedPending(sqlite);
    vi.mocked(oauth.validateApplicationLevelSignature).mockRejectedValueOnce(
      new oauth.OperationProcessingError("invalid signature"),
    );
    expect(await failureCode(await callback(sqlite))).toBe("id_token_invalid");
  });

  it("sub 形态不合白名单 → subject_invalid(登录这一刻就暴露)", async () => {
    const sqlite = new DatabaseSync(":memory:");
    createSchema(sqlite);
    await seedPending(sqlite);
    vi.mocked(oauth.getValidatedIdTokenClaims).mockReturnValueOnce({ sub: "uuid-like-id" } as never);
    expect(await failureCode(await callback(sqlite))).toBe("subject_invalid");
  });

  it("userinfo 拿不到 / 邮箱缺失 → userinfo_failed", async () => {
    const sqlite = new DatabaseSync(":memory:");
    createSchema(sqlite);
    await seedPending(sqlite);
    vi.mocked(oauth.processUserInfoResponse).mockReturnValueOnce({
      sub: SUBJECT,
      email: "not-an-email",
      email_verified: true,
    } as never);
    expect(await failureCode(await callback(sqlite))).toBe("userinfo_failed");
  });

  it("写会话失败 → session_store_failed", async () => {
    const sqlite = new DatabaseSync(":memory:");
    createSchema(sqlite);
    await seedPending(sqlite);
    expect(
      await failureCode(await callback(sqlite, `code=code-1&state=${STATE}`, { faults: { sessionInsert: true } })),
    ).toBe("session_store_failed");
  });

  it("授权应答不成形 / 未预期异常 → authorization(兜底仍然是一个明确的码)", async () => {
    const sqlite = new DatabaseSync(":memory:");
    createSchema(sqlite);
    await seedPending(sqlite);
    vi.mocked(oauth.validateAuthResponse).mockImplementationOnce(() => {
      throw new Error("unexpected");
    });
    expect(await failureCode(await callback(sqlite))).toBe("authorization");
  });

  it("成功路径不受影响:回 /?account=connected 并下发会话 cookie", async () => {
    const sqlite = new DatabaseSync(":memory:");
    createSchema(sqlite);
    await seedPending(sqlite);
    const response = await callback(sqlite);
    expect(response.headers.get("location")).toBe("/?account=connected");
    expect(response.headers.get("set-cookie")).toContain("__Host-biff.session=");
    expect(
      sqlite.prepare("SELECT subject FROM app_session").all(),
    ).toEqual([{ subject: SUBJECT }]);
  });
});
