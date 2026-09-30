// 贴纸**按款聚合**（2026-09-29）。
//
// 为什么单独一个文件：这一批改动的风险全在「两本账必须同拍」——
//   `film_vote_stat`（两色总数，权威）与 `film_vote_skin_stat`（按款细分）是分开写的两张表，
//   少减一次 / 多减一次**不会报错**，只会让展板上的群点比卡片上的数字多一枚或少一枚，
//   而且**永不自愈**（聚合只在「贡献行有差分」时修正）。所以这里逐条钉死
//   增 / 减 / 改款 / 改色 / 撤票 / 只改款这六种差分。
//
// ⚠ 跑的是一整套真 SQL（drizzle 生成的语句 + `node:sqlite` 垫片），不是断言实现。

import { DatabaseSync } from "node:sqlite";
import type { StickerSkin } from "@biff/contracts/sticker";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { database } from "../src/db";
import { formatSkinCounts, normalizeSkin } from "../src/film-vote-stats";
import {
  claimContributorVotes,
  readContributorVotes,
  readRecentComments,
  readSkinCounts,
  readVoteCounts,
  replaceContributorVotes,
} from "../src/film-vote-store";
import app from "../src/index";
import { createD1, createStatSchema } from "./d1-shim";

const EDITION = "biff-2026";
const ORIGIN = "http://localhost:31028";

/** 某个贡献者在库里那一行的款列（直接问库，不走任何白名单——它要能看见脏数据）。 */
function storedSkin(sqlite: DatabaseSync, contributor: string, filmKey: string): unknown {
  const row = sqlite
    .prepare("SELECT skin FROM film_vote_contribution WHERE edition = ? AND contributor = ? AND film_key = ?")
    .get(EDITION, contributor, filmKey) as { skin: unknown } | undefined;
  return row?.skin ?? null;
}

/** 按款聚合表里的全部行（用来断言「0 行应该被删掉」这类表层面的事实）。 */
function skinRows(sqlite: DatabaseSync): Array<{ skin: string; vote: string; count: number }> {
  return sqlite
    .prepare("SELECT skin, vote, count FROM film_vote_skin_stat ORDER BY skin, vote")
    .all() as Array<{ skin: string; vote: string; count: number }>;
}

describe("normalizeSkin（纯函数：款的唯一收口）", () => {
  it("白名单内原样通过，其余一律 null", () => {
    expect(normalizeSkin("stub")).toBe("stub");
    expect(normalizeSkin("reel")).toBe("reel");
    // 不是字符串的那几档 —— 它的调用方全是不可信来源（上报载荷 / 被改过的库行）
    expect(normalizeSkin(undefined)).toBeNull();
    expect(normalizeSkin(null)).toBeNull();
    expect(normalizeSkin(42)).toBeNull();
    expect(normalizeSkin({})).toBeNull();
    // 「长得像但不是」的一律不猜
    expect(normalizeSkin("STUB")).toBeNull();
    expect(normalizeSkin("torn ")).toBeNull();
    expect(normalizeSkin("")).toBeNull();
  });
});

describe("formatSkinCounts（纯函数：聚合行 → 稀疏字典）", () => {
  it("按片与款归并两色；计数 ≤ 0 的桶不出现", () => {
    expect(
      formatSkinCounts([
        { film_key: "f001", skin: "stub", vote: "red", count: 2 },
        { film_key: "f001", skin: "stub", vote: "black", count: 1 },
        { film_key: "f002", skin: "reel", vote: "black", count: 3 },
        { film_key: "f003", skin: "torn", vote: "red", count: 0 },
      ]),
    ).toEqual({
      f001: { stub: { red: 2, black: 1 } },
      f002: { reel: { red: 0, black: 3 } },
    });
  });

  it("脏行丢弃：款不在白名单 / 颜色不是红黑的都不进结果", () => {
    expect(
      formatSkinCounts([
        { film_key: "f001", skin: "nope", vote: "red", count: 5 },
        { film_key: "f001", skin: "stub", vote: "purple", count: 5 },
        { film_key: "f001", skin: "stub", vote: "red", count: -3 },
        { film_key: "f001", skin: "reel", vote: "red", count: "4" },
      ]),
    ).toEqual({ f001: { reel: { red: 4, black: 0 } } });
  });
});

