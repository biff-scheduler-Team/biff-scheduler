import { describe, expect, it } from "vitest";
import { DISCUSSION_CATEGORIES, isDiscussionCategory } from "@biff/contracts/screening";
import {
  DISCUSSION_LIMIT_DEFAULT,
  DISCUSSION_LIMIT_MAX,
  normalizeDiscussionPost,
} from "../src/screening-discussion";
import { parseDiscussionCursor, parseDiscussionLimit } from "../src/screening-discussion-store";

describe("discussion categories", () => {
  it("分类 key 固定四类,未知 key 不合法", () => {
    expect(DISCUSSION_CATEGORIES.map((category) => category.key)).toEqual([
      "gift",
      "swap",
      "buddy",
      "other",
    ]);
    for (const category of DISCUSSION_CATEGORIES) expect(isDiscussionCategory(category.key)).toBe(true);
    expect(isDiscussionCategory("nope")).toBe(false);
    expect(isDiscussionCategory("")).toBe(false);
  });
});

describe("discussion post payload", () => {
  it("分类合法 + 正文 trim 后 1–2000 字才通过", () => {
    expect(normalizeDiscussionPost({ category: "gift", body: "  求一张 10/8 的票  " })).toEqual({
      category: "gift",
      body: "求一张 10/8 的票",
    });
    expect(normalizeDiscussionPost({ category: "gift", body: "" })).toBeNull();
    expect(normalizeDiscussionPost({ category: "gift", body: "   " })).toBeNull();
    expect(normalizeDiscussionPost({ category: "gift", body: "a".repeat(2000) })).not.toBeNull();
    expect(normalizeDiscussionPost({ category: "gift", body: "a".repeat(2001) })).toBeNull();
  });

  it("载荷不是对象 / 缺字段 / 分类不在白名单 → null", () => {
    expect(normalizeDiscussionPost(null)).toBeNull();
    expect(normalizeDiscussionPost("gift")).toBeNull();
    expect(normalizeDiscussionPost({ body: "x" })).toBeNull();
    expect(normalizeDiscussionPost({ category: "gift" })).toBeNull();
    expect(normalizeDiscussionPost({ category: "nope", body: "x" })).toBeNull();
    expect(normalizeDiscussionPost({ category: 1, body: "x" })).toBeNull();
  });
});

describe("discussion pagination", () => {
  it("limit 夹在 1–50,缺省 20", () => {
    expect(parseDiscussionLimit(undefined)).toBe(DISCUSSION_LIMIT_DEFAULT);
    expect(parseDiscussionLimit("10")).toBe(10);
    expect(parseDiscussionLimit("0")).toBe(20);
    expect(parseDiscussionLimit("999")).toBe(DISCUSSION_LIMIT_MAX);
    expect(parseDiscussionLimit("nope")).toBe(20);
  });

  it("cursor 与建议反馈同一口径", () => {
    expect(parseDiscussionCursor("100_abc")).toEqual({ createdAt: 100, id: "abc" });
    expect(parseDiscussionCursor("bad")).toBeNull();
    expect(parseDiscussionCursor(undefined)).toBeNull();
  });
});
