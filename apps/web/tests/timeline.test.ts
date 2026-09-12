// 移动端单日时间线的**纯函数**口径测试(2026-09-12,PLAN-20260912002532)。
//
// 只测 `timelineEntries()` —— 排序、筛选剔除、以及「与上一场**已选**」的间隔 / 重叠判定。
// 渲染(`buildTimeline`)是 DOM 产物,走无头交互验收,不在这里断言。
//
// ⚠ 连接件**只服务已选场次**:时间线列的是当天全部场次(≈75 场),给任意相邻两场都算「赶场间隔」
//   是纯噪声 —— 未排进场次的间隔没有意义。故 `prev` 只在遇到已选场次时推进(见 `timelineEntries`)。
import { describe, expect, it } from "vitest";
import type { Catalog, Screening } from "../src/types";
import { makeFilterState } from "../src/filters";
import { timelineEntries } from "../src/timeline";

const DATE = "2026-10-08";

const show = (
  code: string,
  start: string,
  end: string,
  o: { venue?: string; duration?: number; gv?: boolean; date?: string } = {}
): Screening => ({
  code,
  title_en: `Film ${code}`,
  title_kr: "",
  title_zh: "",
  date: o.date ?? DATE,
  start_time: start,
  end_time: end,
  duration_min: o.duration ?? 100,
  venue_id: o.venue ?? "b1",
  venue_display: "BCC Cinema 1",
  is_gv: o.gv ?? false,
});

/** `timelineEntries` 只读 `cat.schedule.screenings` —— 给一个最小壳,不必造整份 Catalog */
const cat = (screenings: Screening[]): Catalog =>
  ({
    schedule: { festival: { name: "BIFF", year: 2026, dates: [DATE] }, screenings },
  }) as unknown as Catalog;

/** 已选场次投影(唯一数据源 `store.slotIndex` 的形状:code → 影片 key) */
const picked = (...codes: string[]): Map<string, { key: string }> =>
  new Map(codes.map((c) => [c, { key: `sched:${c}` }]));

const opts = (codes: string[] = [], over: Partial<Parameters<typeof timelineEntries>[2]> = {}) => ({
  slots: picked(...codes),
  gvTalkOf: () => true,
  transitMin: 0,
  ...over,
});

describe("timelineEntries — 排序与筛选", () => {
  it("按开始时间升序(与入参顺序无关)", () => {
    const c = cat([show("B", "15:00", "17:00"), show("A", "10:00", "12:00"), show("C", "19:00", "21:00")]);
    expect(timelineEntries(c, DATE, opts()).map((e) => e.s.code)).toEqual(["A", "B", "C"]);
  });

  it("同时刻按影厅 id 兜底,产出稳定序", () => {
    const c = cat([show("B", "10:00", "12:00", { venue: "c1" }), show("A", "10:00", "12:00", { venue: "b1" })]);
    expect(timelineEntries(c, DATE, opts()).map((e) => e.s.venue_id)).toEqual(["b1", "c1"]);
  });

  it("只列当日场次", () => {
    const c = cat([show("A", "10:00", "12:00"), show("B", "10:00", "12:00", { date: "2026-10-09" })]);
    expect(timelineEntries(c, DATE, opts()).map((e) => e.s.code)).toEqual(["A"]);
  });

  it("排片筛选生效时,被筛掉的场次不列(时间线读**甘特图那套**筛选)", () => {
    const f = makeFilterState();
    f.gv = "gv"; // 只看 GV
    const c = cat([show("A", "10:00", "12:00"), show("B", "13:00", "15:00", { gv: true })]);
    expect(timelineEntries(c, DATE, opts([], { filters: f })).map((e) => e.s.code)).toEqual(["B"]);
  });
});

