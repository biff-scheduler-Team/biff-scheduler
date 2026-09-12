// 「冲突组 + 顺位 → 全部无冲突方案」派生单测(2026-09-11,PLAN-20260911223000)。
//
// 锁住四件事:
//   ① **方案 = 枚举所有「每个冲突组各取一场」的组合**(不是「顺位 k → 方案 k」那种一对一);
//   ② **顺位只表达偏好次序**:组内按它排序,方案按「顺位成本」(Σ 各组所选顺位)升序排列;
//   ③ 枚举顺序天然分层(成本从组数一路加上去),故同成本内按组序字典序稳定;
//   ④ 逐套跑冲突校验 —— 内部撞车的组合不进 `options`,其场次进 `broken`。
//
// 纯函数,不碰 DOM(vitest environment = node)。

import { describe, expect, it } from "vitest";
import { computeConflicts, type ConflictResult, type Slot } from "../src/conflict";
import { autoFixRanks, buildPlanSet, MAX_OPTIONS } from "../src/plans";

/** 一场(默认 2026-10-08 @ b1);start / end 为当日分钟数 */
function slot(code: string, start: number, end: number, date = "2026-10-08"): Slot {
  return { code, date, start, end, venue: "b1" };
}

function conflictsOf(slots: Slot[]): Map<string, ConflictResult> {
  return computeConflicts(slots, () => 0);
}

/** 组内兜底排序键 = code 的数字值(测试里就是字典序) */
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
    const ps = buildPlanSet(["001", "002"], conflictsOf(slots), new Map(), byCode, distinctFilms);
    expect(ps.groups).toEqual([]);
    expect(ps.common.sort()).toEqual(["001", "002"]);
    expect(ps.options).toEqual([{ picks: [], codes: ["001", "002"], cost: 0 }]);
    expect(ps.total).toBe(1);
    expect(ps.truncated).toBe(false);
    expect(ps.broken.size).toBe(0);
  });

  it("同刻不同日不成组(冲突按 date 分桶)", () => {
    const slots = [slot("001", 600, 700), slot("002", 600, 700, "2026-10-09")];
    const ps = buildPlanSet(["001", "002"], conflictsOf(slots), new Map(), byCode, distinctFilms);
    expect(ps.groups).toEqual([]);
    expect(ps.options.length).toBe(1);
  });
});

describe("buildPlanSet:单冲突组", () => {
  const slots = [slot("001", 600, 700), slot("002", 650, 750)];

  it("2 场重叠 → 2 套方案,按顺位成本排序", () => {
    const ps = buildPlanSet(["001", "002"], conflictsOf(slots), new Map(), byCode, distinctFilms);
    expect(ps.groups).toEqual([["001", "002"]]);
    expect(ps.rankOf.get("001")).toBe(1);
    expect(ps.rankOf.get("002")).toBe(2);
    expect(ps.options).toEqual([
      { picks: ["001"], codes: ["001"], cost: 1 },
      { picks: ["002"], codes: ["002"], cost: 2 },
    ]);
  });

  it("显式顺位覆盖兜底序(拖动的效果)", () => {
    const rank = new Map([
      ["001", 2],
      ["002", 1],
    ]);
    const ps = buildPlanSet(["001", "002"], conflictsOf(slots), rank, byCode, distinctFilms);
    expect(ps.groups).toEqual([["002", "001"]]);
    expect(ps.options.map((o) => o.picks)).toEqual([["002"], ["001"]]);
  });

  it("顺位归一成 1..n —— 输入是脏值(100 / 7)也重排", () => {
    const rank = new Map([
      ["001", 100],
      ["002", 7],
    ]);
    const ps = buildPlanSet(["001", "002"], conflictsOf(slots), rank, byCode, distinctFilms);
    expect(ps.rankOf.get("002")).toBe(1);
    expect(ps.rankOf.get("001")).toBe(2);
  });
});

