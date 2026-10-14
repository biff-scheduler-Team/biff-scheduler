// 「热门榜」分享图的**模型层**单测（2026-10-14，PLAN-20261014150805 修订 2）。
//
// 为什么单测它：出图是「对外的成品」，条数 / 单元 / 头尾选错都不报错、不崩 ——
// 只会安静地发出一张内容不对的图，只能靠断言守。
// ⚠ 绘制本身（像素）不做断言：E2E 用 DOM 锚点（`data-poster-count` / 尺寸文案）守。

import { describe, expect, it } from "vitest";
import type { HotRow } from "../src/hot-board";
import {
  buildHotPosterModel,
  HOT_POSTER_ROWS,
  hotPosterHeight,
} from "../src/hot-poster";
import { CREDIT_BY, POSTER_W, SITE } from "../src/poster-brush";

function row(want: number, over: Partial<HotRow> = {}): HotRow {
  return {
    key: `cat:f${want}`,
    title: `片${want}`,
    units: ["甲单元"],
    unitName: "甲单元",
    // 分享图不读这两个字段（它们属于榜单页本体的呈现），这里给中性值
    rising: 0,
    rankDelta: null,
    want,
    red: 0,
    black: 0,
    score: null,
    ...over,
  };
}

/** 想看降序的 n 行（`buildHotRows` 的输出形状：已排序）。 */
function rows(n: number): HotRow[] {
  return Array.from({ length: n }, (_, i) => row((n - i) * 2, { key: `cat:f${i}`, title: `片${i}` }));
}

const TODAY = new Date(2026, 9, 14); // 2026-10-14

describe("hotPosterHeight:单屏 3:4", () => {
  it("默认 8 行正好是 1080 × 1440（3:4）", () => {
    const model = buildHotPosterModel({ rows: rows(HOT_POSTER_ROWS), today: TODAY });
    // ⚠ 写死这两个数是有意的：它们是**产品口径**（公众号正文图 1080 宽、手机一屏能读完），
    //   不是实现的副产品。改了行高 / 头高导致这条红，先问是不是真的要改这个比例。
    expect(POSTER_W).toBe(1080);
    expect(hotPosterHeight(model)).toBe(1440);
  });

  it("行数少 → 图**同比变矮**（不留白），而不是把 8 行的高度硬撑满", () => {
    const eight = buildHotPosterModel({ rows: rows(8), today: TODAY });
    const five = buildHotPosterModel({ rows: rows(5), today: TODAY });
    expect(hotPosterHeight(five)).toBeLessThan(hotPosterHeight(eight));
    // 高度按行数线性：差 3 行就正好差 3 个行高
    expect(hotPosterHeight(eight) - hotPosterHeight(five)).toBe(
      (hotPosterHeight(eight) - hotPosterHeight(buildHotPosterModel({ rows: rows(7), today: TODAY }))) * 3,
    );
  });

  it("一行都没有时不留一个空壳：图高 > 0，画的是那句空态", () => {
    const model = buildHotPosterModel({ rows: [], today: TODAY, unitName: "甲单元" });
    expect(hotPosterHeight(model)).toBeGreaterThan(0);
    expect(model.emptyText).toContain("甲单元");
  });
});

describe("buildHotPosterModel:条数 topN", () => {
  it("取前 N 名（榜单已经是降序，所以就是前 N 行）", () => {
    const model = buildHotPosterModel({ rows: rows(12), topN: 5, today: TODAY });
    expect(model.rows.map((r) => r.want)).toEqual([24, 22, 20, 18, 16]);
  });

  it("不足 N 行时**全列**，不补零", () => {
    const model = buildHotPosterModel({ rows: rows(3), topN: 20, today: TODAY });
    expect(model.rows).toHaveLength(3);
  });

  it("topN <= 0 = 不截断", () => {
    const model = buildHotPosterModel({ rows: rows(12), topN: 0, today: TODAY });
    expect(model.rows).toHaveLength(12);
  });

  it("不传 topN 就是 `HOT_POSTER_ROWS`（默认那档）", () => {
    expect(buildHotPosterModel({ rows: rows(12), today: TODAY }).rows).toHaveLength(HOT_POSTER_ROWS);
  });

  it("截断只改**列表**，不改头部那三个数（它们是整个范围的规模，与页面 hero 同一件事）", () => {
    const all = buildHotPosterModel({ rows: rows(12), topN: 0, today: TODAY });
    const top8 = buildHotPosterModel({ rows: rows(12), topN: 8, today: TODAY });
    expect(top8.rows).toHaveLength(8);
    expect(top8.rows).not.toEqual(all.rows);
    // 「只印 8 行」不能被说成「全站只有 8 部」
    expect(top8.subtitle).toBe(all.subtitle);
    expect(top8.subtitle).toContain("全站 12 部");
  });
});

