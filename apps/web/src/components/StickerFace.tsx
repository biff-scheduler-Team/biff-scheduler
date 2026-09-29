/**
 * 贴纸的**本体**(2026-09-29,PLAN-20260929195500):异形轮廓 + 沿轮廓的内描边 + 中心微图标。
 *
 * 为什么抽成组件:`.rb-dot` 有**两个**绘制点 —— 卡片上那枚可拖可点的 `<button>`
 * (`RedBlackPage.tsx::RbCard`)与「放大看全部」弹层里那枚只读的 `<span>`
 * (`StickerZoomDialog.tsx`)。两者必须**长得一模一样**(弹层的说明明写着「位置与卡片上一致」),
 * 而外形恰好是四条渲染路径里最容易漏掉一条的那部分 —— 所以本体只能有一处实现。
 *
 * ⚠ 两条 SVG 路径都来自 `sticker-shape.ts` / `sticker-glyph.ts` 的**同一个函数**,
 *   这里**不允许**出现任何字面量 `d`(`tests/sticker-shape.test.ts` 会机械守住)。
 * ⚠ 外层的底色 / 质感仍在 CSS(`.rb-dot--red` / `--black` 下的 `.rb-dot__face`),
 *   因为那三层是 `background-image` 渐变 —— 搬进 SVG 就得给每个实例配一套 pattern / gradient id,
 *   而 id 是全局的,近 300 张卡会互相抢。分工:形状与图标走 SVG,CSS 只管底色与光效。
 */

import { GLYPH_BOX, ICON_RATIO, glyphPath, type StickerGlyph } from "../sticker-glyph";
import { SHAPE_BOX, shapePath, type StickerShape } from "../sticker-shape";

interface StickerFaceProps {
  shape: StickerShape;
  glyph: StickerGlyph;
}

export function StickerFace({ shape, glyph }: StickerFaceProps) {
  // 边长由 `ICON_RATIO` 算出来,**不写在 CSS 里** —— 否则「图标占贴纸多少」就有两处口径,
  // 而 canvas 那两侧(sprite / 分享图)读的是同一个常量,迟早对不上。
  const iconSize = `${ICON_RATIO * 100}%`;
  return (
    // 这一层带 `clip-path: var(--rb-shape)`(由调用方写成内联变量),
    // **它会连子元素一起裁** —— 所以下面那条 2px 的描边只剩内侧一像素,正是要的效果。
    // 也正是这一层的 `clip-path` 顺带把微图标裁在轮廓内(胶片残片那种窄条形状比图标矮)。
    <span className="rb-dot__face">
      <svg className="rb-dot__edge" viewBox={`0 0 ${SHAPE_BOX} ${SHAPE_BOX}`} aria-hidden="true">
        <path d={shapePath(shape)} />
      </svg>
      <svg
        className="rb-dot__icon"
        viewBox={`0 0 ${GLYPH_BOX} ${GLYPH_BOX}`}
        style={{ width: iconSize, height: iconSize }}
        aria-hidden="true"
      >
        <path d={glyphPath(glyph)} />
      </svg>
    </span>
  );
}
