/**
 * 贴纸的**本体**（2026-09-29）：异形轮廓 + 沿轮廓的内描边 + 中心微图标 + 材质标记。
 *
 * 为什么抽成组件：`.rb-dot` 有**两个**绘制点 —— 卡片上那枚可拖可点的 `<button>`
 * (`RedBlackPage.tsx::RbCard`)与只读展示里那个 `<span>`。两者必须**长得一模一样**，
 * 而外形恰好是四条渲染路径里最容易漏掉一条的那部分 —— 所以本体只能有一处实现。
 *
 * ⚠ 它只收一个 **`skin`**（而不是松散的 shape + glyph）：一款皮肤 = 轮廓 + 材质 + 图标，
 *   整套绑定。让调用方自己拆开传，等于把「哪款配哪个图形」的知识复制到每个调用点。
 * ⚠ 两条 SVG 路径都来自 `sticker-shape.ts` / `sticker-glyph.ts` 的**同一个函数**，
 *   这里**不允许**出现任何字面量 `d`（`tests/sticker-shape.test.ts` 会机械守住）。
 * ⚠ 底色与材质仍在 CSS（`.rb-dot--red/black` 的底色 + `[data-rb-material]` 的材质层），
 *   因为那几层是 `background-image` 渐变 —— 搬进 SVG 就得给每个实例配一套 pattern id，
 *   而 id 是全局的，近 300 张卡会互相抢。分工：形状与图标走 SVG，CSS 只管底色与光效。
 */

import type { CSSProperties } from "react";
import { GLYPH_BOX, ICON_RATIO, glyphPath } from "../sticker-glyph";
import { SHAPE_BOX, shapeClipVar, shapePath } from "../sticker-shape";
import { skinSpec, type StickerSkin } from "../sticker-skin";
// ⚠ 贴纸边长从 `sticker-sprite.ts` 取(**全站唯一口径**),不在这里另写一个数。
//   它有两个用处:① `clip-path: path()` 是**绝对 px**、必须按实际尺寸生成;
//   ② 材质那段 CSS 也是按实际尺寸换算的(`materialBackground`)。
//   两个都由尺寸派生 —— 自己写一个 24 就等于多了一处口径。
import { STICKER_SIZE } from "../sticker-sprite";

interface StickerFaceProps {
  skin: StickerSkin;
}

export function StickerFace({ skin }: StickerFaceProps) {
  const spec = skinSpec(skin);
  // 边长由 `ICON_RATIO` 算出来,**不写在 CSS 里** —— 否则「图标占贴纸多少」就有两处口径,
  // 而 canvas 那两侧(sprite / 分享图)读的是同一个常量,迟早对不上。
  const iconSize = `${ICON_RATIO * 100}%`;
  return (
    // 这一层带 `clip-path: var(--rb-shape)`,**它会连子元素一起裁** ——
    // 所以下面那条 2px 的描边只剩内侧一像素,微图标也不会探出轮廓。
    // `data-rb-material` 交给 CSS 选材质层(CSS 里只写数值配方,不出现路径)。
    <span
      className="rb-dot__face"
      data-rb-material={spec.material}
      // ⚠ `data-rb-glyph` 交给 CSS 选**图标墨色**:挂在这一层而不是 `.rb-dot`,
      //   因为图标是「款」的属性,这一层正是「款长什么样」的边界。
      //   ⚠ 2026-10-05 金棕榈下线后 CSS 里那条按图标覆写墨色的规则也删了,这个属性**仍然留着** ——
      //     将来若再出现一款不跟纸色走的图标,规则挂这一层即可(不必回头改组件)。
      data-rb-glyph={spec.glyph}
      // ⚠ 轮廓按**实际贴纸尺寸**生成:`clip-path: path()` 是绝对 px、不随元素缩放
      //   (SVG 的 `viewBox` 才会缩放,两者不是一回事)。传错尺寸不会报错,
      //   只会**静默地**把贴纸裁成右上角一小块 —— 所以 `shapeClipVar` 的尺寸是必填参数。
      style={{ "--rb-shape": shapeClipVar(spec.shape, STICKER_SIZE) } as CSSProperties}
    >
      <svg className="rb-dot__edge" viewBox={`0 0 ${SHAPE_BOX} ${SHAPE_BOX}`} aria-hidden="true">
        <path d={shapePath(spec.shape)} />
      </svg>
      <svg
        className="rb-dot__icon"
        viewBox={`0 0 ${GLYPH_BOX} ${GLYPH_BOX}`}
        style={{ width: iconSize, height: iconSize }}
        aria-hidden="true"
      >
        <path d={glyphPath(spec.glyph)} />
      </svg>
    </span>
  );
}
