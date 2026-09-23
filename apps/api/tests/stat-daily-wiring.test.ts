import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { database } from "../src/db";
import { kstDay } from "../src/day";
import { replaceContributorVotes } from "../src/film-vote-store";
import { clearContributorScreenings, replaceContributorScreenings } from "../src/screening-stats-store";
import { readDailyBucket, readDailySeries } from "../src/stat-daily";
import { applyContributorTelemetry, clearContributorTelemetry } from "../src/telemetry-store";
import { replaceContributorTickets } from "../src/ticket-stats-store";
import { clearContributorWants, replaceContributorWants } from "../src/want-store";
import { createD1, createStatSchema } from "./d1-shim";

/**
 * **五条写路径都记日账本**（2026-09-23，PLAN-20260923142546，批 1）。
 *
 * 为什么单独一个文件：`stat-daily.test.ts` 测的是「日桶本身对不对」，这里测的是
 * **「上报真的会写进日桶」** —— 地基写好了但忘了接线，是最容易漏、也最难从 UI 上看出来的错
 * （趋势图会一直空着，而榜单一切正常）。
 *
 * 三条断言口径：
 *   ① 五条 ping 各自的 weightDelta / hitsDelta 落对桶（含红黑票按颜色分桶）；
 *   ② **撤票 / 登出清理也要记负增量** —— 只记加不记减，趋势会虚高且永不自愈；
 *   ③ `day` 与 `kstDay(Date.now())` 一致（不是 UTC，也不是客户端传的）。
 */

const EDITION = "biff-2026";
// 日界只能服务端算，测试也走同一个函数 —— 不自己拼日期字符串
const TODAY = kstDay(Date.now());

describe("日账本接线（d1 垫片，跑真 SQL）", () => {
  let sqlite: DatabaseSync;
  let db: ReturnType<typeof database>;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    createStatSchema(sqlite);
    db = database(createD1(sqlite));
  });

  afterEach(() => {
    sqlite.close();
  });

  it("想看：登录 1.0 / 匿名 0.75 各记各的权重", async () => {
    await replaceContributorWants(db, EDITION, "c-login", 1, ["cat:f001"]);
    await replaceContributorWants(db, EDITION, "c-anon", 0.75, ["cat:f001"]);
    expect(await readDailyBucket(db, EDITION, TODAY, "want", "cat:f001")).toEqual({
      weight: 1.75,
      hits: 0,
    });
  });

  it("想看：撤掉一票记负增量，减到 0 时该行消失", async () => {
    await replaceContributorWants(db, EDITION, "c-anon", 0.75, ["cat:f001"]);
    await clearContributorWants(db, EDITION, "c-anon");
    expect(await readDailyBucket(db, EDITION, TODAY, "want", "cat:f001")).toBeNull();
  });

  it("红黑票：红 / 黑进不同的桶（一人一票，weightDelta = ±1）", async () => {
    await replaceContributorVotes(db, EDITION, "c1", new Map([["cat:f001", "red"]]));
    await replaceContributorVotes(db, EDITION, "c2", new Map([["cat:f001", "black"]]));
    expect(await readDailyBucket(db, EDITION, TODAY, "vote:red", "cat:f001")).toEqual({
      weight: 1,
      hits: 0,
    });
    expect(await readDailyBucket(db, EDITION, TODAY, "vote:black", "cat:f001")).toEqual({
      weight: 1,
      hits: 0,
    });
  });

  it("红黑票：改票（红 → 黑）在两个桶里各留一笔，不互相抵消", async () => {
    await replaceContributorVotes(db, EDITION, "c1", new Map([["cat:f001", "red"]]));
    await replaceContributorVotes(db, EDITION, "c1", new Map([["cat:f001", "black"]]));
    expect(await readDailyBucket(db, EDITION, TODAY, "vote:red", "cat:f001")).toBeNull();
    expect(await readDailyBucket(db, EDITION, TODAY, "vote:black", "cat:f001")).toEqual({
      weight: 1,
      hits: 0,
    });
  });

  it("同场人数：按场次 code 记加权和", async () => {
    await replaceContributorScreenings(db, EDITION, "c-login", 1, ["008"]);
    await replaceContributorScreenings(db, EDITION, "c-anon", 0.75, ["008"]);
    expect(await readDailyBucket(db, EDITION, TODAY, "screening", "008")).toEqual({
      weight: 1.75,
      hits: 0,
    });
    await clearContributorScreenings(db, EDITION, "c-anon");
    expect(await readDailyBucket(db, EDITION, TODAY, "screening", "008")).toEqual({
      weight: 1,
      hits: 0,
    });
  });

  it("抢票结果：四项结果各自成桶（metric 带子类型）", async () => {
    await replaceContributorTickets(db, EDITION, "c1", 1, new Map([["S001", "got"]]));
    await replaceContributorTickets(db, EDITION, "c2", 1, new Map([["S001", "missed"]]));
    expect(await readDailyBucket(db, EDITION, TODAY, "ticket:got", "S001")).toEqual({
      weight: 1,
      hits: 0,
    });
    expect(await readDailyBucket(db, EDITION, TODAY, "ticket:missed", "S001")).toEqual({
      weight: 1,
      hits: 0,
    });
  });

  it("事件流水：viewer 与 hits 分别落 weight_sum / hits_sum", async () => {
    await applyContributorTelemetry(
      db,
      EDITION,
      "c-anon",
      0.75,
      new Map([["page|/redblack", { kind: "page", target: "/redblack", hits: 2 }]]),
    );
    expect(await readDailyBucket(db, EDITION, TODAY, "telemetry:page", "/redblack")).toEqual({
      weight: 0.75,
      hits: 1.5,
    });
  });

  it("★ 登出 / 登录去重要把事件流水的日账本也减回去（只记加不记减 = 趋势虚高且不可自愈）", async () => {
    await applyContributorTelemetry(
      db,
      EDITION,
      "c-anon",
      0.75,
      new Map([["page|/redblack", { kind: "page", target: "/redblack", hits: 2 }]]),
    );
    await clearContributorTelemetry(db, EDITION, "c-anon");
    expect(await readDailyBucket(db, EDITION, TODAY, "telemetry:page", "/redblack")).toBeNull();
  });

  it("★ 序列口径：一天里多次上报聚合成一个点，day 与 kstDay(now) 一致", async () => {
    await replaceContributorWants(db, EDITION, "c1", 1, ["cat:f001"]);
    await replaceContributorWants(db, EDITION, "c2", 0.75, ["cat:f001", "cat:f002"]);
    const series = await readDailySeries(db, { edition: EDITION, metric: "want", fromDay: TODAY });
    expect(series).toEqual([{ day: TODAY, weight: 2.5, hits: 0 }]);
  });
});
