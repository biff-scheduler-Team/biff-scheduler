import { describe, expect, it } from "vitest";
import { REACTION_EMOJIS, isReactionEmoji } from "@biff/contracts/reactions";
import { aggregateReactions, decideReactionToggle } from "../src/reactions";

// 2026-09-14:反应判定从 `feedback.ts` 上提到 `src/reactions.ts`(白名单在 contracts),
// 因为「场次讨论」要用同一套 —— 对应断言从 `feedback.test.ts` 搬到这里。

describe("reaction whitelist", () => {
  it("只接受白名单 emoji(含「点踩」👎)", () => {
    for (const emoji of REACTION_EMOJIS) expect(isReactionEmoji(emoji)).toBe(true);
    expect(isReactionEmoji("👎")).toBe(true);
    expect(isReactionEmoji("🔥")).toBe(false);
    expect(isReactionEmoji("")).toBe(false);
    expect(isReactionEmoji("👍 ")).toBe(false);
  });
});

describe("reaction toggle / aggregate", () => {
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