describe("按款聚合的写路径（d1 垫片，跑真 SQL）", () => {
  let sqlite: DatabaseSync;
  let db: ReturnType<typeof database>;
  const skins = (entries: Array<[string, StickerSkin | null]>) => new Map(entries);

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    createStatSchema(sqlite);
    db = database(createD1(sqlite));
  });

  afterEach(() => {
    sqlite.close();
  });

  it("贴上第一枚：两本账同时记上", async () => {
    await replaceContributorVotes(db, EDITION, "u1", new Map([["f001", "red"]]), {
      skins: skins([["f001", "stub"]]),
    });
    expect(await readVoteCounts(db, EDITION)).toEqual({ f001: { red: 1, black: 0 } });
    expect(await readSkinCounts(db, EDITION)).toEqual({ f001: { stub: { red: 1, black: 0 } } });
    expect(storedSkin(sqlite, "u1", "f001")).toBe("stub");
  });

  it("★ 只换款：旧款 −1、新款 +1，总数**一枚都不动**", async () => {
    await replaceContributorVotes(db, EDITION, "u1", new Map([["f001", "red"]]), {
      skins: skins([["f001", "stub"]]),
    });
    await replaceContributorVotes(db, EDITION, "u1", new Map([["f001", "red"]]), {
      skins: skins([["f001", "reel"]]),
    });
    // 票与颜色都没变 → 总数那条路径根本不该被触发（`diffVotes` 看不见这次编辑）
    expect(await readVoteCounts(db, EDITION)).toEqual({ f001: { red: 1, black: 0 } });
    expect(await readSkinCounts(db, EDITION)).toEqual({ f001: { reel: { red: 1, black: 0 } } });
    // 旧桶要**真的被删行**，而不是留一个 count = 0
    expect(skinRows(sqlite)).toEqual([{ skin: "reel", vote: "red", count: 1 }]);
  });

  it("★ 改色同时带着款一起走：旧 (款,色) 减、新 (款,色) 加", async () => {
    await replaceContributorVotes(db, EDITION, "u1", new Map([["f001", "red"]]), {
      skins: skins([["f001", "stub"]]),
    });
    await replaceContributorVotes(db, EDITION, "u1", new Map([["f001", "black"]]), {
      skins: skins([["f001", "reel"]]),
    });
    expect(await readVoteCounts(db, EDITION)).toEqual({ f001: { red: 0, black: 1 } });
    expect(await readSkinCounts(db, EDITION)).toEqual({ f001: { reel: { red: 0, black: 1 } } });
  });

  it("★ 撤票：按款那一行也要归零删行", async () => {
    await replaceContributorVotes(db, EDITION, "u1", new Map([["f001", "red"]]), {
      skins: skins([["f001", "stub"]]),
    });
    await replaceContributorVotes(db, EDITION, "u1", new Map(), { skins: new Map() });
    expect(await readVoteCounts(db, EDITION)).toEqual({});
    expect(await readSkinCounts(db, EDITION)).toEqual({});
    expect(skinRows(sqlite)).toEqual([]);
  });

  it("★ 不给 `skins` 这一份时，款原样保留（认领迁移 / 管理端删票走这条）", async () => {
    await replaceContributorVotes(db, EDITION, "u1", new Map([["f001", "red"]]), {
      skins: skins([["f001", "stub"]]),
    });
    // 改色，但**不**给 skins —— 「不给」与「给了一份空的」是两件事
    await replaceContributorVotes(db, EDITION, "u1", new Map([["f001", "black"]]));
    expect(storedSkin(sqlite, "u1", "f001")).toBe("stub");
    // 款式没被抹掉，而且按款聚合跟着颜色搬过去了
    expect(await readSkinCounts(db, EDITION)).toEqual({ f001: { stub: { red: 0, black: 1 } } });
  });

  it("★ 旧版前端（整个载荷一个 skin 都没有）：款列为 null，但票照常记", async () => {
    // 这是本次改动最要紧的回归守卫：老客户端不带这个字段，**不许**因此丢票或报错
    await replaceContributorVotes(db, EDITION, "old-client", new Map([["f002", "black"]]));
    expect(await readVoteCounts(db, EDITION)).toEqual({ f002: { red: 0, black: 1 } });
    expect(await readSkinCounts(db, EDITION)).toEqual({});
    expect(storedSkin(sqlite, "old-client", "f002")).toBeNull();
  });

  it("非法的款：只当「没带款」处理，票照常记，聚合里不出现", async () => {
    await replaceContributorVotes(db, EDITION, "u1", new Map([["f001", "red"]]), {
      skins: new Map([["f001", "definitely-not-a-skin" as StickerSkin]]),
    });
    expect(await readVoteCounts(db, EDITION)).toEqual({ f001: { red: 1, black: 0 } });
    expect(await readSkinCounts(db, EDITION)).toEqual({});
    expect(storedSkin(sqlite, "u1", "f001")).toBeNull();
  });

  it("库里那一行的款被人工改成白名单外的值时：票照常搬，旧的按款行会留下", async () => {
    await replaceContributorVotes(db, EDITION, "u1", new Map([["f001", "red"]]), {
      skins: skins([["f001", "stub"]]),
    });
    // 模拟人工改库（正常写路径永远过白名单，落不出这种值）
    sqlite.prepare("UPDATE film_vote_contribution SET skin = 'garbage' WHERE contributor = 'u1'").run();
    await replaceContributorVotes(db, EDITION, "u1", new Map([["f001", "black"]]));

    // ⚠ 这里断言的是**当前实际行为**，不是「理想行为」（AGENTS §3：不得为让测试变绿改实现）：
    //   票这一侧完全正确（红 → 黑），但按款那一侧**减不掉** —— `prevSkins` 走白名单得出 `null`，
    //   我们无从知道该减哪个桶（库里那一行已经不可信）。于是旧桶留下、新桶不写。
    //   后果：群点会比卡片上的数字多一枚。这只可能来自人工改库，与 `stat_drift` 同类；
    //   真正的操作约束写在 `film-vote-store.ts` 的 `prevSkins` 旁边（**将来删掉某一款皮肤时必须清表**）。
    expect(await readVoteCounts(db, EDITION)).toEqual({ f001: { red: 0, black: 1 } });
    expect(await readSkinCounts(db, EDITION)).toEqual({ f001: { stub: { red: 1, black: 0 } } });
  });

  it("两个贡献者投同一部片的同一款：聚合成 2，不是覆盖", async () => {
    await replaceContributorVotes(db, EDITION, "u1", new Map([["f001", "red"]]), {
      skins: skins([["f001", "stub"]]),
    });
    await replaceContributorVotes(db, EDITION, "u2", new Map([["f001", "red"]]), {
      skins: skins([["f001", "stub"]]),
    });
    expect(await readSkinCounts(db, EDITION)).toEqual({ f001: { stub: { red: 2, black: 0 } } });
    expect(skinRows(sqlite)).toEqual([{ skin: "stub", vote: "red", count: 2 }]);
  });

  it("★ 认领迁移：款跟着票一起搬（不搬的话票还在、款变回默认，且聚合当场偏掉）", async () => {
    await replaceContributorVotes(db, EDITION, "anon:x", new Map([["f001", "red"]]), {
      skins: skins([["f001", "stub"]]),
    });
    await replaceContributorVotes(db, EDITION, "sub-1", new Map([["f002", "black"]]), {
      skins: skins([["f002", "reel"]]),
    });
    await claimContributorVotes(db, EDITION, "anon:x", "sub-1");
    expect(await readSkinCounts(db, EDITION)).toEqual({
      f001: { stub: { red: 1, black: 0 } },
      f002: { reel: { red: 0, black: 1 } },
    });
    expect(storedSkin(sqlite, "sub-1", "f001")).toBe("stub");
    // 源那几行被清掉后，它的聚合也必须一起清干净（否则群点会永远多一枚）
    expect(skinRows(sqlite)).toHaveLength(2);
    expect(await readContributorVotes(db, EDITION, "anon:x")).toHaveLength(0);
  });
});

