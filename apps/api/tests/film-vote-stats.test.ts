import { describe, expect, it } from "vitest";
import {
  clampCommentLimit,
  decodeCommentCursor,
  diffVotes,
  encodeCommentCursor,
  formatVoteCounts,
  isFilmVote,
  MAX_COMMENT_LENGTH,
  MAX_FILM_KEY_LENGTH,
  MAX_VOTES_PER_PING,
  normalizeComment,
  normalizeDisplayName,
  normalizeVotes,
  toCommentItems,
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

// 评语（2026-09-29,PLAN-20260929181900）—— 它是**公开显示**的自由文本，
// 所以这一组要卡的是「能公开出去的东西长什么样」：长度按码点算、空白归一、坏行丢弃。
describe("评语归一", () => {
  it("去首尾空白;空白串与空串都归一成 null(与「从来没写」同值)", () => {
    expect(normalizeComment("  好看  ")).toBe("好看");
    expect(normalizeComment("   ")).toBeNull();
    expect(normalizeComment("")).toBeNull();
    expect(normalizeComment(undefined)).toBeNull();
    expect(normalizeComment(42)).toBeNull();
  });

  it("超长按**码点**截断,不会把 emoji 劈成半个代理对", () => {
    const cut = normalizeComment("🎬".repeat(MAX_COMMENT_LENGTH + 10)) ?? "";
    // 劈开的话这里要么长度不符、要么末尾是半个代理对(经 `[... ]` 会变成一个乱码字符)
    expect([...cut]).toHaveLength(MAX_COMMENT_LENGTH);
    expect(cut).toBe("🎬".repeat(MAX_COMMENT_LENGTH));
  });

  it("普通超长文本按码点截断", () => {
    expect(normalizeComment("字".repeat(200))).toHaveLength(MAX_COMMENT_LENGTH);
  });

  it("昵称同一套口径(也按码点截断)", () => {
    expect(normalizeDisplayName("  小林  ")).toBe("小林");
    expect(normalizeDisplayName("")).toBeNull();
    expect(normalizeDisplayName("名".repeat(100))).toHaveLength(40);
  });
});

describe("游标编解码(不透明串)", () => {
  const cursor = { updatedAt: 1_760_000_000_000, filmKey: "cat:f007" };

  it("往返一致", () => {
    expect(decodeCommentCursor(encodeCommentCursor(cursor))).toEqual(cursor);
  });

  it("null 就是 null(没有下一页)", () => {
    expect(encodeCommentCursor(null)).toBeNull();
    expect(decodeCommentCursor(null)).toBeNull();
    expect(decodeCommentCursor(undefined)).toBeNull();
    expect(decodeCommentCursor("")).toBeNull();
  });

  it("坏输入一律当「没有游标」,不抛", () => {
    expect(decodeCommentCursor("not-base64!!")).toBeNull();
    expect(decodeCommentCursor(btoa("not json"))).toBeNull();
    expect(decodeCommentCursor(btoa("[]"))).toBeNull();
    expect(decodeCommentCursor(btoa(encodeURIComponent('["x", 1]')))).toBeNull();
    expect(decodeCommentCursor(btoa(encodeURIComponent("[1]")))).toBeNull();
  });

  it("**不许夹带身份**:多塞一个字段就解不出来(解析端是白名单)", () => {
    // 这条守的是「游标也是公开响应体的一部分」——如果有人为了排序方便往里加 `contributor`,
    // 这里会当场红,而不是悄悄把它发出去
    const smuggled = btoa(encodeURIComponent(JSON.stringify([1, "cat:f001", "anon:deadbeef"])));
    expect(decodeCommentCursor(smuggled)).toBeNull();
  });

  it("中文 filmKey 也能往返(btoa 只吃 latin1,所以先 encodeURIComponent)", () => {
    const zh = { updatedAt: 1, filmKey: "片:零零七" };
    expect(decodeCommentCursor(encodeCommentCursor(zh))).toEqual(zh);
  });
});

describe("toCommentItems", () => {
  it("只留**写了评语**的行,坏 vote 行丢弃", () => {
    const items = toCommentItems([
      { film_key: "a", vote: "red", comment: "好看", display_name: "小林" },
      { film_key: "b", vote: "black", comment: null, display_name: null },
      { film_key: "c", vote: "purple", comment: "坏行", display_name: null },
      { film_key: "d", vote: "black", comment: "   ", display_name: "  " },
    ]);
    expect(items).toEqual([{ filmKey: "a", vote: "red", comment: "好看", displayName: "小林" }]);
  });

  it("匿名(display_name 为空)回 null,而不是空串", () => {
    const items = toCommentItems([
      { film_key: "a", vote: "red", comment: "好看", display_name: null },
    ]);
    expect(items[0]?.displayName).toBeNull();
  });

  it("**不回 contributor**:入参带着它,结果里也不许有", () => {
    // ⚠ 用变量而不是内联字面量:内联会触发 TS 的多余属性检查,而这条要测的正是「多给的字段被丢掉」
    const rows = [
      { film_key: "a", vote: "red", comment: "好看", display_name: "小林", contributor: "anon:deadbeef" },
    ];
    const items = toCommentItems(rows);
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty("contributor");
  });
});

describe("clampCommentLimit", () => {
  it("缺省 20;夹在 1..50 之间(不信前端传的数)", () => {
    expect(clampCommentLimit(undefined)).toBe(20);
    expect(clampCommentLimit("abc")).toBe(20);
    expect(clampCommentLimit("0")).toBe(1);
    expect(clampCommentLimit("-5")).toBe(1);
    expect(clampCommentLimit("999")).toBe(50);
    expect(clampCommentLimit("7")).toBe(7);
  });
});
