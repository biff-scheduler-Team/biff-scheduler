/**
 * 贴纸的**离屏 sprite** 预渲染(2026-09-22,PLAN-20260922145815;2026-09-29 扩形状族)。
 *
 * 画布上一张卡可能有上百枚贴纸,每枚都现场构造渐变 = 上百次 `createLinearGradient` /
 * `createRadialGradient`,那才是 canvas 里最贵的一步。贴纸只有红 / 黑两种底、样子完全一样,
 * 所以**每种按 dpr 各画一次**存进离屏画布,之后每枚只做 `drawImage`。
 *
 * ⚠ 形状与质感必须与 `redblack-parity.css` 里的 `.rb-dot` **逐字对应**
 *   (用户 2026-09-22 选的是「预渲染 sprite,视觉几乎不变」):
 *   · 尺寸 32×32(`STICKER_SIZE`;2026-09-28 曾由 26 缩到 20,2026-09-29 又按用户要求放大到 32
 *     —— 为的是让**中心微图标**在卡片上读得出来);
 *   · 轮廓 —— 由 `sticker-shape.ts` 的**形状族**给出(`torn` / `stub` / `sprocket` / `scrap` / `reel`),
 *     不再是一条固定的 border-radius;
 *   · 三层外落影 + 一层内描边(`inset 0 0 0 1px rgb(255 255 255 / 18%)`);
 *   · 红 / 黑各一层斜向细条纹(115°,周期 3px)+ 一枚径面高光(圆心 34% / 28%);
 *   · 中心微图标由 `sticker-glyph.ts` 给出,占贴纸边长 `ICON_RATIO`。
 *   颜色**只从 CSS token 读**(`--rb-red` / `--rb-black` / `--rb-icon-*`),这里绝不另写一份十六进制。
 */

import type { StickerType } from "./redblack";
import { glyphPath, glyphPlacement, type StickerGlyph } from "./sticker-glyph";
// 轮廓与分享图(`redblack-poster.ts`)、CSS(内联 `--rb-shape`)共用同一条路径 —— 四处表达
// 都从 `sticker-shape.ts` 取,不要在这里另描一份。
import { shapePath2D, type StickerShape } from "./sticker-shape";

/** 贴纸边长(CSS px)。⚠ 必须与 `.rb-dot` 的 `width` / `height` 一致。
 *
 * ⚠ 2026-09-28 由 26 缩到 20(PLAN-20260928003736,为了「容纳更多」);
 *   2026-09-29 又回到 **32**(PLAN-20260929195500):用户要的是「像实体贴纸」——
 *   异形轮廓 + 中心微图标在 20px 下完全糊成一粒点。代价已明示并接受:
 *   卡片画布约 176px 高,32px 时纵向只铺得下 5 行(20px 是 8 行)。 */
export const STICKER_SIZE = 32;

/** sprite 四周给落影留的余量(CSS px)。
 *
 * ⚠ 这是**绝对尺寸**、**刻意不随贴纸大小缩放**:它算的是落影往外铺多远 ——
 *   第三层是 `offsetY 3px + blur 7px`,向外约 10px,所以留 12。
 *   (2026-09-29:落影由两层加到三层,本值随之由 8 提到 12;跟着贴纸等比缩会把最外层裁掉一条边。) */
export const SPRITE_PAD = 12;

/** 外落影三层(`box-shadow` 的后三条)—— 近层收边、中层过渡、远层扩散。
 *  三层是「贴纸有厚度」与「扁平阴影」的分界;两层会读成单纯的下投影。 */
const SHADOWS: ReadonlyArray<readonly [offsetY: number, blur: number, color: string]> = [
  [1, 1, "rgba(0, 0, 0, 0.18)"],
  [2, 3, "rgba(0, 0, 0, 0.14)"],
  [3, 7, "rgba(0, 0, 0, 0.1)"],
];

/** 红 / 黑各自的径面高光强度 —— 与 CSS 里 `.rb-dot--red` / `--black` 的 0.14 / 0.10 一致 */
const HIGHLIGHT: Record<StickerType, number> = { red: 0.14, black: 0.1 };

export interface StickerSprite {
  /** 离屏画布(物理像素,边长 = (32 + 2×12) × dpr) */
  canvas: HTMLCanvasElement;
  /** 贴纸**中心**到 sprite 中心的偏移(CSS px)—— `drawImage` 时用来从中心反推左上角 */
  pad: number;
}

const cache = new Map<string, StickerSprite>();

/** 「样式表还没生效」这一种意外用的中性灰 —— 一眼能看出不对 */
const FALLBACK = "#8b8b8b";

