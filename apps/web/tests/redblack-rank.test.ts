// 红黑榜「排行榜」行模型的纯逻辑单测（2026-10-15，PLAN-20261015153233）。
//
// 为什么单测它：这一屏是**给人看的排名**，判错的后果都是「看着挺合理、其实少了一截」——
// 门槛写错（黑榜里混进「黑 0」）、截断写错（第 51 名冒上来）、排序写错（票少的排在前面），
// 都不会报错。所以这里把三条口径各钉一条断言；排序与门槛的**实现**在 `redblack.ts`，
// 那边已有自己的用例（本文件只守「这一屏怎么用它」）。
//
// ⚠ 与 `redblack.test.ts` 同一手法：用内存 localStorage 替身而不是 jsdom ——
//   被测模块 import 期不碰 DOM / localStorage（真的碰了，这个文件会当场炸）。

import { describe, expect, it } from "vitest";
import type { FilmNode } from "../src/app/model";
import { crowdOf } from "../src/redblack";
import { buildRankRows, RANK_LIMIT } from "../src/redblack-rank";

/** 最小 FilmNode：只填被测函数真正读的字段 */
function film(
  key: string,
  shows: FilmNode["shows"] = [],
  patch: Partial<FilmNode> = {},
): FilmNode {
  return {
    key,
    title: key,
    en: key,
    zh: key,
    names: [],
    meta: "",
    cats: [],
    shows,
    ...patch,
  };
}

/** 一场「有排期」的最小场次（`boardFilms` 只认 `shows` 非空的节点） */
function show(code: string): FilmNode["shows"][number] {
  return {
    code,
    title_en: "Test Film",
    title_kr: "",
    title_zh: "",
    date: "2026-10-08",
    start_time: "10:00",
    end_time: "11:40",
    duration_min: 100,
    venue_id: "b1",
    venue_display: "BCC Cinema 1",
    is_gv: false,
  };
}

describe("buildRankRows", () => {
  it("红榜按红票降序、黑榜按黑票降序（不是同一份名单）", () => {
    const films = [film("sched:a", [show("001")]), film("sched:b", [show("002")])];
    const crowd = crowdOf({
      "sched:a": { red: 1, black: 9 },
      "sched:b": { red: 8, black: 2 },
    });

    expect(buildRankRows(films, crowd, "red", 0.5).map((row) => row.key)).toEqual([
      "sched:b",
      "sched:a",
    ]);
    expect(buildRankRows(films, crowd, "black", 0.5).map((row) => row.key)).toEqual([
      "sched:a",
      "sched:b",
    ]);
  });

  it("该榜那一色一票都没有的片不进该榜（黑 0 的片不出现在黑榜里）", () => {
    const films = [film("sched:a", [show("001")]), film("sched:b", [show("002")])];
    // a 全红：它在红榜里，但**不该**在黑榜里出现（那会是一条「黑 0」的假行）
    const crowd = crowdOf({ "sched:a": { red: 5, black: 0 }, "sched:b": { red: 0, black: 3 } });

    expect(buildRankRows(films, crowd, "red", 0.5).map((row) => row.key)).toEqual(["sched:a"]);
    expect(buildRankRows(films, crowd, "black", 0.5).map((row) => row.key)).toEqual(["sched:b"]);
  });

  it("超过 TOP50 只留前 50，且留下的是票数最高的那 50 部", () => {
    const films = Array.from({ length: RANK_LIMIT + 3 }, (_, index) =>
      film(`sched:f${index}`, [show(`1${String(index).padStart(2, "0")}`)]),
    );
    // 票数 = 序号：f0 最少、f52 最多 —— 前 50 名应当是 f52 … f3（共 50 部），f0/f1/f2 出局
    const votes: Record<string, { red: number; black: number }> = {};
    films.forEach((entry, index) => {
      votes[entry.key] = { red: index + 1, black: 0 };
    });

    const rows = buildRankRows(films, crowdOf(votes), "red", 0.5);
    expect(rows).toHaveLength(RANK_LIMIT);
    expect(rows[0].key).toBe(`sched:f${RANK_LIMIT + 2}`);
    expect(rows.at(-1)?.key).toBe("sched:f3");
    expect(rows.some((row) => row.key === "sched:f2")).toBe(false);
  });

  it("一行只带名称 / 海报 / 红黑数；中英名相同时不重复带英文名", () => {
    const films = [
      film("sched:a", [show("001")], {
        zh: "她说",
        en: "She Said",
        poster: "/posters/f228.jpg",
      }),
      film("sched:b", [show("002")], { zh: "In Winter", en: "In Winter" }),
    ];
    const crowd = crowdOf({ "sched:a": { red: 4, black: 1 }, "sched:b": { red: 0, black: 2 } });

    const [first, second] = buildRankRows(films, crowd, "black", 0.5);
    expect(first).toMatchObject({
      key: "sched:b",
      title: "In Winter",
      en: "",
      red: 0,
      black: 2,
    });
    expect(first.poster).toBeUndefined();
    expect(second).toMatchObject({
      key: "sched:a",
      title: "她说",
      en: "She Said",
      red: 4,
      black: 1,
      poster: "/posters/f228.jpg",
    });
  });

  it("合集卡拆成成员片后再排名（与卡片栅格同一份 `boardFilms`）", () => {
    // 062 = 「Asian Short Film Competition 1」这张合集场次票：成员片 `shows` 为空、
    // 只挂了 `block`（它只在这个合集里放映）—— 榜单上占卡的是**成员片**，不是那张合集卡。
    const collection = film("sched:collection", [show("062")], {
      zh: "Asian Short Film Competition 1",
      en: "Asian Short Film Competition 1",
    });
    collection.shows[0].midnight_members = ["She Said"];
    const member = film("cat:m1", [], { block: show("062"), zh: "她说", en: "She Said" });
    const crowd = crowdOf({
      "cat:m1": { red: 6, black: 0 },
      // 合集卡自己那一份票不该出现在榜上（它已经不占卡了）
      "sched:collection": { red: 99, black: 0 },
    });

    const rows = buildRankRows([collection, member], crowd, "red", 0.5);
    expect(rows.map((row) => row.key)).toEqual(["cat:m1"]);
    expect(rows[0]).toMatchObject({ title: "她说", en: "She Said", red: 6 });
  });

  it("一枚贴纸都没有时不造行（弹层据此说「榜还是空的」）", () => {
    const films = [film("sched:a", [show("001")])];
    expect(buildRankRows(films, crowdOf({}), "red", 0.5)).toEqual([]);
  });
});
