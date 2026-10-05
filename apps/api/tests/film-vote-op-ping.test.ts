// 增量上报（ops + 批次号）的**端点级契约**（2026-10-05，PLAN-20261005182415 §C）。
//
// 为什么单独一个文件：这是**第二条载荷形状**，而它最容易坏的地方不是「字段对不对」，
// 而是**顺序**——`keepalive` 那一发与正常那一发会同时在路上：
//   · 同一个 seq 重复到达（重放）→ 必须整批跳过；
//   · 旧 seq 晚于新 seq 到达（乱序）→ 更是必须跳过，否则**用户刚改成黑的又被改回红**；
//   · 两台设备各自从 1 开始数 → 绝不能互相把对方吞掉。
// 这三条都不会报错、只会「看起来没生效」，所以在这里逐条钉住。
//
// ⚠ 走真 drizzle + `d1-shim` 内存库（真 SQL），断言从聚合表直接取。
// ⚠ **每一批都要带同一个匿名 cookie**：匿名身份就是那个 cookie，不带就是另一个人
//    （服务端第一次会发一个）—— 所以下面用 `session()` 模拟「同一个浏览器连着发几批」。

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { createD1, createStatSchema } from "./d1-shim";

const EDITION = "biff-2026";
const ORIGIN = "http://localhost:31028";

