/**
 * 贴纸**中心微图标**的注册表(2026-09-29,PLAN-20260929195500)。
 *
 * 用户原话:「红贴纸保持红色圆点,但在圆点正中央掏空/印上一个白色的极简五角星/胶片齿孔/心形;
 * 黑贴纸中央印一个灰白色的极简叉号/闪电/散场箭头」。这一层就是那些图形。
 *
 * ⚠ 与 `sticker-shape.ts` 同一套约定:图形**只用一个表达** —— SVG path 的 `d` 字符串,
 *   同时喂内联 `<svg>`(我贴的那一枚)与 `new Path2D(d)`(canvas sprite / 分享图)。
 *
 * ⚠ 设计盒是 **24×24**(不是形状的 32):图形四边各留 2~3 单位的安全边,消费端按
 *   `图形边长 = 贴纸边长 × ICON_RATIO` 换算缩放,不要改这里的坐标去迁就某个尺寸。
 *
 * ⚠ 纯常量 + 纯函数,**import 期不碰 DOM**。
 */

/** 中心微图标的图形族。
 *  ⚠ **必须颜色中立**（用户口径:红黑共用同一套皮肤,「只是红色跟黑色的区别」）——
 *    所以这里**没有** `cross`(叉号 / 避雷那类负面图形)、也没有任何「只在黑贴上才成立」的寓意:
 *    同一款皮肤两个颜色都会用到,图案的褒贬会让另一色读起来自相矛盾。 */
export type StickerGlyph = "star" | "heart" | "hole" | "bolt" | "exit";

/** 图形的设计盒边长(见文件头说明)。 */
export const GLYPH_BOX = 24;

/** 图形边长占贴纸边长的比例。
 *  ⚠ 0.45 是「32px 下仍读得出是个符号、而不是一粒噪点」的下限附近:
 *    32 × 0.45 ≈ 14.4px,再小就该被认成印刷瑕疵了。 */
export const ICON_RATIO = 0.45;

/** 图形 → path `d`(24×24 盒,坐标写死即可:缩放交给消费端)。 */
const GLYPHS: Record<StickerGlyph, string> = {
  // 五角星:外接圆 r=10、内接圆 r=4.2,十个顶点按 -90° 起算交替取半径
  star: "M12 2 L14.47 8.6 L21.51 8.91 L15.99 13.3 L17.88 20.09 L12 16.2 L6.12 20.09 L8.01 13.3 L2.49 8.91 L9.53 8.6 Z",
  // 心形:上方两个对称的圆瓣 + 下方收成尖
  heart:
    "M12 21 C12 21 3 15.2 3 9.4 C3 5.9 5.8 3.4 8.8 3.4 C10.5 3.4 11.5 4.3 12 5.2 " +
    "C12.5 4.3 13.5 3.4 15.2 3.4 C18.2 3.4 21 5.9 21 9.4 C21 15.2 12 21 12 21 Z",
  // 胶片圆孔:一个实心圆(最小、最抽象的那一档,专门给「不想读出具体图案」的场合)
  hole: "M5 12 A7 7 0 1 0 19 12 A7 7 0 1 0 5 12 Z",
  // 闪电:自上而下折三道
  bolt: "M13.6 2 L5.4 13.4 L10.4 13.4 L9.2 22 L18.6 9.8 L13.2 9.8 Z",
  // 散场箭头:一根粗横杆 + 一个指向右的实心三角
  exit: "M4 10 L13 10 L13 6 L21 12 L13 18 L13 14 L4 14 Z",
};

/** 全部图形。⚠ 与形状同理：2026-09-29 起**不再按颜色分子集** ——
 *  「哪款皮肤配哪个图形」在 `sticker-skin.ts`（那里是皮肤体系的唯一入口）。 */
export const ALL_GLYPHS: readonly StickerGlyph[] = ["star", "heart", "hole", "bolt", "exit"];

/** 图形 → path `d`。 ⚠ 图形**不做尺寸换算** —— 它的盒是固定的 24,缩放由消费端做
 *  (DOM 走 `<svg viewBox>`,canvas 走 `ctx.scale`)。这样图形本身没有第二个尺寸口径。 */
export function glyphPath(glyph: StickerGlyph): string {
  return GLYPHS[glyph];
}

/** 把 `GLYPH_BOX` 那一份图形画进 `size` 方格里时,**左上角该摆在哪、缩放多少**。
 *
 *  ⚠ 抽成纯函数是因为它真踩过一次(2026-09-29,截图取证时才发现):`ctx.scale` 是**绕原点**缩的,
 *    若只 `translate(size/2, size/2)` 再 `scale`,图形那 `0..24` 的坐标会被当成「以中心为原点」
 *    → 整块图案偏到**右下角**(实测偏约 `size × 0.225` ≈ 7px)。当时 DOM 那条路径(DOM 靠
 *    `viewBox` + `margin:auto` 居中)是对的,**只有 canvas 那两条错** —— 单测与 E2E 全绿,
 *    因为它们只验证了「节点在、路径一致」,没验证「画在哪」。
 *  ⚠ 所以这里把式子定成唯一一份,**三处 canvas 消费端(sprite / 分享图两处)都走它**。 */
export function glyphPlacement(size: number): { x: number; y: number; scale: number } {
  const scale = (size * ICON_RATIO) / GLYPH_BOX;
  const offset = (size - GLYPH_BOX * scale) / 2;
  return { x: offset, y: offset, scale };
}


