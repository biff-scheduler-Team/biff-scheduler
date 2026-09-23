import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { database } from "../src/db";
import { readVoteCounts, replaceContributorVotes } from "../src/film-vote-store";
import { readScreeningCounts, replaceContributorScreenings } from "../src/screening-stats-store";
import { applyContributorTelemetry, readTelemetryCounts } from "../src/telemetry-store";
import { readTicketCounts, replaceContributorTickets } from "../src/ticket-stats-store";
import { replaceContributorWants } from "../src/want-store";
import { createD1, createShimStats, createStatSchema, type D1ShimStats } from "./d1-shim";

/**
 * 计数聚合的**并发正确性**与**往返次数**（2026-09-23，PLAN-20260923111748，B1）。
 *
 * 覆盖两条线上症状：
 *   ① 聚合表用「SELECT → JS 加减 → UPDATE」维护，D1 没有跨语句事务 —— 并发上报同一部片会丢更新，
 *      且 `replaceContributorWants` 只在「贡献行有差分」时修正聚合，丢掉的量**永远不会自愈**；
 *   ② 单次上报逐条 await（每条 2–3 次 D1 往返），500 条上限下最坏 ~1500 次串行往返 —— 请求路径上超时。
 *
 * ⚠ 断言打的是**真实行为**：`node:sqlite` 内存库跑 drizzle 生成的真 SQL，
 *   连并发也是靠 `Promise.all` 真实交错（微任务队列），不是 mock 出来的。
 */

const EDITION = "biff-2026";

describe("计数聚合：原子性与往返次数", () => {
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
    vi.restoreAllMocks();
    sqlite.close();
  });

  /** 直接读聚合表原始文本（不经展示层的四舍五入）—— 丢更新要看的就是这一格。 */
  function weightSum(filmKey: string): string | undefined {
    const row = sqlite
      .prepare("SELECT weight_sum FROM film_want_stat WHERE edition = ? AND film_key = ?")
      .get(EDITION, filmKey) as { weight_sum?: string } | undefined;
    return row?.weight_sum;
  }

  function contributorCount(filmKey: string): number {
    const row = sqlite
      .prepare("SELECT COUNT(*) AS n FROM film_want_contribution WHERE edition = ? AND film_key = ?")
      .get(EDITION, filmKey) as { n: number };
    return row.n;
  }

  it("★ 两位贡献者并发给同一部片加权：聚合必须等于两人之和（读-改-写会丢更新）", async () => {
    // 先让聚合行存在（第一位贡献者建立了它）—— 这正是「读-改-写」会走 update 分支的前提
    await replaceContributorWants(db, EDITION, "c1", 1, ["f001"]);
    expect(weightSum("f001")).toBe("1");

    await Promise.all([
      replaceContributorWants(db, EDITION, "c2", 1, ["f001"]),
      replaceContributorWants(db, EDITION, "c3", 1, ["f001"]),
    ]);

    expect(contributorCount("f001")).toBe(3);
    // 旧实现下这里会是 "2"：两人都读到 "1"，各自写回 "2"
    expect(weightSum("f001")).toBe("3");
  });

  it("★ 一次 200 条上报的 D1 往返是常数级（逐条 await 会放大到数百次）", async () => {
    const films = Array.from({ length: 200 }, (_, index) => `f${String(index).padStart(3, "0")}`);
    await replaceContributorWants(db, EDITION, "c1", 1, films);

    // 全部写入都在批次内（批次由 D1 在一个事务里依次执行）
    expect(stats.outsideRuns).toBe(0);
    expect(stats.batches).toBeGreaterThan(0);
    // 只允许「读一次现有贡献行」这一次额外往返（drizzle 的带字段查询走 `raw()`）
    expect(stats.outsideRaws).toBe(1);
    expect(stats.outsideAlls).toBe(0);
    expect(weightSum("f199")).toBe("1");
  });

  it("整份替换语义不变：新增 / 移除 / 匿名→登录的权重补差", async () => {
    await replaceContributorWants(db, EDITION, "anon", 0.75, ["f001", "f002"]);
    expect(weightSum("f001")).toBe("0.75");
    expect(weightSum("f002")).toBe("0.75");

    // 匿名升级为登录（0.75 → 1）：仍在集合里的补 +0.25，移出集合的归零删行
    await replaceContributorWants(db, EDITION, "anon", 1, ["f001"]);
    expect(weightSum("f001")).toBe("1");
    expect(weightSum("f002")).toBeUndefined();
    expect(contributorCount("f002")).toBe(0);
  });

  it("★ 聚合被减过头（负漂移）时告警，而不是静默钳成 0", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // 制造漂移：贡献行说 0.75，聚合行却只有 0.5（少算了 0.25）
    sqlite
      .prepare(
        "INSERT INTO film_want_contribution (edition, film_key, contributor, weight, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(EDITION, "f001", "anon", "0.75", 0);
    sqlite
      .prepare("INSERT INTO film_want_stat (edition, film_key, weight_sum, updated_at) VALUES (?, ?, ?, ?)")
      .run(EDITION, "f001", "0.5", 0);

    await replaceContributorWants(db, EDITION, "anon", 0.75, []);

    expect(weightSum("f001")).toBeUndefined();
    const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).toContain("stat_drift");
    expect(logged).toContain("f001");
  });
});

