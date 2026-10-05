// 贴纸**皮肤体系**（2026-09-29，第三轮）。
//
// 本文件收的是「上一轮按颜色分的形状 / 图标族」那条口径 —— 现在**红黑共用同一套皮肤**
// （用户原话「只是红色跟黑色的区别」），所以断言从「红族与黑族互不重叠」变成了
// 「两个颜色拿到的是同一张表」，而「表登记得全不全」由 TypeScript 的
// `Record<StickerSkin, SkinSpec>` 在编译期保证（这里再在运行期钉一遍）。
//
// ⚠ 库里的 id 与中文名在 `@biff/contracts/sticker`（前后端唯一来源）；本文件只测**外观**那一侧。

import { STICKER_SKIN_KEYS, isStickerSkin } from "@biff/contracts/sticker";
import { describe, expect, it } from "vitest";

import { ALL_SHAPES } from "../src/sticker-shape";
import { ALL_GLYPHS } from "../src/sticker-glyph";
import { STICKER_MATERIAL_LIST } from "../src/sticker-material";
import { ALL_SKINS, FALLBACK_SKIN, derivedSkin, resolveSkin, skinSpec } from "../src/sticker-skin";
import { hashOf } from "../src/redblack";

describe("皮肤的登记表", () => {
  it("契约层有几款，这里就有几款（不多不少）", () => {
    expect([...ALL_SKINS].sort()).toEqual([...STICKER_SKIN_KEYS].sort());
  });

  it("每款都有完整的轮廓 / 图标 / 材质，且三样都在白名单里", () => {
    for (const skin of ALL_SKINS) {
      const spec = skinSpec(skin);
      expect(ALL_SHAPES).toContain(spec.shape);
      // ⚠ `none`（留空）**不在** `ALL_GLYPHS` 里：它不是「一个图形」，而是「这一款不印图形」。
      //    2026-10-05 缩到三款后没有哪一款留空了（上一轮用它的场记板已下线），
      //    但这条口径仍然成立 —— 断言留着，免得将来加回留空款时静默传过。
      expect(spec.glyph === "none" || ALL_GLYPHS.includes(spec.glyph)).toBe(true);
      expect(STICKER_MATERIAL_LIST).toContain(spec.material);
    }
  });

  it("★ 红黑共用同一套皮肤 —— 「只是红色跟黑色的区别」", () => {
    // 这条是上一轮「红族 / 黑族各一套形状」的反面：同一个款没有颜色一说，
    // 所以「哪款配哪个图形」也不能有任何只在某一色下才成立的寓意。
    for (const skin of ALL_SKINS) {
      // 同一款取两次必须是同一份（不存在「红版 / 黑版」）
      expect(skinSpec(skin)).toBe(skinSpec(skin));
    }
    // 各款的轮廓互不相同、图标也互不相同（否则并排看像复制粘贴）
    const shapes = ALL_SKINS.map((skin) => skinSpec(skin).shape);
    const glyphs = ALL_SKINS.map((skin) => skinSpec(skin).glyph);
    expect(new Set(shapes).size).toBe(ALL_SKINS.length);
    expect(new Set(glyphs).size).toBe(ALL_SKINS.length);
  });

  it("兜底款在白名单里（契约层定的那个）", () => {
    expect(isStickerSkin(FALLBACK_SKIN)).toBe(true);
    expect(ALL_SKINS).toContain(FALLBACK_SKIN);
  });
});

describe("取款：存了的用它，没存的按 id 兜底", () => {
  it("★ 存了且合法 → 用它", () => {
    expect(resolveSkin("s-anything", "sprocket")).toBe("sprocket");
    expect(resolveSkin("s-anything", "stub")).toBe("stub");
  });

  it("★ 没存 / 存了脏值 → 按 id 兜底（不崩、不静默变成某一款）", () => {
    for (const junk of [undefined, null, "", "nope", "STUB", 42 as unknown as string]) {
      expect(resolveSkin("s-x", junk)).toBe(derivedSkin("s-x"));
    }
  });

  it("兜底是**确定性**的：同一个 id 永远同一款（刷新 / 换设备 / 分享图都稳定）", () => {
    for (const id of ["cat:f001#crowd-0", "cat:f001#crowd-1", "cat:f007#crowd-9", "s-x-1"]) {
      expect(derivedSkin(id)).toBe(derivedSkin(id));
    }
  });

  it("兜底会在各款之间铺开（不是永远落在同一款上）", () => {
    const seen = new Set(
      Array.from({ length: 200 }, (_, i) => derivedSkin(`cat:f001#crowd-${i}`)),
    );
    expect([...seen].sort()).toEqual([...ALL_SKINS].sort());
  });

  it("兜底确实读了哈希（与 `hashOf` 同源，不是另一份实现）", () => {
    const id = "s-x-1";
    expect(derivedSkin(id)).toBe(ALL_SKINS[hashOf(id) % ALL_SKINS.length]);
  });
});
