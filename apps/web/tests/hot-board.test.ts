// 「热门榜」纯逻辑单测（2026-10-14，PLAN-20261014150805 修订 1 / 2；同日再修订为单一榜单）。
//
// 覆盖点：① 排序口径（想看降序、同数按片名）—— 与 `RushCrowdPanel` 共用同一支比较器；
//   ② **全部影片都在榜上**（2026-10-14 用户：「全部默认就是全部影片的想看人数就行」），
//     想看 0 的只是排在末尾，不再被筛掉；
//   ③ 口碑评分**逐字复用** `redblack.ts::scoreOf`（这里断言与它相等，而不是硬编码数字）；
//   ④ 脏值夹成非负整数；⑤ 分组：组内保持排序、组间按想看合计降序。

import { describe, expect, it } from "vitest";
import type { FilmNode } from "../src/app/model";
import type { FilmItem } from "../src/types";
import { buildHotRows, compareByWant, groupByUnit, hotTotals } from "../src/hot-board";
import { scoreOf, type CrowdCounts } from "../src/redblack";

/** 最小影片节点：只写热门榜真正读的字段（`cats[0].unit` / `title` / `poster`）。
 *  `also` = 联映块单元的成员关系（`FilmItem.also_units`）。 */
function film(key: string, title: string, unit: string, poster?: string, also?: string[]): FilmNode {
  return {
    key,
    title,
    en: "",
    zh: title,
    names: [title],
    meta: "",
    cats: [{ unit, also_units: also } as FilmItem],
    shows: [],
    poster,
  };
}

function crowd(entries: Array<[string, { red: number; black: number }]>): CrowdCounts {
  return new Map(
    entries.map(([key, counts]) => [
      key,
      { total: counts.red + counts.black, red: counts.red, black: counts.black },
    ]),
  );
}

const PRIOR = 0.5;

describe("compareByWant", () => {
  it("想看降序；同数按片名（稳定，不随机）", () => {
    // ⚠ 片名用 ASCII：`localeCompare` 在中文串上的结果随运行环境的 locale 变，
    // 拿它当断言会变成「测环境」而不是「测口径」。中文片名的并列顺序不是本条的考点。
    const rows = [
      { want: 5, title: "Beta" },
      { want: 30, title: "Alpha" },
      { want: 5, title: "Alpha" },
    ];
    expect([...rows].sort(compareByWant).map((r) => `${r.title}:${r.want}`)).toEqual([
      "Alpha:30",
      "Alpha:5",
      "Beta:5",
    ]);
  });
});

