// 「冲突组 → 全部无冲突方案」派生单测(2026-09-11,PLAN-20260911223000)。
//
// 锁住四件事:
//   ① **方案 = 枚举所有「每个冲突组各取一场」的组合**(不是「第 k 场 → 方案 k」那种一对一);
//   ② **组内次序 = 开场时间**(`fallbackOrder`;用户可拖的抢票顺位已于 2026-09-30 下线,
//      见 `PLAN-20260930213528`),方案按「成本」(Σ 各组所选场次在组内的位次)升序排列;
//   ③ 枚举顺序天然分层(成本从组数一路加上去),故同成本内按组序字典序稳定;
//   ④ 逐套跑冲突校验 —— 内部撞车的组合不进 `options`,其场次进 `broken`。
//
// 纯函数,不碰 DOM(vitest environment = node)。

import { describe, expect, it } from "vitest";
import { computeConflicts, type ConflictResult, type Slot } from "../src/conflict";
import { buildPlanSet, MAX_OPTIONS } from "../src/plans";

/** 一场(默认 2026-10-08 @ b1);start / end 为当日分钟数 */
function slot(code: string, start: number, end: number, date = "2026-10-08"): Slot {
  return { code, date, start, end, venue: "b1" };
}

function conflictsOf(slots: Slot[]): Map<string, ConflictResult> {
  return computeConflicts(slots, () => 0);
}

/** 组内排序键 = code 的数字值(测试里就是字典序) */
const byCode = (code: string): number => Number(code);

/** 默认影片口径:每个 code 都是**独立影片** —— 不触发「同一部片只留一场」去重 */
const distinctFilms = (code: string): string => `film:${code}`;

/** 造 N 个**互不相交**的冲突组:第 i 组放在第 i 天,组内各场两两重叠 */
function disjointGroups(sizes: number[]): { codes: string[]; slots: Slot[] } {
  const codes: string[] = [];
  const slots: Slot[] = [];
  sizes.forEach((size, gi) => {
    const date = `2026-10-${String(8 + gi).padStart(2, "0")}`;
    for (let i = 0; i < size; i++) {
      const code = `g${gi}c${i}`;
      codes.push(code);
      slots.push(slot(code, 600 + i * 5, 700 + i * 5, date));
    }
  });
  return { codes, slots };
}

describe("buildPlanSet:无冲突", () => {
  it("全部场次都进 common,只有 1 套方案", () => {
    const slots = [slot("001", 600, 700), slot("002", 700, 800)];
    const ps = buildPlanSet(["001", "002"], conflictsOf(slots), byCode, distinctFilms);
    expect(ps.groups).toEqual([]);
    expect(ps.common.sort()).toEqual(["001", "002"]);
    expect(ps.options).toEqual([{ picks: [], codes: ["001", "002"], cost: 0 }]);
    expect(ps.total).toBe(1);
    expect(ps.truncated).toBe(false);
    expect(ps.broken.size).toBe(0);
  });

  it("同刻不同日不成组(冲突按 date 分桶)", () => {
    const slots = [slot("001", 600, 700), slot("002", 600, 700, "2026-10-09")];
    const ps = buildPlanSet(["001", "002"], conflictsOf(slots), byCode, distinctFilms);
    expect(ps.groups).toEqual([]);
    expect(ps.options.length).toBe(1);
  });
});

