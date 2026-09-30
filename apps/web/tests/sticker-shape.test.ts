// 贴纸的**形状族几何**与**单一来源守卫**（2026-09-29，第三轮起只守这两件事）。
//
// ⚠ 2026-09-29 的改动把「哪个形状配哪个颜色」的交给了皮肤体系（`sticker-skin.ts`）：
//   红黑共用同一套形状，所以本文件里原来的「按颜色分子集」断言被**移走**到
//   `sticker-skin.test.ts`（不是删掉——那条口径仍然存在，只是换了归属）。
//   这里只剩两件事：路径几何本身，以及「形状只有一处实现」的机械守卫。
//
// ⚠ node 环境：不碰 DOM，也不调用 `shapePath2D`（node 里没有 `Path2D`）。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ALL_SHAPES,
  SHAPE_BOX,
  shapeClipVar,
  shapePath,
  type StickerShape,
} from "../src/sticker-shape";
import { ALL_GLYPHS, GLYPH_BOX, ICON_RATIO, glyphPath, glyphPlacement } from "../src/sticker-glyph";

/** 取出 path `d` 里所有数字。 */
function numbersIn(d: string): number[] {
  return (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

describe("形状的几何", () => {
  it("每个形状都闭合、且坐标落在设计盒内", () => {
    for (const shape of ALL_SHAPES) {
      const d = shapePath(shape);
      expect(d.startsWith("M")).toBe(true);
      expect(d.endsWith("Z")).toBe(true);
      for (const value of numbersIn(d)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(SHAPE_BOX);
      }
      expect(numbersIn(d).length).toBeGreaterThanOrEqual(8);
    }
  });

  it("形状之间确实长得不一样（不能是同一份路径换了名字）", () => {
    expect(new Set(ALL_SHAPES.map((shape) => shapePath(shape))).size).toBe(ALL_SHAPES.length);
  });

  it("`shapePath` 传 size 会等比换算坐标，而不是另描一份路径", () => {
    for (const shape of ALL_SHAPES) {
      const full = numbersIn(shapePath(shape, SHAPE_BOX));
      const half = numbersIn(shapePath(shape, SHAPE_BOX / 2));
      expect(half.length).toBe(full.length);
      full.forEach((value, i) => {
        expect(Math.abs(half[i] - value / 2)).toBeLessThanOrEqual(0.01);
      });
      expect(shapePath(shape)).toBe(shapePath(shape, SHAPE_BOX));
    }
  });
});

describe("中心微图标的几何", () => {
  it("五款图形各自闭合、坐标落在自己的设计盒内", () => {
    for (const glyph of ALL_GLYPHS) {
      const d = glyphPath(glyph);
      expect(d.endsWith("Z")).toBe(true);
      for (const value of numbersIn(d)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(GLYPH_BOX);
      }
    }
  });

  it("图形之间互不相同", () => {
    expect(new Set(ALL_GLYPHS.map((glyph) => glyphPath(glyph))).size).toBe(ALL_GLYPHS.length);
  });

  it("图标占比是 45% —— 32px 贴纸上约 14px，再小就会被读成印刷瑕疵", () => {
    expect(ICON_RATIO).toBeCloseTo(0.45, 5);
    expect(Math.round(SHAPE_BOX * ICON_RATIO)).toBe(14);
  });

  it("`glyphPlacement` 把图形摆在**正中** —— 这是 canvas 那一侧踩过的坑", () => {
    // 曾经只 `translate(size/2, size/2)` 再 `scale`：那是绕原点缩的，图形那 0..24 的坐标
    // 会被当成以中心为原点 → 整块偏到右下角（偏约 size × 0.225）。用「左右留白相等」钉死它。
    for (const size of [14, 24, 32, 64]) {
      const { x, y, scale } = glyphPlacement(size);
      const drawn = GLYPH_BOX * scale;
      expect(drawn).toBeCloseTo(size * ICON_RATIO, 6);
      expect(x).toBeCloseTo(size - drawn - x, 6);
      expect(y).toBeCloseTo(size - drawn - y, 6);
    }
    expect(glyphPlacement(SHAPE_BOX).x).toBeCloseTo(8.8, 6);
  });
});

describe("单一来源（四处消费不许各描一份）", () => {
  const css = readFileSync(new URL("../src/pages/redblack-parity.css", import.meta.url), "utf8");
  const face = readFileSync(new URL("../src/components/StickerFace.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/pages/RedBlackPage.tsx", import.meta.url), "utf8");

  it("CSS 里不出现任何硬编码的形状路径", () => {
    expect(css).not.toMatch(/path\(\s*["']?M/);
    expect(css).toContain("var(--rb-shape)");
  });

  it("本体组件与页面组件里都不手写 SVG 路径", () => {
    // `StickerFace` 负责画形状与图标（那是它该做的），但它必须走 `shapePath` / `glyphPath`；
    // 页面那头连本体都不许自己画（`<StickerFace skin={…} />` 才是唯一入口）。
    expect(face).not.toMatch(/d=\{\s*["'`]M/);
    expect(page).not.toMatch(/d=\{\s*["'`]M/);
    // 页面不该再直接摸形状 / 图标（那是本体组件的职责）
    expect(page).not.toMatch(/shapePath|glyphPath|shapeClipVar/);
  });

  it("`shapeClipVar` 产出的是 CSS 能直接吃的 path() 字面量", () => {
    const value = shapeClipVar("torn", SHAPE_BOX);
    expect(value.startsWith('path("M')).toBe(true);
    expect(value.endsWith('")')).toBe(true);
    expect(value).toBe(`path("${shapePath("torn")}")`);
  });

  // `clip-path: path()` 是**绝对 px**、不随元素缩放（这一点与 SVG 的 `viewBox` 不同）。
  // 贴纸尺寸已经改过四轮，一旦有人忘了把尺寸传进来，症状是贴纸**被裁掉右下角**
  // —— 而那不会报错、只有人眼看得出来，所以这里把它钉死。
  it("★ 传给 `shapeClipVar` 的尺寸会真的反映到坐标上（不是被忽略）", () => {
    const big = shapeClipVar("torn", SHAPE_BOX);
    const small = shapeClipVar("torn", SHAPE_BOX / 2);
    expect(small).not.toBe(big);
    expect(small).toBe(`path("${shapePath("torn", SHAPE_BOX / 2)}")`);
    // 折半之后所有坐标（含控制点）都不该跑出盒子 —— 用最大坐标近似校验一下
    const coords = (small.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    for (const value of coords) expect(Math.abs(value)).toBeLessThanOrEqual(SHAPE_BOX / 2 + 0.01);
  });

  it("形状只有一处实现：`shapePath` 对同一个形状稳定产出同一条路径", () => {
    const shapes: StickerShape[] = [...ALL_SHAPES];
    for (const shape of shapes) expect(shapePath(shape)).toBe(shapePath(shape));
  });

  // 这条守的是「同一形状、两个坐标系」这个事实：描边那枚 SVG 用的是 `SHAPE_BOX` 坐标系
  // （靠 `viewBox` 缩到实际大小），而 `clip-path` 用的是**贴纸坐标系**（绝对 px，不缩放）。
  // 两者能对得上，**完全依赖** `shapePath` 的缩放是等比的 —— 一旦有人给某个形状特判一个尺寸，
  // 贴纸就会「轮廓是那个形状、裁切却是另一个形状」，而且只有并排看才看得出来。
  it("★ `shapePath` 的 size 是**等比缩放**（同一条形状，只是坐标系不同）", () => {
    const nums = (d: string): number[] => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    for (const shape of ALL_SHAPES) {
      const base = nums(shapePath(shape, SHAPE_BOX));
      const half = nums(shapePath(shape, SHAPE_BOX / 2));
      expect(half).toHaveLength(base.length);
      for (let i = 0; i < base.length; i += 1) {
        // `num()` 收两位小数 → 每项允许 0.011 的取整误差
        expect(Math.abs(half[i] - base[i] / 2)).toBeLessThanOrEqual(0.011);
      }
    }
  });
});