describe("buildHotRows", () => {
  it("★ 回归：没有信号的影片**也在榜上**，只是排在末尾（原先它会被筛掉）", () => {
    const films = [film("cat:a", "A", "Test Unit"), film("cat:b", "B", "Test Unit")];
    const rows = buildHotRows(films, { "cat:a": 7 }, new Map(), PRIOR);
    // b 想看 0、也一票没有 —— 2026-10-14 起榜单是「本届全部影片」，它照样在
    expect(rows.map((r) => r.key)).toEqual(["cat:a", "cat:b"]);
    expect(rows[1].want).toBe(0);
  });

  it("排序是「想看降序」：票多的片也不会插到想看少的片前面", () => {
    const films = [
      film("cat:a", "A", "Test Unit"),
      film("cat:b", "B", "Test Unit"),
      film("cat:c", "C", "Test Unit"),
    ];
    const rows = buildHotRows(
      films,
      { "cat:a": 3, "cat:b": 9 },
      // a 有 80 枚贴纸（全场最多）却只有 3 人想看；b 只有 9 人想看但没票 ——
      // 榜单按**想看**排，所以 a 不能因为票多而插到 b 前面。
      // c 零想看零票 → 在榜上，但排在最末（想看 0 一律靠后）。
      crowd([["cat:a", { red: 40, black: 40 }]]),
      PRIOR,
    );
    expect(rows.map((r) => r.key)).toEqual(["cat:b", "cat:a", "cat:c"]);
  });

  it("口碑评分与 redblack.ts::scoreOf 逐字一致；一票没有 = null", () => {
    const counts = { red: 3, black: 0 };
    const films = [film("cat:a", "A", "Test Unit"), film("cat:b", "B", "Test Unit")];
    const rows = buildHotRows(films, { "cat:a": 5, "cat:b": 4 }, crowd([["cat:a", counts]]), PRIOR);
    expect(rows[0].score).toBe(scoreOf({ ...counts, total: 3 }, PRIOR));
    expect(rows[1].score).toBeNull();
  });

  it("脏值夹成非负整数（负数 / NaN / 字符串都不炸）", () => {
    const films = [film("cat:a", "A", "Test Unit")];
    const rows = buildHotRows(films, { "cat:a": -5 }, crowd([["cat:a", { red: -2, black: 3 }]]), PRIOR);
    expect(rows).toHaveLength(1);
    expect(rows[0].want).toBe(0);
    expect(rows[0].red).toBe(0);
    expect(rows[0].black).toBe(3);
  });

  it("单元键取自目录条目（FilmNode 上没有 unit），未知单元原样兜底", () => {
    const rows = buildHotRows([film("cat:a", "A", "Test Unit")], { "cat:a": 1 }, new Map(), PRIOR);
    expect(rows[0].units).toEqual(["Test Unit"]);
    expect(rows[0].unitName).toBe("Test Unit");
  });

  it("★ 回归：同一单元的不同写法归一到**一个**键（原先是 4 个同名选项各占一行）", () => {
    // 2026-10-14 打开榜单页实测：单元下拉里出现了 4 个一模一样的
    // 「Asian Filmmaker of the Year · 年度亚洲电影人奖 · 杨紫琼专题，1 部」——
    // 根因是按**原串**分组，而 `units.ts::unitKey` 早就把它们归一成「亚洲电影人奖」了。
    const films = [
      film("cat:a", "A", "亚洲电影人奖"),
      film("cat:b", "B", "年度亚洲电影人奖-杨紫琼专题"),
      film("cat:c", "C", "2026年度亚洲电影人奖-杨紫琼专题"),
    ];
    const rows = buildHotRows(
      films,
      { "cat:a": 3, "cat:b": 2, "cat:c": 1 },
      new Map(),
      PRIOR,
    );
    expect(rows.map((r) => r.units)).toEqual([
      ["亚洲电影人奖"],
      ["亚洲电影人奖"],
      ["亚洲电影人奖"],
    ]);
    const units = groupByUnit(rows);
    expect(units).toHaveLength(1);
    expect(units[0].name).toContain("年度亚洲电影人奖");
  });

  it("联映块成员片**同时**属于两个单元（与影片库 `filmInUnit` / `libraryUnits` 同一口径）", () => {
    const rows = buildHotRows(
      [film("cat:a", "A", "广角镜 - 纪录片放映", undefined, ["Midnight Passion"])],
      { "cat:a": 5 },
      new Map(),
      PRIOR,
    );
    expect(rows[0].units).toEqual(["广角镜 - 纪录片放映", "Midnight Passion"]);
    // 行里那行小字仍是**主单元**的名字
    expect(rows[0].unitName).toContain("广角镜");

    // 两个单元各成一组（⚠ 不断言组的**顺序**：两组想看合计相同 → 落到按组名排那一档，
    // 而中文序随运行环境的 ICU 数据变），组名跟着**组**走 ——
    // 不是行上的主单元名，否则「午夜激情」那一组会被标成「广角镜 · 纪录片放映」
    const units = groupByUnit(rows);
    expect(units.map((u) => u.id).sort()).toEqual(
      ["Midnight Passion", "广角镜 - 纪录片放映"].sort(),
    );
    const midnight = units.find((u) => u.id === "Midnight Passion")!;
    expect(midnight.name).toContain("午夜激情");
    expect(midnight.rows.map((r) => r.key)).toEqual(["cat:a"]);
  });

  it("电影库里没有的键（sched:* 讲座 / 探针残留）天然出局", () => {
    // `want-counts` 实测有 59 个 `sched:*` 脏 key —— 它们不在 `films` 里，
    // 所以这里传进去也不会多出一行。
    const rows = buildHotRows(
      [film("cat:a", "A", "Test Unit")],
      { "cat:a": 2, "sched:[cine class] bi gan": 99, "cat:__probe-20260930__": 50 },
      new Map(),
      PRIOR,
    );
    expect(rows.map((r) => r.key)).toEqual(["cat:a"]);
  });
});

describe("groupByUnit", () => {
  it("组内保持想看降序，组间按组内想看合计降序", () => {
    const films = [
      film("cat:a", "A", "甲单元"),
      film("cat:b", "B", "乙单元"),
      film("cat:c", "C", "甲单元"),
    ];
    // 甲单元合计 14（a 8 + c 6），乙单元 10 —— 组间看**合计**而不是组内最大的那一部
    const rows = buildHotRows(films, { "cat:a": 8, "cat:b": 10, "cat:c": 6 }, new Map(), PRIOR);
    const units = groupByUnit(rows);
    expect(units.map((u) => u.id)).toEqual(["甲单元", "乙单元"]);
    expect(units[0].want).toBe(14);
    expect(units[0].rows.map((r) => r.key)).toEqual(["cat:a", "cat:c"]);
    expect(units[1].rows.map((r) => r.key)).toEqual(["cat:b"]);
  });

  it("未标单元的组有兜底名字，且与影片库**同一个词**（不出现空标题）", () => {
    const rows = buildHotRows([film("cat:a", "A", "")], { "cat:a": 1 }, new Map(), PRIOR);
    // `units.ts::unitKey("")` = 「未标注单元」—— 与影片库单元下拉的兜底同一处实现
    expect(groupByUnit(rows)[0].id).toBe("未标注单元");
    expect(groupByUnit(rows)[0].name).toBe("未标注单元");
  });
});

