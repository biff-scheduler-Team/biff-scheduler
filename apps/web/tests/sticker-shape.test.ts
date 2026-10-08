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
// ⚠ 只为把「图标在**真贴纸**上有多大」也算进来(`STICKER_SIZE` 是全站唯一那份尺寸口径)。
//   它在 node 里可 import:与 `sticker-material.test.ts` 同一条路,`createElement` 只在 `build()` 里调。
import { STICKER_SIZE } from "../src/sticker-sprite";

/** 取出 path `d` 里所有数字。 */
function numbersIn(d: string): number[] {
  return (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

/** 取出 path `d` 里**每一段的终点**(`M` / `L` 就是那对数字,`C` 取最后那对)。
 *  与 `sticker-shape.ts::ringArea` 同一个近似口径(曲线段按直线算)—— 这里能这么算,
 *  是因为顶点环的终点恰好就是那些顶点。 */
function ringPoints(d: string): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (const match of d.matchAll(/([MLC])((?:\s*-?\d+(?:\.\d+)?)+)/g)) {
    const nums = numbersIn(match[2]);
    out.push({ x: nums[nums.length - 2], y: nums[nums.length - 1] });
  }
  return out;
}

/** 顶点环的近似面积(鞋带公式) */
function ringArea(d: string): number {
  const points = ringPoints(d);
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
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

  // ★ 2026-10-08 用户「统一一下贴纸大小」:三款轮廓在同一个 32 设计盒里的**视觉占位**必须一致 ——
  //   归一前实测 票根 470 / 胶片齿孔 463 / 胶片残片 280,并排看就是「残片小一圈」。
  //   ⚠ 面积用顶点环近似(与实现同一口径):`stub` 那几个平滑顶点真路径是曲线,这里按直线算 ——
  //     近似值本身不必准,准的是「三款互相一致」。
  //   ⚠ 这条同时守着「归一后的顶点没被顶出设计盒」的反面:目标面积一旦大于某款放得下的上限,
  //     那款就会被放大到越界,上一条用例(坐标 ≤ SHAPE_BOX)会先红。
  it("★ 三款轮廓的视觉面积一致(用户口径:并排看大小要一样)", () => {
    const areas = ALL_SHAPES.map((shape) => ringArea(shapePath(shape)));
    for (const area of areas) {
      expect(Math.abs(area - areas[0]) / areas[0]).toBeLessThan(0.02);
    }
    // 顺带钉住量级:归一后应落在三者原始面积的均值附近(约 404)
    expect(areas[0]).toBeGreaterThan(380);
    expect(areas[0]).toBeLessThan(430);
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
  it("全部图形各自闭合、坐标落在自己的设计盒内", () => {
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

  // ⚠ 0.45 → 0.55(2026-09-30) → 0.46(2026-10-05):贴纸放大到 24px 时，
  //   用比例把中心图标的**实际像素**压回放大前的 11px(用户「中间挖孔大小不变」)。
  it("图标占比是 46% —— 24px 贴纸上仍是约 11px(与放大前 20 × 0.55 同值)", () => {
    expect(ICON_RATIO).toBeCloseTo(0.46, 5);
    expect(Math.round(SHAPE_BOX * ICON_RATIO)).toBe(15);
    expect(Math.round(STICKER_SIZE * ICON_RATIO)).toBe(11);
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
    // (32 − 24 × (32 × 0.46 / 24)) / 2 = 8.64
    expect(glyphPlacement(SHAPE_BOX).x).toBeCloseTo(8.64, 6);
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
    const value = shapeClipVar("stub", SHAPE_BOX);
    expect(value.startsWith('path("M')).toBe(true);
    expect(value.endsWith('")')).toBe(true);
    expect(value).toBe(`path("${shapePath("stub")}")`);
  });

  // `clip-path: path()` 是**绝对 px**、不随元素缩放（这一点与 SVG 的 `viewBox` 不同）。
  // 贴纸尺寸已经改过四轮，一旦有人忘了把尺寸传进来，症状是贴纸**被裁掉右下角**
  // —— 而那不会报错、只有人眼看得出来，所以这里把它钉死。
  it("★ 传给 `shapeClipVar` 的尺寸会真的反映到坐标上（不是被忽略）", () => {
    const big = shapeClipVar("stub", SHAPE_BOX);
    const small = shapeClipVar("stub", SHAPE_BOX / 2);
    expect(small).not.toBe(big);
    expect(small).toBe(`path("${shapePath("stub", SHAPE_BOX / 2)}")`);
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
