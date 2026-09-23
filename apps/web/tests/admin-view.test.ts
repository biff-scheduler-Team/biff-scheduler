import { describe, expect, it } from "vitest";
import {
  adminRowsMetricOf,
  adminTabLabel,
  adminTabOf,
  adminTrendMetricOf,
  auditHeadline,
  fillTrendDays,
  formatBytes,
  formatTime,
  formatWeight,
  metricLabel,
  nextDay,
} from "../src/admin-view";
import type { AdminAudit } from "../src/admin-api";

/**
 * 管理端纯逻辑（2026-09-23，PLAN-20260923142546，批 2）。
 *
 * 这里钉的都是「安静地错」的地方：URL 参数归一（错一个值整页空白）、趋势补零（少补一天图就短一截
 * 而看不出来）、对账结论（**空库不能说成「都对」**）。页面本体不在这里测 —— 它是 DOM 层的事，
 * 按项目口径归 E2E。
 */

describe("Tab / 指标归一（手改 URL 不该把页面搞白）", () => {
  it("合法 tab 原样，未知与缺失落回概览", () => {
    expect(adminTabOf("rows")).toBe("rows");
    expect(adminTabOf("trends")).toBe("trends");
    expect(adminTabOf("nope")).toBe("overview");
    expect(adminTabOf(null)).toBe("overview");
    expect(adminTabOf(undefined)).toBe("overview");
    expect(adminTabOf("")).toBe("overview");
  });

  it("每个 tab 都有中文名（新增 tab 忘了配文案会在这里红）", () => {
    expect(adminTabLabel("overview")).toBe("概览");
    expect(adminTabLabel("rows")).toBe("明细");
    expect(adminTabLabel("trends")).toBe("趋势");
    expect(adminTabLabel("content")).toBe("内容");
  });

  it("明细指标白名单只有服务端认的五种（子类型不在这里，它属于趋势视图）", () => {
    expect(adminRowsMetricOf("vote")).toBe("vote");
    expect(adminRowsMetricOf("ticket")).toBe("ticket");
    expect(adminRowsMetricOf("vote:red")).toBe("vote"); // 明细按表读，颜色只是行里的 sub
    expect(adminRowsMetricOf(null)).toBe("vote");
  });

  it("趋势指标既收精确值也收族名", () => {
    expect(adminTrendMetricOf("vote:red")).toBe("vote:red");
    expect(adminTrendMetricOf("ticket")).toBe("ticket");
    expect(adminTrendMetricOf("bogus")).toBe("vote");
  });
});

describe("metricLabel", () => {
  it("已知指标给中文，未知**原样回**（宁可露出 foo:bar 也不要静默空白）", () => {
    expect(metricLabel("want")).toBe("想看人数");
    expect(metricLabel("vote:red")).toBe("红票");
    expect(metricLabel("ticket:missed")).toBe("没抢到");
    expect(metricLabel("something:new")).toBe("something:new");
  });
});

describe("nextDay / fillTrendDays", () => {
  it("nextDay 跨月跨年都对", () => {
    expect(nextDay("2026-09-23")).toBe("2026-09-24");
    expect(nextDay("2026-09-30")).toBe("2026-10-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
    expect(nextDay("2028-02-28")).toBe("2028-02-29"); // 闰年
  });

  it("★ 补零：起点是服务端给的 fromDay，长度恰为 days（不依赖本地「今天」）", () => {
    const filled = fillTrendDays(
      [
        { day: "2026-09-23", weight: 2, hits: 0 },
        { day: "2026-09-25", weight: 0.75, hits: 3 },
      ],
      "2026-09-23",
      4,
    );
    expect(filled).toEqual([
      { day: "2026-09-23", weight: 2, hits: 0 },
      { day: "2026-09-24", weight: 0, hits: 0 },
      { day: "2026-09-25", weight: 0.75, hits: 3 },
      { day: "2026-09-26", weight: 0, hits: 0 },
    ]);
  });

  it("接口给了范围外的日子也不会挤进来（按 fromDay 起的天数铺，不按接口给的顺序）", () => {
    const filled = fillTrendDays([{ day: "2026-09-01", weight: 9, hits: 0 }], "2026-09-23", 2);
    expect(filled).toEqual([
      { day: "2026-09-23", weight: 0, hits: 0 },
      { day: "2026-09-24", weight: 0, hits: 0 },
    ]);
  });

  it("不改入参（页面拿到的原数组还要用于别的展示）", () => {
    const points = [{ day: "2026-09-23", weight: 1, hits: 0 }];
    fillTrendDays(points, "2026-09-23", 1);
    expect(points).toEqual([{ day: "2026-09-23", weight: 1, hits: 0 }]);
  });
});

describe("auditHeadline（空库不能读成「都对」）", () => {
  const audit = (over: Partial<AdminAudit>): AdminAudit => ({
    edition: "biff-2026",
    scanned: { film_vote_contribution: 3 },
    drifts: [],
    ok: true,
    ...over,
  });

  it("未运行 / 空库 / 通过 / 有漂移，四态各有话说", () => {
    expect(auditHeadline(undefined)).toBe("对账未运行");
    expect(auditHeadline(audit({ scanned: { a: 0, b: 0 } }))).toContain("库是空的");
    expect(auditHeadline(audit({}))).toContain("对账通过");
    expect(auditHeadline(audit({ ok: false, drifts: [{ metric: "want", key: "f1", contribution: 1, stat: 0 }] }))).toBe(
      "对账发现 1 处一致性问题",
    );
  });
});

describe("格式化", () => {
  it("formatBytes 分级，且非法值给 0 B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("formatTime 非法时间戳给破折号而不是抛（脏数据不该让整页渲染失败）", () => {
    expect(formatTime(Number.NaN)).toBe("—");
    expect(formatTime(Date.UTC(2026, 8, 23, 0, 0, 0))).toMatch(/^2026\//);
  });

  it("formatWeight 收两位（0.75 的整数倍不会有第三位小数，多余的是误差）", () => {
    expect(formatWeight(1.75)).toBe("1.75");
    expect(formatWeight(1.7500000000000002)).toBe("1.75");
    expect(formatWeight(Number.NaN)).toBe("0");
  });
});
