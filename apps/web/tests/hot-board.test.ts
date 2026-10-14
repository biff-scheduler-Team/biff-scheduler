// 「热门榜」纯逻辑单测（2026-10-14，PLAN-20261014150805 修订 1 / 2）。
//
// 覆盖点：① 排序口径（想看降序、同数按片名）—— 与 `RushCrowdPanel` 共用同一支比较器；
//   ② 无信号影片不入榜（want = 0 且零票）；
//   ③ 口碑评分**逐字复用** `redblack.ts::scoreOf`（这里断言与它相等，而不是硬编码数字）；
//   ④ 脏值夹成非负整数；⑤ 分组：组内保持排序、组间按想看合计降序。

import { describe, expect, it } from "vitest";
import type { FilmNode } from "../src/app/model";
import type { FilmItem } from "../src/types";
import { buildHotRows, compareByWant, groupByUnit, hotTotals } from "../src/hot-board";
import { scoreOf, type CrowdCounts } from "../src/redblack";

/** 最小影片节点：只写热门榜真正读的字段（`cats[0].unit` / `title` / `poster`）。 */
function film(key: string, title: string, unit: string, poster?: string): FilmNode {
  return {
    key,
    title,
    en: "",
    zh: title,
    names: [title],
    meta: "",
    cats: [{ unit } as FilmItem],
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
  it("只收有信号的影片：want = 0 且零票的不进榜", () => {
    const films = [film("cat:a", "A", "Test Unit"), film("cat:b", "B", "Test Unit")];
    const rows = buildHotRows(films, { "cat:a": 7 }, new Map(), PRIOR);
    expect(rows.map((r) => r.key)).toEqual(["cat:a"]);
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
      // c 零想看零票 → 不入榜（所以期望里没有它）。
      crowd([["cat:a", { red: 40, black: 40 }]]),
      PRIOR,
    );
    expect(rows.map((r) => r.key)).toEqual(["cat:b", "cat:a"]);
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

  it("单元取自目录条目（FilmNode 上没有 unit），未知单元原样展示", () => {
    const rows = buildHotRows([film("cat:a", "A", "Test Unit")], { "cat:a": 1 }, new Map(), PRIOR);
    expect(rows[0].unit).toBe("Test Unit");
    expect(rows[0].unitName).toBe("Test Unit");
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

  it("未标单元的组有兜底名字（不出现空标题）", () => {
    const rows = buildHotRows([film("cat:a", "A", "")], { "cat:a": 1 }, new Map(), PRIOR);
    expect(groupByUnit(rows)[0].name).toBe("未标单元");
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