describe("buildPlanSet:单冲突组", () => {
  const slots = [slot("001", 600, 700), slot("002", 650, 750)];

  it("2 场重叠 → 2 套方案,按组内位次成本排序", () => {
    const ps = buildPlanSet(["001", "002"], conflictsOf(slots), byCode, distinctFilms);
    expect(ps.groups).toEqual([["001", "002"]]);
    expect(ps.options).toEqual([
      { picks: ["001"], codes: ["001"], cost: 1 },
      { picks: ["002"], codes: ["002"], cost: 2 },
    ]);
  });

  // 回归:组内次序改由 `fallbackOrder` 唯一决定(顺位那层已经没有了)。
  // 这条钉住「开场早的排在前」——它同时决定成本顺序与 `topPlanCodes` 取哪一场。
  it("组内次序 = 开场时间:code 更小但开场更晚的排后面", () => {
    // 两场**重叠**(720 > 700)才会成组;这里刻意让 code 次序与开场次序相反
    const rows = [slot("001", 700, 800), slot("002", 600, 720)];
    const startOf: Record<string, number> = { "001": 700, "002": 600 };
    const ps = buildPlanSet(["001", "002"], conflictsOf(rows), (c) => startOf[c] ?? 0, distinctFilms);
    expect(ps.groups).toEqual([["002", "001"]]);
    expect(ps.options.map((o) => o.picks[0])).toEqual(["002", "001"]);
  });
});

describe("buildPlanSet:链式重叠(连通分量)", () => {
  // 001~002、002~003 重叠,001 与 003 不重叠 → 同一个连通分量(三场一组)
  const slots = [slot("001", 600, 700), slot("002", 650, 750), slot("003", 720, 820)];

  it("一组三场 → 3 套方案,成本 1/2/3", () => {
    const ps = buildPlanSet(["001", "002", "003"], conflictsOf(slots), byCode, distinctFilms);
    expect(ps.groups).toEqual([["001", "002", "003"]]);
    expect(ps.options.map((o) => [o.picks[0], o.cost])).toEqual([
      ["001", 1],
      ["002", 2],
      ["003", 3],
    ]);
  });
});

describe("buildPlanSet:多组 → 枚举所有组合", () => {
  // 用户截图里的真实结构:组① {005, 027}(12:20 同时开)、组② {071, 089}(09:00 同时开)
  // 两组互不重叠 ⇒ 任意组合都不冲突 ⇒ 2 × 2 = 4 套
  // ⚠ 本组刻意让四场**分属四部不同影片**(`distinctFilms`),把「组合枚举」本身与
  //   「同一部片只留一场」两条规则分开锁 —— 后者的用例见下一个 describe。
  const slots = [
    slot("005", 740, 898),
    slot("027", 740, 886),
    slot("071", 540, 686),
    slot("089", 540, 724),
  ];
  const codes = ["005", "027", "071", "089"];

  it("2 组 × 2 场 → 4 套,按成本 2 / 3 / 3 / 4 排序", () => {
    const ps = buildPlanSet(codes, conflictsOf(slots), byCode, distinctFilms);
    expect(ps.groups).toEqual([
      ["005", "027"],
      ["071", "089"],
    ]);
    expect(ps.total).toBe(4);
    expect(ps.options.map((o) => [o.picks.join("+"), o.cost])).toEqual([
      ["005+071", 2],
      ["005+089", 3],
      ["027+071", 3],
      ["027+089", 4],
    ]);
  });

  it("共同场次进每一套,且不进 picks", () => {
    const withCommon = [...slots, slot("900", 1100, 1200)];
    const ps = buildPlanSet([...codes, "900"], conflictsOf(withCommon), byCode, distinctFilms);
    expect(ps.common).toEqual(["900"]);
    for (const o of ps.options) {
      expect(o.picks).not.toContain("900");
      expect(o.codes).toContain("900");
      expect(o.codes.length).toBe(o.picks.length + 1);
    }
  });

  it("3 组 → 8 套(组合数 = ∏ 组大小)", () => {
    const { codes: c, slots: s } = disjointGroups([2, 2, 2]);
    const ps = buildPlanSet(c, conflictsOf(s), () => 0, () => null);
    expect(ps.total).toBe(8);
    expect(ps.options.length).toBe(8);
    expect(ps.truncated).toBe(false);
  });
});