/** 贴纸用到的全部颜色,**一起读、一起失效**:底色的红黑、微图标的两种墨色。 */
interface Palette {
  base: Record<StickerType, string>;
  icon: Record<StickerType, string>;
}

let palette: Palette | null = null;

/* ---------------- 外观失效(2026-09-28,PLAN-20260928003736) ----------------
 * 要挡的是什么:`palette` 与 `cache` 都是模块级单例、**只在首次读取**,而读失败时还会兜底成中性灰
 * `#8b8b8b`(样式表还没生效的那一瞬)。也就是说那次读到的值会**永久生效** —— 之后 token 怎么变
 * 都不会再读一次。
 *
 * ⚠ **诚实记录(2026-09-28 核实)**:`--rb-red` / `--rb-black` 目前只在 `redblack-parity.css` 的
 *   `:root` 定义一次、**没有任何暗色覆盖**,所以切主题时贴纸颜色本来就**不会变** —— 这一条不是
 *   在修一个用户可见的 bug。它收的是上面那个脆弱点:`style.css` 的 `:root[data-theme="dark"]`
 *   已经覆盖了几十个 token,给贴纸补一档是很自然的下一步,届时这里一行都不用再改。
 *
 * ⚠ 监听 `data-theme` 属性而不是 `prefers-color-scheme`:应用主题由根元素属性标记
 *   (`state.ts` 的主题切换),系统偏好只是它的默认值之一。
 * ⚠ 光清缓存**不够**:画布的重绘守护比较的是尺寸与票数,它看不见 token 变化 —— 已经画下去的像素
 *   不会自己变色。所以还要通知订阅者重画(`onSpriteInvalidate`),并把 `spriteEpoch()` 并进
 *   `DrawKey`(见 `sticker-canvas-guard.ts`)。 */
let epoch = 0;
const listeners = new Set<() => void>();

function invalidate(): void {
  palette = null;
  cache.clear();
  epoch += 1;
  for (const cb of listeners) cb();
}

