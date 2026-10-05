// 红黑榜上报接口的**前后端契约**（2026-09-30）。
//
// 为什么单独一个文件：这条 ping 是全站唯一「客户端拼载荷、服务端解析」的地方，而它此前
// **一个端点级测试都没有** —— api 侧的用例测的是 `replaceContributorVotes` 这些模块函数，
// E2E 侧把这条路由整个 stub 掉（只断言「载荷里有 comment」）。于是「前端每条都带
// `comment: null` / `skin: null`，服务端的 zod 只收 `z.string()`」这种对不上
// **两边各自都是绿的**，而线上表现是：**每一次上报都 422** → 票 / 评语 / 款一个字都写不进去，
// 讨论区永远是空的（用户 2026-09-30 报的就是这个）。
//
// 所以这里断言的是**真实行为**：拿 `redblack.ts::votesOf()` 真正会发的那份载荷去打真接口，
// 走真 drizzle + `d1-shim` 内存库，最后从**公开读接口**把评语读回来。

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// ⚠ `Env` 是 `wrangler types` 生成的**全局**类型（`worker-configuration.d.ts`），
//   不需要也不能 import —— 它不是 `src/` 下的模块。
import app from "../src/index";
import { createD1, createStatSchema } from "./d1-shim";

const EDITION = "biff-2026";
const ORIGIN = "http://localhost:31028";

/** 前端 `redblack.ts::votesOf()` 会发出的那一条 —— **`comment` / `skin` 永远在**，
 *  没写评语 / 没选款时是 `null`。这不是「顺手带上」，而是服务端分辨新旧前端的唯一信号
 *  （见 `index.ts` 里 `carriesComments` / `carriesSkins` 那两段说明）：
 *  服务端一旦把这个形状判成非法，损失的不只是评语，**连票都写不进去**。 */
function entry(
  key: string,
  vote: "red" | "black",
  comment: string | null = null,
  skin: string | null = null,
) {
  return { key, vote, comment, skin };
}

/** 一次真实上报（与前端 `sendVotes` 同形状：POST + JSON + 同源 Origin）。
 *  ⚠ `cookie` 要传同一个匿名 cookie 才是**同一个人**：匿名身份就是那个 cookie，
 *    不带就是另一个 contributor（测「我撤了票」必须带上，否则测的是「别人投了一票」）。 */
async function ping(
  env: Env,
  votes: Array<ReturnType<typeof entry>>,
  cookie?: string,
): Promise<Response> {
  return app.request(
    `${ORIGIN}/api/stats/film-votes-ping`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ edition: EDITION, votes }),
    },
    env,
  );
}

describe("上报载荷的前后端契约：前端真的会发的形状，服务端必须收下", () => {
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

  it("★ 每条都带 `comment: null` / `skin: null` → 200（这一档此前是 422，整份载荷被丢掉）", async () => {
    const response = await ping(env, [entry("cat:f001", "red")]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, count: 1 });
    // 票**真的**落库了 —— 422 那一版连这一条都写不进去（用户看到的「贴了但榜上不涨」）
    const stored = sqlite
      .prepare("SELECT vote, comment, skin FROM film_vote_contribution WHERE film_key = 'cat:f001'")
      .get() as { vote: string; comment: unknown; skin: unknown } | undefined;
    expect(stored?.vote).toBe("red");
    expect(stored?.comment ?? null).toBeNull();
    expect(stored?.skin ?? null).toBeNull();
  });

  it("★ 带评语 + 款的那一条：票、款、评语三样都落库，且评语从公开读接口读得回来", async () => {
    const response = await ping(env, [entry("cat:f001", "red", "拉片细节绝了", "stub")]);
    expect(response.status).toBe(200);

    const comments = await app.request(
      `${ORIGIN}/api/stats/film-comments?edition=${EDITION}&filmKey=cat:f001`,
      { headers: { origin: ORIGIN } },
      env,
    );
    expect(comments.status).toBe(200);
    const body = (await comments.json()) as {
      items: Array<{ filmKey: string; vote: string; comment: string }>;
    };
    expect(body.items).toEqual([
      { filmKey: "cat:f001", vote: "red", comment: "拉片细节绝了", displayName: null },
    ]);

    // 款也进了聚合 —— 展板上的群点按它画
    const votes = await app.request(`${ORIGIN}/api/stats/film-votes?edition=${EDITION}`, {}, env);
    expect(await votes.json()).toEqual({
      edition: EDITION,
      votes: { "cat:f001": { red: 1, black: 0 } },
      skins: { "cat:f001": { stub: { red: 1, black: 0 } } },
    });
  });

  it("★ 一条带评语、一条 `null`（同一份载荷混发）：两票都落库，只有那一条进讨论区", async () => {
    const response = await ping(env, [
      entry("cat:f001", "red", "有评语", "sprocket"),
      entry("cat:f002", "black"),
    ]);
    expect(response.status).toBe(200);

    const comments = await app.request(
      `${ORIGIN}/api/stats/film-comments?edition=${EDITION}`,
      { headers: { origin: ORIGIN } },
      env,
    );
    const body = (await comments.json()) as { items: Array<{ filmKey: string }> };
    expect(body.items.map((item) => item.filmKey)).toEqual(["cat:f001"]);

    const votes = await app.request(`${ORIGIN}/api/stats/film-votes?edition=${EDITION}`, {}, env);
    const counts = (await votes.json()) as {
      votes: Record<string, { red: number; black: number }>;
    };
    expect(Object.keys(counts.votes).sort()).toEqual(["cat:f001", "cat:f002"]);
  });

  it("撤票（空表）也是合法载荷：把这一份清空，服务端据此删掉我的票", async () => {
    const first = await ping(env, [entry("cat:f001", "red")]);
    // 服务端第一次就给这一位匿名访客发了 cookie —— 撤票要用**同一个**身份发
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie).not.toBe("");
    const cleared = await ping(env, [], cookie);
    expect(cleared.status).toBe(200);
    const stored = sqlite.prepare("SELECT COUNT(*) AS n FROM film_vote_contribution").get() as {
      n: number;
    };
    expect(stored.n).toBe(0);
  });
});
