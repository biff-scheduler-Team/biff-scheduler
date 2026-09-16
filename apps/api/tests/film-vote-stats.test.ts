import { describe, expect, it } from "vitest";
import {
  diffVotes,
  formatVoteCounts,
  isFilmVote,
  MAX_FILM_KEY_LENGTH,
  MAX_VOTES_PER_PING,
  normalizeVotes,
  voteScore,
} from "../src/film-vote-stats";

// 红黑榜投票:一人一部一票,不做权重 —— 这里只测纯函数(与仓库里其他 api 单测同一范围;
// 落库行为由 store 负责,形状与 want-store 完全同构)。

describe("film vote whitelist", () => {
  it("只接受 red / black", () => {
    expect(isFilmVote("red")).toBe(true);
    expect(isFilmVote("black")).toBe(true);
    expect(isFilmVote("RED")).toBe(false);
    expect(isFilmVote("")).toBe(false);
    expect(isFilmVote(1)).toBe(false);
  });

  it("上报上限与 want-ping 对齐", () => {
    expect(MAX_VOTES_PER_PING).toBe(500);
    expect(MAX_FILM_KEY_LENGTH).toBe(128);
  });
});

describe("normalizeVotes", () => {
  it("丢弃非法条目,同一部片以最后一条为准", () => {
    const votes = normalizeVotes([
      { key: "a", vote: "red" },
      { key: "", vote: "red" },
      { key: "b", vote: "purple" },
      { key: "a", vote: "black" }, // 同 key 后到者胜
      { key: "c", vote: null },
      { key: "x".repeat(MAX_FILM_KEY_LENGTH + 1), vote: "red" },
    ]);
    expect([...votes]).toEqual([
      ["a", "black"],
      ["b", undefined],
    ].filter(([, vote]) => vote !== undefined) as Array<[string, string]>);
    expect(votes.get("a")).toBe("black");
    expect(votes.has("b")).toBe(false);
    expect(votes.has("c")).toBe(false);
    expect(votes.size).toBe(1);
  });

  it("空输入 → 空表", () => {
    expect(normalizeVotes([]).size).toBe(0);
  });
});

describe("diffVotes", () => {
  it("改票同时出现在 removed(旧色) 与 added(新色)", () => {
    const previous = new Map([
      ["a", "red"],
      ["b", "black"],
    ] as const);
    const next = new Map([
      ["a", "black"], // 改票
      ["c", "red"], // 新增
    ] as const);
    const { removed, added } = diffVotes(previous, next);
    expect(removed).toEqual([
      { key: "a", vote: "red" },
      { key: "b", vote: "black" },
    ]);
    // added 的顺序跟 `next` 的插入序走(a 先于 c),removed 跟 `previous` 的插入序走
    expect(added).toEqual([
      { key: "a", vote: "black" },
      { key: "c", vote: "red" },
    ]);
  });

  it("完全没变 → 两个空数组(store 据此直接返回,不碰库)", () => {
    const same = new Map([["a", "red"]] as const);
    expect(diffVotes(same, new Map(same))).toEqual({ removed: [], added: [] });
  });

  it("整份撤回 → 全部进 removed", () => {
    const { removed, added } = diffVotes(new Map([["a", "red"]] as const), new Map());
    expect(removed).toEqual([{ key: "a", vote: "red" }]);
    expect(added).toEqual([]);
  });
});

describe("formatVoteCounts", () => {
  it("两色都为 0 的影片不输出;字符串数字也认", () => {
    expect(
      formatVoteCounts([
        { film_key: "a", red_count: 3, black_count: "1" },
        { film_key: "b", red_count: 0, black_count: 0 },
        { film_key: "c", red_count: "nope", black_count: 2 },
      ]),
    ).toEqual({ a: { red: 3, black: 1 }, c: { red: 0, black: 2 } });
  });

  it("负数被夹回 0", () => {
    expect(formatVoteCounts([{ film_key: "a", red_count: -5, black_count: 2 }])).toEqual({
      a: { red: 0, black: 2 },
    });
  });
});

describe("voteScore", () => {
  it("全红 10 / 全黑 0 / 一票没有 null", () => {
    expect(voteScore({ red: 4, black: 0 })).toBe(10);
    expect(voteScore({ red: 0, black: 4 })).toBe(0);
    expect(voteScore({ red: 0, black: 0 })).toBeNull();
  });

  it("与前端 scoreOf 同一套折算(红占比 × 10,一位小数)", () => {
    expect(voteScore({ red: 1, black: 2 })).toBe(3.3);
    expect(voteScore({ red: 2, black: 1 })).toBe(6.7);
  });
});
