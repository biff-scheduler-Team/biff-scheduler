import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_SUBJECTS } from "../src/admin";
import { hash, seal } from "../src/crypto";
import { database } from "../src/db";
import { mergeVoteBoards, type FilmVote } from "../src/film-vote-stats";
import {
  ANON_PREFIX,
  claimContributorVotes,
  readContributorVotes,
  readVoteCounts,
  removeContributorVote,
  replaceContributorVotes,
} from "../src/film-vote-store";
import app from "../src/index";
import { kstDay, kstDayMinus } from "../src/day";
import { replaceContributorWants } from "../src/want-store";
import { createAdminSchema, createD1, createSessionSchema, createStatSchema } from "./d1-shim";

/**
 * 红黑榜**管理端**（2026-09-23，PLAN-20260923140943）。
 *
 * 由来：自查接口刻意不回 `contributor`，于是「这两枚匿名死贴纸到底是谁的」查不出来；
 * 本服务原本也没有任何管理员概念。这里补上门禁（subject 白名单）+ 读 / 删 / 认领迁移。
 *
 * ⚠ 测试的重点不是「功能能跑」，而是**两个容易错的方向**：
 *   ① 权限：少一层门禁就等于把「谁投了什么」的名单挂到公网 —— 非白名单必须 403，
 *      未登录必须 401（这两条各有用例，且互相不能顶替）；
 *   ② 计数：删 / 迁移都要同时改贡献表与**聚合表**，所以断言打的是 `readVoteCounts`
 *      （聚合视图），不是只看贡献行 —— 只看贡献行的话，聚合漂了也发现不了。
 */

const EDITION = "biff-2026";

/** 与 `src/admin.ts` 的白名单同源：这里硬编码一份 + 断言它确实在名单里（见第一个用例）。 */
const ADMIN_SUBJECT = "user_01M2EVF3GTTJ6JC9NTM8NXYNHY";
const NON_ADMIN_SUBJECT = "user_00000000000000000000000001";

describe("mergeVoteBoards（纯函数：认领迁移的冲突口径）", () => {
  const target = (): Map<string, FilmVote> => new Map([["f001", "red"]]);

  it("并集：目标没有的片搬过去，报 moved", () => {
    const { merged, moved, alreadyHad, conflicts } = mergeVoteBoards(
      target(),
      new Map([
        ["f002", "black"],
        ["f003", "red"],
      ]),
    );
    expect([...merged]).toEqual([
      ["f001", "red"],
      ["f002", "black"],
      ["f003", "red"],
    ]);
    expect({ moved, alreadyHad, conflicts }).toEqual({ moved: 2, alreadyHad: 0, conflicts: [] });
  });

  it("★ 冲突：同一部片两色 → 保留**目标**那票，并把两边原样报出来", () => {
    const { merged, moved, alreadyHad, conflicts } = mergeVoteBoards(
      target(),
      new Map([["f001", "black"]]),
    );
    expect(merged.get("f001")).toBe("red");
    expect({ moved, alreadyHad }).toEqual({ moved: 0, alreadyHad: 0 });
    expect(conflicts).toEqual([{ key: "f001", source: "black", target: "red" }]);
  });

  it("同色重复 → alreadyHad（无信息量，不必逐条报）", () => {
    const { moved, alreadyHad, conflicts } = mergeVoteBoards(target(), new Map([["f001", "red"]]));
    expect({ moved, alreadyHad, conflicts }).toEqual({ moved: 0, alreadyHad: 1, conflicts: [] });
  });

  it("不改入参（迁移算的是新表，源 / 目标都要保持可读）", () => {
    const to = target();
    mergeVoteBoards(to, new Map([["f002", "black"]]));
    expect([...to]).toEqual([["f001", "red"]]);
  });
});

