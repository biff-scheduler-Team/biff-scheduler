import { describe, expect, it } from "vitest";
import { canDeleteFeedbackPost, normalizeFeedbackBody, writeAuthError } from "../src/feedback";
import {
  feedbackCursorOf,
  parseFeedbackCursor,
  parseFeedbackLimit,
} from "../src/feedback-store";

// ⚠ 反应(emoji)白名单 / toggle / 聚合已上提到 `src/reactions.ts` 与 `@biff/contracts/reactions`
//   (2026-09-14 起建议反馈与场次讨论共用),原断言已搬到 `reactions.test.ts`。

describe("feedback body", () => {
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

describe("feedback auth / delete", () => {
  it("无会话写操作返回 UNAUTHENTICATED", () => {
    expect(writeAuthError(null)).toBe("UNAUTHENTICATED");
    expect(writeAuthError(undefined)).toBe("UNAUTHENTICATED");
    expect(writeAuthError({ row: { subject: "user_x" } })).toBeNull();
  });

  it("仅作者可删本帖", () => {
    expect(canDeleteFeedbackPost("user_a", "user_a")).toBe(true);
    expect(canDeleteFeedbackPost("user_a", "user_b")).toBe(false);
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
