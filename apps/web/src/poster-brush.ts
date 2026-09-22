/**
 * 分享图的**共用笔刷**(2026-09-22)。
 *
 * 为什么单独成文件:这个应用现在有**两张**对外出图的分享图 —— 「看片计划海报」(`poster.ts`)与
 * 「红黑榜分享图」(`redblack-poster.ts`)。配色、圆角、字体、超采样、品牌红条这些必须**只有一份**,
 * 否则同一个应用出的两张图会长得不像一家人(§5 口径单一来源)。
 *
 * ⚠ 这里只放**两张图都用得上**的东西;只有看片计划海报用的(日期分节、海报缩略图、GV 胶囊、
 *   行高等)仍留在 `poster.ts`。
 * ⚠ import 期不碰 DOM:本模块是纯常量与纯函数(`posterBlob` 只在被调用时才碰 canvas),
 *   可以被 node 环境的单测安全 import。
 */

/** 逻辑宽度 —— 分享图按 1080 宽出图(微信 / 相册长图的常规宽度),再按 `SCALE` 超采样取像素。 */
export const POSTER_W = 1080;
/** 超采样倍率:逻辑 1px = 2 物理像素(视网膜屏上文字与描边不糊)。 */
export const SCALE = 2;
/** 长图退档阈值(逻辑高)—— 画布**单边上限 32767**,超过就回 1×。
 *  ⚠ `toBlob` 超限时**静默出空图**(不抛错,最难查),所以宁可降清晰度也不能让画布过界。 */
export const SCALE_DOWN_H = 8000;

/** 左右内距 */
export const PAD = 56;
/** 顶部 / 底部品牌红条的高度 */
export const ACCENT_H = 10;
/** 页脚区高度 */
export const FOOTER_H = 104;

/** 分享图**固定深色** —— 不跟随应用主题:分享图是对外成品,深底 + 品牌红在聊天流里辨识度最高,
 *  且亮 / 暗两种应用外观下出图一致(否则同一份内容在不同人手里长得不一样)。 */
export const COLORS = {
  bg: "#101013",
  card: "#1a1a21",
  line: "#2b2b33",
  ink: "#f4f4f6",
  ink2: "#c7c7d0",
  muted: "#8a8a95",
  red: "#ce1e36",
  red2: "#e8455c",
  note: "#e2b667",
  gvBg: "#2b2b35",
  gvInk: "#f2a6b2",
  /** 「黑贴纸」在**深底海报**上的填充色。
   *  ⚠ 不能照搬页面的 `--rb-black`:那是给浅底画布配的深色,而海报**恒为深底**
   *    (`bg: #101013`),直接用会变成「一枚看不见的黑点」。改成比底色亮一档的深灰,
   *    再由绘制方补一圈亮边,才读得出「这是一枚黑贴纸」。 */
  stickerBlack: "#3a3a45",
};

/** 字体栈与页面同族(中文优先 PingFang / 微软雅黑,拉丁走 system-ui)。 */
export const FONT =
  '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif';

export function posterFont(size: number, weight: number): string {
  return `${weight} ${size}px ${FONT}`;
}

/** 圆角矩形路径 —— 手写 `arcTo` 而不依赖 `ctx.roundRect`(兼容性最稳,行为完全确定)。 */
export function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 单行截断:超出 `maxW` 时尾部补「…」(画布没有 CSS 的 text-overflow)。 */
export function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let out = "";
  for (const ch of text) {
    if (ctx.measureText(out + ch + "…").width > maxW) break;
    out += ch;
  }
  return out ? `${out}…` : "…";
}

/** 上下两条品牌红条(渐变同顶栏按钮)—— 两张分享图的共同外框。 */
export function drawAccentBars(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const bar = ctx.createLinearGradient(0, 0, w, 0);
  bar.addColorStop(0, COLORS.red);
  bar.addColorStop(1, COLORS.red2);
  ctx.fillStyle = bar;
  ctx.fillRect(0, 0, w, ACCENT_H);
  ctx.fillRect(0, h - ACCENT_H, w, ACCENT_H);
}

/** 一条水平分隔线 */
export function drawRule(ctx: CanvasRenderingContext2D, y: number, w: number): void {
  ctx.fillStyle = COLORS.line;
  ctx.fillRect(PAD, y, w, 1);
}

/** 画布 → PNG Blob(`toBlob` 回调式,包一层 Promise)。 */
export function posterBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}
