// 单元显示口径单测(纯函数)。
//
// 为什么单测它:`unitLabel()` 是**卡片副标题**与**单元下拉筛选**两处的唯一取用口,
// 它把「官网英文 section 名」与「节目册中文单元名」两条管线合流成同一排版
// (「英文 · 中文」,与片名同口径)。表里漏一行 / 归一化写错,表现是
// 「有的单元又退回单语言」—— 不报错、不报类型错,只能靠断言守住。

import { describe, expect, it } from "vitest";
import { unitLabel } from "../src/util";

describe("unitLabel:单元「英文 · 中文」", () => {
  it("官网英文 section 名 → 补中文", () => {
    expect(unitLabel("Icons")).toBe("Icons · 标志性影人");
    expect(unitLabel("World Cinema")).toBe("World Cinema · 世界电影");
  });

  it("节目册中文单元名 → 补英文", () => {
    expect(unitLabel("亚洲电影之窗")).toBe("A Window on Asian Cinema · 亚洲电影之窗");
    expect(unitLabel("主竞赛")).toBe("Competition · 主竞赛");
  });

  it("带子单元的单元:两侧都保留子单元名", () => {
    expect(unitLabel("Vision–Korea")).toBe("Vision – Korea · 视界 · 韩国");
    expect(unitLabel("广角镜 - 亚洲短片竞赛")).toBe(
      "Wide Angle – Asian Short Film Competition · 广角镜 · 亚洲短片竞赛"
    );
  });

  it("破折号写法差异(en dash / 连字符)归一后仍命中", () => {
    expect(unitLabel("Vision-Korea")).toBe(unitLabel("Vision–Korea"));
  });

  it("带前导年份的脏值(数据里确实存在)→ 去掉年份后命中", () => {
    expect(unitLabel("2026年度亚洲电影人奖-杨紫琼专题")).toBe(
      "Asian Filmmaker of the Year – Michelle Yeoh · 年度亚洲电影人奖 · 杨紫琼专题"
    );
  });

  it("表里没有的单元 → 原样返回(新单元不会因漏行而变空)", () => {
    expect(unitLabel("Some Brand New Section")).toBe("Some Brand New Section");
    expect(unitLabel("")).toBe("");
    expect(unitLabel(null)).toBe("");
  });
});
