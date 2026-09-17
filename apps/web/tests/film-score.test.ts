import { describe, expect, it } from "vitest";
import type { FilmItem, Mapping } from "../src/types";
import { doubanMappingOf, doubanScoreOf, doubanUrlOf, fmtVoters } from "../src/util";

const film = (p: Partial<FilmItem>): FilmItem => ({
  id: "f001",
  unit: "",
  remark: "",
  title_zh: "",
  title_orig: "",
  year: null,
  rating: null,
  rating_count: null,
  country: "",
  director: "",
  ...p,
});

const map = (p: Partial<Mapping>): Mapping => ({
  code: "001",
  subject_id: 1,
  title_cn: null,
  douban_url: null,
  ...p,
});

describe("fmtVoters", () => {
  it("不足一万原样", () => {
    expect(fmtVoters(0)).toBe("0");
    expect(fmtVoters(999)).toBe("999");
    expect(fmtVoters(9999)).toBe("9999");
  });
  it("过万写成万,一位小数、整万去掉 .0", () => {
    expect(fmtVoters(10000)).toBe("1万");
    expect(fmtVoters(16019)).toBe("1.6万");
    expect(fmtVoters(120000)).toBe("12万");
  });
});

describe("doubanScoreOf", () => {
  it("目录有分就用目录,人数可缺", () => {
    expect(doubanScoreOf(film({ rating: 8.1, rating_count: 16019 }))).toEqual({
      rating: 8.1,
      count: 16019,
    });
    expect(doubanScoreOf(film({ rating: 8.1 }))).toEqual({ rating: 8.1, count: null });
  });
  it("目录没有分,映射兜底", () => {
    expect(doubanScoreOf(film({}), map({ rating: 7.4, rating_count: 88 }))).toEqual({
      rating: 7.4,
      count: 88,
    });
  });
  it("0 分 / 空当没有", () => {
    expect(doubanScoreOf(film({ rating: 0, rating_count: 12 }))).toBeNull();
    expect(doubanScoreOf(undefined, map({ rating: null }))).toBeNull();
    expect(doubanScoreOf()).toBeNull();
  });
});

describe("doubanMappingOf", () => {
  const byCode = map({ code: "001", douban_url: "https://movie.douban.com/subject/1/" });
  const byFilm = map({ code: "f042", douban_url: "https://movie.douban.com/subject/2/" });
  const mappings = new Map([
    [byCode.code, byCode],
    [byFilm.code, byFilm],
  ]);

  it("有场次且 code 命中就用它(不看目录片 id)", () => {
    expect(doubanMappingOf(mappings, { code: "001", filmId: "f042" })).toBe(byCode);
  });

  it("code 未命中 → 退目录片 id", () => {
    // P&I 场次的 code 不在产物里(产物按公开排期 code 生成),这是这条腿在线上唯一真正生效的场景
    expect(doubanMappingOf(mappings, { code: "PI-09-04", filmId: "f042" })).toBe(byFilm);
  });

  it("纯目录片(没有场次)只给 filmId", () => {
    expect(doubanMappingOf(mappings, { filmId: "f042" })).toBe(byFilm);
    expect(doubanMappingOf(mappings, { code: null, filmId: "f042" })).toBe(byFilm);
  });

  it("两侧都没有 → undefined(调用方交给 doubanUrlOf 退搜索)", () => {
    expect(doubanMappingOf(mappings, { code: "999", filmId: "f999" })).toBeUndefined();
    expect(doubanMappingOf(mappings, {})).toBeUndefined();
    expect(doubanMappingOf(new Map(), { code: "001" })).toBeUndefined();
  });
});

describe("doubanUrlOf", () => {
  it("映射有条目就用条目页(搜索兜底不参与)", () => {
    expect(
      doubanUrlOf({ zh: "彼此的日夜", en: "The Table" }, map({ douban_url: "https://movie.douban.com/subject/1/" })),
    ).toBe("https://movie.douban.com/subject/1/");
  });
  it("没有映射时按片名搜索,中文名优先", () => {
    expect(doubanUrlOf({ zh: "彼此的日夜", en: "The Table" })).toBe(
      "https://www.douban.com/search?q=%E5%BD%BC%E6%AD%A4%E7%9A%84%E6%97%A5%E5%A4%9C",
    );
  });
  it("中文名空 / 只有空格时退回英文名,并 trim", () => {
    expect(doubanUrlOf({ zh: "   ", en: "The Table: Day and Night" })).toBe(
      "https://www.douban.com/search?q=The%20Table%3A%20Day%20and%20Night",
    );
    expect(doubanUrlOf({ en: "  Beneath  " })).toBe("https://www.douban.com/search?q=Beneath");
  });
  it("两个名字都没有 / 传空时给一个空搜索(调用方自己保证有名字)", () => {
    expect(doubanUrlOf(null)).toBe("https://www.douban.com/search?q=");
    expect(doubanUrlOf()).toBe("https://www.douban.com/search?q=");
  });
});
