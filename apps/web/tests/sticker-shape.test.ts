// 贴纸的**形状族与中心微图标**(2026-09-29,PLAN-20260929195500)。
//
// 为什么单测它:形状与图形是本轮唯一「同一个外观有 4 条渲染路径」的东西
// (CSS clip-path / canvas sprite / 分享图 / 拖拽浮标)。一旦某条路径自己描了一份路径,
// 表现不是报错,而是**分享图上的贴纸与页面上长得不一样** —— 只有人眼能发现。
// 所以这里守三件事:① 推导必须确定性;② 四个消费端共用的路径只有一份来源;
// ③ CSS 里不许出现硬编码路径(这条能机械守住「一处定义、四处消费」)。
//
// ⚠ node 环境:不碰 DOM,也不调用 `shapePath2D`(node 里没有 `Path2D`)。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { hashOf, type StickerType } from "../src/redblack";
import {
  SHAPE_BOX,
  shapeClipVar,
  shapeOf,
  shapePath,
  shapesOf,
  type StickerShape,
} from "../src/sticker-shape";
import {
  GLYPH_BOX,
  ICON_RATIO,
  glyphOf,
  glyphPath,
  glyphPlacement,
  glyphsOf,
} from "../src/sticker-glyph";

const RED: StickerType = "red";
const BLACK: StickerType = "black";

/** 一批**稳定**的贴纸 id:真机上群点就是 `${filmKey}#crowd-${i}` 这个形状。 */
function ids(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `cat:f001#crowd-${i}`);
}

