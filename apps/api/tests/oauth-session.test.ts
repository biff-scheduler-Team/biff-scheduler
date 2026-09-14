import { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import * as oauth from "oauth4webapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hash, seal } from "../src/crypto";
import { provider, sessionFor } from "../src/oauth";
import * as oauthModule from "../src/oauth";

// `sessionFor()` 是账号体系里唯一会**在请求路径上改会话状态**的函数:access token 快到期时
// 它会拿 D1 租约、调上游换 token、再把新 token 写回。这条链路上任何一步处理错,
// 都会把一个健康的登录会话变成「cookie 还在、行没了」的 401。
//
// 2026-09-14 线上实测到 `503 SERVICE_UNAVAILABLE` 紧跟 `401 UNAUTHENTICATED`,见
// PLAN-20260914181918 §现状。这里覆盖当时定位到的 4 个缺陷。
//
// 测试替身分两层,都是为了让断言打**真实行为**而不是断言实现:
//   1. D1 替身: `node:sqlite` 内存库 + 最小 D1 接口垫片 → drizzle 生成的真 SQL 会被真执行;
//   2. `oauth4webapi` 只替换网络/验签那几个函数(discovery / refresh / 验签),
//      `ResponseBodyError` 用**真的类**,这样 `instanceof` 判断与线上一致。

vi.mock("oauth4webapi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("oauth4webapi")>();
  return {
    ...actual,
    discoveryRequest: vi.fn(async () => new Response("{}", { status: 200 })),
    processDiscoveryResponse: vi.fn(() => ({
      token_endpoint: "https://account.iff.day/api/v1/auth/token",
    })),
    refreshTokenGrantRequest: vi.fn(async () => new Response("{}", { status: 200 })),
    processRefreshTokenResponse: vi.fn(),
    validateApplicationLevelSignature: vi.fn(),
    getValidatedIdTokenClaims: vi.fn(() => ({
      iss: "https://account.iff.day/api/v1/auth",
      aud: "biff-scheduler",
      iat: 0,
      exp: 0,
      sub: "user_00000000000000000000000001",
    })),
  };
});

const refreshResponse = vi.mocked(oauth.processRefreshTokenResponse);
const bindingFetch = vi.fn();

const COOKIE = "browser-session-cookie";
const SUBJECT = "user_00000000000000000000000001";
const SESSION_SECRET = "unit-test-session-secret-at-least-32-chars";
const DAY_MS = 86_400_000;

/** 与 `migrations/0001_account.sql` 的 `app_session` 保持一致。 */
function createSchema(sqlite: DatabaseSync) {
  sqlite.exec(`
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

/**
 * 最小 D1 接口垫片。drizzle 的 d1 驱动只用到
 * `prepare().bind().run()/all()/raw()` 与 `batch()`(见 `drizzle-orm/d1/session.js`),
 * 因此把 `node:sqlite` 包成这三个方法即可跑真 SQL。
 */
function createD1(sqlite: DatabaseSync): D1Database {
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
      const info = sqlite.prepare(query).run(...(params as never[]));
      return { success: true, results: [], meta: meta(Number(info.changes)) };
    },
    all: async () => ({
      success: true,
      results: sqlite.prepare(query).all(...(params as never[])),
      meta: meta(0),
    }),
    // drizzle 的 `.get()` 走 `values()` → `raw()`,要的是「按列顺序的数组的数组」。
    raw: async () =>
      (sqlite.prepare(query).all(...(params as never[])) as Record<string, unknown>[]).map((row) =>
        Object.values(row),
      ),
  });
  return {
    prepare: (query: string) => statement(query, []),
    batch: async (statements: { run(): Promise<unknown> }[]) => {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
    exec: async (query: string) => {
      sqlite.exec(query);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
}

function environment(sqlite: DatabaseSync): Env {
  return {
    APP_ENV: "production",
    APP_ORIGIN: "https://biff.lcandy.co",
    IFFDAY_ORIGIN: "https://account.iff.day",
    OIDC_CLIENT_ID: "biff-scheduler",
    OIDC_CLIENT_SECRET: "s".repeat(32),
    SESSION_SECRET,
    DB: createD1(sqlite),
    IFFDAY_API: { fetch: bindingFetch },
  } as unknown as Env;
}

async function sealedPayload(tokens: Record<string, unknown>): Promise<string> {
  return seal(
    { email: "viewer@example.com", emailVerified: true, ...tokens },
    SESSION_SECRET,
    `session:${await hash(COOKIE)}`,
  );
}

/** 写入一行「access token 已过期、可以刷新」的会话,并返回它的 token_hash。 */
async function seedSession(
  sqlite: DatabaseSync,
  overrides: { payload?: string; refreshUntil?: number; expiresAt?: number } = {},
): Promise<string> {
  const tokenHash = await hash(COOKIE);
  const payload = overrides.payload ?? (await sealedPayload({ accessToken: "at-1", refreshToken: "rt-1" }));
  sqlite
    .prepare(
      `INSERT INTO app_session (token_hash, subject, payload, expires_at, token_expires_at, refresh_until)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      tokenHash,
      SUBJECT,
      payload,
      overrides.expiresAt ?? Date.now() + 7 * DAY_MS,
      Date.now() - 1_000,
      overrides.refreshUntil ?? 0,
    );
  return tokenHash;
}

