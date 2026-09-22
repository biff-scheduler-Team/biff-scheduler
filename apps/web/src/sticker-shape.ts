/**
 * 贴纸的**形状路径**(2026-09-22)。
 *
 * 为什么单独抽出来:同一个形状现在有**三处**要用 ——
 *  ① `redblack-parity.css` 的 `.rb-dot`(`border-radius: 48% 52% 45% 55% / 52% 46% 54% 48%`);
 *  ② `sticker-sprite.ts` 把它预渲染成离屏 sprite(卡片画布上的群点);
 *  ③ `redblack-poster.ts` 分享图里那几枚小贴纸。
 * ②③ 必须用**同一条路径**,否则分享图上的「贴纸」和页面上长得不一样。
 * ⚠ ①②③ 三处是同一个形状的三种表达(它们是 CSS 值、canvas 路径、canvas 路径),
 *   改任何一处都要同步另外两处 —— 这里是唯一可以共享的那两份(②③)。
 * ⚠ 纯函数,import 期不碰 DOM:可以被 node 单测 import。
 */

/** 不规则圆片路径 —— 四角各用一对椭圆半径,对应 CSS 的
 *  `border-radius: 48% 52% 45% 55% / 52% 46% 54% 48%`:
 *  横向半径(tl,tr,br,bl)= 48% / 52% / 45% / 55%,纵向半径 = 52% / 46% / 54% / 48%。 */
export function blobPath(ctx: CanvasRenderingContext2D, size: number): void {
  const tlx = 0.48 * size;
  const tly = 0.52 * size;
  const trx = 0.52 * size;
  const trY = 0.46 * size;
  const brx = 0.45 * size;
  const brY = 0.54 * size;
  const blx = 0.55 * size;
  const blY = 0.48 * size;
  const half = Math.PI / 2;

  ctx.beginPath();
  ctx.moveTo(tlx, 0);
  ctx.lineTo(size - trx, 0);
  ctx.ellipse(size - trx, trY, trx, trY, 0, -half, 0);
  ctx.lineTo(size, size - brY);
  ctx.ellipse(size - brx, size - brY, brx, brY, 0, 0, half);
  ctx.lineTo(blx, size);
  ctx.ellipse(blx, size - blY, blx, blY, 0, half, Math.PI);
  ctx.lineTo(0, tly);
  ctx.ellipse(tlx, tly, tlx, tly, 0, Math.PI, Math.PI + half);
  ctx.closePath();
}
