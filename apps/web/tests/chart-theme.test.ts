// 图表配色适配层单测（2026-09-20，PLAN-20260920203010；2026-09-20 修订 4 加分类色板）。
//
// 重点在**降级**：`getComputedStyle().getPropertyValue()` 对未定义的变量返回**空串**，
// 直接当 `fill` 用会画出透明图形（现场看就是「图不见了」，且没有任何报错）。
// 所以每个 token 都必须「读不到就回退」，且回退值不能是 undefined/null/空串。

import { describe, expect, it } from "vitest";
import {
  CHART_PALETTE_DARK,
  CHART_PALETTE_LIGHT,
  CHART_TOKEN_FALLBACK,
  CHART_TOKEN_NAMES,
  resolveChartTokens,
} from "../src/chart-theme";

/** 走 CSS 变量的那些字段（`palette` **不在此列** —— 它按主题取表，见 chart-theme.ts）。 */
type VarKey = keyof typeof CHART_TOKEN_NAMES;
const VAR_KEYS = Object.keys(CHART_TOKEN_NAMES) as VarKey[];

/** 造一个「按变量名给值」的读取器；未列出的名字返回 undefined（模拟未定义变量）。 */
const reader =
  (values: Partial<Record<string, string>>) =>
  (name: string): string | undefined =>
    values[name];

describe("token 名映射", () => {
  it("每个字段都指向一个 CSS 变量；除已声明的别名外不重复指向同一个变量", () => {
    const names = VAR_KEYS.map((key) => CHART_TOKEN_NAMES[key]);
    expect(names.every((name) => name.startsWith("--"))).toBe(true);
    // `emptySkeleton`（空态骨架）刻意复用 `--raised`，不新增变量 —— 唯一一处允许的别名
    const duplicates = VAR_KEYS.filter(
      (key) => VAR_KEYS.filter((other) => CHART_TOKEN_NAMES[other] === CHART_TOKEN_NAMES[key]).length > 1,
    );
    expect(duplicates.sort()).toEqual(["emptySkeleton", "raised"]);
  });

  it("兜底色板与 token 名一一对应（`palette` 是唯一不来自 CSS 变量的字段）", () => {
    expect(Object.keys(CHART_TOKEN_FALLBACK).sort()).toEqual([...VAR_KEYS, "palette"].sort());
  });

  it("兜底色板里没有空值 / undefined —— 它就是要保证 SVG 永远拿得到色值", () => {
    for (const key of VAR_KEYS) {
      expect(CHART_TOKEN_FALLBACK[key]).toMatch(/^#[0-9a-f]{3,8}$/i);
    }
  });
});

describe("分类色板", () => {
  it("浅深两套都是合法色值，且**第一色恒为品牌色**（只有一两类时外观仍是本站主色）", () => {
    for (const palette of [CHART_PALETTE_LIGHT, CHART_PALETTE_DARK]) {
      expect(palette.length).toBeGreaterThanOrEqual(6);
      for (const color of palette) expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(CHART_PALETTE_LIGHT[0]).toBe(CHART_TOKEN_FALLBACK.brand);
  });

  it("同一索引的浅深两色不同 —— 否则暗底上会有一类看不见", () => {
    for (let index = 0; index < CHART_PALETTE_LIGHT.length; index += 1) {
      expect(CHART_PALETTE_LIGHT[index]).not.toBe(CHART_PALETTE_DARK[index]);
    }
  });

  it("`isDark` 决定取哪一套", () => {
    expect(resolveChartTokens(() => undefined, false).palette).toEqual([...CHART_PALETTE_LIGHT]);
    expect(resolveChartTokens(() => undefined, true).palette).toEqual([...CHART_PALETTE_DARK]);
  });
});

describe("resolveChartTokens", () => {
  it("读得到就用读到的值（trim 掉两边空白）", () => {
    const tokens = resolveChartTokens(reader({ "--brand": "  #123456  ", "--line": "#abcdef" }));
    expect(tokens.brand).toBe("#123456");
    expect(tokens.line).toBe("#abcdef");
  });

  it("空串（未定义的变量）→ 回退，而不是产出空 fill", () => {
    const tokens = resolveChartTokens(reader({ "--brand": "" }));
    expect(tokens.brand).toBe(CHART_TOKEN_FALLBACK.brand);
  });

  it("undefined / null / 只有空白 → 一律回退", () => {
    expect(resolveChartTokens(reader({})).muted).toBe(CHART_TOKEN_FALLBACK.muted);
    expect(resolveChartTokens(reader({ "--muted": "   " })).muted).toBe(CHART_TOKEN_FALLBACK.muted);
    expect(resolveChartTokens(() => null).text).toBe(CHART_TOKEN_FALLBACK.text);
  });

  it("字符串化的 undefined / null（某些 polyfill 的产物）→ 同样回退", () => {
    const tokens = resolveChartTokens(reader({ "--surface": "undefined", "--raised": "null" }));
    expect(tokens.surface).toBe(CHART_TOKEN_FALLBACK.surface);
    expect(tokens.raised).toBe(CHART_TOKEN_FALLBACK.raised);
  });

  it("什么都读不到时整份回退 —— 每个字段都仍是合法色值", () => {
    const tokens = resolveChartTokens(() => undefined);
    for (const key of VAR_KEYS) {
      expect(tokens[key]).toBe(CHART_TOKEN_FALLBACK[key]);
      expect(tokens[key]).not.toBe("");
    }
  });

  it("深浅两套读到的值不同 —— 这正是必须运行时读取的原因", () => {
    const light = resolveChartTokens(reader({ "--line": "#dcdce1" }));
    const dark = resolveChartTokens(reader({ "--line": "#44444b" }));
    expect(light.line).not.toBe(dark.line);
    expect(light.line).toBe("#dcdce1");
    expect(dark.line).toBe("#44444b");
  });
});