describe("timelineEntries — 连接件只服务已选", () => {
  it("未选场次不产生任何间隔判定(slack / overlap 恒空)", () => {
    const c = cat([show("A", "10:00", "12:00"), show("B", "11:00", "13:00")]);
    for (const e of timelineEntries(c, DATE, opts())) {
      expect(e.picked).toBe(false);
      expect(e.slack).toBeNull();
      expect(e.overlapMin).toBe(0);
    }
  });

  it("已选 → 已选:算出间隔与余量", () => {
    const c = cat([show("A", "10:00", "12:00"), show("B", "12:40", "14:00")]);
    const [, b] = timelineEntries(c, DATE, opts(["A", "B"]));
    expect(b.picked).toBe(true);
    expect(b.slack!.gap).toBe(40); // 12:40 − 12:00
    expect(b.overlapMin).toBe(0);
  });

  it("中间夹着**未选**场次时,间隔按「上一场已选」算(不被未选场次打断)", () => {
    const c = cat([show("A", "10:00", "12:00"), show("X", "12:10", "13:00"), show("B", "14:00", "15:00")]);
    const list = timelineEntries(c, DATE, opts(["A", "B"]));
    expect(list[1].slack).toBeNull(); // X 未选
    expect(list[2].slack!.gap).toBe(120); // 14:00 − 12:00(跳过 X)
  });

  it("第一场已选不产生连接件(前面没有已选)", () => {
    const c = cat([show("A", "10:00", "12:00"), show("B", "13:00", "15:00")]);
    expect(timelineEntries(c, DATE, opts(["A", "B"]))[0].slack).toBeNull();
  });
});

describe("timelineEntries — 重叠与跨午夜", () => {
  it("两场已选时间重叠 → overlapMin 为正、gap 为负(红色连接条的判据)", () => {
    const c = cat([show("A", "10:00", "12:00"), show("B", "11:20", "13:00")]);
    const [, b] = timelineEntries(c, DATE, opts(["A", "B"]));
    expect(b.overlapMin).toBe(40); // 12:00 − 11:20
    expect(b.slack!.gap).toBe(-40);
    expect(b.slack!.verdict).toBe("bad");
  });

  it("首尾相接(end == next.start)不算重叠", () => {
    const c = cat([show("A", "10:00", "12:00"), show("B", "12:00", "14:00")]);
    expect(timelineEntries(c, DATE, opts(["A", "B"]))[1].overlapMin).toBe(0);
  });

  it("★ 24+ 时制不取模:end_time ≥ 24:00 按真实分钟参与判定", () => {
    // A 21:00 开场、官方槽位末 29:00(= 次日 05:00,1740min);B 23:00 开场。
    // 若把 1740 折回 05:00(300min),gap 会算成 1380−300=+1080(假「宽裕」);
    // 真实是 1380−1740 = −360(重叠 6 小时)。
    const c = cat([show("A", "21:00", "29:00", { duration: 300 }), show("B", "23:00", "24:30")]);
    const [, b] = timelineEntries(c, DATE, opts(["A", "B"]));
    expect(b.slack!.gap).toBe(-360);
    expect(b.overlapMin).toBe(360);
  });

  it("非 GV 场次的有效结束取官方 end_time(片长 ≠ 槽位时长时以官方为准)", () => {
    // 片长 100 但槽位到 12:30 —— 非 GV 走保护性分支,取官方 end_time(750)
    const c = cat([show("A", "10:00", "12:30", { duration: 100 }), show("B", "12:45", "14:00")]);
    expect(timelineEntries(c, DATE, opts(["A", "B"]))[1].slack!.gap).toBe(15);
  });
});

describe("timelineEntries — 跨馆缓冲", () => {
  it("跨馆时余量扣缓冲;同馆不扣", () => {
    const c = cat([
      show("A", "10:00", "12:00", { venue: "b1" }),
      show("B", "12:30", "14:00", { venue: "c1" }), // 跨馆
      show("C", "15:00", "17:00", { venue: "c1" }), // 同馆
    ]);
    const list = timelineEntries(c, DATE, opts(["A", "B", "C"], { transitMin: 20 }));
    expect(list[1].crossVenue).toBe(true);
    expect(list[1].slack!.need).toBe(20);
    expect(list[1].slack!.slack).toBe(10); // 30 − 20
    expect(list[2].crossVenue).toBe(false);
    expect(list[2].slack!.need).toBe(0);
  });

  it("扣完缓冲后为负 → verdict = bad(时间线标红「赶不上」)", () => {
    const c = cat([
      show("A", "10:00", "12:00", { venue: "b1" }),
      show("B", "12:10", "14:00", { venue: "c1" }),
    ]);
    const [, b] = timelineEntries(c, DATE, opts(["A", "B"], { transitMin: 30 }));
    expect(b.overlapMin).toBe(0); // 不重叠
    expect(b.slack!.verdict).toBe("bad"); // 但缓冲后赶不上
  });
});