describe("管理端写路径（d1 垫片，跑真 SQL）", () => {
  let sqlite: DatabaseSync;
  let db: ReturnType<typeof database>;
  const anon = `${ANON_PREFIX}hash-x`;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    createStatSchema(sqlite);
    db = database(createD1(sqlite));
  });

  afterEach(() => {
    sqlite.close();
  });

  it("readContributorVotes 只回这个身份的票（走索引，不夹带别人）", async () => {
    await replaceContributorVotes(db, EDITION, "sub-me", new Map([["f001", "red"]]));
    await replaceContributorVotes(db, EDITION, anon, new Map([["f002", "black"]]));
    const rows = await readContributorVotes(db, EDITION, anon);
    expect(rows.map((row) => row.film_key)).toEqual(["f002"]);
  });

  it("★ removeContributorVote：删贡献行 **并同步减聚合计数**，归零就删聚合行", async () => {
    await replaceContributorVotes(
      db,
      EDITION,
      "sub-me",
      new Map([
        ["f001", "red"],
        ["f002", "black"],
      ]),
    );
    await replaceContributorVotes(db, EDITION, "sub-other", new Map([["f001", "red"]]));

    expect(await removeContributorVote(db, EDITION, "sub-me", "f001")).toBe(true);
    // 别人那一票必须还在（只减我这一个身份的一票）
    expect(await readVoteCounts(db, EDITION)).toEqual({
      f001: { red: 1, black: 0 },
      f002: { red: 0, black: 1 },
    });
    // 未命中不静默成功：调用方要能区分「删掉了」与「参数写错了」
    expect(await removeContributorVote(db, EDITION, "sub-me", "f001")).toBe(false);

    expect(await removeContributorVote(db, EDITION, "sub-me", "f002")).toBe(true);
    // f002 两色都归零 → 聚合行整体消失（读侧不再返回这一部片）
    expect(await readVoteCounts(db, EDITION)).toEqual({ f001: { red: 1, black: 0 } });
  });

  it("★ claimContributorVotes：并到目标 + 清掉源；聚合数不重不漏", async () => {
    await replaceContributorVotes(db, EDITION, "sub-admin", new Map([["f001", "red"]]));
    await replaceContributorVotes(
      db,
      EDITION,
      anon,
      new Map([
        ["f002", "black"],
        ["f003", "red"],
      ]),
    );

    const outcome = await claimContributorVotes(db, EDITION, anon, "sub-admin");
    expect(outcome).toMatchObject({
      moved: 2,
      alreadyHad: 0,
      conflicts: [],
      dryRun: false,
      cleared: 2,
      targetTotal: 3,
    });
    expect(await readContributorVotes(db, EDITION, anon)).toEqual([]);
    expect(await readVoteCounts(db, EDITION)).toEqual({
      f001: { red: 1, black: 0 },
      f002: { red: 0, black: 1 },
      f003: { red: 1, black: 0 },
    });
  });

  it("★ 冲突的片：保留目标那票，聚合数**不能变成 2**", async () => {
    await replaceContributorVotes(db, EDITION, "sub-admin", new Map([["f001", "red"]]));
    await replaceContributorVotes(db, EDITION, anon, new Map([["f001", "black"]]));

    const outcome = await claimContributorVotes(db, EDITION, anon, "sub-admin");
    expect(outcome.moved).toBe(0);
    expect(outcome.conflicts).toEqual([{ key: "f001", source: "black", target: "red" }]);
    expect(await readVoteCounts(db, EDITION)).toEqual({ f001: { red: 1, black: 0 } });
    expect(await readContributorVotes(db, EDITION, anon)).toEqual([]);
  });

  it("dryRun=true：报告照给，但一个字节都不写", async () => {
    await replaceContributorVotes(db, EDITION, "sub-admin", new Map([["f001", "red"]]));
    await replaceContributorVotes(db, EDITION, anon, new Map([["f002", "black"]]));

    const outcome = await claimContributorVotes(db, EDITION, anon, "sub-admin", { dryRun: true });
    expect(outcome).toMatchObject({ moved: 1, dryRun: true, targetTotal: 2 });
    // 源还在、目标没变、聚合没变
    expect(await readContributorVotes(db, EDITION, anon)).toHaveLength(1);
    expect(await readContributorVotes(db, EDITION, "sub-admin")).toHaveLength(1);
    expect(await readVoteCounts(db, EDITION)).toEqual({
      f001: { red: 1, black: 0 },
      f002: { red: 0, black: 1 },
    });
  });
});

