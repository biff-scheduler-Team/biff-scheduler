import { describe, expect, it } from "vitest";
import { kstDay, kstDayMinus } from "../src/day";

/**
 * 日界口径（2026-09-23，PLAN-20260923142546，批 1）。
 *
 * 这一条最容易「看起来对、其实是 UTC」——所以断言的取样点全部压在**边界两侧**：
 * KST 的 23:59:59.999 与 00:00:00.000。时间戳用 `Date.UTC` 显式构造，避免测试本身受本机时区影响。
 */

/** KST 的某天某时刻 → 毫秒时间戳（KST = UTC+9，所以 UTC 要减 9 小时）。 */
function kstMoment(day: string, hour: number, minute = 0, second = 0, ms = 0): number {
  const utcHour = hour - 9; // 负数交给 Date.UTC 自己借位（如 00:00 KST = 前一天 15:00 UTC）
  return Date.UTC(
    Number(day.slice(0, 4)),
    Number(day.slice(5, 7)) - 1,
    Number(day.slice(8, 10)),
    utcHour,
    minute,
    second,
    ms,
  );
}

describe("kstDay（KST 日界）", () => {
  it("KST 当天 23:59:59.999 仍算当天", () => {
    expect(kstDay(kstMoment("2026-09-23", 23, 59, 59, 999))).toBe("2026-09-23");
  });

  it("KST 次日 00:00:00.000 已经算次日（跨日只差 1 毫秒）", () => {
    expect(kstDay(kstMoment("2026-09-24", 0, 0, 0, 0))).toBe("2026-09-24");
    expect(kstDay(kstMoment("2026-09-24", 0, 0, 0, 0) - 1)).toBe("2026-09-23");
  });

  it("★ 不能退化成 UTC：KST 凌晨 00:30 与 UTC 前一天 15:30 是同一时刻，但日期必须是 KST 的那天", () => {
    const at = kstMoment("2026-09-24", 0, 30);
    expect(new Date(at).toISOString()).toBe("2026-09-23T15:30:00.000Z"); // UTC 侧还是 23 号
    expect(kstDay(at)).toBe("2026-09-24");
  });

  it("午夜场那种「深夜贴纸」不会掉进第二天：KST 02:00 仍算当天", () => {
    expect(kstDay(kstMoment("2026-09-23", 2))).toBe("2026-09-23");
  });
});

describe("kstDayMinus（趋势起点）", () => {
  const at = kstMoment("2026-10-01", 12);

  it("0 天 = 当天", () => {
    expect(kstDayMinus(0, at)).toBe("2026-10-01");
  });

  it("跨月回退", () => {
    expect(kstDayMinus(1, at)).toBe("2026-09-30");
    expect(kstDayMinus(30, at)).toBe("2026-09-01");
  });

  it("在日界附近也按整日回退（KST 无夏令时，不存在 23 小时的那天）", () => {
    const justAfterMidnight = kstMoment("2026-10-01", 0, 0, 0, 1);
    expect(kstDayMinus(1, justAfterMidnight)).toBe("2026-09-30");
  });
});
