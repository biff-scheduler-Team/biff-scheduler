import { describe, expect, it } from "vitest";
import {
  TICKET_COUNT_MAX,
  normalizeTicketInfo,
  ticketBadgeText,
  ticketCountOf,
  ticketInfoTitle,
  totalTicketCount,
} from "../src/ticket-info";
import type { TicketInfo } from "../src/types";

// 票据明细(2026-09-24,PLAN-20260924141442)。纯逻辑,不碰 DOM / localStorage。
// ⚠ 断言写「当前实际行为」:本模块刻意的取舍是「非法 = 没填」,不是「非法 = 兜底成 1」。

describe("normalizeTicketInfo", () => {
  it("不是对象 / 三个字段都没落下有效值 → 整条丢弃(不留空壳记录)", () => {
    expect(normalizeTicketInfo(null)).toBeNull();
    expect(normalizeTicketInfo("2")).toBeNull();
    expect(normalizeTicketInfo({})).toBeNull();
    expect(normalizeTicketInfo({ count: 0 })).toBeNull();
    expect(normalizeTicketInfo({ count: -3 })).toBeNull();
    expect(normalizeTicketInfo({ count: TICKET_COUNT_MAX + 1 })).toBeNull();
    expect(normalizeTicketInfo({ count: "2" })).toBeNull();
    expect(normalizeTicketInfo({ accountId: "" })).toBeNull();
    expect(normalizeTicketInfo({ seats: [] })).toBeNull();
  });

  it("张数只认 1..上限 的整数;越界一律按「没填」处理(不是 1,也不是 0)", () => {
    expect(normalizeTicketInfo({ count: 2 })).toEqual({ count: 2 });
    expect(normalizeTicketInfo({ count: TICKET_COUNT_MAX })).toEqual({ count: TICKET_COUNT_MAX });
    // 小数四舍五入到整数后再判:1.4 → 1 合法,0.4 → 0 不合法
    expect(normalizeTicketInfo({ count: 1.4 })).toEqual({ count: 1 });
    expect(normalizeTicketInfo({ count: 0.4 })).toBeNull();
  });

  it("座位按张数截断,单个座位号超长会被截", () => {
    const long = "A".repeat(40);
    expect(normalizeTicketInfo({ count: 1, seats: ["F12", "F13"] })).toEqual({
      count: 1,
      seats: ["F12"],
    });
    expect(normalizeTicketInfo({ count: 2, seats: [long] })).toEqual({
      count: 2,
      seats: [long.slice(0, 12)],
    });
  });

  it("★ 座位数组保位对齐:中间的空项留下,尾部的空项收掉", () => {
    // 下标 = 第几张票。丢掉中间那一项会把「第 3 张是 14」读成「第 2 张是 14」
    expect(normalizeTicketInfo({ count: 3, seats: ["12", "", "14"] })).toEqual({
      count: 3,
      seats: ["12", "", "14"],
    });
    expect(normalizeTicketInfo({ count: 3, seats: ["12", "", ""] })).toEqual({
      count: 3,
      seats: ["12"],
    });
    // 座位数超过张数:按张数截断
    expect(normalizeTicketInfo({ count: 1, seats: ["12", "", "14"] })).toEqual({
      count: 1,
      seats: ["12"],
    });
  });

  it("只填座位 / 只填账号也能成立(张数可以缺省)", () => {
    expect(normalizeTicketInfo({ seats: ["F12"] })).toEqual({ seats: ["F12"] });
    expect(normalizeTicketInfo({ accountId: "a1" })).toEqual({ accountId: "a1" });
  });
});

describe("ticketCountOf / ticketBadgeText", () => {
  it("没填张数 → undefined(与「1 张」区分开)", () => {
    expect(ticketCountOf(undefined)).toBeUndefined();
    expect(ticketCountOf({})).toBeUndefined();
    expect(ticketCountOf({ seats: ["A1"] })).toBeUndefined();
    expect(ticketCountOf({ count: 3 })).toBe(3);
  });

  it("徽章只在显式填过张数时给文案 —— 没填就不渲染,否则整张画布都是「1 张」", () => {
    expect(ticketBadgeText(undefined)).toBeNull();
    expect(ticketBadgeText({})).toBeNull();
    expect(ticketBadgeText({ count: 2 })).toBe("2 张");
  });
});

describe("totalTicketCount(「共 N 张票」的唯一口径)", () => {
  it("已抢到的场次 ∪ 有明细的场次;没填张数的按 1 张", () => {
    const got = new Set(["001", "002"]);
    const info = new Map<string, TicketInfo>([
      ["002", { count: 3 }],
      ["003", { count: 2 }],
    ]);
    // 001 → 1(已抢到,没填);002 → 3(填了);003 → 2(没标已抢到,但填了)
    expect(totalTicketCount(got, info)).toBe(6);
  });

  it("只标三态的老用户 → 数字与「实际 N 场」一致", () => {
    expect(totalTicketCount(new Set(["001", "002", "003"]), new Map())).toBe(3);
  });

  it("什么都没有 → 0", () => {
    expect(totalTicketCount(new Set(), new Map())).toBe(0);
  });

  it("只有账号覆盖、没填张数的场次按 1 张", () => {
    const info = new Map<string, TicketInfo>([["007", { accountId: "a1" }]]);
    expect(totalTicketCount(new Set(), info)).toBe(1);
  });
});

describe("ticketInfoTitle", () => {
  it("把张数 / 座位 / 账号拼成一句;座位带上「第几张」,中间空档跳过", () => {
    expect(
      ticketInfoTitle({ count: 3, seats: ["12", "", "14"] }, "主号"),
    ).toBe("3 张，座位 第 1 张 12 / 第 3 张 14，账号 主号");
  });

  it("没有账号时明说「未指定账号」,不静默省略", () => {
    expect(ticketInfoTitle(undefined, null)).toBe("未指定账号");
  });
});