describe("buildPlanSet:同一部片只留一场", () => {
  // 用户截图(2026-09-11)报的真实场景:
  //   组① {005 Satoko, 027 峡湾}(10/7 12:20 同开)、组② {071 峡湾, 089 Possible Love}(10/8 09:00 同开);
  //   027 与 071 **是同一部片**《Fjord · 峡湾》。不去重时 `027+071` = 同一部片看两遍。
  // ⚠ 顺位下线后组内次序 = 开场时间,同刻再按 code:组① [005, 027]、组② [071, 089]。
  const slots = [
    slot("005", 740, 898, "2026-10-07"),
    slot("027", 740, 886, "2026-10-07"),
    slot("071", 540, 686, "2026-10-08"),
    slot("089", 540, 724, "2026-10-08"),
  ];
  const codes = ["005", "027", "071", "089"];
  /** 027 与 071 是同一部片,其余各自独立 */
  const films = (code: string): string => (code === "027" || code === "071" ? "film:fjord" : `film:${code}`);

  it("同片两场分属两组 → 剔除该组合,套数 4 → 3", () => {
    const ps = buildPlanSet(codes, conflictsOf(slots), byCode, films);
    expect(ps.total).toBe(4);
    expect(ps.options.map((o) => [o.picks.join("+"), o.cost])).toEqual([
      ["005+071", 2],
      ["005+089", 3],
      ["027+089", 4],
    ]);
    expect(ps.droppedSameFilm).toBe(1);
  });

  it("剔除后每一套内部都没有同片重复", () => {
    const ps = buildPlanSet(codes, conflictsOf(slots), byCode, films);
    for (const o of ps.options) {
      const keys = o.picks.map(films);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("filmKeyOf 返回 null 的场次不参与去重(不误杀)", () => {
    const ps = buildPlanSet(codes, conflictsOf(slots), byCode, () => null);
    expect(ps.options.length).toBe(4);
    expect(ps.droppedSameFilm).toBe(0);
  });

  it("所有组合都被判死 → 退回不去重结果,不返回空列表", () => {
    // 两个冲突组的成员**各自**都是同一部片的两场(同日不同厅、时间重叠)
    const sameFilmSlots = [
      slot("a1", 600, 700, "2026-10-07"),
      slot("a2", 650, 750, "2026-10-07"),
      slot("b1", 600, 700, "2026-10-08"),
      slot("b2", 650, 750, "2026-10-08"),
    ];
    const ps = buildPlanSet(
      ["a1", "a2", "b1", "b2"],
      conflictsOf(sameFilmSlots),
      () => 0,
      () => "film:x"
    );
    expect(ps.options.length).toBe(4);
    expect(ps.droppedSameFilm).toBe(0);
  });
});

describe("buildPlanSet:上限与入参", () => {
  it("组合数超过上限 → 只保留成本最低的一批并置 truncated", () => {
    const { codes, slots } = disjointGroups([4, 4, 4, 4]); // 4^4 = 256 > 240
    const ps = buildPlanSet(codes, conflictsOf(slots), () => 0, () => null);
    expect(ps.total).toBe(256);
    expect(ps.options.length).toBe(MAX_OPTIONS);
    expect(ps.truncated).toBe(true);
  });

  it("重复 code 去重保序;不在 cat 里的 code 照常参与(不抛)", () => {
    const slots = [slot("001", 600, 700)];
    const ps = buildPlanSet(["001", "001", "zzz"], conflictsOf(slots), byCode, distinctFilms);
    expect(ps.common).toEqual(["001", "zzz"]);
    expect(ps.options[0].codes).toEqual(["001", "zzz"]);
  });

  it("空输入 → 1 套空方案", () => {
    const ps = buildPlanSet([], new Map(), byCode, distinctFilms);
    expect(ps.options).toEqual([{ picks: [], codes: [], cost: 0 }]);
    expect(ps.total).toBe(1);
  });
});

/* 「顺位撞车」(`rankClashes`)与一键修复(`autoFixRanks`)的两个 describe 已于 2026-09-30
 * 整体删除(`PLAN-20260930213528`):它们锁的是「用户拖出来的顺位互相打架」这个状态,
 * 而顺位本身随卡片视图下线,组内次序现在由开场时间唯一决定 —— 没有可让路的余地。 */