describe("单一榜单：本届全部影片，按想看降序（2026-10-14 用户拍板，撤掉三档）", () => {
  const films = [film("cat:a", "A", "甲单元"), film("cat:b", "B", "甲单元"), film("cat:c", "C", "甲单元")];

  it("★ 回归：全部影片都在榜上，想看 0 的排最后（原先它们被「有没有信号」筛掉了）", () => {
    const rows = buildHotRows(films, { "cat:a": 5, "cat:b": 9 }, new Map(), PRIOR);
    expect(rows.map((r) => r.key)).toEqual(["cat:b", "cat:a", "cat:c"]);
    expect(rows.map((r) => r.want)).toEqual([9, 5, 0]);
  });

  it("同数按片名（与 `compareByWant` 同一支比较器，不另立一套）", () => {
    const rows = buildHotRows(films, { "cat:a": 5, "cat:b": 5, "cat:c": 5 }, new Map(), PRIOR);
    expect(rows.map((r) => r.title)).toEqual(["A", "B", "C"]);
  });

  it("名次变化照样算（日账本只喂 ▲▼，不参与排序）", () => {
    const rows = buildHotRows(films, { "cat:a": 10, "cat:b": 12 }, new Map(), PRIOR, {
      rising: { "cat:b": 6 },
    });
    // 排序仍是**想看降序**（b 今天 12），不是按今日新增排
    expect(rows.map((r) => r.key)).toEqual(["cat:b", "cat:a", "cat:c"]);
    expect(rows.map((r) => r.rankDelta)).toEqual([1, -1, null]);
  });
});

describe("名次变化：由日账本反推昨日累计（不是另存一份快照）", () => {
  const films = [film("cat:a", "A", "U"), film("cat:b", "B", "U")];

  it("昨日累计 = 当前累计 − 今日新增；反推出来的名次差就是 ▲▼", () => {
    // 今天 b 反超 a：b 昨天 6、今天 12；a 昨天 10、今天 10
    const rows = buildHotRows(films, { "cat:a": 10, "cat:b": 12 }, new Map(), PRIOR, {
      rising: { "cat:b": 6 },
    });
    expect(rows.map((r) => r.key)).toEqual(["cat:b", "cat:a"]);
    expect(rows.map((r) => r.rankDelta)).toEqual([1, -1]);
  });

  it("昨天还没人想看的片**不写变化**（null）—— 不把「新上榜」画成「上升 N 名」", () => {
    const rows = buildHotRows([film("cat:c", "C", "U")], { "cat:c": 5 }, new Map(), PRIOR, {
      rising: { "cat:c": 5 },
    });
    expect(rows[0].rankDelta).toBeNull();
  });

  it("没有账本数据时：「算得出、没动」是 0，不是 null（两者不同，界面都不画）", () => {
    const rows = buildHotRows(films, { "cat:a": 10, "cat:b": 4 }, new Map(), PRIOR, { rising: {} });
    expect(rows.map((r) => r.rankDelta)).toEqual([0, 0]);
  });

  it("想看 0 的片在榜上，但**不算名次**（两次排名都把它排除，于是保持 null）", () => {
    const rows = buildHotRows(
      [...films, film("cat:z", "Z", "U")],
      { "cat:a": 10, "cat:b": 4 },
      new Map(),
      PRIOR,
      { rising: { "cat:a": 2 } },
    );
    expect(rows.map((r) => r.key)).toEqual(["cat:a", "cat:b", "cat:z"]);
    expect(rows.map((r) => r.rankDelta)).toEqual([0, 0, null]);
  });
});

describe("hotTotals", () => {
  it("汇总想让与票数", () => {
    const rows = buildHotRows(
      [film("cat:a", "A", "U"), film("cat:b", "B", "U")],
      { "cat:a": 3, "cat:b": 4 },
      crowd([["cat:a", { red: 2, black: 1 }]]),
      PRIOR,
    );
    expect(hotTotals(rows)).toEqual({ films: 2, want: 7, votes: 3 });
  });
});
