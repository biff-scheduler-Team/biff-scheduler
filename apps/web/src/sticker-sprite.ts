/**
 * 贴纸的**离屏 sprite** 预渲染(2026-09-22,PLAN-20260922145815;2026-09-29 扩形状族)。
 *
 * 画布上一张卡可能有上百枚贴纸,每枚都现场构造渐变 = 上百次 `createLinearGradient` /
 * `createRadialGradient`,那才是 canvas 里最贵的一步。贴纸只有红 / 黑两种底、样子完全一样,
 * 所以**每种按 dpr 各画一次**存进离屏画布,之后每枚只做 `drawImage`。
 *
 * ⚠ 形状与质感必须与 `redblack-parity.css` 里的 `.rb-dot` **逐字对应**
 *   (用户 2026-09-22 选的是「预渲染 sprite,视觉几乎不变」):
 *   · 尺寸由 `STICKER_SIZE` 给出(沿革 26 → 20 → 32 → 20 → **24**;
 *     2026-10-05 用户「把贴纸放大一点」,同时要求中心图标**尺寸不变** ——
 *     那件事由 `ICON_RATIO` 0.55 → 0.46 顶着,见 `sticker-glyph.ts`);
 *   · 轮廓 —— 由 `sticker-shape.ts` 的**形状族**给出(`stub` / `sprocket` / `scrap`),
 *     不再是一条固定的 border-radius;
 *   · 三层外落影 + 一层内描边(`inset 0 0 0 1px rgb(255 255 255 / 18%)`);
 *   · 材质层由**皮肤**决定(`sticker-material.ts`),红 / 黑只差底色;
 *   · 一枚径面高光(圆心 34% / 28%);
 *   · 中心微图标由 `sticker-glyph.ts` 给出,占贴纸边长 `ICON_RATIO`。
 *   颜色**只从 CSS token 读**(`--rb-red` / `--rb-black` / `--rb-icon-*`),这里绝不另写一份十六进制。
 */

import type { StickerType } from "./redblack";
import { glyphPath, glyphPlacement } from "./sticker-glyph";
// 材质配方与绘制只在 `sticker-material.ts` 一处实现（页面 CSS 侧的数值是照抄它）。
import { paintMaterial } from "./sticker-material";
// 轮廓与分享图(`redblack-poster.ts`)、CSS(内联 `--rb-shape`)共用同一条路径 —— 四处表达
// 都从 `sticker-shape.ts` 取,不要在这里另描一份。
import { SHAPE_BOX, shapePath2D } from "./sticker-shape";
// 一款皮肤 = 轮廓 + 材质 + 图标，整套绑定；这里只消费 `skin`，不自己拆。
import { skinSpec, type StickerSkin } from "./sticker-skin";

/** 贴纸边长(CSS px)。**全站唯一的尺寸口径**。
 *
 * ⚠ 必须与 `.rb-dot` 的 `width` / `height` 逐字一致 —— 一边是 canvas 画的群点、
 *   一边是 DOM 那枚可拖的按钮,尺寸只此两处表达(`tests/sticker-sprite.test.ts`
 *   会机械比对样式表里那个数,不靠注释提醒)。
 * ⚠ 它同时是**其它几条路径的缩放基准**:`StickerFace` 用它算 `clip-path: path()`,
 *   `materialBackground()` 用它把材质配方换算到实际尺寸 —— 改这里,
 *   材质那段 CSS 会**对不上**(单测会直接把该贴什么报出来),不要只改数字。
 *
 * 尺寸沿革(用户五轮改过,记下来免得再猜):
 *   26 → 20(2026-09-28,PLAN-20260928003736,为了「容纳更多」,纵向 8 行)
 *     → 32(2026-09-29 上午,为「像实体贴纸」:异形轮廓 + 微图标在 20px 下糊成一粒点)
 *     → 20(2026-09-29 下午):用户看过 32 的实机效果后明确要求「都调小一点,20 左右差不多」
 *     → **24**(2026-10-05):用户「把贴纸放大一点」—— 取 24 而不是回到 32(那一档已被否决过),
 *       并把 `ICON_RATIO` 调回 0.46,让中心图标**停在 11px 不变**(用户「中间挖孔大小不变」)。
 *   用户已知并接受的代价:微图标只有 11px(不随贴纸放大),票根的 V 形撕口 / 齿孔只剩轮廓感;
 *   细密那几层材质(胶片颗粒)落在 1px 上下,实际读作一层淡淡的色调。 */
export const STICKER_SIZE = 24;

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

