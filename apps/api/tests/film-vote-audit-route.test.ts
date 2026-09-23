import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hash, seal } from "../src/crypto";
import { database } from "../src/db";
import { ANON_PREFIX, replaceContributorVotes } from "../src/film-vote-store";
import app from "../src/index";
import { createD1, createStatSchema } from "./d1-shim";

/**
 * `GET /api/account/film-vote-contributions` 的 **HTTP 边界**（2026-09-23，PLAN-20260923124402）。
 *
 * 为什么必须在这一层测：本仓库其余 api 单测都是模块级的，而这条路由有两个**只接线才错**的风险，
 * 模块级测试一个都挡不住：
 *   ① 它靠「路径挂在 `/api/account/*` 下」继承 `requireIdentity` —— 路径或注册顺序写错，
 *      它就会变成一个**任何人都能读投票行**的裸接口；
 *   ② 响应体一旦把 `contributor` 带上，隐私口径就破了。
 *
 * 断言打的是真实行为：真 `app.request()` + 真 drizzle SQL（`d1-shim` 内存库）+
 * 只把「IFFDAY 身份服务」这一个外部依赖换成替身。
 */

const ORIGIN = "http://localhost:31028";
const IFFDAY_ORIGIN = "http://127.0.0.1:5183";
const SESSION_COOKIE = "biff.session";
const ANON_COOKIE = "biff.want";
const COOKIE = "browser-session-cookie";
const ANON_TOKEN = "this-browser-anon-token";
const SUBJECT = "user_00000000000000000000000001";
const EDITION = "biff-2026";
const SESSION_SECRET = "unit-test-session-secret-at-least-32-chars";

const bindingFetch = vi.fn();

/** 与 `apps/api/.dev.vars` 同形的最小 env（`configuration()` 会校验全部字段，缺一个就直接抛）。 */
function environment(sqlite: DatabaseSync): Env {
  return {
    APP_ENV: "local",
    APP_ORIGIN: ORIGIN,
    IFFDAY_ORIGIN,
    OIDC_CLIENT_ID: "biff-scheduler-local",
    OIDC_CLIENT_SECRET: "s".repeat(32),
    SESSION_SECRET,
    DB: createD1(sqlite),
    IFFDAY_API: { fetch: bindingFetch },
  } as unknown as Env;
}

