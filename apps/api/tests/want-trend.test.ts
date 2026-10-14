import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { database } from "../src/db";
import { flushStatBatch } from "../src/stat-batch";
import { dailyBucketWrites, voteDailyMetric } from "../src/stat-daily";
import { readWantDailyDeltas } from "../src/want-store";
import { createD1, createStatSchema } from "./d1-shim";

/**
 * 「正在升温」的数据源（2026-10-14，`PLAN-20261014162246`）。
 *
 * 它只做一件事：把**日账本**里 `want` 指标的增量按影片加起来。盯着三个最容易错的地方：
 *   ① 窗口内的多天 / 多批要**累加**，不是取最后一条；
 *   ② 窗口外的天**不能串味**（`fromDay` 是闭区间左端）；
 *   ③ 只认 `want` —— 票 / 场次 / 遥测的增量混进来，会让「升温」榜凭空长出一批没人在意的片。
 *
 * ⚠ 断言打的是真 SQL（`d1-shim` 内存库），不是断言实现。
 */

const EDITION = "biff-2026";
const NOW = 1_700_000_000_000;

describe("readWantDailyDeltas（d1 垫片，跑真 SQL）", () => {
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

  async function bump(
    day: string,
    target: string,
    weightDelta: number,
    metric: Parameters<typeof dailyBucketWrites>[1]["metric"] = "want",
  ) {
    await flushStatBatch(
      db,
      dailyBucketWrites(db, { edition: EDITION, day, metric, target, weightDelta }, NOW),
    );
  }

  it("按影片把窗口内的增量加起来（同一天多批也累加）", async () => {
    await bump("2026-10-13", "cat:f001", 1);
    await bump("2026-10-14", "cat:f001", 0.75);
    await bump("2026-10-14", "cat:f001", 0.75);
    await bump("2026-10-14", "cat:f002", 2);
    // f001 = 1 + 0.75 + 0.75 = 2.5 → 与累计数同一处取整（`want-stats.ts::roundWantCount`
    // 即 `Math.round`，.5 向上）→ 3。⚠ 断言的是**这个口径**，不是「四舍六入」的直觉。
    expect(await readWantDailyDeltas(db, EDITION, "2026-10-13")).toEqual({
      "cat:f001": 3,
      "cat:f002": 2,
    });
  });

  it("窗口外的天不串味（`fromDay` 是闭区间左端，只往里算）", async () => {
    await bump("2026-10-12", "cat:old", 9);
    await bump("2026-10-13", "cat:edge", 3);
    await bump("2026-10-14", "cat:new", 4);

    const from13 = await readWantDailyDeltas(db, EDITION, "2026-10-13");
    expect(from13).toEqual({ "cat:edge": 3, "cat:new": 4 });
    expect(from13["cat:old"]).toBeUndefined();

    // fromDay = 当天 → 只剩当天
    expect(await readWantDailyDeltas(db, EDITION, "2026-10-14")).toEqual({ "cat:new": 4 });
  });

  it("只认 `want`：票 / 场次 / 遥测的增量不会被当成「升温」", async () => {
    await bump("2026-10-14", "cat:f001", 5, voteDailyMetric("red"));
    await bump("2026-10-14", "sched:008", 7, "screening");
    await bump("2026-10-14", "cat:f002", 1);
    expect(await readWantDailyDeltas(db, EDITION, "2026-10-14")).toEqual({ "cat:f002": 1 });
  });

  it("撤票不会在榜上留下 0 / 负数（涨完又撤光的片直接缺席）", async () => {
    await bump("2026-10-14", "cat:gone", 1);
    await bump("2026-10-14", "cat:gone", -1);
    await bump("2026-10-14", "cat:still", 3);
    await bump("2026-10-14", "cat:still", -1);
    const deltas = await readWantDailyDeltas(db, EDITION, "2026-10-14");
    expect(deltas).toEqual({ "cat:still": 2 });
    expect(deltas["cat:gone"]).toBeUndefined();
  });

  it("别的届次不混进来", async () => {
    await flushStatBatch(
      db,
      dailyBucketWrites(
        db,
        { edition: "biff-2025", day: "2026-10-14", metric: "want", target: "cat:old", weightDelta: 8 },
        NOW,
      ),
    );
    expect(await readWantDailyDeltas(db, EDITION, "2026-10-14")).toEqual({});
  });
});