describe("buildPlanSet:链式重叠(连通分量)", () => {
  // 001~002、002~003 重叠,001 与 003 不重叠 → 同一个连通分量(三场一组)
  const slots = [slot("001", 600, 700), slot("002", 650, 750), slot("003", 720, 820)];

  it("一组三场 → 3 套方案,成本 1/2/3", () => {
    const ps = buildPlanSet(["001", "002", "003"], conflictsOf(slots), new Map(), byCode, distinctFilms);
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
    const ps = buildPlanSet(codes, conflictsOf(slots), new Map(), byCode, distinctFilms);
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
    const ps = buildPlanSet([...codes, "900"], conflictsOf(withCommon), new Map(), byCode, distinctFilms);
    expect(ps.common).toEqual(["900"]);
    for (const o of ps.options) {
      expect(o.picks).not.toContain("900");
      expect(o.codes).toContain("900");
      expect(o.codes.length).toBe(o.picks.length + 1);
    }
  });

  it("换顺位 → 方案顺序整体改变(但集合不变)", () => {
    const rank = new Map([
      ["005", 2],
      ["027", 1],
      ["071", 2],
      ["089", 1],
    ]);
    const ps = buildPlanSet(codes, conflictsOf(slots), rank, byCode, distinctFilms);
    expect(ps.options.map((o) => o.picks.join("+"))).toEqual([
      "027+089",
      "027+071",
      "005+089",
      "005+071",
    ]);
  });

  it("3 组 → 8 套(组合数 = ∏ 组大小)", () => {
    const { codes: c, slots: s } = disjointGroups([2, 2, 2]);
    const ps = buildPlanSet(c, conflictsOf(s), new Map(), () => 0, () => null);
    expect(ps.total).toBe(8);
    expect(ps.options.length).toBe(8);
    expect(ps.truncated).toBe(false);
  });
});

