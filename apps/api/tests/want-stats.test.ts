import { describe, expect, it } from "vitest";
import {
  diffFilmKeys,
  formatWantCounts,
  pickFilmKeysFromRecords,
  roundWantCount,
  wantWeightFor,
  WANT_WEIGHT_ANON,
  WANT_WEIGHT_AUTH,
} from "../src/want-stats";

describe("want-stats weighting", () => {
  it("登录 1.0 / 匿名 0.75", () => {
    expect(wantWeightFor(true)).toBe(WANT_WEIGHT_AUTH);
    expect(wantWeightFor(false)).toBe(WANT_WEIGHT_ANON);
    expect(WANT_WEIGHT_AUTH).toBe(1);
    expect(WANT_WEIGHT_ANON).toBe(0.75);
  });

  it("四舍五入展示：0.75→1、1.5→2、2.25→2", () => {
    expect(roundWantCount(0.75)).toBe(1);
    expect(roundWantCount(1)).toBe(1);
    expect(roundWantCount(1.5)).toBe(2);
    expect(roundWantCount(2.25)).toBe(2);
    expect(roundWantCount(2.5)).toBe(3);
    expect(roundWantCount(0)).toBe(0);
  });

  it("从 sync records 抽出 pick 片键", () => {
    expect(
      [...pickFilmKeysFromRecords({ "pick:cat:f001": "{}", "plan:x": "{}", "local:biff.x": "{}" })].sort(),
    ).toEqual(["cat:f001"]);
  });

  it("差分增删", () => {
    expect(diffFilmKeys(["a", "b"], ["b", "c"])).toEqual({ removed: ["a"], added: ["c"] });
  });

  it("聚合行格式化为整数 counts", () => {
    expect(formatWantCounts([{ film_key: "a", weight_sum: "0.75" }, { film_key: "b", weight_sum: 1.5 }])).toEqual({
      a: 1,
      b: 2,
    });
  });
});
