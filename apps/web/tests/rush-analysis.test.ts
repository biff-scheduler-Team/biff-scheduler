// 「抢票分析」纯逻辑单测（2026-09-20,PLAN-20260920161837）。
//
// 覆盖点：① 难度分级阈值边界（含容量缺失的降级与除零）；② 相对分位；
// ③ 需求集中度；④ 时段分桶的 **24+ 时制不取模**（合成 `>= 24` 样本 + 真实排期的小时域）；
// ⑤ 抢到率的样本量门槛与「转票不进分子分母」；⑥ 口碑结论的最小票数门槛。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  capacityOf,
  demandRatio,
  difficultyLevelOf,
  difficultyOf,
  percentileOf,
} from "../src/capacity";
import {
  demandByDate,
  demandByHour,
  demandConcentration,
  difficultyBoard,
  HEAT_VERDICT_LABELS,
  hotVsVotes,
  MIN_RATE_SAMPLES,
  MIN_VOTES_FOR_VERDICT,
  NEXT_DAY_HOUR,
  startHourOf,
  ticketOutcomeStats,
  type FilmSignals,
  type ShowDemandRow,
} from "../src/rush-analysis";
import type { ScheduleFile, Venue } from "../src/types";

const venue = (patch: Partial<Venue>): Venue => ({
  id: "v",
  name: "V",
  name_kr: "",
  group: "bcc",
  ...patch,
});

const row = (patch: Partial<ShowDemandRow> & { code: string }): ShowDemandRow => ({
  date: "2026-10-08",
  startHour: 10,
  demand: 0,
  capacity: null,
  ...patch,
});

describe("capacityOf", () => {
  it("未收录 / 非法 / ≤ 0 一律 null（不退化成 0 —— 那会让倍率变成 Infinity）", () => {
    expect(capacityOf(undefined)).toBeNull();
    expect(capacityOf(null)).toBeNull();
    expect(capacityOf(venue({}))).toBeNull();
    expect(capacityOf(venue({ capacity: 0 }))).toBeNull();
    expect(capacityOf(venue({ capacity: -10 }))).toBeNull();
    expect(capacityOf(venue({ capacity: Number.NaN }))).toBeNull();
  });

  it("有效容量取整", () => {
    expect(capacityOf(venue({ capacity: 413 }))).toBe(413);
    expect(capacityOf(venue({ capacity: 413.6 }))).toBe(414);
  });
});

describe("demandRatio", () => {
  it("分母缺失 / ≤ 0 → null（不是 0，也不是 Infinity）", () => {
    expect(demandRatio(100, null)).toBeNull();
    expect(demandRatio(100, 0)).toBeNull();
  });

  it("需求缺失按 0 处理（0 人是事实，不是缺数据）", () => {
    expect(demandRatio(0, 200)).toBe(0);
    expect(demandRatio(Number.NaN, 200)).toBe(0);
  });

  it("倍率 = 需求 ÷ 容量", () => {
    expect(demandRatio(100, 200)).toBe(0.5);
    expect(demandRatio(300, 200)).toBe(1.5);
  });
});

describe("难度分级：阈值边界", () => {
  it("恰好落在阈值上取下界那一档（>= 而不是 >）", () => {
    expect(difficultyLevelOf(1)).toBe("extreme");
    expect(difficultyLevelOf(0.999)).toBe("high");
    expect(difficultyLevelOf(0.5)).toBe("high");
    expect(difficultyLevelOf(0.499)).toBe("medium");
    expect(difficultyLevelOf(0.2)).toBe("medium");
    expect(difficultyLevelOf(0.199)).toBe("low");
    expect(difficultyLevelOf(0)).toBe("low");
  });

  it("倍率为 null（容量未收录）→ unknown，而不是 low", () => {
    expect(difficultyLevelOf(null)).toBe("unknown");
  });

  it("容量缺失 → unknown + 明示「未收录」判据（绝不估数）", () => {
    const verdict = difficultyOf(120, null);
    expect(verdict.level).toBe("unknown");
    expect(verdict.ratio).toBeNull();
    expect(verdict.reason).toContain("未收录");
  });

  it("判据说明印出原始三元组，供用户复核分档", () => {
    expect(difficultyOf(300, 200).reason).toContain("300");
    expect(difficultyOf(300, 200).reason).toContain("200");
    expect(difficultyOf(300, 200).level).toBe("extreme");
  });
});

describe("percentileOf", () => {
  it("高于多少比例的样本（与样本顺序无关）", () => {
    expect(percentileOf(0.5, [0.1, 0.5, 0.9])).toBe(33);
    expect(percentileOf(0.9, [0.9, 0.1, 0.5])).toBe(67);
  });

  it("样本 < 2 或自身无倍率 → null（小样本上分位数没有意义）", () => {
    expect(percentileOf(0.5, [0.5])).toBeNull();
    expect(percentileOf(0.5, [])).toBeNull();
    expect(percentileOf(null, [0.1, 0.9])).toBeNull();
  });
});

