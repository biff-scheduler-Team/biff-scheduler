// C 组「群体行为与口碑」纯逻辑单测（2026-09-20，第 2 轮，PLAN-20260920203010 修订 1）。
//
// 覆盖点：① 两个子面在一票 / 一人都没有时返回 null（页面走空态）；
// ② 想看榜的中位数与「群体热门」基准；③ 「有争议」必须两边都达到最小票数；
// ④ 我与群体的重合度：`>=` 中位数算热门、零想看算冷门、无数据时 median 为 null。
//
// ⚠ 原第三子面 `talkBoard`（场次讨论榜）的用例已于 2026-09-22 随讨论区下线删除
//   （`PLAN-20260922101227`）—— 纯逻辑连同它的唯一用途一起消失，留着测一个没人用的函数没有意义。

import { describe, expect, it } from "vitest";
import { MIN_VOTES_FOR_VERDICT } from "../src/rush-analysis";
import { myCrowdOverlap, voteBoard, wantBoard } from "../src/rush-crowd";

describe("wantBoard", () => {
  it("一个人都没点 → null（不画全 0 的图）", () => {
    expect(wantBoard([{ key: "a", title: "A", want: 0 }])).toBeNull();
    expect(wantBoard([])).toBeNull();
  });

  it("想看降序 + 中位数（只算有想看的片）", () => {
    const board = wantBoard([
      { key: "a", title: "A", want: 30 },
      { key: "b", title: "B", want: 10 },
      { key: "c", title: "C", want: 0 },
    ]);
    expect(board?.films).toBe(3);
    expect(board?.withWant).toBe(2);
    expect(board?.wantTotal).toBe(40);
    expect(board?.median).toBe(20);
    expect(board?.top.map((r) => r.key)).toEqual(["a", "b"]);
  });
});

describe("voteBoard", () => {
  it("一票都没有 → null", () => {
    expect(voteBoard([{ key: "a", title: "A", red: 0, black: 0 }])).toBeNull();
  });

  it("红票占比 + 红 / 黑两个榜各按自己的票数降序", () => {
    const board = voteBoard([
      { key: "a", title: "A", red: 8, black: 1 },
      { key: "b", title: "B", red: 2, black: 9 },
    ]);
    expect(board?.red).toBe(10);
    expect(board?.black).toBe(10);
    expect(board?.redShare).toBe(0.5);
    expect(board?.topRed.map((r) => r.key)).toEqual(["a", "b"]);
    expect(board?.topBlack.map((r) => r.key)).toEqual(["b", "a"]);
  });

  it("「有争议」要求红黑两边都够最小票数（只贴一枚黑票不算争议）", () => {
    const board = voteBoard([
      { key: "a", title: "A", red: MIN_VOTES_FOR_VERDICT, black: MIN_VOTES_FOR_VERDICT },
      { key: "b", title: "B", red: 30, black: 1 },
    ]);
    expect(board?.divided.map((r) => r.key)).toEqual(["a"]);
  });

  it("脏值被夹成非负整数，不会让占比出现负数或 NaN", () => {
    const board = voteBoard([{ key: "a", title: "A", red: -5, black: 3 }]);
    expect(board?.red).toBe(0);
    expect(board?.redShare).toBe(0);
  });
});

describe("myCrowdOverlap", () => {
  it("想看 ≥ 中位数算热门（`>=` 而不是 `>`），一个人都没点的算冷门", () => {
    const rows = [
      { key: "a", title: "A", want: 30 },
      { key: "b", title: "B", want: 10 },
      { key: "c", title: "C", want: 0 },
    ];
    // 中位数 = 20（只算有想看的 a/b）
    const overlap = myCrowdOverlap(["a", "b", "c", "a"], rows);
    expect(overlap.mine).toBe(3);
    expect(overlap.hot).toBe(1);
    expect(overlap.cold).toBe(1);
    expect(overlap.median).toBe(20);
  });

  it("全站还没有想看数据 → median 为 null，hot 为 0（不把「无数据」当成「冷门」以外的结论）", () => {
    const overlap = myCrowdOverlap(["a"], [{ key: "a", title: "A", want: 0 }]);
    expect(overlap).toEqual({ mine: 1, hot: 0, cold: 1, median: null });
  });

  it("空行程 → 全 0", () => {
    expect(myCrowdOverlap([], [])).toEqual({ mine: 0, hot: 0, cold: 0, median: null });
  });
});
