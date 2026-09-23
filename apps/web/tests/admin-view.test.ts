import { describe, expect, it } from "vitest";
import {
  adminContentKindOf,
  adminRowsMetricOf,
  adminTabLabel,
  adminTabOf,
  adminTrendFieldOf,
  adminTrendMetricOf,
  auditHeadline,
  authorBars,
  bodyExcerpt,
  categoryDonut,
  categoryLabel,
  contentDonut,
  contentKindLabel,
  fillTrendDays,
  metricBars,
  formatBytes,
  formatTime,
  formatWeight,
  metricLabel,
  nextDay,
  reactionSummary,
  shortDay,
  trendBars,
  trendFieldLabel,
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

describe("趋势视图（chart 契约的数据侧）", () => {
  const points = [
    { day: "2026-09-22", weight: 1.75, hits: 0 },
    { day: "2026-09-23", weight: 0, hits: 3 },
  ];

  it("shortDay 只留月日；非标准长度原样回（不硬切）", () => {
    expect(shortDay("2026-09-23")).toBe("09-23");
    expect(shortDay("2026-09-23T00:00")).toBe("2026-09-23T00:00");
  });

  it("trendBars 按字段取值、标签用短日期（图上的横轴）", () => {
    expect(trendBars(points)).toEqual([
      { label: "09-22", value: 1.75 },
      { label: "09-23", value: 0 },
    ]);
    expect(trendBars(points, "hits")).toEqual([
      { label: "09-22", value: 0 },
      { label: "09-23", value: 3 },
    ]);
  });

  it("★ 补零后的每一天都要画进图里（图只画有值的天会让曲线假装连起来）", () => {
    const filled = fillTrendDays([{ day: "2026-09-22", weight: 2, hits: 0 }], "2026-09-22", 3);
    const bars = trendBars(filled);
    expect(bars).toHaveLength(3);
    // 中间那天是 0 也要在，否则横轴会少一格、看起来「那天不存在」
    expect(bars.map((bar) => bar.value)).toEqual([2, 0, 0]);
  });

  it("字段与指标都有白名单兜底（手改 URL 落回默认值）", () => {
    expect(adminTrendFieldOf("hits")).toBe("hits");
    expect(adminTrendFieldOf("nope")).toBe("weight");
    expect(adminTrendFieldOf(null)).toBe("weight");
    expect(trendFieldLabel("hits")).toBe("次数");
    expect(trendFieldLabel("weight")).toBe("加权和");
  });
});

describe("内容视图", () => {
  it("kind 白名单兜底", () => {
    expect(adminContentKindOf("feedback")).toBe("feedback");
    expect(adminContentKindOf("nope")).toBe("discussion");
    expect(adminContentKindOf(null)).toBe("discussion");
    expect(contentKindLabel("feedback")).toBe("反馈留言");
    expect(contentKindLabel("discussion")).toBe("场次讨论");
  });

  it("reactionSummary：有反应给紧凑文案，没反应给破折号（不是空串）", () => {
    expect(reactionSummary({ "👍": 2, "❤️": 1 })).toBe("👍 2 · ❤️ 1");
    expect(reactionSummary({})).toBe("—");
    expect(reactionSummary(undefined)).toBe("—");
    // 0 计数的键不显示（反应被撤光后会留 0）
    expect(reactionSummary({ "👍": 0 })).toBe("—");
  });

  it("★ categoryLabel 用契约里的唯一来源，未知 key 原样回（不自造映射）", () => {
    expect(categoryLabel("gift")).toBe("无料交换");
    expect(categoryLabel("other")).toBe("其他");
    expect(categoryLabel("brand-new")).toBe("brand-new");
    expect(categoryLabel(undefined)).toBe("—");
  });

  it("bodyExcerpt：折叠空白、超长截断（列表只给一眼能扫的量）", () => {
    expect(bodyExcerpt("  很伟大的  一个网站\n谢谢  ")).toBe("很伟大的 一个网站 谢谢");
    expect(bodyExcerpt("一二三四五", 3)).toBe("一二三…");
    expect(bodyExcerpt("", 3)).toBe("");
  });
});

describe("图表数据（概览 / 内容）", () => {
  const metrics = [
    { metric: "vote", rows: 12, contributors: 3, targets: 2, total: 12, today: 1 },
    { metric: "telemetry:click", rows: 900, contributors: 40, targets: 5, total: 900, today: 30 },
  ];

  it("metricBars：标签用中文、数值取**参与人数**（不是记录数）", () => {
    expect(metricBars(metrics)).toEqual([
      { label: "红黑榜", value: 3 },
      { label: "点击", value: 40 },
    ]);
    // 未定义 / 空表一律给空数组，页面据此走空态
    expect(metricBars(undefined)).toEqual([]);
  });

  it("★ contentDonut：两边都是 0 时返回空数组（让页面说一句话，而不是画一个空环）", () => {
    expect(contentDonut({ discussions: 0, feedback: 0 })).toEqual([]);
    expect(contentDonut(undefined)).toEqual([]);
    expect(contentDonut({ discussions: 2, feedback: 0 })).toEqual([{ name: "场次讨论", value: 2 }]);
    expect(contentDonut({ discussions: 2, feedback: 3 })).toEqual([
      { name: "场次讨论", value: 2 },
      { name: "反馈留言", value: 3 },
    ]);
  });

  it("authorBars：计数后按帖子数降序，同名的登录 / 匿名身份算在一起", () => {
    const posts = [
      { displayName: "citron", subject: "s1" },
      { displayName: "citron", subject: "s1" },
      { displayName: "gaaiyeoi", subject: "s2" },
      { displayName: "citron", subject: "s9" }, // 同一名字、另一条身份 → 仍合并
    ];
    expect(authorBars(posts as never)).toEqual([
      { label: "citron", value: 3 },
      { label: "gaaiyeoi", value: 1 },
    ]);
  });

  it("authorBars：名字为空时退回 subject；两者都空的行丢掉；只取 TOP N", () => {
    const posts = [
      { displayName: "", subject: "s-anon" },
      { displayName: "  ", subject: "" },
      ...Array.from({ length: 12 }, (_, index) => ({
        displayName: `who-${index}`,
        subject: `s-${index}`,
      })),
    ];
    const bars = authorBars(posts as never, 5);
    expect(bars).toHaveLength(5);
    // 名字空的退回 subject（`s-anon` 进来了）；13 个人人各 1 条，同分时按名字排
    //（结果稳定 —— 否则每次刷新榜单换一批人，看图的人会以为「热度在变」）
    expect(bars.map((bar) => bar.label)).toEqual([
      "s-anon",
      "who-0",
      "who-1",
      "who-10",
      "who-11",
    ]);
    expect(authorBars([{ displayName: "", subject: "" }] as never)).toEqual([]);
  });

  it("categoryDonut：用契约里的中文标签、按条数降序、未知分类原样回", () => {
    const posts = [
      { category: "gift" },
      { category: "other" },
      { category: "gift" },
      { category: "brand-new" },
      { category: undefined },
    ];
    expect(categoryDonut(posts as never)).toEqual([
      { name: "无料交换", value: 2 },
      { name: "—", value: 1 },
      { name: "brand-new", value: 1 },
      { name: "其他", value: 1 },
    ]);
  });
});
