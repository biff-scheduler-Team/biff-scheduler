import { describe, expect, it } from "vitest";
import { cursorOf, parseCursor, parseLimit } from "../src/pagination";

// 2026-09-14:游标分页从 `feedback-store.ts` 上提到 `src/pagination.ts`,
// 供建议反馈与场次讨论共用;这里直接测共用实现本身。

describe("pagination limit", () => {
  it("非法回落 fallback,超上限截断", () => {
    expect(parseLimit(undefined, 20, 50)).toBe(20);
    expect(parseLimit("10", 20, 50)).toBe(10);
    expect(parseLimit("0", 20, 50)).toBe(20);
    expect(parseLimit("-3", 20, 50)).toBe(20);
    expect(parseLimit("999", 20, 50)).toBe(50);
    expect(parseLimit("nope", 20, 50)).toBe(20);
    expect(parseLimit("7.9", 20, 50)).toBe(7);
  });
});

describe("pagination cursor", () => {
  it("编解码 `${created_at}_${id}`", () => {
    expect(cursorOf(100, "abc")).toBe("100_abc");
    expect(parseCursor("100_abc")).toEqual({ createdAt: 100, id: "abc" });
  });

  it("缺分隔符 / 空 id / 空 createdAt → null", () => {
    expect(parseCursor("bad")).toBeNull();
    expect(parseCursor("_abc")).toBeNull();
    expect(parseCursor("100_")).toBeNull();
    expect(parseCursor(undefined)).toBeNull();
    expect(parseCursor("")).toBeNull();
  });
});