describe("评语按片读（卡片级讨论区用的那条过滤）", () => {
  let sqlite: DatabaseSync;
  let db: ReturnType<typeof database>;

  beforeEach(async () => {
    sqlite = new DatabaseSync(":memory:");
    createStatSchema(sqlite);
    db = database(createD1(sqlite));
    await replaceContributorVotes(db, EDITION, "u1", new Map([["f001", "red"]]), {
      comments: new Map([["f001", "第一部好看"]]),
      displayName: "阿一",
    });
    await replaceContributorVotes(db, EDITION, "u2", new Map([["f002", "black"]]), {
      comments: new Map([["f002", "第二部避雷"]]),
    });
    // 一个**没写评语**的票：它不该出现在评语页里（口径就是「只列写了评语的人」）
    await replaceContributorVotes(db, EDITION, "u3", new Map([["f001", "black"]]));
  });

  afterEach(() => {
    sqlite.close();
  });

  it("带 filmKey 只回那一片；不带就回全场", async () => {
    const one = await readRecentComments(db, EDITION, null, 20, { filmKey: "f001" });
    expect(one.rows.map((row) => row.film_key)).toEqual(["f001"]);
    const all = await readRecentComments(db, EDITION, null, 20);
    expect(all.rows.map((row) => row.film_key).sort()).toEqual(["f001", "f002"]);
  });

  it("filmKey 传 null / 空串 = 没有过滤（容错，与游标的容错同一条口径）", async () => {
    expect((await readRecentComments(db, EDITION, null, 20, { filmKey: null })).rows).toHaveLength(2);
    expect((await readRecentComments(db, EDITION, null, 20, { filmKey: "" })).rows).toHaveLength(2);
  });

  it("没写评语的行不出现（放开它等于把「谁贴了什么」变成公开名单）", async () => {
    const rows = (await readRecentComments(db, EDITION, null, 20, { filmKey: "f001" })).rows;
    expect(rows).toHaveLength(1);
    // u3 那一票是黑、没评语 —— 聚合里数得到，评语页里读不到
    expect(await readVoteCounts(db, EDITION)).toEqual({ f001: { red: 1, black: 1 }, f002: { red: 0, black: 1 } });
  });
});