describe("buildPlanSet:同一部片只留一场", () => {
  // 用户截图(2026-09-11)报的真实场景:
  //   组① {005 Satoko, 027 峡湾}(10/7 12:20 同开)、组② {071 峡湾, 089 Possible Love}(10/8 09:00 同开);
  //   027 与 071 **是同一部片**《Fjord · 峡湾》,且各自都是组内顺位 1 ⇒ 不去重时
  //   「最优先」那套 = `027+071` = 同一部片看两遍。去重后应只剩 3 套。
  const slots = [
    slot("005", 740, 898, "2026-10-07"),
    slot("027", 740, 886, "2026-10-07"),
    slot("071", 540, 686, "2026-10-08"),
    slot("089", 540, 724, "2026-10-08"),
  ];
  const codes = ["005", "027", "071", "089"];
  /** 027 与 071 是同一部片,其余各自独立 */
  const films = (code: string): string => (code === "027" || code === "071" ? "film:fjord" : `film:${code}`);
  /** 用户拖出来的顺位:两组都是「峡湾在前」 */
  const rank = new Map([
    ["027", 1],
    ["005", 2],
    ["071", 1],
    ["089", 2],
  ]);

  it("同片两场分属两组 → 剔除该组合,套数 4 → 3", () => {
    const ps = buildPlanSet(codes, conflictsOf(slots), rank, byCode, films);
    expect(ps.total).toBe(4);
    expect(ps.options.map((o) => [o.picks.join("+"), o.cost])).toEqual([
      ["027+089", 3],
      ["005+071", 3],
      ["005+089", 4],
    ]);
    expect(ps.droppedSameFilm).toBe(1);
  });

  it("剔除后「最优先」不再是同片重复那套(成本层自然上移,不空窗)", () => {
    const ps = buildPlanSet(codes, conflictsOf(slots), rank, byCode, films);
    expect(ps.options[0].picks).toEqual(["027", "089"]);
    for (const o of ps.options) {
      const keys = o.picks.map(films);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("filmKeyOf 返回 null 的场次不参与去重(不误杀)", () => {
    const ps = buildPlanSet(codes, conflictsOf(slots), rank, byCode, () => null);
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
      new Map(),
      () => 0,
      () => "film:x"
    );
    expect(ps.options.length).toBe(4);
    expect(ps.droppedSameFilm).toBe(0);
  });
});

describe("buildPlanSet:顺位撞车(逐层)+ 一键修复", () => {
  // 用户报的真实场景(2026-09-12):
  //   组① {027 峡湾, 005}(10/7 12:20 同开)、组② {071 峡湾, 089}(10/8 09:00 同开);
  //   027 与 071 **是同一部片**,且各自都是组内顺位 1 ⇒ 「都取首选」那层 = `027+071`
  //   被「同一部片只留一场」剔除 —— 正是要提示 + 让路的状态。
  const slots = [
    slot("005", 740, 898, "2026-10-07"),
    slot("027", 740, 886, "2026-10-07"),
    slot("071", 540, 686, "2026-10-08"),
    slot("089", 540, 724, "2026-10-08"),
  ];
  const codes = ["005", "027", "071", "089"];
  /** 027 与 071 是同一部片,其余各自独立 */
  const films = (code: string): string => (code === "027" || code === "071" ? "film:fjord" : `film:${code}`);
  /** 用户拖出来的顺位:两组都是「峡湾在前」 */
  const rank = new Map([
    ["027", 1],
    ["005", 2],
    ["071", 1],
    ["089", 2],
  ]);

  it("第 1 层两组同片 → 检出一条撞车,两个槽位各给出 alt", () => {
    const ps = buildPlanSet(codes, conflictsOf(slots), rank, byCode, films);
    expect(ps.rankClashes.length).toBe(1);
    expect(ps.rankClashes[0].layer).toBe(1);
    expect(ps.rankClashes[0].filmKey).toBe("film:fjord");
    expect(ps.rankClashes[0].spots.map((s) => [s.group, s.code, s.alt])).toEqual([
      [0, "027", "005"],
      [1, "071", "089"],
    ]);
  });

  it("让路(组① 首选换成 005)后撞车消失,「每组都取首选」那层回到第一", () => {
    const fixed = new Map([
      ["005", 1],
      ["027", 2],
      ["071", 1],
      ["089", 2],
    ]);
    const ps = buildPlanSet(codes, conflictsOf(slots), fixed, byCode, films);
    expect(ps.rankClashes).toEqual([]);
    expect(ps.options[0].picks).toEqual(["005", "071"]);
    expect(ps.options[0].cost).toBe(2);
  });

  it("第 2 层撞车也检出(逐层,不只第 1 层)", () => {
    // 组① {005, 027}、组② {089, 071}:第 1 层 005 / 089 不同片;第 2 层 027 / 071 同片
    const rank2 = new Map([
      ["005", 1],
      ["027", 2],
      ["089", 1],
      ["071", 2],
    ]);
    const ps = buildPlanSet(codes, conflictsOf(slots), rank2, byCode, films);
    expect(ps.rankClashes.length).toBe(1);
    expect(ps.rankClashes[0].layer).toBe(2);
    expect(ps.rankClashes[0].spots.map((s) => s.code)).toEqual(["027", "071"]);
  });

  it("filmKeyOf 返回 null 的场次不参与判定(不误杀)", () => {
    const ps = buildPlanSet(codes, conflictsOf(slots), rank, byCode, () => null);
    expect(ps.rankClashes).toEqual([]);
  });

  it("autoFixRanks:让路后干净,只改一组", () => {
    const ps = buildPlanSet(codes, conflictsOf(slots), rank, byCode, films);
    const fix = autoFixRanks(ps.groups, films);
    expect(fix.remaining).toEqual([]);
    expect(fix.changes.length).toBe(1);
    expect(fix.changes[0].after[0]).not.toBe(fix.changes[0].before[0]);
    // 修复后两组第 1 层不同片
    expect(films(fix.groups[0][0])).not.toBe(films(fix.groups[1][0]));
  });

  it("autoFixRanks:干净输入 → 零改动", () => {
    const ps = buildPlanSet(codes, conflictsOf(slots), rank, byCode, films);
    // 每场都是独立影片 → 无撞车
    const clean = autoFixRanks(ps.groups, (c) => `film:${c}`);
    expect(clean.changes).toEqual([]);
    expect(clean.remaining).toEqual([]);
  });

  it("组内其余场次全是同一部片 → 两层都撞车,alt 为 null,一键修复也救不了", () => {
    const allSame = [
      slot("a1", 600, 700, "2026-10-07"),
      slot("a2", 650, 750, "2026-10-07"),
      slot("b1", 600, 700, "2026-10-08"),
      slot("b2", 650, 750, "2026-10-08"),
    ];
    const ps = buildPlanSet(["a1", "a2", "b1", "b2"], conflictsOf(allSame), new Map(), () => 0, () => "film:x");
    expect(ps.rankClashes.length).toBe(2);
    expect(ps.rankClashes.map((c) => c.layer)).toEqual([1, 2]);
    expect(ps.rankClashes[0].spots.map((s) => s.alt)).toEqual([null, null]);
    const fix = autoFixRanks(ps.groups, () => "film:x");
    expect(fix.changes).toEqual([]);
    expect(fix.remaining.length).toBe(2);
  });
});

describe("buildPlanSet:上限与入参", () => {
  it("组合数超过上限 → 只保留成本最低的一批并置 truncated", () => {
    const { codes, slots } = disjointGroups([4, 4, 4, 4]); // 4^4 = 256 > 240
    const ps = buildPlanSet(codes, conflictsOf(slots), new Map(), () => 0, () => null);
    expect(ps.total).toBe(256);
    expect(ps.options.length).toBe(MAX_OPTIONS);
    expect(ps.truncated).toBe(true);
  });

  it("重复 code 去重保序;不在 cat 里的 code 照常参与(不抛)", () => {
    const slots = [slot("001", 600, 700)];
    const ps = buildPlanSet(["001", "001", "zzz"], conflictsOf(slots), new Map(), byCode, distinctFilms);
    expect(ps.common).toEqual(["001", "zzz"]);
    expect(ps.options[0].codes).toEqual(["001", "zzz"]);
  });

  it("空输入 → 1 套空方案", () => {
    const ps = buildPlanSet([], new Map(), new Map(), byCode, distinctFilms);
    expect(ps.options).toEqual([{ picks: [], codes: [], cost: 0 }]);
    expect(ps.total).toBe(1);
  });
});