async function post(env: Env, body: unknown, cookie?: string): Promise<Response> {
  return app.request(
    `${ORIGIN}/api/stats/film-votes-ping`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

/** 一个「浏览器会话」：像真客户端那样把匿名 cookie 带着走。 */
function session(env: Env) {
  let cookie: string | undefined;
  return async (ops: unknown[], options: { clientId?: string; seq?: number } = {}) => {
    const { clientId = "dev-a", seq = 1 } = options;
    const response = await post(env, { edition: EDITION, ops, clientId, seq }, cookie);
    const set = response.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return response;
  };
}

const set = (
  key: string,
  vote: "red" | "black",
  comment: string | null = null,
  skin: string | null = null,
) => ({ op: "set" as const, key, vote, comment, skin });
const remove = (key: string) => ({ op: "remove" as const, key });

describe("增量上报（ops + seq）", () => {
  let sqlite: DatabaseSync;
  let env: Env;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    createStatSchema(sqlite);
    env = {
      APP_ENV: "local",
      APP_ORIGIN: ORIGIN,
      IFFDAY_ORIGIN: "http://127.0.0.1:5183",
      OIDC_CLIENT_ID: "biff-scheduler-local",
      OIDC_CLIENT_SECRET: "s".repeat(32),
      SESSION_SECRET: "unit-test-session-secret-at-least-32-chars",
      DB: createD1(sqlite),
    } as unknown as Env;
  });

  afterEach(() => {
    sqlite.close();
  });

  /** 聚合表原样（不经读侧白名单）—— 断言「票数真的变了没有」看它。 */
  function statOf(key: string): { red: number; black: number } | undefined {
    return sqlite
      .prepare("SELECT red_count AS red, black_count AS black FROM film_vote_stat WHERE film_key = ?")
      .get(key) as { red: number; black: number } | undefined;
  }

  function contributionCount(): number {
    return (sqlite.prepare("SELECT COUNT(*) AS n FROM film_vote_contribution").get() as { n: number }).n;
  }

  it("★ 一批 `set` op：票 / 评语 / 款三样都落库，响应回显批次号", async () => {
    const ping = session(env);
    const response = await ping([set("cat:f001", "red", "拉片细节绝了", "stub")]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, count: 1, appliedSeq: 1, skipped: false });

    expect(statOf("cat:f001")).toEqual({ red: 1, black: 0 });
    const row = sqlite
      .prepare("SELECT vote, comment, skin FROM film_vote_contribution WHERE film_key = 'cat:f001'")
      .get() as { vote: string; comment: string | null; skin: string | null };
    expect(row).toEqual({ vote: "red", comment: "拉片细节绝了", skin: "stub" });
  });

  it("★ 同一个 seq 重复到达：**整批跳过**（连内容变了也照样跳过 —— 判据是批次号，不是内容）", async () => {
    const ping = session(env);
    await ping([set("cat:f001", "red")], { seq: 1 });
    // 重放：同一个 seq，**内容故意换成另一部片** —— 被跳过才说明守卫真的在看批次号
    const replay = await ping([set("cat:f002", "red")], { seq: 1 });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ appliedSeq: 1, skipped: true });

    expect(statOf("cat:f001")).toEqual({ red: 1, black: 0 });
    expect(statOf("cat:f002")).toBeUndefined();
  });

  it("★ 旧批次晚到（乱序）：跳过，不能把用户刚改成的黑又改回红", async () => {
    const ping = session(env);
    await ping([set("cat:f001", "red")], { seq: 1 });
    await ping([set("cat:f001", "black")], { seq: 2 });
    expect(statOf("cat:f001")).toEqual({ red: 0, black: 1 });

    // 第 1 批（红）现在才到 —— 它比水位旧
    const late = await ping([set("cat:f001", "red")], { seq: 1 });
    expect(await late.json()).toMatchObject({ skipped: true });
    expect(statOf("cat:f001")).toEqual({ red: 0, black: 1 });
  });

  it("★ 水位按**设备**记：两台设备各自从 1 开始，谁的票都不该被吞掉", async () => {
    const deviceA = session(env);
    const deviceB = session(env);
    await deviceA([set("cat:f001", "red")], { clientId: "dev-a", seq: 1 });
    // 第二台设备（换设备 / 双开）：同一个 contributor（同一个人），但自己的 seq 也从 1 开始
    const second = await deviceB([set("cat:f002", "red")], { clientId: "dev-b", seq: 1 });
    expect(await second.json()).toMatchObject({ appliedSeq: 1, skipped: false });
    expect(statOf("cat:f002")).toEqual({ red: 1, black: 0 });

    // ⚠ 反过来说：**同一台设备**的旧批次仍然被跳过（水位分设备、不分内容）
    expect(await (await deviceA([set("cat:f003", "red")], { clientId: "dev-a", seq: 1 })).json()).toMatchObject({
      skipped: true,
    });
    expect(statOf("cat:f003")).toBeUndefined();
  });

  it("★ `remove` op 把那一票撤回（聚合同时归位）", async () => {
    const ping = session(env);
    await ping([set("cat:f001", "red"), set("cat:f002", "black")], { seq: 1 });
    const pruned = await ping([remove("cat:f001")], { seq: 2 });
    expect(pruned.status).toBe(200);

    expect(statOf("cat:f001")).toBeUndefined();
    expect(statOf("cat:f002")).toEqual({ red: 0, black: 1 });
    expect(contributionCount()).toBe(1);
  });

  it("同一批里同一部片出现多条 op：**以最后一条为准**（客户端会合并，但合并出错的载荷不该写坏）", async () => {
    const ping = session(env);
    await ping([set("cat:f001", "red"), set("cat:f001", "black", "还是黑的", "scrap")], { seq: 1 });
    expect(statOf("cat:f001")).toEqual({ red: 0, black: 1 });
    const row = sqlite
      .prepare("SELECT vote, comment, skin FROM film_vote_contribution WHERE film_key = 'cat:f001'")
      .get() as { vote: string; comment: string | null; skin: string | null };
    expect(row).toEqual({ vote: "black", comment: "还是黑的", skin: "scrap" });

    // set 之后又 remove → 这一票不在了（同一个 key 的两条 op 也是「最后一条为准」）
    await ping([set("cat:f002", "red"), remove("cat:f002")], { seq: 2 });
    expect(statOf("cat:f002")).toBeUndefined();
  });

  // ⚠ 断言的是**当前口径**：op 的**结构**错了（空 key / 非红非黑）→ 整批 422，一条都不写。
  //   这与整份替换那条路径是同一条口径（zod 挡结构、白名单收口在 store）。
  //   真要「丢掉坏的那一条、留下好的」得先回答「坏的那条算不算用户意图」—— 那不是服务端该猜的。
  it("（当前口径）op 结构坏了就整批 422，一条都不写", async () => {
    const ping = session(env);
    expect((await ping([{ op: "set", key: "", vote: "red" }])).status).toBe(422);
    expect((await ping([{ op: "set", key: "cat:f001", vote: "green" }])).status).toBe(422);
    expect((await ping([{ op: "nope", key: "cat:f001" }])).status).toBe(422);
    expect(contributionCount()).toBe(0);
    expect(statOf("cat:f001")).toBeUndefined();
  });

  it("★ 向后兼容：老客户端（整份替换）仍然可用；两者**二选一**，都带 = 422", async () => {
    const legacy = await post(env, {
      edition: EDITION,
      votes: [{ key: "cat:f001", vote: "red", comment: null, skin: null }],
    });
    expect(legacy.status).toBe(200);
    expect(statOf("cat:f001")).toEqual({ red: 1, black: 0 });

    // 两个都带：含糊的载荷比报错更难查（该按哪一份写？）—— 直接 422
    const both = await post(env, {
      edition: EDITION,
      votes: [{ key: "cat:f009", vote: "red", comment: null, skin: null }],
      ops: [set("cat:f009", "red")],
      clientId: "dev-a",
      seq: 1,
    });
    expect(both.status).toBe(422);

    // `ops` 缺 `clientId` / `seq` → 也 422（水位推不了，宁可不写）
    expect((await post(env, { edition: EDITION, ops: [set("cat:f009", "red")] })).status).toBe(422);
    expect(statOf("cat:f009")).toBeUndefined();
  });

  it("★ 撤光之后水位继续推进：同一台设备下一批仍然是新批次", async () => {
    const ping = session(env);
    await ping([set("cat:f001", "red")], { seq: 1 });
    await ping([remove("cat:f001")], { seq: 2 });
    expect(contributionCount()).toBe(0);

    // 水位到 2 了：再来一批 seq 2 必须被跳过，seq 3 才生效
    expect(await (await ping([set("cat:f002", "red")], { seq: 2 })).json()).toMatchObject({ skipped: true });
    expect(await (await ping([set("cat:f002", "red")], { seq: 3 })).json()).toMatchObject({ skipped: false });
    expect(statOf("cat:f002")).toEqual({ red: 1, black: 0 });
  });
});
