import { describe, expect, it } from "vitest";
import {
  formatAttendanceCounts,
  MAX_SCREENING_CODES_PER_PING,
  SCREENING_CODE_MAX_LENGTH,
} from "../src/screening-stats";

// 同场观影人数:与「想看人数」共用权重口径(登录 1.0 / 匿名 0.75),这里只测场次侧纯函数。

describe("screening attendance counts", () => {
  it("权重和四舍五入成整数;<= 0 与非法值不输出", () => {
    expect(
      formatAttendanceCounts([
        { code: "001", weight_sum: "0.75" },
        { code: "002", weight_sum: 1.5 },
        { code: "003", weight_sum: "0" },
        { code: "004", weight_sum: "nope" },
      ]),
    ).toEqual({ "001": 1, "002": 2 });
  });

  it("与「想看人数」同一套四舍五入口径(2.25 → 2、2.5 → 3)", () => {
    expect(formatAttendanceCounts([{ code: "001", weight_sum: "2.25" }])).toEqual({ "001": 2 });
    expect(formatAttendanceCounts([{ code: "001", weight_sum: "2.5" }])).toEqual({ "001": 3 });
  });

  it("空输入 → 空表", () => {
    expect(formatAttendanceCounts([])).toEqual({});
  });
});

describe("screening ping limits", () => {
  it("单场 code 与单次上报条数的上限", () => {
    expect(SCREENING_CODE_MAX_LENGTH).toBe(64);
    expect(MAX_SCREENING_CODES_PER_PING).toBe(500);
  });
});
