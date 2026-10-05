// 贴纸**材质**的单一来源守卫（2026-09-29，PLAN-20260929195500 第三轮）。
//
// 材质有**两个渲染器**：CSS（我贴的那一枚）与 Canvas 2D（群点 sprite / 分享图）。
// 一份配方、两个翻译器，所以两条路径不可能对不上 —— 但 CSS 那一份是
// `sticker-material.ts::materialBackground()` **生成**出来贴进样式表的**副本**
// （不内联的理由见那个函数的说明：300 张卡共用一条规则，内联要复制 300 份）。
//
// 于是这里守着「副本没漂移」：把生成的文本与样式表里的实际文本各自压缩空白后比对。
// ⚠ 压缩空白是必要的：生成器为了可读会换行缩进，而样式表里的换行位置是排版自由 ——
//   真正要钉死的是**每一层的取值与顺序**，不是它们在哪儿断行。
//
// ⚠ 这条守卫的价值在于：材质的偏差**几乎不可能靠人眼发现**
//   （两块都被 32px 的轮廓裁着，颜色还只差几个百分点），而一旦两条路径不一致，
//   展板上「我贴的那枚」与「别人贴的那枚」就会长得不一样 —— 那正是本轮要消灭的东西。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { STICKER_SKIN_KEYS } from "@biff/contracts/sticker";
import {
  STICKER_MATERIAL_LIST,
  materialBackground,
  materialBackgroundSize,
  type StickerMaterial,
} from "../src/sticker-material";
import { STICKER_SIZE } from "../src/sticker-sprite";
import { skinSpec } from "../src/sticker-skin";

/** 把连续空白压成一个空格 —— 只对齐「写了什么」，不对齐换行。 */
function squish(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const css = readFileSync(new URL("../src/pages/redblack-parity.css", import.meta.url), "utf8");
const squishedCss = squish(css);

describe("材质 ↔ 样式表：副本不许漂移", () => {
  it.each(STICKER_MATERIAL_LIST)("`%s` 的 background-image 与样式表逐字一致", (material) => {
    const expected = squish(`--rb-mat: ${materialBackground(material, STICKER_SIZE)};`);
    expect(squishedCss).toContain(expected);
  });

  it.each(STICKER_MATERIAL_LIST)("`%s` 的 background-size 与样式表逐字一致", (material) => {
    const expected = squish(`--rb-mat-size: ${materialBackgroundSize(material, STICKER_SIZE)};`);
    expect(squishedCss).toContain(expected);
  });

  it("每个材质在样式表里都有**自己那条**规则（而不是全都落在同一条上）", () => {
    for (const material of STICKER_MATERIAL_LIST) {
      expect(squishedCss).toContain(`.rb-dot__face[data-rb-material="${material}"] {`);
    }
    // 层数不能全一样到「看起来只有一条规则」——两个材质各自的层数必然不同
    const layerCounts = STICKER_MATERIAL_LIST.map((m) => materialBackground(m, STICKER_SIZE).split("radial-gradient").length + materialBackground(m, STICKER_SIZE).split("repeating-linear-gradient").length);
    expect(new Set(layerCounts).size).toBeGreaterThan(1);
  });

  it("底色的高光经 `--rb-gloss` 代进来，且带 `none` 兜底（否则整条声明会失效、连高光一起丢）", () => {
    expect(squishedCss).toContain("background-image: var(--rb-gloss), var(--rb-mat, none);");
    // 红黑各一条 `--rb-gloss`（透明度不同）
    expect(squishedCss).toMatch(/\.rb-dot--red \.rb-dot__face \{[^}]*--rb-gloss: radial-gradient/);
    expect(squishedCss).toMatch(/\.rb-dot--black \.rb-dot__face \{[^}]*--rb-gloss: radial-gradient/);
  });
});

describe("材质的配方本身", () => {
  it("每个材质都有内容，且互不相同（不能是同一串换个名字）", () => {
    for (const material of STICKER_MATERIAL_LIST) {
      expect(materialBackground(material, STICKER_SIZE).length).toBeGreaterThan(10);
    }
    const all = STICKER_MATERIAL_LIST.map((m) => materialBackground(m, STICKER_SIZE));
    expect(new Set(all).size).toBe(STICKER_MATERIAL_LIST.length);
  });

  it("★ 确定性：同一材质取两次必须**逐字**一样（否则 sprite 每次重建都不一样、缓存失效时会闪）", () => {
    for (const material of STICKER_MATERIAL_LIST) {
      expect(materialBackground(material, STICKER_SIZE)).toBe(materialBackground(material, STICKER_SIZE));
      expect(materialBackgroundSize(material, STICKER_SIZE)).toBe(materialBackgroundSize(material, STICKER_SIZE));
    }
  });

  it("每个材质都被至少一款皮肤用到（没有登记了却没人用的材质）", () => {
    const used = new Set(STICKER_SKIN_KEYS.map((skin) => skinSpec(skin).material));
    for (const material of STICKER_MATERIAL_LIST) expect(used.has(material)).toBe(true);
  });

  it("几何全落在 32 设计盒里（超出盒子的层会被轮廓裁掉，等于白写）", () => {
    // 逐层解析生成结果：出现的 px 坐标/半径都不该超过盒子。
    // ⚠ 留 0.05 的余量给「两位小数取整」：配方里已经按「中心 + 半径 ≤ 32」夹过一次，
    //   四舍五入可能把它顶出去万分之几 —— 那不是真越界。
    for (const material of STICKER_MATERIAL_LIST) {
      for (const value of materialBackground(material, STICKER_SIZE).match(/([\d.]+)px/g) ?? []) {
        expect(Number.parseFloat(value)).toBeLessThanOrEqual(32.05);
      }
    }
  });

  it("只有平铺圆点需要 background-size；其余材质回 `auto` 而不是一串 auto", () => {
    const dotted: StickerMaterial[] = ["grain"];
    for (const material of STICKER_MATERIAL_LIST) {
      const size = materialBackgroundSize(material, STICKER_SIZE);
      // ⚠ 小数也要认:配方按 32 设计盒写,换算到实际贴纸尺寸(24)后就是小数
      if (dotted.includes(material)) expect(size).toMatch(/^\d+(\.\d+)?px \d+(\.\d+)?px/);
      else expect(size).toBe("auto");
    }
  });
});