describe("HTTP 边界：公开读接口的响应形状", () => {
  let sqlite: DatabaseSync;
  let db: ReturnType<typeof database>;
  let env: Env;

  beforeEach(async () => {
    sqlite = new DatabaseSync(":memory:");
    createStatSchema(sqlite);
    db = database(createD1(sqlite));
    env = {
      APP_ENV: "local",
      APP_ORIGIN: ORIGIN,
      IFFDAY_ORIGIN: "http://127.0.0.1:5183",
      OIDC_CLIENT_ID: "biff-scheduler-local",
      OIDC_CLIENT_SECRET: "s".repeat(32),
      SESSION_SECRET: "unit-test-session-secret-at-least-32-chars",
      DB: createD1(sqlite),
    } as unknown as Env;
    await replaceContributorVotes(db, EDITION, "u1", new Map([["f001", "red"]]), {
      skins: new Map([["f001", "stub"]]),
    });
  });

  afterEach(() => {
    sqlite.close();
  });

  it("★ `/api/stats/film-votes` 同时回两色总数与按款细分（前端一次往返就能画群点）", async () => {
    const response = await app.request(`${ORIGIN}/api/stats/film-votes?edition=${EDITION}`, {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      edition: EDITION,
      votes: { f001: { red: 1, black: 0 } },
      skins: { f001: { stub: { red: 1, black: 0 } } },
    });
  });

  it("★ 响应体里**没有**任何身份字段 —— 皮肤是聚合，不是名单", async () => {
    const response = await app.request(`${ORIGIN}/api/stats/film-votes?edition=${EDITION}`, {}, env);
    const body = JSON.stringify(await response.json());
    // 这条是把「只回聚合」的口径钉在**响应体**上，而不是只写在注释里
    expect(body).not.toContain("u1");
    expect(body).not.toContain("contributor");
    expect(body).not.toContain("displayName");
  });

  it("按片读评语：非法 / 超长的 filmKey 当作没有过滤，而不是 422", async () => {
    const tooLong = "x".repeat(200);
    const response = await app.request(
      `${ORIGIN}/api/stats/film-comments?edition=${EDITION}&filmKey=${tooLong}`,
      {},
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });
});
