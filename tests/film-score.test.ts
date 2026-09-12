import { describe, expect, it } from "vitest";
import type { FilmItem, Mapping } from "../src/types";
import { doubanScoreOf, fmtVoters } from "../src/util";

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
