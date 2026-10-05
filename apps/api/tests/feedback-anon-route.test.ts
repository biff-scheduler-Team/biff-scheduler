import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hash, seal } from "../src/crypto";
import app from "../src/index";
import { ANON_PREFIX } from "../src/film-vote-store";
import { FEEDBACK_ANON_DISPLAY_NAME } from "../src/feedback";
import { createAdminSchema, createD1, createSessionSchema } from "./d1-shim";

/**
 * 「建议反馈」**免登录写**的 HTTP 边界（2026-10-05，PLAN-20261005204202）。
 *
 * 为什么必须在这一层测：改前 `POST /api/feedback` 挂着 `requireIdentity`，
 * 而「匿名」这件事**只接线才成立** ——
 *   ① 匿名身份必须来自那枚全站匿名 cookie（`biff.want`），否则「自己点过的反应」认不出来；
 *   ② 反过来，读路径还得靠同一枚 cookie 回填 `myReactions`，不然匿名者一刷新 chip 就灭；
 *   ③ 免登录写必须真的挂上限流，否则等于开了个零成本落库的口子。
 * 这三条在模块级单测里一个都挡不住（它们全是路由装配）。
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
const ANON_HEADER = `${ANON_COOKIE}=${ANON_TOKEN}`;
const SUBJECT = "user_00000000000000000000000001";
const SESSION_SECRET = "unit-test-session-secret-at-least-32-chars";
const BODY = "希望能按影厅筛选";

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

/** `feedback_reaction` 不在 `createAdminSchema` 里（那张 DDL 只到 `feedback_post`），与 `0004` 逐字补上。 */
function createReactionSchema(sqlite: DatabaseSync): void {
  sqlite.exec(`
    CREATE TABLE feedback_reaction (
      post_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(post_id, subject, emoji)
    );
    CREATE INDEX feedback_reaction_post ON feedback_reaction(post_id);
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
    updatedAt: "2026-10-05T00:00:00.000Z",
    version: 1,
  });
}

describe("建议反馈免登录写", () => {
  let sqlite: DatabaseSync;
  let env: Env;

  /** 每条用例一个来源 IP —— 限流桶按「路径 + IP」分，共用 IP 会让用例互相污染额度。 */
  function post(ip: string, headers: Record<string, string> = {}, body = BODY) {
    return app.request(
      `${ORIGIN}/api/feedback`,
      {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json", "cf-connecting-ip": ip, ...headers },
        body: JSON.stringify({ body }),
      },
      env,
    );
  }

  function react(postId: string, emoji: string, ip: string, headers: Record<string, string> = {}) {
    return app.request(
      `${ORIGIN}/api/feedback/${postId}/reactions`,
      {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json", "cf-connecting-ip": ip, ...headers },
        body: JSON.stringify({ emoji }),
      },
      env,
    );
  }

  function list(ip: string, headers: Record<string, string> = {}) {
    return app.request(`${ORIGIN}/api/feedback`, { headers: { "cf-connecting-ip": ip, ...headers } }, env);
  }

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    createSessionSchema(sqlite);
    createAdminSchema(sqlite);
    createReactionSchema(sqlite);
    env = environment(sqlite);
    bindingFetch.mockReset();
    bindingFetch.mockImplementation(async () => profileResponse(SUBJECT));
  });

  afterEach(() => {
    sqlite.close();
  });

  it("改前会 401：未登录 POST 现在落匿名帖（署名「匿名观众」+ 发一枚匿名 cookie）", async () => {
    const response = await post("203.0.113.11");
    expect(response.status).toBe(201);
    const created = (await response.json()) as { subject: string; displayName: string; body: string };
    expect(created.displayName).toBe(FEEDBACK_ANON_DISPLAY_NAME);
    expect(created.body).toBe(BODY);
    // ★ 身份是 `anon:<hash>`，不是明文 cookie —— 明文外发等于把「谁是谁」挂出去
    expect(created.subject.startsWith(ANON_PREFIX)).toBe(true);
    expect(created.subject).not.toContain(ANON_TOKEN);
    // 首次访问没有 cookie → 服务端必须发一枚（否则下次刷新认不出自己）
    expect(response.headers.get("set-cookie")).toContain(`${ANON_COOKIE}=`);
  });

  it("匿名也能点反应，且只有本机那枚 cookie 看得到 myReactions", async () => {
    const created = (await (await post("203.0.113.12", { cookie: ANON_HEADER })).json()) as { id: string };

    const reacted = await react(created.id, "👍", "203.0.113.12", { cookie: ANON_HEADER });
    expect(reacted.status).toBe(200);
    expect(await reacted.json()).toMatchObject({
      active: true,
      reactionCounts: { "👍": 1 },
      myReactions: ["👍"],
    });

    // 同一枚 cookie 重新拉列表 → chip 仍亮（改前 `mySubject` 恒 null，这里会空）
    const mine = (await (await list("203.0.113.12", { cookie: ANON_HEADER })).json()) as {
      posts: Array<{ myReactions: string[]; reactionCounts: Record<string, number> }>;
    };
    expect(mine.posts[0].myReactions).toEqual(["👍"]);
    expect(mine.posts[0].reactionCounts).toEqual({ "👍": 1 });

    // 另一台机器看到票数，但**不是**自己的 —— 不能「所有人都亮」
    const other = (await (await list("203.0.113.13", { cookie: `${ANON_COOKIE}=someone-else` })).json()) as {
      posts: Array<{ myReactions: string[] }>;
    };
    expect(other.posts[0].myReactions).toEqual([]);

    // 再点一次即取消（与登录态同一套 toggle 语义）
    const off = await react(created.id, "👍", "203.0.113.12", { cookie: ANON_HEADER });
    expect(await off.json()).toMatchObject({ active: false, myReactions: [] });
  });

  it("免登录写挂上了限流：同一 IP 超出额度回 429 + Retry-After", async () => {
    const ip = "203.0.113.14";
    for (let i = 0; i < 20; i += 1) {
      expect((await post(ip, { cookie: ANON_HEADER })).status).toBe(201);
    }
    const blocked = await post(ip, { cookie: ANON_HEADER });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    expect(await blocked.json()).toEqual({ error: "RATE_LIMITED" });
  });

  it("reaction 限流按「路由」分桶，不按帖子 id 分（跨帖共用一份额度）", async () => {
    const ip = "203.0.113.17";
    const first = (await (await post("203.0.113.18", { cookie: ANON_HEADER })).json()) as { id: string };
    const second = (await (await post("203.0.113.19", { cookie: ANON_HEADER })).json()) as { id: string };

    // 两帖各点 10 次 —— 若限流键误用 `c.req.path`（含 `:id`），两边各有 20 次额度，
    // 第 21 次就会**错误地**放行；这条断言正是为此立的。
    for (let i = 0; i < 10; i += 1) {
      expect((await react(first.id, "👍", ip, { cookie: ANON_HEADER })).status).toBe(200);
      expect((await react(second.id, "👍", ip, { cookie: ANON_HEADER })).status).toBe(200);
    }
    expect((await react(first.id, "👍", ip, { cookie: ANON_HEADER })).status).toBe(429);
  });

  it("登录态行为不变：署名仍是账号昵称，subject 仍是账号 id", async () => {
    await seedSession(sqlite);
    const response = await post("203.0.113.15", { cookie: `${SESSION_COOKIE}=${COOKIE}` });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ subject: SUBJECT, displayName: "Ra" });
  });

  it("删除**仍要登录**（本轮只放开写，没放开删）", async () => {
    const created = (await (await post("203.0.113.16", { cookie: ANON_HEADER })).json()) as { id: string };
    const response = await app.request(
      `${ORIGIN}/api/feedback/${created.id}`,
      { method: "DELETE", headers: { origin: ORIGIN, "cf-connecting-ip": "203.0.113.16", cookie: ANON_HEADER } },
      env,
    );
    expect(response.status).toBe(401);
  });
});