function sessionRow(sqlite: DatabaseSync): Record<string, unknown> | undefined {
  return sqlite.prepare("SELECT * FROM app_session").get();
}

/** 用**真的** `ResponseBodyError`,保证 `oauth.ts` 里的 `instanceof` 判断与线上一致。 */
function invalidGrant(): oauth.ResponseBodyError {
  return new oauth.ResponseBodyError("invalid_grant", {
    cause: { error: "invalid_grant", error_description: "refresh token already used" },
    response: new Response(null, { status: 400 }),
  } as never);
}

function freshTokens(accessToken: string, refreshToken: string) {
  return {
    // `TokenEndpointResponse.token_type` 是 `Lowercase<string>`,字面量要显式收窄。
    token_type: "bearer" as const,
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 900,
  };
}

/** 上游换 token 时一起换掉的 id_token 声明;`sessionFor` 只比对 `sub`。 */
function idTokenClaims(sub: string) {
  return {
    iss: "https://account.iff.day/api/v1/auth",
    aud: "biff-scheduler",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
    sub,
  };
}

// 只清调用记录,保留各 mock 在工厂里设的默认实现(clearAllMocks 不动实现)。
beforeEach(() => vi.clearAllMocks());

function setup(overrides: Parameters<typeof seedSession>[1] = {}) {
  const sqlite = new DatabaseSync(":memory:");
  createSchema(sqlite);
  return { sqlite, seeded: seedSession(sqlite, overrides) };
}

