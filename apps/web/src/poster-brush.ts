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
/** 画布**单边**上限(物理像素)—— 浏览器硬限 32767,超了 `toBlob` 静默出空图(不抛错,最难查)。
 *  ⚠ 2026-10-08 起它不再以「逻辑高超过 8000 就回 1×」那种**一刀切**的形式出现(那会把很长的图
 *    直接砍到 1×),而是并进 `posterScale` 的连续倍率里一起算。 */
export const MAX_SIDE = 32767;
/** 画布**面积**上限(物理像素)—— 除了单边 32767,还有一条没人踩过就想不到的:
 *  **iOS Safari 的单张画布面积上限约 16.7M px**,超了同样**静默出空图**。
 *  取 16M 留一点余量(保守取值)。⚠ 这条是 2026-09-22 加「红黑榜分享图」时才补的:
 *  1080×2 = 2160 宽,只要逻辑高超过 ~3700(约 20 场),2× 就已经越线 ——
 *  而当时那条「逻辑高 8000 回 1×」拦不住它,于是「长行程的分享图在 iPhone 上是一张空图」。 */
export const MAX_PIXELS = 16_000_000;

/** 按图的大小决定超采样倍率 —— 在两条硬上限内**取到最大的那个倍率**,而不是在 2× / 1× 之间二选一。
 *
 * ⚠ 为什么必须是连续值(2026-10-08,用户「分享图需要高清一点,因为加上了海报」):
 *   红黑榜分享图三榜各 TOP10 + 「我贴过的」十几行 ≈ 6900 逻辑高,2× 要 2160×13800 ≈ **29.8M px**,
 *   远超 16M —— 旧写法于是**直接掉回 1×**,海报缩略图只剩 59px 物理宽,加上海报后糊得最明显。
 *   按面积反算能取到 √(16M / 1080×6900) ≈ **1.45×**(物理宽 1566,海报约 86px),
 *   而两条上限一个都不越 —— 这是「更清楚」与「不越界出空图」之间唯一不赌机型的写法。
 * ⚠ 下限是 1:倍率小于 1 只会让图变小变糊,不如老实按原尺寸出。
 *   **代价写明**:逻辑高超过约 3 万时(≈285 行,190 场那种量级),即使 1× 本身也已经越过 16M 面积
 *   上限 —— 那一档没有解,只能与旧写法一样按 1× 出。这不是本函数新引入的洞,如实记着。
 * ⚠ **不要**改成「先按 2× 出、失败再回退」:iOS 超限是**静默出空图**(既抛不出错,也拿不到
 *   可判定的失败信号),没有可靠的回落触发点。 */
export function posterScale(logicalWidth: number, logicalHeight: number): number {
  const width = Math.max(1, logicalWidth);
  const height = Math.max(1, logicalHeight);
  const safe = Math.min(
    SCALE,
    Math.sqrt(MAX_PIXELS / (width * height)),
    MAX_SIDE / Math.max(width, height),
  );
  return Math.max(1, safe);
}

/** 逻辑尺寸 → 画布的**物理像素**与倍率。
 *
 * ⚠ 取整只允许在这一处:画布尺寸、绘制用的变换、以及界面上那句「这张长图 W × H px」必须同源 ——
 *   倍率现在是连续值(见 `posterScale`),三处各写一次取整迟早对不上。
 * ⚠ 取整一律**向下**:两条上限是「越了就是空图」那种硬约束,四舍五入会把恰好贴着上限的图顶破
 *   (实测 1080×6900 四舍五入后 1583 × 10111 = 16.01M > 16M)。
 * ⚠ 绘制那侧**不要**直接用浮点 `scale` 做 `ctx.scale`:画布宽高取了整,直接用浮点倍率会在
 *   右下角留下一条不足 1px 的透明缝(深底图上就是一条亮线)。用 `width / logicalWidth`
 *   这两个比值当变换,内容就正好铺满。 */
export function posterPixels(
  logicalWidth: number,
  logicalHeight: number,
): { width: number; height: number; scale: number } {
  const scale = posterScale(logicalWidth, logicalHeight);
  return {
    scale,
    width: Math.floor(logicalWidth * scale),
    height: Math.floor(logicalHeight * scale),
  };
}

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
  /** 「贴纸中心微图标」在深底海报上的墨色(2026-09-29,PLAN-20260929195500)。
   *  ⚠ 与 `ink` 同值但**含义不同**:`ink` 是正文色,这一枚跟着**贴纸**走 ——
   *    将来把正文调暗/调暖时,不该顺手把贴纸上的图案也一起改掉。
   *    红贴(`red`)与黑贴(`stickerBlack`)在深底上都用这一档白,两处都不必再分色。 */
  stickerInk: "#f4f4f6",
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

/** 加载分享图要用的影片海报 —— **失败即静默跳过**(缺图走占位块,不能让一张图挂掉整张海报)。
 *  同源图片不会污染画布,`toBlob` 依旧可用。
 *
 *  ⚠ 从 `poster.ts` 迁来这里(2026-10-08):红黑榜分享图也开始画海报缩略图,两张图必须共用
 *    同一份加载语义(§5 口径单一来源)。
 *  ⚠ import 期不碰 DOM —— 只在**调用时**才 `new Image()`,所以本模块仍可被 node 单测安全 import。 */
export function loadPosterImages(urls: string[]): Promise<Map<string, HTMLImageElement>> {
  const out = new Map<string, HTMLImageElement>();
  const tasks = [...new Set(urls)].map(
    (u) =>
      new Promise<void>((resolve) => {
        const img = new Image();
        img.decoding = "async";
        img.onload = () => {
          out.set(u, img);
          resolve();
        };
        img.onerror = () => resolve();
        img.src = u;
      }),
  );
  return Promise.all(tasks).then(() => out);
}