/** 另外四个 store 与 want-store 同构，各自钉住「并发不丢」+「写全在批次内」。 */
describe("计数聚合：其余四个 store 的并发正确性与往返次数", () => {
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
    vi.restoreAllMocks();
    sqlite.close();
  });

  it("★ 同场观影人数：两人并发把同一场加进行程，聚合等于两人之和", async () => {
    await replaceContributorScreenings(db, EDITION, "c1", 1, ["S001"]);
    await Promise.all([
      replaceContributorScreenings(db, EDITION, "c2", 1, ["S001"]),
      replaceContributorScreenings(db, EDITION, "c3", 1, ["S001"]),
    ]);
    expect(await readScreeningCounts(db, EDITION)).toEqual({ S001: 3 });
    expect(stats.outsideRuns).toBe(0);
  });

  it("★ 红黑榜：两人并发投同一部片，票数等于两人之和；撤票后归零即删行", async () => {
    await replaceContributorVotes(db, EDITION, "c1", new Map([["f001", "red"]]));
    await Promise.all([
      replaceContributorVotes(db, EDITION, "c2", new Map([["f001", "red"]])),
      replaceContributorVotes(db, EDITION, "c3", new Map([["f001", "red"]])),
    ]);
    expect(await readVoteCounts(db, EDITION)).toEqual({ f001: { red: 3, black: 0 } });

    // 改票：红 → 黑（同一人），红减 1、黑加 1
    await replaceContributorVotes(db, EDITION, "c1", new Map([["f001", "black"]]));
    expect(await readVoteCounts(db, EDITION)).toEqual({ f001: { red: 2, black: 1 } });

    // 全部撤票 → 两个计数都归零 → 删行（读侧不再返回这一部片）
    await replaceContributorVotes(db, EDITION, "c1", new Map());
    await replaceContributorVotes(db, EDITION, "c2", new Map());
    await replaceContributorVotes(db, EDITION, "c3", new Map());
    expect(await readVoteCounts(db, EDITION)).toEqual({});
    expect(stats.outsideRuns).toBe(0);
  });

  it("★ 抢票结果：两人并发标同一场，四项计数分别累加（含匿名 0.75 的权重）", async () => {
    await Promise.all([
      replaceContributorTickets(db, EDITION, "c1", 1, new Map([["S001", "got" as const]])),
      replaceContributorTickets(db, EDITION, "c2", 0.75, new Map([["S001", "got" as const]])),
    ]);
    expect(await readTicketCounts(db, EDITION)).toEqual({
      S001: { got: 2, transfer: 0, missed: 0, dropped: 0 },
    });

    // 改结果：got → missed（同一人）
    await replaceContributorTickets(db, EDITION, "c1", 1, new Map([["S001", "missed" as const]]));
    expect(await readTicketCounts(db, EDITION)).toEqual({
      S001: { got: 1, transfer: 0, missed: 1, dropped: 0 },
    });
    expect(stats.outsideRuns).toBe(0);
  });

  it("★ 事件流水（计数型）：两人并发上报同一页，viewers 与 hits 都等于两人之和", async () => {
    const schedule = (hits: number) =>
      new Map([["page|/schedule", { kind: "page" as const, target: "/schedule", hits }]]);
    await applyContributorTelemetry(db, EDITION, "c1", 1, schedule(1));
    await Promise.all([
      applyContributorTelemetry(db, EDITION, "c2", 1, schedule(1)),
      applyContributorTelemetry(db, EDITION, "c3", 1, schedule(1)),
    ]);
    expect(await readTelemetryCounts(db, EDITION)).toEqual({
      page: { "/schedule": { viewers: 3, hits: 3 } },
    });

    // 同一个人再报 4 次：viewers 不动、hits 累加（计数型与状态型的根本差别）
    await applyContributorTelemetry(db, EDITION, "c1", 1, schedule(4));
    expect(await readTelemetryCounts(db, EDITION)).toEqual({
      page: { "/schedule": { viewers: 3, hits: 7 } },
    });
    expect(stats.outsideRuns).toBe(0);
  });
});
