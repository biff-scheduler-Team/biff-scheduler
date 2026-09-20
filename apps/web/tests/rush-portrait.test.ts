// B 组「我的观影画像」纯逻辑单测（2026-09-20，第 2 轮，PLAN-20260920203010 修订 1）。
//
// 覆盖点：① 空行程 → null（不渲染一份全 0 的画像）；② 影片数按身份去重、场次不去重；
// ③ 平均每日场次；④ 跨午夜时段走同一份不取模映射；⑤ 多值国别字段拆分（占比之和可 > 1）；
// ⑥ 平均分只对有评分的片取平均；⑦ 票价 / 时长只累加有效值。

import { describe, expect, it } from "vitest";
import { buildPortrait, filmFacets, splitCountries, type FilmFacetRow, type MyShowRow } from "../src/rush-portrait";

/** 影片分析的输入行（默认值给全，测试只关心那一两个字段） */
const facet = (patch: Partial<FilmFacetRow> & { key: string }): FilmFacetRow => ({
  title: patch.key,
  unit: "主竞赛",
  country: "韩国",
  year: 2026,
  rating: null,
  durationMin: null,
  ...patch,
});

const mine = (patch: Partial<MyShowRow> & { code: string }): MyShowRow => ({
  filmKey: "f1",
  date: "2026-10-08",
  startHour: 10,
  durationMin: 100,
  priceKrw: 10000,
  venueId: "b1",
  venueGroup: "bcc",
  venueLabel: "BCC 1",
  unit: "主竞赛",
  country: "韩国",
  rating: null,
  ...patch,
});

describe("splitCountries", () => {
  it("按 / 、 , · | 拆开并去空白", () => {
    expect(splitCountries("韩国/法国")).toEqual(["韩国", "法国"]);
    expect(splitCountries("韩国、日本, 美国")).toEqual(["韩国", "日本", "美国"]);
    expect(splitCountries("")).toEqual([]);
  });
});

describe("buildPortrait", () => {
  it("空行程 → null（不渲染全 0 的画像）", () => {
    expect(buildPortrait([])).toBeNull();
  });

  it("影片按身份去重、场次不去重；覆盖天数与影厅数按出现去重", () => {
    const portrait = buildPortrait([
      mine({ code: "001", filmKey: "a", date: "2026-10-08", venueId: "b1" }),
      mine({ code: "002", filmKey: "a", date: "2026-10-08", venueId: "b1" }),
      mine({ code: "003", filmKey: "b", date: "2026-10-09", venueId: "b2", venueLabel: "BCC 2" }),
    ]);
    expect(portrait?.films).toBe(2);
    expect(portrait?.shows).toBe(3);
    expect(portrait?.days).toBe(2);
    expect(portrait?.venues).toBe(2);
    expect(portrait?.avgPerDay).toBe(1.5);
    expect(portrait?.busiest).toEqual({ date: "2026-10-08", shows: 2 });
  });

  it("时长与票面总额只累加有效值，脏值不计入也不报错", () => {
    const portrait = buildPortrait([
      mine({ code: "001", durationMin: 100, priceKrw: 10000 }),
      mine({ code: "002", durationMin: 0, priceKrw: 0 }),
      mine({ code: "003", durationMin: Number.NaN, priceKrw: -1 }),
    ]);
    expect(portrait?.minutes).toBe(100);
    expect(portrait?.priceKrw).toBe(10000);
  });

  it("跨午夜场并入次日档（不取模）", () => {
    const portrait = buildPortrait([
      mine({ code: "001", startHour: 20 }),
      mine({ code: "002", startHour: 25 }),
      mine({ code: "003", startHour: 29 }),
    ]);
    expect(portrait?.byHour).toEqual([
      { key: "20", label: "20:00", shows: 1 },
      { key: "24", label: "次日（跨午夜场）", shows: 2 },
    ]);
  });

  it("合拍片同时计给两国（占比之和因此可能 > 1）", () => {
    const portrait = buildPortrait([
      mine({ code: "001", country: "韩国/法国" }),
      mine({ code: "002", country: "韩国" }),
    ]);
    expect(portrait?.byCountry.map((c) => [c.label, c.shows])).toEqual([
      ["韩国", 2],
      ["法国", 1],
    ]);
  });

  it("平均分只对有评分的片取平均", () => {
    const portrait = buildPortrait([
      mine({ code: "001", rating: 8 }),
      mine({ code: "002", rating: 6 }),
      mine({ code: "003", rating: null }),
    ]);
    expect(portrait?.rated).toEqual({ average: 7, count: 2 });
  });

  it("一个评分都没有 → rated 为 null（不是 0 分）", () => {
    expect(buildPortrait([mine({ code: "001" })])?.rated).toBeNull();
  });

  it("空字符串字段归入「未标注」，不产出一个无名桶", () => {
    const portrait = buildPortrait([mine({ code: "001", unit: "", venueGroup: "  " })]);
    expect(portrait?.byUnit[0].label).toBe("未标注");
    expect(portrait?.byVenueGroup[0].label).toBe("未标注");
  });
});

describe("filmFacets（影片分析：数的是片目，不是场次）", () => {
  it("合拍片同时计给两国；单元同样按分隔符拆", () => {
    const facets = filmFacets([
      facet({ key: "a", country: "韩国/法国", unit: "主竞赛" }),
      facet({ key: "b", country: "韩国", unit: "主竞赛/亚洲电影之窗" }),
    ]);
    expect(facets.byCountry.map((row) => [row.label, row.films])).toEqual([
      ["韩国", 2],
      ["法国", 1],
    ]);
    expect(facets.byUnit.map((row) => [row.label, row.films])).toEqual([
      ["主竞赛", 2],
      ["亚洲电影之窗", 1],
    ]);
  });

  it("评分分档按**档位顺序**排，无评分单列一档（不是 0 分）", () => {
    const facets = filmFacets([
      facet({ key: "a", rating: 6.5 }),
      facet({ key: "b", rating: 7.4 }),
      facet({ key: "c", rating: 8.6 }),
      facet({ key: "d", rating: null }),
    ]);
    expect(facets.byRating.map((row) => [row.label, row.films])).toEqual([
      ["< 7 分", 1],
      ["7 – 8 分", 1],
      ["≥ 8 分", 1],
      ["无评分", 1],
    ]);
  });

  it("时长分档同样按档位顺序排", () => {
    const facets = filmFacets([
      facet({ key: "a", durationMin: 80 }),
      facet({ key: "b", durationMin: 100 }),
      facet({ key: "c", durationMin: 150 }),
    ]);
    expect(facets.byDuration.map((row) => row.label)).toEqual(["< 90 分钟", "90 – 120 分钟", "≥ 120 分钟"]);
  });

  it("年份按升序（时间轴语义），未标注年份单列", () => {
    const facets = filmFacets([
      facet({ key: "a", year: 2026 }),
      facet({ key: "b", year: 1998 }),
      facet({ key: "c", year: null }),
    ]);
    expect(facets.byYear.map((row) => row.label)).toEqual(["1998", "2026", "未标注"]);
  });

  it("空片目 → 数量为 0 且各榜为空（页面据此不画图）", () => {
    const facets = filmFacets([]);
    expect(facets.films).toBe(0);
    expect(facets.byCountry).toEqual([]);
  });
});
