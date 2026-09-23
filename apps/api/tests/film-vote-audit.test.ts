import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { database } from "../src/db";
import {
  ANON_PREFIX,
  auditVoteRows,
  readVoteRows,
  replaceContributorVotes,
  type VoteRow,
} from "../src/film-vote-store";
import { createD1, createShimStats, createStatSchema, type D1ShimStats } from "./d1-shim";

/**
 * 红黑榜投票行的「按访问者分档」投影（2026-09-23，PLAN-20260923124402）。
 *
 * 由来：线上贴纸只能看到聚合数，查不出「这枚是不是我贴的」。而**登录态一旦丢失**，同一个人会以
 * 「subject + anon」两个身份各占一行（去重只做了「匿名 → 登录」半个方向，见
 * `screening-stats-store.ts::clearAnonContributions`），匿名行在 cookie 丢失后永远撤不掉。
 * 自查接口要回答的就是：哪几行在我名下、哪几行是别人（含匿名）、**本浏览器匿名 cookie 命中哪几行**。
 *
 * ⚠ 断言里刻意盯住「不回 contributor 原文」：这是全站唯一一处会读到「谁投的」的地方，
 *   一旦有人把原始行接进响应体，隐私口径就破了，所以要有测试挡着。
 */

const EDITION = "biff-2026";

describe("auditVoteRows（纯投影）", () => {
  const SUBJECT = "subject-me";
  const ANON = `${ANON_PREFIX}hash-this-browser`;

  /** 一个典型的「同一人两个身份」现场：f001 是登录期贴的，f002 是丢登录态后匿名贴的。 */
  const rows: VoteRow[] = [
    { film_key: "cat:f001", contributor: SUBJECT, vote: "red", updated_at: 300 },
    { film_key: "cat:f002", contributor: ANON, vote: "black", updated_at: 200 },
    { film_key: "cat:f003", contributor: `${ANON_PREFIX}hash-别的机器`, vote: "red", updated_at: 100 },
    { film_key: "cat:f004", contributor: "subject-别人", vote: "black", updated_at: 50 },
    { film_key: "cat:f005", contributor: SUBJECT, vote: "被人工改过的坏值", updated_at: 10 },
  ];

  it("我名下的行进 mine，其余进 others，且保持传入顺序", () => {
    const audit = auditVoteRows(rows, { subject: SUBJECT, anonContributor: null });
    expect(audit.mine.map((row) => row.filmKey)).toEqual(["cat:f001"]);
    expect(audit.others.map((row) => row.filmKey)).toEqual(["cat:f002", "cat:f003", "cat:f004"]);
  });

  it("白名单外的坏 vote 行一律丢弃（连我自己的那条也不展示）", () => {
    const audit = auditVoteRows(rows, { subject: SUBJECT, anonContributor: null });
    const all = [...audit.mine, ...audit.others];
    expect(all.some((row) => row.filmKey === "cat:f005")).toBe(false);
  });

  it("anonymous 只看前缀：匿名行 true，登录行 false", () => {
    const audit = auditVoteRows(rows, { subject: SUBJECT, anonContributor: null });
    expect(audit.mine.map((row) => row.anonymous)).toEqual([false]);
    expect(audit.others.map((row) => row.anonymous)).toEqual([true, true, false]);
  });

  it("本浏览器匿名 cookie 命中 → matched 给出那几行（含「同一人两个身份」这个现场）", () => {
    const audit = auditVoteRows(rows, { subject: SUBJECT, anonContributor: ANON });
    expect(audit.thisBrowser.hasAnonCookie).toBe(true);
    expect(audit.thisBrowser.matched.map((row) => row.filmKey)).toEqual(["cat:f002"]);
    // 命中不影响分档：那行依然是「别人（匿名）」，因为它不属于我的登录 subject
    expect(audit.others.map((row) => row.filmKey)).toContain("cat:f002");
  });

  it("没有匿名 cookie → hasAnonCookie=false、matched 为空（cookie 已失联的现场）", () => {
    const audit = auditVoteRows(rows, { subject: SUBJECT, anonContributor: null });
    expect(audit.thisBrowser).toEqual({ hasAnonCookie: false, matched: [] });
  });

  it("★ 不回 contributor 原文：返回行的字段只有四个，且不含身份", () => {
    const audit = auditVoteRows(rows, { subject: SUBJECT, anonContributor: ANON });
    for (const row of [...audit.mine, ...audit.others, ...audit.thisBrowser.matched]) {
      // ⚠ 字段名一并锁死：DTO 走 camelCase（与其它接口一致），库里的 snake_case 不得漏到响应体
      expect(Object.keys(row).sort()).toEqual(["anonymous", "filmKey", "updatedAt", "vote"]);
    }
    expect(JSON.stringify(audit)).not.toContain(SUBJECT);
    expect(JSON.stringify(audit)).not.toContain("hash-this-browser");
  });
});

describe("readVoteRows（d1 垫片，跑真 SQL）", () => {
  let sqlite: DatabaseSync;
  let stats: D1ShimStats;
  let db: ReturnType<typeof database>;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    createStatSchema(sqlite);
    stats = createShimStats();
    db = database(createD1(sqlite, stats));
  });

  afterEach(() => {
    sqlite.close();
  });

  it("按 edition 收窄、按 updated_at 降序，且能同时读到匿名与登录两种身份", async () => {
    await replaceContributorVotes(db, EDITION, "subject-me", new Map([["cat:f001", "red"]]));
    await replaceContributorVotes(db, EDITION, `${ANON_PREFIX}h1`, new Map([["cat:f002", "black"]]));
    // 另一个 edition 的行不该出现
    await replaceContributorVotes(db, "biff-2027", "subject-me", new Map([["cat:f999", "red"]]));

    const rows = await readVoteRows(db, EDITION);
    expect(rows.map((row) => row.film_key)).toEqual(["cat:f002", "cat:f001"]);
    expect(new Set(rows.map((row) => row.contributor))).toEqual(
      new Set(["subject-me", `${ANON_PREFIX}h1`]),
    );

    const audit = auditVoteRows(rows, { subject: "subject-me", anonContributor: `${ANON_PREFIX}h1` });
    expect(audit.mine.map((row) => row.filmKey)).toEqual(["cat:f001"]);
    expect(audit.thisBrowser.matched.map((row) => row.filmKey)).toEqual(["cat:f002"]);
  });

  it("limit 生效（防止行数长大后把整个 isolate 拖垮）", async () => {
    await replaceContributorVotes(
      db,
      EDITION,
      "subject-me",
      new Map([
        ["cat:f001", "red"],
        ["cat:f002", "black"],
        ["cat:f003", "red"],
      ]),
    );
    // ⚠ 计数要**读前快照**再比：写入本身也会进 batch，直接断言 0 是在断言 setUp 而不是读路径
    const before = { ...stats };
    const rows = await readVoteRows(db, EDITION, 2);
    expect(rows).toHaveLength(2);
    // 读路径只读贡献表：不动聚合表、不写任何东西
    expect(stats.batches).toBe(before.batches);
    expect(stats.outsideRuns).toBe(before.outsideRuns);
  });
});