/** 贴纸用到的全部颜色,**一起读、一起失效**:底色的红黑 + 微图标的两种墨色。
 *  ⚠ 2026-10-05：金棕榈下线后**不再有**「不跟纸色走」的墨色，`iconGold` 随之删掉 ——
 *    图标墨色现在只有红 / 黑两档，与 CSS 里 `.rb-dot--red/black .rb-dot__icon` 逐条对应。 */
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
 * ⚠ **已兑现(2026-09-30,PLAN-20260930214335)**:2026-09-28 当时核实的状况是 `--rb-red` /
 *   `--rb-black` 只在 `redblack-parity.css` 的 `:root` 定义一次、没有暗色覆盖,所以这条链路
 *   「修的是一个尚未发生的用户可见 bug 的前置脆弱点」。现在 `--rb-black` 补上了
 *   `:root[data-theme="dark"]` 覆盖(黑贴纸在暗色卡片底上与 `#252528` 撞亮度、糊成一片)——
 *   切主题时贴纸与群点**真的**会换色,下面这条监听就是那次换色唯一的触发入口。
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
 *  ⚠ **款必须进键**:以前只有 `type@dpr`,因为那时候「同色贴纸长得一模一样」是对的;
 *    现在同一张卡上会同时出现好几款,不按款分桶就会「先画的那款被复用给所有贴纸」
 *    (没有任何报错,只有人眼看得出来)。
 *  ⚠ 形状与图标不必再单独进键 —— 它们由款决定（`skinSpec`），款进键就够了。
 *  ⚠ 分桶上界 = 2 色 × 3 款 × 至多 3 档 dpr = 18 张，仍是**有界**的（比五款那会儿还少）。 */
function spriteKey(type: StickerType, skin: StickerSkin, dpr: number): string {
  return `${type}@${skin}@${dpr}`;
}

function build(type: StickerType, skin: StickerSkin, dpr: number): StickerSprite {
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
  const body = shapePath2D(skinSpec(skin).shape, size);

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

  // ③ 材质层（2026-09-29）：丝网重影 / 胶片颗粒 / 印章油墨边，由**皮肤**决定。
  //    ⚠ 配方与绘制只在 `sticker-material.ts` 一处实现（CSS 侧的数值是照抄它，见那里的说明）——
  //      在这里再写一套就等于同一款材质两份表达，两边迟早长得不一样。
  const material = skinSpec(skin).material;
  paintMaterial(ctx, material, body, size);

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
  const glyph = skinSpec(skin).glyph;
  ctx.save();
  ctx.clip(body);
  ctx.translate(spot.x, spot.y);
  ctx.scale(spot.scale, spot.scale);
  // ⚠ 墨色只有「跟纸色」这一档(与 CSS 里 `.rb-dot--red/black .rb-dot__icon` 对应)——
  //   2026-10-05 金棕榈下线后,那款「恒为金」的特判已随之删掉。
  //   `none`(留空)是空路径,画不出东西 —— 但这一支仍然照走,不必为它加特判。
  ctx.fillStyle = colors.icon[type];
  ctx.fill(new Path2D(glyphPath(glyph)));
  ctx.restore();

  // ⑥ 内描边(`inset 0 0 0 1px`):裁到形状内再描 2px 的线,可见的就是内侧那一像素
  //    ⚠ 线宽必须**按设计盒等比**,不能写死 2:DOM 那侧的描边是 SVG `<path>` 上的
  //      `stroke-width: 2`(**viewBox 单位**),它会随元素尺寸自动缩放 —— 贴纸不是 32px 时
  //      (比如现在的 20)两边的描边粗细就会不一样,而这只差 0.75px、只有并排看才看得出来。
  ctx.save();
  ctx.clip(body);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
  ctx.lineWidth = 2 * (size / SHAPE_BOX);
  ctx.stroke(body);
  ctx.restore();

  return { canvas, pad: SPRITE_PAD };
}

/** 取一枚贴纸 sprite —— 按 `(颜色, 款, dpr)` 缓存,同一帧里同类的上百枚共用同一张。
 *
 * ⚠ `skin` 由**调用方**从那一枚推好再传（`sticker-skin.ts::resolveSkin(id, sticker.skin)`）——
 *   本模块不碰 id:它要能被缓存,就必须只依赖这三个键。
 * ⚠ 上界 = 2 色 × 3 款 × 至多 3 档 dpr = 18 张离屏画布。
 *   单张 `(STICKER_SIZE + 2×SPRITE_PAD)² × dpr²` 像素 = `(24 + 2×12)² × dpr²`
 *   —— dpr = 1 时约 9KB、dpr = 2 时约 37KB、dpr = 3 时约 83KB
 *   (逐张 4 字节/像素)。最坏一档 ≈ 1.5MB,但它**与票数无关**、且同一张卡里同类只留一份 ——
 *   `O(1) 有界`,不会随票数上涨。 */
export function stickerSprite(type: StickerType, skin: StickerSkin, dpr: number): StickerSprite {
  const key = spriteKey(type, skin, dpr);
  const hit = cache.get(key);
  if (hit) return hit;
  const built = build(type, skin, dpr);
  cache.set(key, built);
  return built;
}
