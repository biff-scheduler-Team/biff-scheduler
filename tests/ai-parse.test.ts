// AI 返回的**本地复检**测试 —— 不信任模型的自我约束:无效 code / 未打标影片 / 同片重复 /
// 时段冲突都必须被本地剔出来并明示,而不是排进方案里等网格变红。见 `ai.ts::parseOnePlan`。
import { describe, expect, it } from "vitest";
import { parseAiResult, type AiPlanOption } from "../src/ai";
import type { EngineFilm } from "../src/score";
import { catalog, show } from "./helpers";

// 夹具(全部 2026-10-08;catalog 无目录 → filmNodeKey 走 sched:<中文名小写>)
//   101 Alpha 10:00–11:40 @b1      102 Alpha 14:00–15:40 @b1(同片第二场)
//   103 Beta  11:00–12:40 @b2(与 101 重叠)
//   104 Beta  16:00–17:40 @b1
//   105 Gamma 12:00–13:00 @b1(与 101 同馆,余量 20min)
//   106 Delta 18:00–19:00 @b1(Delta 故意不打标)
//   110 Gamma 11:50–12:50 @b2(与 101 跨馆,余量 10min < 转场 30min)
const shows = [
  show({ code: "101", title_zh: "Alpha", start_time: "10:00", end_time: "11:40", venue_id: "b1" }),
  show({ code: "102", title_zh: "Alpha", start_time: "14:00", end_time: "15:40", venue_id: "b1" }),
  show({ code: "103", title_zh: "Beta", start_time: "11:00", end_time: "12:40", venue_id: "b2" }),
  show({ code: "104", title_zh: "Beta", start_time: "16:00", end_time: "17:40", venue_id: "b1" }),
  show({ code: "105", title_zh: "Gamma", start_time: "12:00", end_time: "13:00", venue_id: "b1" }),
  show({ code: "106", title_zh: "Delta", start_time: "18:00", end_time: "19:00", venue_id: "b1" }),
  show({ code: "110", title_zh: "Gamma", start_time: "11:50", end_time: "12:50", venue_id: "b2" }),
];
const cat = catalog(shows);

const film = (zh: string, priority: EngineFilm["priority"]): EngineFilm => ({
  key: `sched:${zh.toLowerCase()}`,
  zh,
  priority,
  rating: null,
  shows: shows.filter((s) => s.title_zh === zh),
});
const films: EngineFilm[] = [film("Alpha", "must"), film("Beta", "maybe"), film("Gamma", "wild")];
const TRANSIT = 30;

const j = (v: unknown): string => JSON.stringify(v);
const one = (raw: string, transit = TRANSIT): AiPlanOption => parseAiResult(raw, cat, films, transit).options[0];

describe("逐场复检:无效 / 未打标 / 同片重复", () => {
  it("清单里没有的 code → rejected(不静默丢)", () => {
    const o = one(j({ picks: ["101", "999"] }));
    expect(o.picks.map((p) => p.code)).toEqual(["101"]);
    expect(o.rejected).toEqual([{ code: "999", why: "无效 code(清单里没有这一场)" }]);
  });

  it("★ 影片未打标(不在本次送出的清单里)→ rejected,不能被静默排进来", () => {
    const o = one(j({ picks: ["106"] }));
    expect(o.picks).toHaveLength(0);
    expect(o.rejected).toEqual([{ code: "106", why: "该影片未打标(不在本次清单内)" }]);
  });

  it("同一部影片给了两场 → 只留一个,另一个 rejected", () => {
    const o = one(j({ picks: ["101", "102"] }));
    expect(o.picks.map((p) => p.code)).toEqual(["101"]);
    expect(o.rejected).toEqual([{ code: "102", why: "同一部影片已选了其它场次" }]);
  });

  it("重复给同一个 code → 第二次按「同片重复」剔除(幂等)", () => {
    const o = one(j({ picks: ["101", "101"] }));
    expect(o.picks.map((p) => p.code)).toEqual(["101"]);
    expect(o.rejected).toHaveLength(1);
  });

  it("picks 支持对象形式 {code}(容错,不要求模型只给字符串)", () => {
    expect(one(j({ picks: [{ code: "101" }] })).picks.map((p) => p.code)).toEqual(["101"]);
  });
});