describe("difficultyBoard", () => {
  it("倍率降序；未收录容量的排最后，同类按需求降序", () => {
    const board = difficultyBoard([
      row({ code: "001", demand: 10, capacity: 1000 }), // 0.01 → low
      row({ code: "002", demand: 500, capacity: 500 }), // 1 → extreme
      row({ code: "003", demand: 900, capacity: null }), // unknown，但需求最高
      row({ code: "004", demand: 30, capacity: 100 }), // 0.3 → medium
    ]);
    expect(board.map((r) => r.code)).toEqual(["002", "004", "001", "003"]);
    expect(board[3].level).toBe("unknown");
    // 有容量的三条都能算出相对分位
    expect(board[0].percentile).toBe(67);
  });

  it("空输入 → 空榜", () => {
    expect(difficultyBoard([])).toEqual([]);
  });
});

describe("demandConcentration", () => {
  it("Top N 占比 + 承载半数需求所需的场次数", () => {
    // 25 场各 4 人 → 合计 100；半数 50 需要 13 场；Top10 吃掉 40%
    const concentration = demandConcentration(Array.from({ length: 25 }, () => 4));
    expect(concentration).not.toBeNull();
    expect(concentration!.total).toBe(100);
    expect(concentration!.shows).toBe(25);
    expect(concentration!.top10.share).toBeCloseTo(0.4, 6);
    expect(concentration!.top20.share).toBeCloseTo(0.8, 6);
    expect(concentration!.halfCount).toBe(13);
  });

  it("场次少于档位时按实际条数算（不补 0）", () => {
    const concentration = demandConcentration([10, 10, 10, 10]);
    expect(concentration!.top10.count).toBe(4);
    expect(concentration!.top10.share).toBe(1);
    expect(concentration!.halfCount).toBe(2);
  });

  it("总需求为 0 / 全是脏值 → null（页面整块不渲染，不出现除零）", () => {
    expect(demandConcentration([])).toBeNull();
    expect(demandConcentration([0, 0])).toBeNull();
    expect(demandConcentration([Number.NaN, -3])).toBeNull();
  });
});

describe("时段分桶：24+ 时制不取模", () => {
  it("startHourOf 读原始小时，不做任何取模", () => {
    expect(startHourOf("08:00")).toBe(8);
    expect(startHourOf("23:59")).toBe(23);
    expect(startHourOf("29:35")).toBe(29);
    expect(startHourOf("")).toBeNull();
  });

  it("hour >= 24 全部并入「次日」档并标注（29 不得被模成 5）", () => {
    const buckets = demandByHour([
      row({ code: "001", startHour: 20, demand: 5 }),
      row({ code: "002", startHour: 24, demand: 3 }),
      row({ code: "003", startHour: 29, demand: 2 }),
    ]);
    expect(buckets.map((b) => b.hour)).toEqual([20, NEXT_DAY_HOUR]);
    const next = buckets[1];
    expect(next.label).toContain("次日");
    expect(next.demand).toBe(5);
    expect(next.shows).toBe(2);
    // 取模的实现会造出一个 05:00 桶 —— 那是本用例的回归点
    expect(buckets.some((b) => b.hour === 5)).toBe(false);
  });

  it("无需求的场次不进桶；桶按小时升序", () => {
    const buckets = demandByHour([
      row({ code: "001", startHour: 18, demand: 0 }),
      row({ code: "002", startHour: 9, demand: 1 }),
      row({ code: "003", startHour: 21, demand: 1 }),
    ]);
    expect(buckets.map((b) => b.hour)).toEqual([9, 21]);
  });

  it("真实排期：本届开场小时域是 08–23（无跨午夜**开场**，次日档因此是防御性分支）", () => {
    // 这条钉住数据事实：一旦换版真的出现 >= 24 的开场，本用例会红，提醒复核次日档的展示文案
    const schedule = JSON.parse(readFileSync("public/schedule.json", "utf8")) as ScheduleFile;
    const hours = schedule.screenings.map((s) => startHourOf(s.start_time)!);
    expect(Math.min(...hours)).toBe(8);
    expect(Math.max(...hours)).toBe(23);
    const buckets = demandByHour(
      schedule.screenings.map((s) =>
        row({ code: s.code, startHour: startHourOf(s.start_time)!, demand: 1, date: s.date }),
      ),
    );
    expect(buckets.some((b) => b.hour >= NEXT_DAY_HOUR)).toBe(false);
    expect(buckets[0].hour).toBe(8);
  });
});

describe("demandByDate", () => {
  it("按日期升序、只算有需求的场次", () => {
    const buckets = demandByDate([
      row({ code: "001", date: "2026-10-08", demand: 3 }),
      row({ code: "002", date: "2026-10-06", demand: 5 }),
      row({ code: "003", date: "2026-10-08", demand: 2 }),
      row({ code: "004", date: "2026-10-06", demand: 0 }),
    ]);
    expect(buckets).toEqual([
      { date: "2026-10-06", demand: 5, shows: 1 },
      { date: "2026-10-08", demand: 5, shows: 2 },
    ]);
  });
});

