// 时间口径测试 —— 24+ 时制(跨午夜)是全站最容易静默出错的一条线:
// 轴界 / 卡片宽度 / 排序 / 整点筛选 / 冲突 / ICS 进位全部依赖 `end > start`。
// 见 `util.ts` 文件头与 `gv.ts` 文件头;PLAN-20260911000705。
import { describe, expect, it } from "vitest";
import { dateInfo, fmtEndClock, fmtMinRange, fmtMinRangeMin, hmsToMin, minToClock, minToHms } from "../src/util";

describe("24+ 时制:分钟 ↔ 时钟字符串", () => {
  it("hmsToMin 不做取模 —— '29:35' = 1775(次日 05:35)", () => {
    expect(hmsToMin("00:00")).toBe(0);
    expect(hmsToMin("23:59")).toBe(1439);
    expect(hmsToMin("24:00")).toBe(1440);
    expect(hmsToMin("29:35")).toBe(1775);
  });

  it("minToClock 折回 24h 内(显示用),minToHms 保留 24+(跨午夜信息的载体)", () => {
    expect(minToClock(1775)).toBe("05:35");
    expect(minToHms(1775)).toBe("29:35");
    expect(minToClock(1440)).toBe("00:00");
    expect(minToHms(1440)).toBe("24:00");
  });

  it("minToClock 对越界值(轴界插值 / 负数)也安全", () => {
    expect(minToClock(-30)).toBe("23:30");
    expect(minToClock(2940)).toBe("01:00"); // 49:00 → 01:00
  });

  it("fmtEndClock 给 ≥1440 加「次日」前缀", () => {
    expect(fmtEndClock(770)).toBe("12:50");
    expect(fmtEndClock(1439)).toBe("23:59");
    expect(fmtEndClock(1440)).toBe("次日 00:00");
    expect(fmtEndClock(1775)).toBe("次日 05:35");
  });
});

describe("起止区间文本", () => {
  it("fmtMinRange:同日不带前缀,跨午夜带「次日」", () => {
    expect(fmtMinRange("09:00", "10:40")).toBe("09:00–10:40");
    expect(fmtMinRange("23:59", "29:35")).toBe("23:59–次日 05:35");
  });

  it("★ fmtMinRange 兼容未归一化的旧数据(end < start 也判为次日)", () => {
    // 旧 JSON 可能把跨午夜终点折回 "05:35" —— 若只按 end>=1440 判定,这里会显示成 05:35 而同日的 09:00 场
    expect(fmtMinRange("23:59", "05:35")).toBe("23:59–次日 05:35");
  });

  it("fmtMinRangeMin 两端各自带跨日标记(GV 拆分卡用,避免印出 25:30)", () => {
    expect(fmtMinRangeMin(600, 700)).toBe("10:00–11:40");
    // 25:30 → 26:00(次日 01:30 → 次日 02:00)
    expect(fmtMinRangeMin(1530, 1560)).toBe("次日 01:30–次日 02:00");
  });
});

describe("dateInfo:本地时区安全解析 + OCT 显示口径", () => {
  it("2026-10-08 → OCT 8 周四", () => {
    const d = dateInfo("2026-10-08");
    expect(d.label).toBe("OCT 8"); // ⚠ 日**不**补零(与官方 Schedule by Date 一致)
    expect(d.weekday).toBe("周四");
    // 用本地时区构造 —— 不能走 Date.parse('2026-10-08')(会被当 UTC,东八区外会偏移一天)
    expect(d.date.getFullYear()).toBe(2026);
    expect(d.date.getMonth()).toBe(9); // 0-based
    expect(d.date.getDate()).toBe(8);
  });

  it("个位日不补零、月份走英文缩写(勿「顺手」改回 10/5)", () => {
    expect(dateInfo("2026-10-05").label).toBe("OCT 5");
    expect(dateInfo("2026-10-15").label).toBe("OCT 15");
  });
});