/** 取出 path `d` 里所有数字(形状的坐标有正有负,这里两样都要抓)。 */
function numbersIn(d: string): number[] {
  return (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

const ALL_SHAPES: StickerShape[] = ["torn", "stub", "sprocket", "scrap", "reel"];

describe("形状族注册表", () => {
  it("红 / 黑各有一组互相独立的形状子集", () => {
    expect(shapesOf(RED)).toEqual(["torn", "stub", "sprocket"]);
    expect(shapesOf(BLACK)).toEqual(["torn", "scrap", "reel"]);
    // 「撕裂圆片」是两色共用的那一档:它保证了同一面展板上有一致的底子
    expect(shapesOf(RED)).toContain("torn");
    expect(shapesOf(BLACK)).toContain("torn");
  });

  it("每个形状都能产出闭合且落在设计盒内的 path", () => {
    for (const shape of ALL_SHAPES) {
      const d = shapePath(shape);
      expect(d.startsWith("M")).toBe(true);
      expect(d.endsWith("Z")).toBe(true);
      for (const value of numbersIn(d)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(SHAPE_BOX);
      }
      // 至少得有几个顶点,否则「形状族」名不副实
      expect(numbersIn(d).length).toBeGreaterThanOrEqual(8);
    }
  });

  it("形状之间确实长得不一样(不能是同一份路径换了名字)", () => {
    const paths = ALL_SHAPES.map((shape) => shapePath(shape));
    expect(new Set(paths).size).toBe(ALL_SHAPES.length);
  });
});

describe("按尺寸缩放", () => {
  it("`shapePath` 传 size 会等比换算坐标,而不是另描一份路径", () => {
    for (const shape of ALL_SHAPES) {
      const full = numbersIn(shapePath(shape, SHAPE_BOX));
      const half = numbersIn(shapePath(shape, SHAPE_BOX / 2));
      expect(half.length).toBe(full.length);
      // 逐个比:半号形状的每个坐标都是原坐标的一半(允许两位小数的取整误差)
      full.forEach((value, i) => {
        expect(Math.abs(half[i] - value / 2)).toBeLessThanOrEqual(0.01);
      });
    }
  });

  it("默认尺寸就是设计盒尺寸", () => {
    for (const shape of ALL_SHAPES) {
      expect(shapePath(shape)).toBe(shapePath(shape, SHAPE_BOX));
    }
  });
});

describe("确定性推导", () => {
  it("同一个 id 永远推出同一个形状 / 图形", () => {
    for (const id of ids(40)) {
      expect(shapeOf(id, RED)).toBe(shapeOf(id, RED));
      expect(glyphOf(id, RED)).toBe(glyphOf(id, RED));
      expect(shapeOf(id, BLACK)).toBe(shapeOf(id, BLACK));
      expect(glyphOf(id, BLACK)).toBe(glyphOf(id, BLACK));
    }
  });

  it("只在本色的子集里取值,且三档都能出得来", () => {
    for (const type of [RED, BLACK] as const) {
      const seenShapes = new Set(ids(200).map((id) => shapeOf(id, type)));
      const seenGlyphs = new Set(ids(200).map((id) => glyphOf(id, type)));
      expect([...seenShapes].sort()).toEqual([...shapesOf(type)].sort());
      expect([...seenGlyphs].sort()).toEqual([...glyphsOf(type)].sort());
    }
  });

  it("形状与图形的推导不共位 —— 3×3 的组合要真的铺开", () => {
    // 两处若读哈希的同一位,「票根」会永远配同一个图形,组合数会塌成 3 种
    const combos = new Set(ids(200).map((id) => `${shapeOf(id, RED)}:${glyphOf(id, RED)}`));
    expect(combos.size).toBeGreaterThanOrEqual(7);
  });

  it("红黑两色的图形命名空间不重叠", () => {
    const red = new Set(glyphsOf(RED));
    for (const glyph of glyphsOf(BLACK)) expect(red.has(glyph)).toBe(false);
  });
});

describe("中心微图标", () => {
  it("六种图形各自闭合、且坐标都落在自己的设计盒内", () => {
    for (const type of [RED, BLACK] as const) {
      for (const glyph of glyphsOf(type)) {
        const d = glyphPath(glyph);
        expect(d.endsWith("Z")).toBe(true);
        for (const value of numbersIn(d)) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThan(GLYPH_BOX);
        }
      }
    }
  });

  it("图形之间互不相同", () => {
    const all = [...glyphsOf(RED), ...glyphsOf(BLACK)].map((glyph) => glyphPath(glyph));
    expect(new Set(all).size).toBe(all.length);
  });

  it("图标占比是 45% —— 32px 贴纸上约 14px,再小就会被读成印刷瑕疵", () => {
    expect(ICON_RATIO).toBeCloseTo(0.45, 5);
    expect(Math.round(SHAPE_BOX * ICON_RATIO)).toBe(14);
  });

  it("`glyphPlacement` 把图形摆在**正中** —— 这是 canvas 那一侧踩过的坑", () => {
    // 曾经只 `translate(size/2, size/2)` 再 `scale`:那是绕原点缩的,图形那 0..24 的坐标
    // 会被当成以中心为原点 → 整块偏到右下角(偏约 size × 0.225)。这里用「左右留白相等」钉死它。
    for (const size of [14, 24, 32, 64]) {
      const { x, y, scale } = glyphPlacement(size);
      const drawn = GLYPH_BOX * scale;
      expect(drawn).toBeCloseTo(size * ICON_RATIO, 6);
      // 左边距 === 右边距,且上下也一样 ⇒ 画出来的方框正落在贴纸中央
      expect(x).toBeCloseTo(size - drawn - x, 6);
      expect(y).toBeCloseTo(size - drawn - y, 6);
    }
    // 32px 贴纸:14.4 的图案,左上角在 8.8
    const at32 = glyphPlacement(SHAPE_BOX);
    expect(at32.x).toBeCloseTo(8.8, 6);
    expect(at32.scale).toBeCloseTo(0.6, 6);
  });
});

describe("单一来源(四处消费不许各描一份)", () => {
  const css = readFileSync(new URL("../src/pages/redblack-parity.css", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/pages/RedBlackPage.tsx", import.meta.url), "utf8");

  it("CSS 里不出现任何硬编码的形状路径", () => {
    // 形状一律经内联变量 `--rb-shape` 进来;CSS 只允许写 `clip-path: var(--rb-shape)`
    expect(css).not.toMatch(/path\(\s*["']?M/);
    expect(css).toContain("var(--rb-shape)");
  });

  it("页面组件里不手写 SVG 路径 —— 图形一律来自 `glyphPath`", () => {
    expect(page).not.toMatch(/d=\{\s*["'`]M/);
  });

  it("`shapeClipVar` 产出的是 CSS 能直接吃的 path() 字面量", () => {
    const value = shapeClipVar("torn");
    expect(value.startsWith('path("M')).toBe(true);
    expect(value.endsWith('")')).toBe(true);
    // 里面必须就是 `shapePath` 的原样输出 —— 中间不许有第二次坐标换算
    expect(value).toBe(`path("${shapePath("torn")}")`);
  });

  it("哈希只有一处实现:形状推导与 `redblack.ts` 共用同一个 `hashOf`", () => {
    // 这条是「不许另写一份差不多的哈希」的机械守卫:同一个 id 的手算结果必须对得上
    expect(shapeOf("s-x-1", RED)).toBe(shapesOf(RED)[hashOf("s-x-1") % 3]);
    expect(shapeOf("s-x-1", BLACK)).toBe(shapesOf(BLACK)[hashOf("s-x-1") % 3]);
  });
});