/** 订阅「已画好的贴纸外观作废了」,返回退订函数。画布靠它触发一次重绘。 */
export function onSpriteInvalidate(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 当前的「贴纸外观版本」—— 主题每切一次 +1。
 *  ⚠ 画布必须把它并进重绘判据:主题切换时尺寸与票数一个都没动,只看那些参数会被判成「不用重画」。 */
export function spriteEpoch(): number {
  return epoch;
}

/** 惰性挂主题监听(第一次真要读颜色时才装):既不在 import 期碰 DOM(本模块要被 node 单测 import),
 *  也免得「从没画过贴纸」的人白挂一个 MutationObserver。 */
let themeWatched = false;

function watchTheme(): void {
  if (themeWatched) return;
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return;
  themeWatched = true;
  new MutationObserver(invalidate).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}

/** 读 CSS token。⚠ 只为「样式表还没生效」这一种意外兜底,
 *  正常路径永远走 token —— 颜色只有那一处实现(AGENTS.md §5)。 */
function readPalette(): Palette {
  if (palette) return palette;
  watchTheme();
  const read = (name: string): string => {
    if (typeof document === "undefined") return FALLBACK;
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || FALLBACK;
  };
  palette = {
    base: { red: read("--rb-red"), black: read("--rb-black") },
    icon: { red: read("--rb-icon-red"), black: read("--rb-icon-black") },
  };
  return palette;
}

/** sprite 缓存键。
 *  ⚠ **形状与图标都必须进键**:以前只有 `type@dpr`,因为那时候「同色贴纸长得一模一样」是对的;
 *    现在两者都由 id 推导、同一张卡上会同时出现好几种组合,不按它们分桶就会
 *    「先画的那种外观被复用给所有贴纸」(没有任何报错,只有人眼看得出来)。
 *  ⚠ 分桶后上界 = 红族 3×3 + 黑族 3×3 = 18 种组合 × 至多 2 档 dpr = 36 张,仍是**有界**的。 */
function spriteKey(type: StickerType, shape: StickerShape, glyph: StickerGlyph, dpr: number): string {
  return `${type}@${shape}@${glyph}@${dpr}`;
}

function build(
  type: StickerType,
  shape: StickerShape,
  glyph: StickerGlyph,
  dpr: number,
): StickerSprite {
  const size = STICKER_SIZE;
  const side = size + SPRITE_PAD * 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(side * dpr);
  canvas.height = Math.round(side * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return { canvas, pad: SPRITE_PAD };

  // 幂等的变换:不要用会累加的 `scale()`(见 PLAN 的实现说明)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(SPRITE_PAD, SPRITE_PAD);
  const colors = readPalette();
  const body = shapePath2D(shape, size);

  // ① 三层外落影(`box-shadow` 的后三条)—— 用同一条轮廓填充三次,影子叠在元素下方
  for (const [offsetY, blur, shadowColor] of SHADOWS) {
    ctx.save();
    ctx.shadowColor = shadowColor;
    ctx.shadowBlur = blur;
    ctx.shadowOffsetY = offsetY;
    ctx.fillStyle = colors.base[type];
    ctx.fill(body);
    ctx.restore();
  }

  // ② 主色(不透明,盖掉上面几次填充的痕迹)
  ctx.fillStyle = colors.base[type];
  ctx.fill(body);

  // ③ 斜向细条纹:`repeating-linear-gradient(115deg, 白 5% 0 1px, 透明 1px 3px)`
  //    —— 把画布转 25° 之后,竖线就是原来的 115°(竖线 90° + 25°)
  ctx.save();
  ctx.clip(body);
  ctx.translate(size / 2, size / 2);
  ctx.rotate((25 * Math.PI) / 180);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  const reach = Math.ceil(size);
  for (let x = -reach; x <= reach; x += 3) {
    ctx.moveTo(x + 0.5, -reach);
    ctx.lineTo(x + 0.5, reach);
  }
  ctx.stroke();
  ctx.restore();

  // ④ 径面高光:`radial-gradient(circle at 34% 28%, 白 N%, 透明 62%)`
  ctx.save();
  ctx.clip(body);
  const hx = size * 0.34;
  const hy = size * 0.28;
  const glow = ctx.createRadialGradient(hx, hy, 0, hx, hy, size * 0.62);
  glow.addColorStop(0, `rgba(255, 255, 255, ${HIGHLIGHT[type]})`);
  glow.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);
  ctx.restore();

  // ⑤ 中心微图标 —— **裁在轮廓内**再画:胶片残片那种窄条形状比图标矮,
  //    不裁的话图标会从贴纸两侧探出去(真机上就是两撮白边)
  //    ⚠ 图标由调用方按贴纸 id 推好再传进来(见 `stickerSprite` 的参数说明):
  //      它在 sprite 里**不是**由形状决定的,两者各推各的。
  //    ⚠ 落点必须走 `glyphPlacement`:**不能**只平移到中心再 `scale`(那是绕原点缩的,
  //      会把整块图案推到右下角 —— 2026-09-29 踩过,见那个函数的说明)。
  const spot = glyphPlacement(size);
  ctx.save();
  ctx.clip(body);
  ctx.translate(spot.x, spot.y);
  ctx.scale(spot.scale, spot.scale);
  ctx.fillStyle = colors.icon[type];
  ctx.fill(new Path2D(glyphPath(glyph)));
  ctx.restore();

  // ⑥ 内描边(`inset 0 0 0 1px`):裁到形状内再描 2px 的线,可见的就是内侧那一像素
  ctx.save();
  ctx.clip(body);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
  ctx.lineWidth = 2;
  ctx.stroke(body);
  ctx.restore();

  return { canvas, pad: SPRITE_PAD };
}

/** 取一枚贴纸 sprite —— 按 `(颜色, 形状, 图标, dpr)` 缓存,同一帧里同类的上百枚共用同一张。
 *
 * ⚠ `shape` / `glyph` 由**调用方**从贴纸 id 推好再传(`sticker-shape.ts::shapeOf` /
 *   `sticker-glyph.ts::glyphOf`)—— 本模块不碰 id:它要能被缓存,就必须只依赖这四个键。
 * ⚠ 上界 = 18 种「色×形状×图标」组合 × 至多 2~3 档 dpr ≈ 36~54 张离屏画布。
 *   单张 `(32 + 2×12)² × dpr²` 像素 —— dpr = 1 时约 12KB、dpr = 2 时约 50KB、dpr = 3 时约 113KB
 *   (逐张 4 字节/像素)。最坏一档 ≈ 6MB,但它**与票数无关**、且同一张卡里同类只留一份 ——
 *   `O(1) 有界`,不会随票数上涨。 */
export function stickerSprite(
  type: StickerType,
  shape: StickerShape,
  glyph: StickerGlyph,
  dpr: number,
): StickerSprite {
  const key = spriteKey(type, shape, glyph, dpr);
  const hit = cache.get(key);
  if (hit) return hit;
  const built = build(type, shape, glyph, dpr);
  cache.set(key, built);
  return built;
}