describe("ticketOutcomeStats：样本门槛与转票", () => {
  it("没有任何结果 → null（结果区整块不渲染）", () => {
    expect(ticketOutcomeStats({})).toBeNull();
    expect(ticketOutcomeStats({ "001": { got: 0, transfer: 0, missed: 0, dropped: 0 } })).toBeNull();
  });

  it("样本不足时不给率值，但计数照印（页面明示「样本不足」）", () => {
    const summary = ticketOutcomeStats({ "001": { got: 3, transfer: 0, missed: 1, dropped: 0 } })!;
    expect(MIN_RATE_SAMPLES).toBe(10);
    expect(summary.samples).toBe(4);
    expect(summary.got).toBe(3);
    expect(summary.gotRate).toBeNull();
    expect(summary.missedRate).toBeNull();
    expect(summary.droppedRate).toBeNull();
  });

  it("样本够了才算率值：抢到率 = 已抢到 ÷ (已抢到 + 没抢到 + 放弃)", () => {
    const summary = ticketOutcomeStats({ "001": { got: 6, transfer: 4, missed: 2, dropped: 2 } })!;
    expect(summary.samples).toBe(10); // 转票 4 不在其中
    expect(summary.gotRate).toBeCloseTo(0.6, 6);
    expect(summary.missedRate).toBeCloseTo(0.2, 6);
    expect(summary.droppedRate).toBeCloseTo(0.2, 6);
    expect(summary.transfer).toBe(4); // 转票单独计数
  });

  it("只有转票 → 样本为 0，率值仍为 null（不产出 0/0）", () => {
    const summary = ticketOutcomeStats({ "001": { got: 0, transfer: 7, missed: 0, dropped: 0 } })!;
    expect(summary.samples).toBe(0);
    expect(summary.gotRate).toBeNull();
    expect(summary.transfer).toBe(7);
  });

  it("权重和先四舍五入成「人」再算率（与印出来的数字同源）", () => {
    const summary = ticketOutcomeStats({
      "001": { got: 0.75, transfer: 0, missed: 8.75, dropped: 0.75 },
    })!;
    expect(summary.got).toBe(1);
    expect(summary.missed).toBe(9);
    expect(summary.samples).toBe(11);
    expect(summary.gotRate).toBeCloseTo(1 / 11, 6);
  });
});

describe("hotVsVotes", () => {
  const film = (patch: Partial<FilmSignals> & { key: string }): FilmSignals => ({
    title: patch.key,
    want: 0,
    demand: 0,
    red: 0,
    black: 0,
    ...patch,
  });

  it("总票数低于门槛一律不下结论", () => {
    expect(MIN_VOTES_FOR_VERDICT).toBe(5);
    const rows = hotVsVotes([film({ key: "a", demand: 100, red: 3, black: 0 })]);
    expect(rows[0].verdict).toBe("unknown");
    expect(HEAT_VERDICT_LABELS[rows[0].verdict]).toBe("样本不足");
  });

  it("热度基准 = 有需求样本的中位数：高热度低口碑要被抓出来", () => {
    const rows = hotVsVotes([
      film({ key: "hot", demand: 100, red: 1, black: 9 }), // 热 + 差
      film({ key: "cold", demand: 10, red: 9, black: 1 }), // 冷 + 好
      film({ key: "mid", demand: 50, red: 5, black: 5 }), // 中位数本身 → 算热 + 好
    ]);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get("hot")!.verdict).toBe("hot-hated");
    expect(byKey.get("cold")!.verdict).toBe("quiet-loved");
    expect(byKey.get("mid")!.verdict).toBe("hot-loved");
    expect(HEAT_VERDICT_LABELS["hot-hated"]).toBe("高热度 · 低口碑");
  });

  it("红票与黑票打平算「好口碑」（>= 而不是 >）", () => {
    // 两片一起给：热度的基准是**样本中位数**，单独一部片的中位数就是它自己（必算「热」），
    // 所以要让「冷」这一档可测，样本里必须有一只更热的
    const rows = hotVsVotes([
      film({ key: "a", demand: 1, red: 3, black: 3 }), // 打平 → 好口碑；需求低于中位数 → 冷
      film({ key: "b", demand: 100, red: 0, black: 0 }), // 只用来把中位数抬上去
    ]);
    const a = rows.find((r) => r.key === "a")!;
    expect(a.votes).toBe(6);
    expect(a.verdict).toBe("quiet-loved");
  });

  it("一条样本也没有 → 全 unknown，不抛", () => {
    expect(hotVsVotes([])).toEqual([]);
    const rows = hotVsVotes([film({ key: "a" })]);
    expect(rows[0].verdict).toBe("unknown");
  });
});