describe("时段冲突复检(口径与网格一致:有效结束 + 同馆 0 / 跨馆 transitMin)", () => {
  it("重叠 → 剔除后一场;排序保证**早场优先保留**", () => {
    const o = one(j({ picks: ["103", "101"] })); // 乱序输入,101 更早
    expect(o.picks.map((p) => p.code)).toEqual(["101"]);
    expect(o.rejected).toEqual([{ code: "103", why: "与已保留场次时段冲突" }]);
  });

  it("同馆余量 20min → 不算冲突(同馆无需转场)", () => {
    expect(one(j({ picks: ["101", "105"] })).picks.map((p) => p.code)).toEqual(["101", "105"]);
  });

  it("★ 跨馆「无重叠但转场不足」当前**不会**被剔除 —— transitMin 对复检结果零影响(实测)", () => {
    // 根因见 tests/conflict.test.ts:computeConflicts 的 break 在追加 transit 之前就中断了内层循环,
    // 而 `a.end + transit > b.start` 在 guard `b.start < a.end` 下对任何 transit ≥ 0 恒真
    // → transit 从不改变判定。故 101(10:00–11:40 b1)与 110(11:50–12:50 b2,余量 10min)按「无重叠」放行。
    // ✅ 这**符合**既定语义:红只留给时间重叠;「跨馆赶不上」由 `grid.ts::markTight` 的黄卡 +
    //    行程页 `agenda.ts::gapConnector` 的「⚠ 赶不上」覆盖 → AI 复检不剔除它是对的(PLAN.md §7.5/§7.6)。
    for (const transit of [0, 30, 120]) {
      const o = one(j({ picks: ["101", "110"] }), transit);
      expect(o.picks.map((p) => p.code)).toEqual(["101", "110"]);
      expect(o.rejected).toHaveLength(0);
    }
  });
});

describe("未纳入(dropped)", () => {
  it("模型自述的原因原样保留(截 40 字)", () => {
    const o = one(j({ picks: ["101"], dropped: [{ key: "sched:beta", why: "时间冲突" }] }));
    expect(o.drops).toContainEqual({ filmKey: "sched:beta", zh: "Beta", why: "时间冲突" });
  });

  it("★ 非 wild 的片没排进来且模型没说明 → 自动补「AI 未排入」(must 不许静默消失)", () => {
    const o = one(j({ picks: ["104"] }));
    expect(o.drops).toContainEqual({ filmKey: "sched:alpha", zh: "Alpha", why: "AI 未排入" });
  });

  it("wild(随缘)没排进来 → 不自动提示(避免噪音)", () => {
    const o = one(j({ picks: ["101"] }));
    expect(o.drops.some((d) => d.filmKey === "sched:gamma")).toBe(false);
  });

  it("dropped 容错:接受 film_key / reason 两种键名", () => {
    const o = one(j({ picks: [], dropped: [{ film_key: "sched:alpha", reason: "排不下" }] }));
    expect(o.drops).toContainEqual({ filmKey: "sched:alpha", zh: "Alpha", why: "排不下" });
  });
});

describe("多方案解析", () => {
  it("plans[] 按原顺序保留(模型已按优先级排好)", () => {
    const p = parseAiResult(j({ plans: [{ title: "必看全覆盖", picks: ["101"] }, { title: "最紧凑", picks: ["104"] }] }), cat, films, TRANSIT);
    expect(p.options.map((o) => o.title)).toEqual(["必看全覆盖", "最紧凑"]);
  });

  it("雷同方案(场次集合相同)只保留第一个", () => {
    const p = parseAiResult(
      j({ plans: [{ title: "A", picks: ["101"] }, { title: "B", picks: ["101"] }, { title: "C", picks: ["104"] }] }),
      cat,
      films,
      TRANSIT
    );
    expect(p.options.map((o) => o.title)).toEqual(["A", "C"]);
  });

  it("最多保留 3 个", () => {
    const p = parseAiResult(
      j({ plans: [{ picks: ["101"] }, { picks: ["104"] }, { picks: ["105"] }, { picks: ["110"] }] }),
      cat,
      films,
      TRANSIT
    );
    expect(p.options).toHaveLength(3);
  });

  it("plans 全是空对象 → 兜底给 1 个空方案(不返回空数组)", () => {
    const p = parseAiResult(j({ plans: [{}, {}] }), cat, films, TRANSIT);
    expect(p.options).toHaveLength(1);
    expect(p.options[0].picks).toHaveLength(0);
  });

  it("兼容旧的单方案格式(顶层 picks),此时无整体 note", () => {
    const p = parseAiResult(j({ picks: ["101"], note: "旧格式" }), cat, films, TRANSIT);
    expect(p.options).toHaveLength(1);
    expect(p.options[0].picks.map((x) => x.code)).toEqual(["101"]);
    expect(p.note).toBe("");
  });
});

describe("容错与截断", () => {
  it("剥 ```json 围栏 + 忽略前后废话", () => {
    const raw = '好的,这是方案:\n```json\n{"picks":["101"]}\n```\n希望对你有帮助';
    expect(one(raw).picks.map((p) => p.code)).toEqual(["101"]);
  });

  it("title 截 30 字 / note 截 200 字(防模型写小作文撑爆卡片)", () => {
    const o = one(j({ picks: [], title: "字".repeat(50), note: "字".repeat(250) }));
    expect(o.title).toHaveLength(30);
    expect(o.note).toHaveLength(200);
  });

  it("完全不是 JSON → 抛 AiError(上层转成可读文案)", () => {
    expect(() => parseAiResult("我无法完成这个请求。", cat, films, TRANSIT)).toThrow();
  });

  it("原始返回原样带出(UI 的「查看原始返回」用)", () => {
    const raw = j({ picks: ["101"] });
    expect(parseAiResult(raw, cat, films, TRANSIT).raw).toBe(raw);
  });
});
