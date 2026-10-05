// 红黑榜聚合的**两条自愈能力**（2026-10-05，PLAN-20261005182415 §B）：
//   ① 写路径不再留下「贡献行有了、聚合没跟上」的半截状态（写组不可拆）；
//   ② 万一还是漂了（人工改库 / 历史遗留 / 任一次中途失败），`recountVoteStats` 能按贡献表修回来。
//
// 为什么这两条值得单独一个文件：它们对应的线上症状是**服务端能观测到、而且永不自愈**的
// ——`film_vote_contribution` 有我这一票，而榜上的数字不含它（用户侧就是「贴纸没上到榜」）。
// 老实现按 40 条**硬切**分块：贡献行全落在第 1 块、聚合行落在第 2 块，第 2 块一失败就正好是这个症状，
// 而之后任何一次重发都修不回来（贡献行已经等于那份载荷 ⇒ 差分为空 ⇒ `replaceContributorVotes` 直接 return）。
//
// ⚠ 断言打的是**真实行为**：`node:sqlite` 内存库跑 drizzle 生成的真 SQL，失败也是真的在第 k 次
//   `batch()` 上抛，不是 mock 出来的布尔量。

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { database } from "../src/db";
import { readVoteCounts, recountVoteStats, replaceContributorVotes } from "../src/film-vote-store";
import { STAT_BATCH_SIZE, chunkStatements } from "../src/stat-batch";
import { createD1, createShimStats, createStatSchema, type D1ShimStats } from "./d1-shim";

const EDITION = "biff-2026";

/* ---------------- ① 写组不可拆（纯函数） ---------------- */

describe("chunkStatements：切块只能落在写组边界上", () => {
  /** 只关心分组，语句本体是什么无所谓。 */
  const w = (group?: string) => ({ group });

  it("没有写组的语句（want / screening / ticket / telemetry 那一档）按 size 硬切", () => {
    const items = Array.from({ length: 7 }, () => w());
    expect(chunkStatements(items, 3).map((batch) => batch.length)).toEqual([3, 3, 1]);
  });

  it("★ 同组不被劈开：一块装满了、下一条又开了新组 → 先收口", () => {
    const items = [w("a"), w("a"), w("a"), w("b"), w("b")];
    const batches = chunkStatements(items, 3);
    expect(batches).toEqual([[w("a"), w("a"), w("a")], [w("b"), w("b")]]);
  });

  it("★ 宁可这一块装不满，也不把一组劈到两块里", () => {
    const items = [w("a"), w("a"), w("b"), w("b"), w("b")];
    const batches = chunkStatements(items, 3);
    // 老实现会切成 [a,a,b] + [b,b] —— 那一组的第二条就飞到了另一块
    expect(batches).toEqual([[w("a"), w("a")], [w("b"), w("b"), w("b")]]);
    for (const group of ["a", "b"]) {
      const owners = batches.filter((batch) => batch.some((item) => item.group === group));
      expect(owners).toHaveLength(1);
    }
  });

  it("单个写组比 size 还大时只能整块发，且**留一条 warn**（静默劈开就是那个半截状态）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const items = [w("big"), w("big"), w("big")];
    expect(chunkStatements(items, 2)).toEqual([items]);
    expect(warn.mock.calls.map((call) => call.join(" ")).join("\n")).toContain("stat_batch_group_oversize");
    warn.mockRestore();
  });
});

/* ---------------- ② 半截状态 / 重算 ---------------- */

