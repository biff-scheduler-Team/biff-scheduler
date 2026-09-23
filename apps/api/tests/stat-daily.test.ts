import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { database } from "../src/db";
import {
  DAILY_METRICS,
  dailyBucketWrites,
  dailyMetricFamily,
  isDailyMetric,
  readDailyBucket,
  readDailySeries,
  readEarliestDay,
  telemetryDailyMetric,
  ticketDailyMetric,
  voteDailyMetric,
} from "../src/stat-daily";
import { flushStatBatch } from "../src/stat-batch";
import { createD1, createStatSchema } from "./d1-shim";

/**
 * 按天分桶的读写（2026-09-23，PLAN-20260923142546，批 1）。
 *
 * 这里盯的是**趋势数据的正确性**，也就是三个最容易错的地方：
 *   ① 同一天多次增量要**累加**（趋势是账本，不是快照）；
 *   ② 撤票要减得回去，减到 0 就删行（否则趋势图上会留下一条假的 0）；
 *   ③ 序列读取要按天聚合、按天升序，且**不跨天串味**。
 *
 * ⚠ 断言打的是真 SQL（`d1-shim` 内存库），不是断言实现。
 */

const EDITION = "biff-2026";
const DAY = "2026-09-23";

describe("stat-daily（d1 垫片，跑真 SQL）", () => {
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

  /** 按调用方的口径写一批日桶（与各 store 里的用法一致：并进同一个 batch）。 */
  async function bump(delta: Parameters<typeof dailyBucketWrites>[1], now = 1_700_000_000_000) {
    await flushStatBatch(db, dailyBucketWrites(db, delta, now));
  }

  it("同一 (metric,target,day) 的多次增量累加，不是覆盖", async () => {
    await bump({ edition: EDITION, day: DAY, metric: "want", target: "cat:f001", weightDelta: 1 });
    await bump({ edition: EDITION, day: DAY, metric: "want", target: "cat:f001", weightDelta: 0.75 });
    expect(await readDailyBucket(db, EDITION, DAY, "want", "cat:f001")).toEqual({
      weight: 1.75,
      hits: 0,
    });
  });

  it("权重以文本存，且是项目既有形状（整数不带 .0）", async () => {
    await bump({ edition: EDITION, day: DAY, metric: "want", target: "cat:f001", weightDelta: 1 });
    await bump({
      edition: EDITION,
      day: DAY,
      metric: "want",
      target: "cat:f001",
      weightDelta: 0.75,
    });
    // 读原始格子而不是经 `readDailyBucket`：形状（文本 / 不带 .0）正是这一条要钉的东西
    const raw = sqlite
      .prepare("SELECT weight_sum FROM stat_daily WHERE target = ?")
      .get("cat:f001") as { weight_sum: string };
    expect(raw.weight_sum).toBe("1.75");
  });

  it("★ 撤票减得回去；减到 0 时整行删掉（趋势图上不留假的 0）", async () => {
    await bump({ edition: EDITION, day: DAY, metric: "want", target: "cat:f001", weightDelta: 1 });
    await bump({
      edition: EDITION,
      day: DAY,
      metric: "want",
      target: "cat:f001",
      weightDelta: -0.75,
    });
    expect(await readDailyBucket(db, EDITION, DAY, "want", "cat:f001")).toEqual({
      weight: 0.25,
      hits: 0,
    });

    await bump({
      edition: EDITION,
      day: DAY,
      metric: "want",
      target: "cat:f001",
      weightDelta: -0.25,
    });
    expect(await readDailyBucket(db, EDITION, DAY, "want", "cat:f001")).toBeNull();
  });

  it("★ 红黑票按**颜色**分桶：改票当天红 −1、黑 +1，两个桶都看得见", async () => {
    await bump({ edition: EDITION, day: DAY, metric: "vote:red", target: "cat:f001", weightDelta: 1 });
    await bump({ edition: EDITION, day: DAY, metric: "vote:black", target: "cat:f001", weightDelta: 1 });
    // 改票：红撤掉、黑补上
    await bump({ edition: EDITION, day: DAY, metric: "vote:red", target: "cat:f001", weightDelta: -1 });
    expect(await readDailyBucket(db, EDITION, DAY, "vote:red", "cat:f001")).toBeNull();
    expect(await readDailyBucket(db, EDITION, DAY, "vote:black", "cat:f001")).toEqual({
      weight: 1,
      hits: 0,
    });
    // 若合成一个 "vote" 桶，这一对 −1/+1 会互相抵消 —— 那正是分开的理由
  });

  it("telemetry 的 hits_sum 单独记（「用了多少次」）", async () => {
    await bump({
      edition: EDITION,
      day: DAY,
      metric: "telemetry:page",
      target: "/redblack",
      weightDelta: 0.75,
      hitsDelta: 3,
    });
    expect(await readDailyBucket(db, EDITION, DAY, "telemetry:page", "/redblack")).toEqual({
      weight: 0.75,
      hits: 3,
    });
  });

  it("★ 序列：按天聚合、升序、只取 fromDay 之后，且不跨天串味", async () => {
    await bump({ edition: EDITION, day: "2026-09-21", metric: "vote:red", target: "cat:f001", weightDelta: 1 });
    await bump({ edition: EDITION, day: "2026-09-23", metric: "vote:red", target: "cat:f001", weightDelta: 1 });
    await bump({ edition: EDITION, day: "2026-09-23", metric: "vote:red", target: "cat:f002", weightDelta: 1 });
    // 别的 edition 不得串进来
    await bump({ edition: "biff-2027", day: "2026-09-23", metric: "vote:red", target: "cat:f001", weightDelta: 5 });
    // 别的 metric 不得串进来
    await bump({ edition: EDITION, day: "2026-09-23", metric: "want", target: "cat:f001", weightDelta: 3 });
    // 同一族的另一个子类型也不得串进来（红 ≠ 黑）
    await bump({ edition: EDITION, day: "2026-09-23", metric: "vote:black", target: "cat:f001", weightDelta: 9 });

    const series = await readDailySeries(db, { edition: EDITION, metric: "vote:red", fromDay: "2026-09-22" });
    expect(series).toEqual([{ day: "2026-09-23", weight: 2, hits: 0 }]);

    const all = await readDailySeries(db, { edition: EDITION, metric: "vote:red", fromDay: "2026-09-01" });
    expect(all).toEqual([
      { day: "2026-09-21", weight: 1, hits: 0 },
      { day: "2026-09-23", weight: 2, hits: 0 },
    ]);
  });

  it("序列可以按单个 target 收窄（某部片的日趋势）", async () => {
    await bump({ edition: EDITION, day: DAY, metric: "vote:red", target: "cat:f001", weightDelta: 1 });
    await bump({ edition: EDITION, day: DAY, metric: "vote:red", target: "cat:f002", weightDelta: 4 });
    const series = await readDailySeries(db, {
      edition: EDITION,
      metric: "vote:red",
      fromDay: DAY,
      target: "cat:f002",
    });
    expect(series).toEqual([{ day: DAY, weight: 4, hits: 0 }]);
  });

  it("一族的子类型可以一起读（抢票四项、事件两类）", async () => {
    await bump({ edition: EDITION, day: DAY, metric: "ticket:got", target: "S001", weightDelta: 1 });
    await bump({ edition: EDITION, day: DAY, metric: "ticket:transfer", target: "S001", weightDelta: 0.75 });
    await bump({ edition: EDITION, day: DAY, metric: "ticket:missed", target: "S002", weightDelta: 1 });
    const series = await readDailySeries(db, {
      edition: EDITION,
      metric: dailyMetricFamily("ticket"),
      fromDay: DAY,
    });
    expect(series).toEqual([{ day: DAY, weight: 2.75, hits: 0 }]);
  });

  it("★ earliestDay 是「趋势从哪天开始」的唯一口径（历史不回填）", async () => {
    expect(await readEarliestDay(db, EDITION)).toBeNull();
    await bump({ edition: EDITION, day: "2026-09-25", metric: "vote:red", target: "cat:f001", weightDelta: 1 });
    await bump({ edition: EDITION, day: "2026-09-23", metric: "vote:red", target: "cat:f001", weightDelta: 1 });
    expect(await readEarliestDay(db, EDITION)).toBe("2026-09-23");
  });

  it("metric 白名单与子类型构造函数收口", () => {
    expect(DAILY_METRICS).toContain(voteDailyMetric("red"));
    expect(DAILY_METRICS).toContain(voteDailyMetric("black"));
    expect(DAILY_METRICS).toContain(ticketDailyMetric("dropped"));
    expect(DAILY_METRICS).toContain(telemetryDailyMetric("click"));
    // 没有子类型的指标才允许裸名；「投票」「事件」必须显式带子类型（否则又出一个合成桶）
    expect(isDailyMetric("want")).toBe(true);
    expect(isDailyMetric("vote")).toBe(false);
    expect(isDailyMetric("telemetry")).toBe(false);
    expect(isDailyMetric("whatever")).toBe(false);
    expect(isDailyMetric(undefined)).toBe(false);
    expect(dailyMetricFamily("ticket")).toEqual([
      "ticket:got",
      "ticket:transfer",
      "ticket:missed",
      "ticket:dropped",
    ]);
  });
});