/** `app_session` 与 `migrations/0001_account.sql` 一致；投票两张表走共享垫片的真 DDL。 */
function createSchema(sqlite: DatabaseSync): void {
  createStatSchema(sqlite);
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

/** 写一行**access token 仍然有效**的会话（不触发刷新，链路里只剩「取 profile」一次上游调用）。 */
async function seedSession(sqlite: DatabaseSync): Promise<void> {
  const payload = await seal(
    { accessToken: "at-1", refreshToken: "rt-1", email: "viewer@example.com", emailVerified: true },
    SESSION_SECRET,
    `session:${await hash(COOKIE)}`,
  );
  sqlite
    .prepare(
      `INSERT INTO app_session (token_hash, subject, payload, expires_at, token_expires_at, refresh_until)
       VALUES (?, ?, ?, ?, ?, 0)`,
    )
    .run(await hash(COOKIE), SUBJECT, payload, Date.now() + 86_400_000, Date.now() + 600_000);
}

function profileResponse(userId: string): Response {
  return Response.json({
    userId,
    displayName: "Ra",
    bio: "",
    website: "",
    avatarUrl: null,
    updatedAt: "2026-09-23T00:00:00.000Z",
    version: 1,
  });
}

function url(edition = EDITION): string {
  return `${ORIGIN}/api/account/film-vote-contributions?edition=${edition}`;
}

describe("GET /api/account/film-vote-contributions", () => {
  let sqlite: DatabaseSync;
  let db: ReturnType<typeof database>;
  let env: Env;

  beforeEach(async () => {
    sqlite = new DatabaseSync(":memory:");
    createSchema(sqlite);
    db = database(createD1(sqlite));
    env = environment(sqlite);
    bindingFetch.mockReset();
    bindingFetch.mockImplementation(async () => profileResponse(SUBJECT));
    await seedSession(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("未登录 → 401（挂在 /api/account/* 下 = 继承 requireIdentity，不是裸接口）", async () => {
    const response = await app.request(url(), {}, env);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "SESSION_NO_COOKIE" });
  });

  it("非法 edition 也先被 401 挡住（鉴权在处理器之前）", async () => {
    const response = await app.request(`${ORIGIN}/api/account/film-vote-contributions?edition=nope`, {}, env);
    expect(response.status).toBe(401);
  });

  it("登录后：我名下的行进 mine，其余进 others，回 contributor 原文即失败", async () => {
    await replaceContributorVotes(db, EDITION, SUBJECT, new Map([["cat:f001", "red"]]));
    await replaceContributorVotes(
      db,
      EDITION,
      `${ANON_PREFIX}somebody-else`,
      new Map([["cat:f002", "black"]]),
    );

    const response = await app.request(
      url(),
      { headers: { cookie: `${SESSION_COOKIE}=${COOKIE}` } },
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      edition: string;
      truncated: boolean;
      mine: unknown[];
      others: unknown[];
      thisBrowser: { hasAnonCookie: boolean; matched: unknown[] };
    };
    expect(body.edition).toBe(EDITION);
    expect(body.truncated).toBe(false);
    expect(body.mine).toEqual([
      { filmKey: "cat:f001", vote: "red", updatedAt: expect.any(Number), anonymous: false },
    ]);
    expect(body.others).toEqual([
      { filmKey: "cat:f002", vote: "black", updatedAt: expect.any(Number), anonymous: true },
    ]);
    // 本请求没带匿名 cookie
    expect(body.thisBrowser).toEqual({ hasAnonCookie: false, matched: [] });
    // ★ 隐私口径：响应体里不得出现任何身份串
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(SUBJECT);
    expect(raw).not.toContain("somebody-else");
    expect(raw).not.toContain(ANON_PREFIX);
  });

  it("★ 带上本浏览器匿名 cookie 时，命中的匿名行出现在 thisBrowser.matched（「是不是我贴的」唯一判据）", async () => {
    await replaceContributorVotes(db, EDITION, SUBJECT, new Map([["cat:f001", "red"]]));
    await replaceContributorVotes(
      db,
      EDITION,
      `${ANON_PREFIX}${await hash(ANON_TOKEN)}`,
      new Map([["cat:f002", "black"]]),
    );
    await replaceContributorVotes(
      db,
      EDITION,
      `${ANON_PREFIX}另外一台机器`,
      new Map([["cat:f003", "red"]]),
    );

    const response = await app.request(
      url(),
      { headers: { cookie: `${SESSION_COOKIE}=${COOKIE}; ${ANON_COOKIE}=${ANON_TOKEN}` } },
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      mine: Array<{ filmKey: string }>;
      others: Array<{ filmKey: string }>;
      thisBrowser: { hasAnonCookie: boolean; matched: Array<{ filmKey: string }> };
    };
    expect(body.mine.map((row) => row.filmKey)).toEqual(["cat:f001"]);
    expect(body.others.map((row) => row.filmKey).sort()).toEqual(["cat:f002", "cat:f003"]);
    // 只有本机那枚被认领；「另外一台机器」不算命中
    expect(body.thisBrowser.hasAnonCookie).toBe(true);
    expect(body.thisBrowser.matched.map((row) => row.filmKey)).toEqual(["cat:f002"]);
  });

  it("身份服务说这人不是会话里的 subject → 401，不返回任何投票行", async () => {
    bindingFetch.mockImplementation(async () => profileResponse("user_00000000000000000000000002"));
    await replaceContributorVotes(db, EDITION, SUBJECT, new Map([["cat:f001", "red"]]));
    const response = await app.request(
      url(),
      { headers: { cookie: `${SESSION_COOKIE}=${COOKIE}` } },
      env,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "IDENTITY_MISMATCH" });
  });
});