/* ---------------- HTTP 边界：门禁与响应 ----------------
 * 这一层是模块级测试挡不住的（路径 / 注册顺序 / 中间件装配都只在这里暴露）。 */

const ORIGIN = "http://localhost:31028";
const IFFDAY_ORIGIN = "http://127.0.0.1:5183";
const SESSION_COOKIE = "biff.session";
const COOKIE = "browser-session-cookie";
const SESSION_SECRET = "unit-test-session-secret-at-least-32-chars";

const bindingFetch = vi.fn();

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

/** 身份服务替身：回的就是会话里的 subject —— 回别的会被 `resolveIdentity` 判成 IDENTITY_MISMATCH
 *  （那是另一条用例专门测的事）。 */
function mockIdentityService(sqlite: DatabaseSync): void {
  bindingFetch.mockReset();
  bindingFetch.mockImplementation(async () => {
    const row = sqlite.prepare("SELECT subject FROM app_session").get() as
      | { subject: string }
      | undefined;
    return Response.json({
      userId: row?.subject ?? NON_ADMIN_SUBJECT,
      displayName: "Ra",
      bio: "",
      website: "",
      avatarUrl: null,
      updatedAt: "2026-09-23T00:00:00.000Z",
      version: 1,
    });
  });
}

/** 以某个 subject 登录后再发请求。
 *  ⚠ 非 GET/HEAD 必须带**同源 `Origin`**：`/api/*` 那道 CSRF 闸门会把它挡成 403 `FORBIDDEN_ORIGIN`
 *    —— 那是「跨站请求」，与「不是管理员」的 403 是两件事，所以断言时要连 `error` 一起断言。 */
async function requestWithSession(
  sqlite: DatabaseSync,
  env: Env,
  subject: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  await seedSession(sqlite, subject);
  return app.request(
    path,
    {
      ...init,
      headers: { cookie: `${SESSION_COOKIE}=${COOKIE}`, origin: ORIGIN, ...init.headers },
    },
    env,
  );
}

async function seedSession(sqlite: DatabaseSync, subject: string): Promise<void> {
  const tokenHash = await hash(COOKIE);
  const payload = await seal(
    { accessToken: "at-1", refreshToken: "rt-1", email: "viewer@example.com", emailVerified: true },
    SESSION_SECRET,
    `session:${tokenHash}`,
  );
  // ⚠ 先删再插：一个用例里会换身份重发请求，而 `token_hash` 是主键（不删就会撞 UNIQUE）
  sqlite.prepare("DELETE FROM app_session WHERE token_hash = ?").run(tokenHash);
  sqlite
    .prepare(
      `INSERT INTO app_session (token_hash, subject, payload, expires_at, token_expires_at, refresh_until)
       VALUES (?, ?, ?, ?, ?, 0)`,
    )
    .run(tokenHash, subject, payload, Date.now() + 86_400_000, Date.now() + 600_000);
}