describe("聚合不会半截，而且修得回来", () => {
  let sqlite: DatabaseSync;
  let stats: D1ShimStats;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    createStatSchema(sqlite);
    stats = createShimStats();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  /** 第 `failAt` 次 `batch()` 抛错 —— 模拟 D1 抖动 / isolate 被换掉 / 客户端 12s 超时掐断连接。 */
  function dbFailingAt(failAt: number): ReturnType<typeof database> {
    const shim = createD1(sqlite, stats);
    let calls = 0;
    const wrapped = {
      ...shim,
      batch: async (statements: { run(): Promise<unknown> }[]) => {
        calls += 1;
        if (calls === failAt) throw new Error("boom");
        return shim.batch(statements as never);
      },
    };
    return database(wrapped as unknown as D1Database);
  }

  function contributedFilms(edition: string): string[] {
    return (
      sqlite
        .prepare("SELECT film_key FROM film_vote_contribution WHERE edition = ? ORDER BY film_key")
        .all(edition) as { film_key: string }[]
    ).map((row) => row.film_key);
  }

  it("★ 中途失败时**不会**留下「贡献行有了、聚合没跟上」（老实现按 40 条硬切就正好是这个症状）", async () => {
    // 40 部片 → 每部片一个写组（贡献行 + 聚合 + 日桶），分组后必定跨多个批次
    const keys = Array.from({ length: 40 }, (_, index) => `f${String(index).padStart(3, "0")}`);
    const votes = new Map(keys.map((key) => [key, "red" as const]));

    const db = dbFailingAt(2);
    await expect(replaceContributorVotes(db, EDITION, "c1", votes)).rejects.toThrow("boom");

    // 失败确实发生在中途（有落下去的、也有没落下去的）
    const persisted = await readVoteCounts(database(createD1(sqlite)), EDITION);
    const persistedCount = Object.keys(persisted).length;
    expect(persistedCount).toBeGreaterThan(0);
    expect(persistedCount).toBeLessThan(keys.length);

    // ★ 不变量：**贡献行存在 ⇔ 聚合行正确**。少任何一侧都是「永不修复」的半截状态
    const contributed = contributedFilms(EDITION);
    expect(contributed).toHaveLength(persistedCount);
    for (const key of keys) {
      if (contributed.includes(key)) expect(persisted[key]).toEqual({ red: 1, black: 0 });
      else expect(persisted[key]).toBeUndefined();
    }
  });

  it("★ recount 按贡献表把漂掉的聚合修回来（含归零残行、按款桶）", async () => {
    const db = database(createD1(sqlite));
    await replaceContributorVotes(db, EDITION, "c1", new Map([
      ["f001", "red"],
      ["f002", "black"],
    ]), { skins: new Map([["f001", "stub"]]) });

    // 手工把两张表打歪（模拟半截提交 / 人工改库）
    sqlite.prepare("UPDATE film_vote_stat SET red_count = 0 WHERE film_key = 'f001'").run();
    sqlite
      .prepare("INSERT INTO film_vote_stat (edition, film_key, red_count, black_count, updated_at) VALUES (?,?,?,?,?)")
      .run(EDITION, "f999", 5, 5, 0); // 零票残行
    sqlite
      .prepare("INSERT INTO film_vote_skin_stat (edition, film_key, skin, vote, count, updated_at) VALUES (?,?,?,?,?,?)")
      .run(EDITION, "f001", "sprocket", "red", 7, 0); // 没有人投过的款

    const result = await recountVoteStats(db, EDITION);
    expect(result.gaps).toBe(0);
    expect(await readVoteCounts(db, EDITION)).toEqual({
      f001: { red: 1, black: 0 },
      f002: { red: 0, black: 1 },
    });
    expect(
      sqlite.prepare("SELECT skin, vote, count FROM film_vote_skin_stat WHERE edition = ? ORDER BY skin, vote").all(EDITION),
    ).toEqual([{ skin: "stub", vote: "red", count: 1 }]);

    // ⚠ 幂等：连跑两次结果一致（运维可以放心重试）
    expect(await recountVoteStats(db, EDITION)).toEqual(result);
  });

  it("票被撤光 → recount 把聚合行删干净（「归零即删行」是这张表既有的口径）", async () => {
    const db = database(createD1(sqlite));
    await replaceContributorVotes(db, EDITION, "c1", new Map([["f001", "red"]]));
    // 只删贡献行、不动聚合 —— 模拟历史遗留的孤儿聚合行
    sqlite.prepare("DELETE FROM film_vote_contribution WHERE edition = ?").run(EDITION);

    const result = await recountVoteStats(db, EDITION);
    expect(result.films).toBe(0);
    expect(result.gaps).toBe(0);
    expect(await readVoteCounts(db, EDITION)).toEqual({});
  });

  // 分块与批次的**规模**本身也钉一下：分组只该让块「装不满」，不该让它爆炸
  it("分组不会让批次规模失控（每块 ≤ size + 最长写组 - 1）", async () => {
    const db = database(createD1(sqlite, stats));
    await replaceContributorVotes(
      db,
      EDITION,
      "c1",
      new Map(Array.from({ length: 40 }, (_, index) => [`f${index}`, "red" as const])),
    );
    expect(stats.batches).toBeGreaterThan(1);
    expect(stats.outsideRuns).toBe(0);
    // 40 部片 × 3 条语句 = 120 条；每块 39 条（13 个写组）+ 收尾块
    expect(stats.statementsInBatch).toBe(120);
    expect(Math.ceil(stats.statementsInBatch / STAT_BATCH_SIZE)).toBeLessThanOrEqual(stats.batches);
  });
});
