/**
 * 贴纸的**离屏 sprite** 预渲染(2026-09-22,PLAN-20260922145815)。
 *
 * 画布上一张卡可能有上百枚贴纸,每枚都现场构造渐变 = 上百次 `createLinearGradient` /
 * `createRadialGradient`,那才是 canvas 里最贵的一步。贴纸只有红 / 黑两种、样子完全一样,
 * 所以**每种按 dpr 各画一次**存进离屏画布,之后每枚只做 `drawImage`。
 *
 * ⚠ 形状与质感必须与 `redblack-parity.css` 里的 `.rb-dot` **逐字对应**(用户 2026-09-22 选的是
 *   「预渲染 sprite,视觉几乎不变」):
 *   · 尺寸 26×26(`STICKER_SIZE`);
 *   · 不规则圆片 —— `border-radius: 48% 52% 45% 55% / 52% 46% 54% 48%`(四角椭圆半径不同);
 *   · 两层外落影 + 一层内描边(`inset 0 0 0 1px rgb(255 255 255 / 18%)`);
 *   · 红 / 黑各一层斜向细条纹(115°,周期 3px)+ 一枚径面高光(圆心 34% / 28%)。
 *   颜色**只从 CSS token 读**(`--rb-red` / `--rb-black`),这里绝不另写一份十六进制。
 */

import type { StickerType } from "./redblack";
// 形状与分享图(`redblack-poster.ts`)共用同一条路径 —— 三处表达(CSS `border-radius` / 这里的
// sprite / 分享图里的小贴纸)改一处要同步另外两处,详见 `sticker-shape.ts`。
import { blobPath } from "./sticker-shape";

/** 贴纸边长(CSS px)。⚠ 必须与 `.rb-dot` 的 `width` / `height` 一致 */
export const STICKER_SIZE = 26;

/** sprite 四周给落影留的余量(CSS px):
 *  最外那层是 `0 2px 4px`,即向下 6px;横向按 4px 模糊留 8px 足够。 */
const SPRITE_PAD = 8;

/** 红 / 黑各自的径面高光强度 —— 与 CSS 里 `.rb-dot--red` / `--black` 的 0.14 / 0.10 一致 */
const HIGHLIGHT: Record<StickerType, number> = { red: 0.14, black: 0.1 };

export interface StickerSprite {
  /** 离屏画布(物理像素,边长 = (26 + 2×8) × dpr) */
  canvas: HTMLCanvasElement;
  /** 贴纸**中心**到 sprite 中心的偏移(CSS px)—— `drawImage` 时用来从中心反推左上角 */
  pad: number;
}

const cache = new Map<string, StickerSprite>();
let colors: Record<StickerType, string> | null = null;

/** 读 CSS token。⚠ 只为「样式表还没生效」这一种意外兜底(给个中性灰,一眼能看出不对),
 *  正常路径永远走 `--rb-red` / `--rb-black` —— 颜色只有那一处实现(AGENTS.md §5)。 */
function readColors(): Record<StickerType, string> {
  if (colors) return colors;
  const read = (name: string): string => {
    if (typeof document === "undefined") return "#8b8b8b";
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#8b8b8b";
  };
  colors = { red: read("--rb-red"), black: read("--rb-black") };
  return colors;
}

function build(type: StickerType, dpr: number): StickerSprite {
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
  const color = readColors()[type];

  // ① 两层外落影(`box-shadow` 的后两条)—— 用同形状填充两次,影子叠在元素下方
  const shadows: Array<[number, number, string]> = [
    [1, 1, "rgba(0, 0, 0, 0.16)"],
    [2, 4, "rgba(0, 0, 0, 0.12)"],
  ];
  for (const [offsetY, blur, shadowColor] of shadows) {
    ctx.save();
    ctx.shadowColor = shadowColor;
    ctx.shadowBlur = blur;
    ctx.shadowOffsetY = offsetY;
    ctx.fillStyle = color;
    blobPath(ctx, size);
    ctx.fill();
    ctx.restore();
  }

  // ② 主色(不透明,盖掉上面两次填充的痕迹)
  ctx.fillStyle = color;
  blobPath(ctx, size);
  ctx.fill();

  // ③ 斜向细条纹:`repeating-linear-gradient(115deg, 白 5% 0 1px, 透明 1px 3px)`
  //    —— 把画布转 25° 之后,竖线就是原来的 115°(竖线 90° + 25°)
  ctx.save();
  blobPath(ctx, size);
  ctx.clip();
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
  blobPath(ctx, size);
  ctx.clip();
  const hx = size * 0.34;
  const hy = size * 0.28;
  const glow = ctx.createRadialGradient(hx, hy, 0, hx, hy, size * 0.62);
  glow.addColorStop(0, `rgba(255, 255, 255, ${HIGHLIGHT[type]})`);
  glow.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);
  ctx.restore();

  // ⑤ 内描边(`inset 0 0 0 1px`):裁到形状内再描 2px 的线,可见的就是内侧那一像素
  ctx.save();
  blobPath(ctx, size);
  ctx.clip();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
  ctx.lineWidth = 2;
  blobPath(ctx, size);
  ctx.stroke();
  ctx.restore();

  return { canvas, pad: SPRITE_PAD };
}

/** 取一枚贴纸 sprite —— 按 `(颜色, dpr)` 缓存,同一帧里上百枚共用同一张。 */
export function stickerSprite(type: StickerType, dpr: number): StickerSprite {
  const key = `${type}@${dpr}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const built = build(type, dpr);
  cache.set(key, built);
  return built;
}