describe("sessionFor:刷新失败不得破坏会话", () => {
  it("上游非 invalid_grant 失败 → 503,会话行必须保留", async () => {
    const { sqlite, seeded } = setup();
    await seeded;
    refreshResponse.mockRejectedValue(new Error("upstream 502"));

    await expect(sessionFor(environment(sqlite), COOKIE)).rejects.toThrow(HTTPException);
    // 这次失败是**可重试**的,行必须还在,否则用户会被无谓地踢出登录。
    expect(sessionRow(sqlite)).toBeDefined();
    // 租约要释放,否则后续请求会被「刷新进行中」挡住。
    expect(sessionRow(sqlite)?.refresh_until).toBe(0);
  });

  it("invalid_grant 且行未被他人改写 → 删行并返回 null(确实失效,强制重新登录)", async () => {
    const { sqlite, seeded } = setup();
    await seeded;
    refreshResponse.mockRejectedValue(invalidGrant());

    expect(await sessionFor(environment(sqlite), COOKIE)).toBeNull();
    expect(sessionRow(sqlite)).toBeUndefined();
  });

  it("★ 并发:败者拿到 invalid_grant 时不得删掉胜者刚写入的健康会话", async () => {
    const { sqlite, seeded } = setup();
    const tokenHash = await seeded;
    const won = await sealedPayload({ accessToken: "at-won", refreshToken: "rt-2" });
    // 模拟「胜者」在我们这次刷新期间已经写入了新 token(上游轮换是原子的,本地写入不是)。
    // 我们这次拿的是已被消费的 rt-1,所以上游回 invalid_grant —— 但这只说明**我们**输了,
    // 不代表会话失效;按 token_hash 无条件删行会把胜者刚建立的好会话一起删掉。
    refreshResponse.mockImplementation(async () => {
      sqlite
        .prepare(
          "UPDATE app_session SET payload = ?, token_expires_at = ?, refresh_until = 0 WHERE token_hash = ?",
        )
        .run(won, Date.now() + 900_000, tokenHash);
      throw invalidGrant();
    });

    const session = await sessionFor(environment(sqlite), COOKIE);

    expect(session).not.toBeNull();
    expect(session?.tokens.accessToken).toBe("at-won");
    expect(sessionRow(sqlite)).toBeDefined();
  });

  it("★ 刷新失败时不得踩掉别人新拿到的租约", async () => {
    const { sqlite, seeded } = setup();
    const tokenHash = await seeded;
    refreshResponse.mockImplementation(async () => {
      // 我们的租约在刷新期间到期、另一个请求接管了它。
      sqlite
        .prepare("UPDATE app_session SET refresh_until = ? WHERE token_hash = ?")
        .run(Date.now() + 60_000, tokenHash);
      throw new Error("upstream 502");
    });

    await expect(sessionFor(environment(sqlite), COOKIE)).rejects.toThrow(HTTPException);
    // 无条件 `set refresh_until = 0` 会把接管者的租约一起清掉 → 并发刷新互相踩 → 双份刷新用同一个 RT。
    expect(sessionRow(sqlite)?.refresh_until).toBeGreaterThan(Date.now() + 30_000);
  });

  it("刷新成功但写入未命中(行已被他人改写)时,采用胜者的 token 而不是自己的", async () => {
    const { sqlite, seeded } = setup();
    const tokenHash = await seeded;
    const won = await sealedPayload({ accessToken: "at-won", refreshToken: "rt-2" });
    refreshResponse.mockImplementation(async () => {
      sqlite
        .prepare(
          "UPDATE app_session SET payload = ?, token_expires_at = ?, refresh_until = 0 WHERE token_hash = ?",
        )
        .run(won, Date.now() + 900_000, tokenHash);
      return freshTokens("at-loser", "rt-3");
    });

    const session = await sessionFor(environment(sqlite), COOKIE);

    expect(session?.tokens.accessToken).toBe("at-won");
  });

  it("刷新成功后写入新 token 并释放租约", async () => {
    const { sqlite, seeded } = setup();
    await seeded;
    refreshResponse.mockResolvedValue(freshTokens("at-2", "rt-2"));

    const session = await sessionFor(environment(sqlite), COOKIE);

    expect(session?.tokens.accessToken).toBe("at-2");
    expect(session?.tokens.refreshToken).toBe("rt-2");
    expect(sessionRow(sqlite)?.refresh_until).toBe(0);
    expect(Number(sessionRow(sqlite)?.token_expires_at)).toBeGreaterThan(Date.now() + 800_000);
  });

  it("id_token 的 sub 与本地会话不符 → 503,且不写入被换掉的 token", async () => {
    const { sqlite, seeded } = setup();
    await seeded;
    refreshResponse.mockResolvedValue({ ...freshTokens("at-2", "rt-2"), id_token: "id-2" });
    vi.mocked(oauth.getValidatedIdTokenClaims).mockReturnValueOnce(
      idTokenClaims("user_00000000000000000000000002"),
    );

    await expect(sessionFor(environment(sqlite), COOKIE)).rejects.toThrow(HTTPException);
    expect(sessionRow(sqlite)).toBeDefined();
  });

  it("没有 refresh token 时直接删行返回 null(不尝试刷新)", async () => {
    const { sqlite, seeded } = setup({ payload: await sealedPayload({ accessToken: "at-1" }) });
    await seeded;

    expect(await sessionFor(environment(sqlite), COOKIE)).toBeNull();
    expect(sessionRow(sqlite)).toBeUndefined();
  });

  it("access token 还够用时不碰上游,也不动租约", async () => {
    const { sqlite, seeded } = setup();
    await seeded;
    sqlite.prepare("UPDATE app_session SET token_expires_at = ?").run(Date.now() + 600_000);

    const session = await sessionFor(environment(sqlite), COOKIE);

    expect(session?.tokens.accessToken).toBe("at-1");
    expect(refreshResponse).not.toHaveBeenCalled();
  });
});