describe("buildHotPosterModel:文案与范围", () => {
  it("头部：届次 / 大标题 / 副标题里的三个数（日期是注入的，不读时钟）", () => {
    const model = buildHotPosterModel({
      rows: [row(30, { red: 2, black: 1 }), row(10)],
      today: TODAY,
    });
    expect(model.eyebrow).toBe("BIFF 2026 · 热度 × 口碑");
    expect(model.title).toBe("热门榜");
    // 三个数分别是「上榜影片数 / 想看合计 / 贴纸合计」—— 与面板 hero 同一份口径（`hotTotals`）
    expect(model.subtitle).toBe("OCT 14 · 全站 2 部 · 40 人想看 · 3 枚贴纸");
  });

  it("选了单元 → 标题带上单元名、副标题也点明范围（只印 8 行却不说哪一单元，读图的人会误读成全站）", () => {
    const model = buildHotPosterModel({
      rows: [row(30)],
      unitName: "主竞赛",
      today: TODAY,
    });
    expect(model.title).toBe("主竞赛 热门榜");
    expect(model.subtitle).toContain("主竞赛");
    expect(model.subtitle).not.toContain("全站");
  });

  it("口碑评分**照传进来的用**（与页面角标同一处实现），一票没有 = null", () => {
    const model = buildHotPosterModel({
      rows: [row(30, { score: 7.7, red: 20, black: 5 }), row(10, { score: null })],
      today: TODAY,
    });
    expect(model.rows.map((r) => r.score)).toEqual([7.7, null]);
    expect(model.rows[0]).toMatchObject({ red: 20, black: 5 });
  });

  it("底部署名 = 网站 + 作者（与另两张分享图 / 页面页脚同源）", () => {
    const model = buildHotPosterModel({ rows: rows(1), today: TODAY });
    expect(model.credit.site).toBe(SITE);
    expect(model.credit.by).toBe(CREDIT_BY);
  });
});

describe("hotPosterHeight:头尾开关只改高度，不改内容", () => {
  it("关掉头部 → 高度少一个与行数无关的固定量", () => {
    const d8 =
      hotPosterHeight(buildHotPosterModel({ rows: rows(8), today: TODAY })) -
      hotPosterHeight(buildHotPosterModel({ rows: rows(8), showHeader: false, today: TODAY }));
    const d3 =
      hotPosterHeight(buildHotPosterModel({ rows: rows(3), today: TODAY })) -
      hotPosterHeight(buildHotPosterModel({ rows: rows(3), showHeader: false, today: TODAY }));
    expect(d8).toBeGreaterThan(0);
    expect(d3).toBe(d8);
  });

  it("关掉署名同理；两个都关仍是一张完整的图（> 0）", () => {
    const base = buildHotPosterModel({ rows: rows(8), today: TODAY });
    const noFooter = buildHotPosterModel({ rows: rows(8), showFooter: false, today: TODAY });
    const bare = buildHotPosterModel({
      rows: rows(8),
      showHeader: false,
      showFooter: false,
      today: TODAY,
    });
    expect(hotPosterHeight(base)).toBeGreaterThan(hotPosterHeight(noFooter));
    expect(hotPosterHeight(bare)).toBeLessThan(hotPosterHeight(noFooter));
    expect(hotPosterHeight(bare)).toBeGreaterThan(0);
  });

  it("关掉头尾**不动**图里的行（榜单内容一字不变）", () => {
    const base = buildHotPosterModel({ rows: rows(6), today: TODAY });
    const bare = buildHotPosterModel({
      rows: rows(6),
      showHeader: false,
      showFooter: false,
      today: TODAY,
    });
    expect(bare.rows).toEqual(base.rows);
    expect(base.showHeader).toBe(true);
    expect(base.showFooter).toBe(true);
  });
});