describe("管理端 HTTP 边界", () => {
  let sqlite: DatabaseSync;
  let db: ReturnType<typeof database>;
  let env: Env;
  const listUrl = `${ORIGIN}/api/admin/film-vote-contributions?edition=${EDITION}`;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    createStatSchema(sqlite);
    createSessionSchema(sqlite);
    db = database(createD1(sqlite));
    env = environment(sqlite);
    mockIdentityService(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  const requestAs = (subject: string, path: string, init: RequestInit = {}) =>
    requestWithSession(sqlite, env, subject, path, init);

  it("白名单里确实有测试用的管理员 id（改名单会让下面 200 / 403 两条用例立刻红）", () => {
    expect(ADMIN_SUBJECTS).toContain(ADMIN_SUBJECT);
  });

  it("未登录 → 401（第一层门禁）", async () => {
    const response = await app.request(listUrl, {}, env);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "SESSION_NO_COOKIE" });
  });

  it("★ 登录但不是白名单 → 403（第二层门禁，不能被 401 顶替）", async () => {
    const response = await requestAs(NON_ADMIN_SUBJECT, listUrl);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "FORBIDDEN" });
  });

  it("非白名单连写路径也进不去（DELETE / claim 同样是 403 FORBIDDEN，而不是 CSRF 那道）", async () => {
    const del = await requestAs(
      NON_ADMIN_SUBJECT,
      `${ORIGIN}/api/admin/film-vote-contributions?edition=${EDITION}&contributor=${encodeURIComponent("sub-x")}&filmKey=cat:f001`,
      { method: "DELETE" },
    );
    expect(del.status).toBe(403);
    expect(await del.json()).toEqual({ error: "FORBIDDEN" });
    const claim = await requestAs(NON_ADMIN_SUBJECT, `${ORIGIN}/api/admin/film-vote-contributions/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: ANON_PREFIX + "x", to: ADMIN_SUBJECT }),
    });
    expect(claim.status).toBe(403);
    expect(await claim.json()).toEqual({ error: "FORBIDDEN" });
  });

  it("写路径仍受 CSRF 闸门保护：不带同源 Origin 的跨站请求拿不到 200", async () => {
    await replaceContributorVotes(db, EDITION, `${ANON_PREFIX}dead`, new Map([["cat:f001", "red"]]));
    await seedSession(sqlite, ADMIN_SUBJECT);
    const crossSite = await app.request(
      `${ORIGIN}/api/admin/film-vote-contributions?edition=${EDITION}&contributor=${encodeURIComponent(`${ANON_PREFIX}dead`)}&filmKey=cat:f001`,
      { method: "DELETE", headers: { cookie: `${SESSION_COOKIE}=${COOKIE}`, origin: "https://evil.example" } },
      env,
    );
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toEqual({ error: "FORBIDDEN_ORIGIN" });
    // 票还在
    expect(await readVoteCounts(db, EDITION)).toEqual({ "cat:f001": { red: 1, black: 0 } });
  });

  it("★ 管理员能读到 contributor 原文（自查接口刻意不给的那一项）", async () => {
    await replaceContributorVotes(db, EDITION, `${ANON_PREFIX}dead`, new Map([["cat:f001", "red"]]));
    await replaceContributorVotes(db, EDITION, NON_ADMIN_SUBJECT, new Map([["cat:f002", "black"]]));

    const response = await requestAs(ADMIN_SUBJECT, listUrl);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      truncated: boolean;
      rows: Array<{ filmKey: string; vote: string; contributor: string; anonymous: boolean }>;
    };
    expect(body.truncated).toBe(false);
    expect(body.rows).toContainEqual({
      filmKey: "cat:f001",
      vote: "red",
      contributor: `${ANON_PREFIX}dead`,
      anonymous: true,
      updatedAt: expect.any(Number),
    });
    expect(body.rows).toContainEqual(
      expect.objectContaining({ filmKey: "cat:f002", contributor: NON_ADMIN_SUBJECT, anonymous: false }),
    );
  });

  it("DELETE：命中 200 且聚合数跟着降；再删同一行 404；缺参数 422", async () => {
    await replaceContributorVotes(db, EDITION, `${ANON_PREFIX}dead`, new Map([["cat:f001", "red"]]));
    const url = `${ORIGIN}/api/admin/film-vote-contributions?edition=${EDITION}&contributor=${encodeURIComponent(`${ANON_PREFIX}dead`)}&filmKey=cat:f001`;

    const del = await requestAs(ADMIN_SUBJECT, url, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await readVoteCounts(db, EDITION)).toEqual({});

    // 已经没有了 → 404（不静默成功）
    const again = await requestAs(ADMIN_SUBJECT, url, { method: "DELETE" });
    expect(again.status).toBe(404);

    // 少一个 filmKey → 422
    const bad = await requestAs(
      ADMIN_SUBJECT,
      `${ORIGIN}/api/admin/film-vote-contributions?edition=${EDITION}&contributor=x`,
      { method: "DELETE" },
    );
    expect(bad.status).toBe(422);
    expect(await bad.json()).toEqual({ error: "INVALID_ADMIN_QUERY" });
  });

  it("claim：from 必须是匿名身份、to 必须是账号格式 —— 否则 422", async () => {
    const post = (body: unknown) =>
      requestAs(ADMIN_SUBJECT, `${ORIGIN}/api/admin/film-vote-contributions/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    expect((await post({ from: NON_ADMIN_SUBJECT, to: ADMIN_SUBJECT })).status).toBe(422);
    expect((await post({ from: `${ANON_PREFIX}x`, to: "not-an-account-id" })).status).toBe(422);
    expect((await post({ from: `${ANON_PREFIX}x`, to: ADMIN_SUBJECT, dryRun: "yes" })).status).toBe(422);
  });

  it("claim：dryRun 只报告、正式执行才落库", async () => {
    await replaceContributorVotes(db, EDITION, ADMIN_SUBJECT, new Map([["cat:f001", "red"]]));
    await replaceContributorVotes(db, EDITION, `${ANON_PREFIX}mine`, new Map([["cat:f002", "black"]]));
    const url = `${ORIGIN}/api/admin/film-vote-contributions/claim`;
    const post = (body: unknown) =>
      requestAs(ADMIN_SUBJECT, url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const preview = await post({ from: `${ANON_PREFIX}mine`, to: ADMIN_SUBJECT, dryRun: true });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ moved: 1, dryRun: true, targetTotal: 2 });
    // 预览不改库
    expect(await readContributorVotes(db, EDITION, `${ANON_PREFIX}mine`)).toHaveLength(1);

    const applied = await post({ from: `${ANON_PREFIX}mine`, to: ADMIN_SUBJECT });
    expect(await applied.json()).toMatchObject({ moved: 1, dryRun: false, cleared: 1, targetTotal: 2 });
    expect(await readContributorVotes(db, EDITION, `${ANON_PREFIX}mine`)).toEqual([]);
    expect(await readVoteCounts(db, EDITION)).toEqual({
      "cat:f001": { red: 1, black: 0 },
      "cat:f002": { red: 0, black: 1 },
    });
  });
});