describe("sessionFor:会话滑动续期", () => {
  /**
   * 固定 7 天窗口的问题:天天在用的用户照样在第 8 天被踢,和一次都没用的人拿到一样的寿命。
   * 滑窗把寿命改成「离上次使用 1 天」,同时 cookie 的 maxAge 由调用方按 `row.expires_at` 同步 ——
   * 所以这里断言的 expires_at 必须是**续期后**的值,而不是库里的旧值。
   */
  it("★ 剩余寿命不足半程 → 推到一个完整窗口(cookie 才跟着续)", async () => {
    const { sqlite, seeded } = setup({ expiresAt: Date.now() + 60_000 });
    await seeded;
    sqlite.prepare("UPDATE app_session SET token_expires_at = ?").run(Date.now() + 600_000);

    const session = await sessionFor(environment(sqlite), COOKIE);

    expect(session?.row.expires_at).toBeGreaterThan(Date.now() + oauthModule.SESSION_TTL_MS - 60_000);
    expect(Number(sessionRow(sqlite)?.expires_at)).toBeGreaterThan(
      Date.now() + oauthModule.SESSION_TTL_MS - 60_000,
    );
  });

  it("剩余寿命还长 → 不回写 D1", async () => {
    const { sqlite, seeded } = setup();
    await seeded;
    sqlite.prepare("UPDATE app_session SET token_expires_at = ?").run(Date.now() + 600_000);
    const before = sessionRow(sqlite)?.expires_at;

    const session = await sessionFor(environment(sqlite), COOKIE);

    expect(session?.row.expires_at).toBe(Number(before));
    expect(sessionRow(sqlite)?.expires_at).toBe(before);
  });

  it("刷新成功后同样续期(活跃用户不该因为换 token 反而更接近过期)", async () => {
    const { sqlite, seeded } = setup({ expiresAt: Date.now() + 60_000 });
    await seeded;
    refreshResponse.mockResolvedValue(freshTokens("at-2", "rt-2"));

    const session = await sessionFor(environment(sqlite), COOKIE);

    expect(session?.tokens.accessToken).toBe("at-2");
    expect(session?.row.expires_at).toBeGreaterThan(Date.now() + oauthModule.SESSION_TTL_MS - 60_000);
  });
});

describe("sessionFor:窗口口径(锁与等待必须对齐)", () => {
  // 旧实现:租约 15s、等待 12 × 200ms = 2.4s。持有者只要慢过 2.4s,等待者就 503 ——
  // 而那次刷新其实会成功。窗口必须覆盖租约,否则 503 会变成常态噪声。
  it("★ 等待窗口必须覆盖租约窗口", () => {
    expect(oauthModule.REFRESH_WAIT_MS).toBeGreaterThanOrEqual(oauthModule.REFRESH_LEASE_MS);
  });

  // 上游挂死时,请求会被拖到 isolate 回收 —— 那时 catch 不会执行,`refresh_until` 会残留
  // 最长一个租约窗口,该会话在此期间每个请求都是 503。硬超时是这条兜底的前提。
  it("★ 上游调用必须有硬超时,且租约能覆盖两次调用", () => {
    expect(oauthModule.IDENTITY_TIMEOUT_MS).toBeGreaterThan(0);
    // 持有者顺序跑 discovery + refresh,租约短于 2 倍超时就会中途过期 → 别人接管 → 同一个 RT 刷两次。
    expect(oauthModule.IDENTITY_TIMEOUT_MS * 2).toBeLessThanOrEqual(oauthModule.REFRESH_LEASE_MS);
  });
});

describe("provider:service binding 调用边界", () => {
  it("customFetch 拒绝账号域之外的 URL", async () => {
    const { sqlite } = setup();
    const client = provider(environment(sqlite), "1.2.3.4");
    const customFetch = client.options[oauth.customFetch] as (
      input: string,
      init: RequestInit,
    ) => Promise<Response>;

    await expect(customFetch("https://evil.example/api/v1/auth/token", {})).rejects.toThrow(
      "Unexpected identity endpoint",
    );
  });

  it("上游 service binding 抛错时必须把错误抛出去(不吞掉)", async () => {
    const { sqlite } = setup();
    bindingFetch.mockRejectedValue(new Error("binding down"));
    const client = provider(environment(sqlite), "1.2.3.4");
    const customFetch = client.options[oauth.customFetch] as (
      input: string,
      init: RequestInit,
    ) => Promise<Response>;

    await expect(
      customFetch("https://account.iff.day/api/v1/auth/token", {}),
    ).rejects.toThrow("binding down");
  });

  it("转发 cf-connecting-ip 给上游", async () => {
    const { sqlite } = setup();
    bindingFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    const client = provider(environment(sqlite), "1.2.3.4");
    const customFetch = client.options[oauth.customFetch] as (
      input: string,
      init: RequestInit,
    ) => Promise<Response>;

    await customFetch("https://account.iff.day/api/v1/auth/token", {});
    const forwarded = bindingFetch.mock.calls.at(-1)?.[0] as Request;

    expect(forwarded.headers.get("cf-connecting-ip")).toBe("1.2.3.4");
  });
});
