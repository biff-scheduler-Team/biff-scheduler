import { describe, expect, it } from "vitest";
import {
  FEEDBACK_EMOJIS,
  aggregateReactions,
  canDeleteFeedbackPost,
  decideReactionToggle,
  isAllowedEmoji,
  normalizeFeedbackBody,
  writeAuthError,
} from "../src/feedback";
import {
  feedbackCursorOf,
  parseFeedbackCursor,
  parseFeedbackLimit,
} from "../src/feedback-store";

describe("feedback whitelist / body", () => {
  it("只接受五个热门 emoji", () => {
    for (const emoji of FEEDBACK_EMOJIS) expect(isAllowedEmoji(emoji)).toBe(true);
    expect(isAllowedEmoji("🔥")).toBe(false);
    expect(isAllowedEmoji("")).toBe(false);
    expect(isAllowedEmoji("👍 ")).toBe(false);
  });

  it("正文 trim 后须 1–2000 字", () => {
    expect(normalizeFeedbackBody("  hi  ")).toBe("hi");
    expect(normalizeFeedbackBody("")).toBeNull();
    expect(normalizeFeedbackBody("   ")).toBeNull();
    expect(normalizeFeedbackBody(null)).toBeNull();
    expect(normalizeFeedbackBody(1)).toBeNull();
    expect(normalizeFeedbackBody("a".repeat(2000))).toHaveLength(2000);
    expect(normalizeFeedbackBody("a".repeat(2001))).toBeNull();
  });
});

describe("feedback auth / delete / toggle", () => {
  it("无会话写操作返回 UNAUTHENTICATED", () => {
    expect(writeAuthError(null)).toBe("UNAUTHENTICATED");
    expect(writeAuthError(undefined)).toBe("UNAUTHENTICATED");
    expect(writeAuthError({ row: { subject: "user_x" } })).toBeNull();
  });

  it("仅作者可删本帖", () => {
    expect(canDeleteFeedbackPost("user_a", "user_a")).toBe(true);
    expect(canDeleteFeedbackPost("user_a", "user_b")).toBe(false);
  });

  it("反应 toggle：有则取消、无则添加", () => {
    expect(decideReactionToggle(false)).toBe("add");
    expect(decideReactionToggle(true)).toBe("remove");
  });

  it("聚合计数并标出我的反应", () => {
    const agg = aggregateReactions(
      [
        { emoji: "👍", subject: "u1" },
        { emoji: "👍", subject: "u2" },
        { emoji: "❤️", subject: "u1" },
        { emoji: "🔥", subject: "u1" },
      ],
      "u1",
    );
    expect(agg.counts).toEqual({ "👍": 2, "❤️": 1 });
    expect(agg.myReactions).toEqual(["👍", "❤️"]);
    expect(aggregateReactions([{ emoji: "👍", subject: "u1" }], null).myReactions).toEqual([]);
  });
});

describe("feedback cursor / limit", () => {
  it("limit 夹在 1–100，缺省 50", () => {
    expect(parseFeedbackLimit(undefined)).toBe(50);
    expect(parseFeedbackLimit("10")).toBe(10);
    expect(parseFeedbackLimit("0")).toBe(50);
    expect(parseFeedbackLimit("999")).toBe(100);
    expect(parseFeedbackLimit("nope")).toBe(50);
  });

  it("cursor 编解码", () => {
    expect(feedbackCursorOf(100, "abc")).toBe("100_abc");
    expect(parseFeedbackCursor("100_abc")).toEqual({ createdAt: 100, id: "abc" });
    expect(parseFeedbackCursor("bad")).toBeNull();
    expect(parseFeedbackCursor(undefined)).toBeNull();
  });
});