/* ---------------- 管理端读接口（whoami / overview / rows / trends） ----------------
 * 与上面同一套 harness：门禁是**同一层**（`/api/admin/*` 两条中间件），所以这里要再钉一遍
 * 「未登录 401 / 非白名单 403 / 白名单 200」—— 新加一条路由忘了进 `/api/admin/*` 就不会有这两道。 */

const TODAY = kstDay(Date.now());

describe("管理端读接口 HTTP 边界", () => {
  let sqlite: DatabaseSync;
  let db: ReturnType<typeof database>;
  let env: Env;
  const base = `${ORIGIN}/api/admin`;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    createStatSchema(sqlite);
    createSessionSchema(sqlite);
    createAdminSchema(sqlite);
    db = database(createD1(sqlite));
    env = environment(sqlite);
    mockIdentityService(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  const requestAs = (subject: string, path: string, init: RequestInit = {}) =>
    requestWithSession(sqlite, env, subject, path, init);

  it("whoami：未登录 401 / 非白名单 403 / 管理员 200（前端据此决定渲染什么）", async () => {
    expect((await app.request(`${base}/whoami`, {}, env)).status).toBe(401);
    expect((await requestAs(NON_ADMIN_SUBJECT, `${base}/whoami`)).status).toBe(403);
    const ok = await requestAs(ADMIN_SUBJECT, `${base}/whoami`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ subject: ADMIN_SUBJECT, admin: true });
  });

  it("★ overview：给出各模块总量与对账结论，且**不含任何片单内容**", async () => {
    await replaceContributorWants(db, EDITION, NON_ADMIN_SUBJECT, 1, ["cat:f001"]);
    sqlite
      .prepare(
        "INSERT INTO festival_document (subject, edition, revision, records, updated_at) VALUES (?, ?, 1, ?, ?)",
      )
      .run(ADMIN_SUBJECT, EDITION, '{"local:biff.picks.v2":"别人的片单"}', Date.now());

    const response = await requestAs(ADMIN_SUBJECT, `${base}/overview?edition=${EDITION}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      metrics: Array<{ metric: string; total: number }>;
      audit: { ok: boolean };
      accounts: { documents: number };
      today: string;
    };
    expect(body.metrics.find((row) => row.metric === "want")?.total).toBe(1);
    expect(body.audit.ok).toBe(true);
    expect(body.accounts.documents).toBe(1);
    expect(body.today).toBe(TODAY);
    expect(JSON.stringify(body)).not.toContain("别人的片单");
  });

  it("rows：管理员能读到 contributor 原文；metric 非法 → 422", async () => {
    await replaceContributorVotes(db, EDITION, `${ANON_PREFIX}dead`, new Map([["cat:f001", "red"]]));
    const ok = await requestAs(ADMIN_SUBJECT, `${base}/rows?edition=${EDITION}&metric=vote`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { rows: unknown[]; nextCursor: string | null };
    expect(body.rows).toEqual([
      {
        target: "cat:f001",
        sub: "red",
        contributor: `${ANON_PREFIX}dead`,
        anonymous: true,
        weight: 1,
        hits: null,
        updatedAt: expect.any(Number),
      },
    ]);
    expect(body.nextCursor).toBeNull();

    const bad = await requestAs(ADMIN_SUBJECT, `${base}/rows?edition=${EDITION}&metric=whatever`);
    expect(bad.status).toBe(422);
    expect(await bad.json()).toEqual({ error: "INVALID_ADMIN_QUERY" });
  });

  it("rows：非白名单 403（读路径的门禁一分都不能少）", async () => {
    const response = await requestAs(NON_ADMIN_SUBJECT, `${base}/rows?edition=${EDITION}&metric=want`);
    expect(response.status).toBe(403);
  });

  it("★ trends：族名展开（vote → 红黑相加）、精确指标也能查、未知指标与超范围天数 → 422", async () => {
    await replaceContributorVotes(db, EDITION, "c1", new Map([["cat:f001", "red"]]));
    await replaceContributorVotes(db, EDITION, "c2", new Map([["cat:f001", "black"]]));

    const family = await requestAs(ADMIN_SUBJECT, `${base}/trends?edition=${EDITION}&metric=vote&days=7`);
    expect(family.status).toBe(200);
    const familyBody = (await family.json()) as {
      metrics: string[];
      points: Array<{ day: string; weight: number; hits: number }>;
      earliestDay: string | null;
      fromDay: string;
    };
    expect(familyBody.metrics).toEqual(["vote:red", "vote:black"]);
    expect(familyBody.points).toEqual([{ day: TODAY, weight: 2, hits: 0 }]);
    expect(familyBody.earliestDay).toBe(TODAY);
    // days=7 → 起点是「今天往前 6 天」（含今天共 7 天）
    expect(familyBody.fromDay).toBe(kstDayMinus(6, Date.now()));

    const exact = await requestAs(ADMIN_SUBJECT, `${base}/trends?edition=${EDITION}&metric=vote%3Ared`);
    const exactBody = (await exact.json()) as { points: Array<{ weight: number }> };
    expect(exactBody.points).toEqual([{ day: TODAY, weight: 1, hits: 0 }]);

    const bad = await requestAs(ADMIN_SUBJECT, `${base}/trends?edition=${EDITION}&metric=nope`);
    expect(bad.status).toBe(422);
    expect(await bad.json()).toEqual({ error: "INVALID_METRIC" });

    expect((await requestAs(ADMIN_SUBJECT, `${base}/trends?edition=${EDITION}&metric=want&days=999`)).status).toBe(422);
    expect((await app.request(`${base}/trends?edition=${EDITION}&metric=want`, {}, env)).status).toBe(401);
  });
});
