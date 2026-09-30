/**
 * 贴纸的**材质**（2026-09-29，PLAN-20260929195500 第三轮）。
 *
 * 「一款皮肤 = 轮廓 + 材质 + 中心图标 整套绑定」，材质是其中一维。它有两类渲染器：
 *   ① **CSS** —— 我贴的那一枚（`.rb-dot__face[data-rb-material=…]` 的 `background-image`）；
 *   ② **Canvas 2D** —— 群点 sprite 与分享图（`paintMaterial`）。
 *
 * ⚠ 这里**不是**「定一组数值、CSS 那边照抄一遍」。做法是把材质描述成一组**层**
 *   （`MaterialLayer[]`），再由两个渲染器各自翻译：
 *     · `materialBackground()` / `materialBackgroundSize()` → CSS 值（贴进样式表，见下）
 *     · `paintMaterial()` → canvas 绘制
 *   一份配方、两个渲染器 —— 所以两条路径**不可能对不上**（要改只能改这一处）。
 *   上一轮「同一外观四条路径各描一份」的教训就在这儿：写成两处表达式，
 *   迟早有一处忘了改，而那种不一致**不会报错**，只有人眼看得出来。
 *
 * ⚠ CSS 那份是**生成出来贴进样式表**的（不是运行期内联），因为：
 *   · 材质是**材质常量**、与具体某一枚贴纸无关 —— 300 张卡共用同一条规则，只解析一次；
 *     内联的话会把这串长文本复制 300 份（≈250KB DOM 属性），白花内存。
 *   · 代价是样式表里那几行是「副本」，所以 `tests/sticker-material.test.ts` 会
 *     **逐个材质断言样式表里就是这串生成结果**（照 `sticker-shape.test.ts` 守 CSS 的既有做法）。
 *
 * ⚠ 一切几何都用**32 设计盒**里的像素（`BOX = 32`）：DOM 那枚恒为 32px，直接照用；
 *   canvas 传入的 `size` 可能是 14 / 24 / 32，统一 `ctx.scale(size / BOX)` 换算
 *   ——**不要**为小尺寸另写一套配方（那就是第二处口径）。
 *
 * ⚠ 纯常量 + 纯函数，**import 期不碰 DOM**（`paintMaterial` 只在真画时才碰 ctx）。
 * ⚠ 一切随机必须是**确定性**整数哈希（禁用 `Math.random`）：否则 sprite 每次重建都不一样，
 *   单测无法比对、缓存失效（切主题）时会「闪一下」变个图案。
 */

import type { StickerMaterial } from "@biff/contracts/sticker";

export type { StickerMaterial };

/** 材质几何的设计盒。⚠ 与 `sticker-sprite.ts::STICKER_SIZE` 同值但**含义不同**：
 *  那个是「贴纸多大」，这个是「材质配方按多大的盒子写」。 */
const BOX = 32;

/** 材质面板：一款皮肤绑一种。 */
export const STICKER_MATERIAL_LIST: readonly StickerMaterial[] = ["screen", "grain", "ink"];

/** 颜色 + 透明度。⚠ 不直接存 `rgba(...)` 字符串：CSS 要 `rgb(r g b / a%)`、canvas 要
 *  `rgba(r,g,b,a)`，存字符串就得在两边各做一次解析（或者赌 canvas 接受 CSS4 语法）。 */
interface Ink {
  r: number;
  g: number;
  b: number;
  a: number;
}

const WHITE = (a: number): Ink => ({ r: 255, g: 255, b: 255, a });
const BLACK = (a: number): Ink => ({ r: 0, g: 0, b: 0, a });

function cssInk({ r, g, b, a }: Ink): string {
  return `rgb(${r} ${g} ${b} / ${Math.round(a * 1000) / 10}%)`;
}

function canvasInk({ r, g, b, a }: Ink): string {
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** 确定性噪声：把 `(i, salt)` 映射到 `[0, 1)`（整数哈希，相邻 i 之间不会出现可见斜纹）。 */
function noise(i: number, salt: number): number {
  let x = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
  x ^= x >>> 15;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

/**
 * 一层材质。几何单位是 32 设计盒里的 px。
 *  · `stripe` 斜向细纹（`angle` 用 **CSS 角度**约定：0° 朝上、顺时针）
 *  · `dots`   平铺圆点（从盒子左上角起铺，`pitch` 一格、半径 `radius`）
 *  · `blob`   指定位置的一个圆点（印章油墨的不均匀感靠它）
 *  · `edge`   以盒子中心为圆心的径向压暗（`from` 起、`to` 止）
 */
type MaterialLayer =
  | { kind: "stripe"; angle: number; pitch: number; width: number; ink: Ink }
  | { kind: "dots"; pitch: number; radius: number; ink: Ink }
  | { kind: "blob"; x: number; y: number; radius: number; ink: Ink }
  | { kind: "edge"; from: number; to: number; ink: Ink };

const HALF = BOX / 2;

/** 印章油墨边的那一圈墨点：位置与深浅都由整数哈希定，**编译期就是常量**。
 *  ⚠ 它必须先在模块级算好：CSS 那份要写成静态的 `radial-gradient(... at Xpx Ypx)`，
 *    而 canvas 那份要画在同样的坐标上 —— 两边读的就是这个数组。 */
const INK_BEADS = 18;

function inkBeads(): MaterialLayer[] {
  const out: MaterialLayer[] = [];
  for (let i = 0; i < INK_BEADS; i += 1) {
    const t = (i / INK_BEADS) * Math.PI * 2;
    const radius = Math.round((0.6 + noise(i, 9) * 1.1) * 100) / 100;
    // ⚠ 离中心的距离要**先扣掉自己那颗的半径**：墨点中心贴着盒边时会被轮廓裁掉一半，
    //   那半颗就是白写的（canvas 与 CSS 两侧都裁，所以是「一致地浪费」—— 一致不等于有意义）。
    //   扣完之后整颗都在 32 盒内，`tests/sticker-material.test.ts` 会机械守住这一条。
    const maxDepth = (HALF - radius) / BOX;
    const depth = Math.min(maxDepth, 0.4 + noise(i, 7) * 0.1);
    out.push({
      kind: "blob",
      // 两位小数就够（CSS 与 canvas 读的是同一份数，精度不影响一致性，只是别让文本长得离谱）
      x: Math.round((HALF + Math.cos(t) * BOX * depth) * 100) / 100,
      y: Math.round((HALF + Math.sin(t) * BOX * depth) * 100) / 100,
      radius,
      ink: BLACK(0.05 + noise(i, 8) * 0.12),
    });
  }
  return out;
}

/**
 * 材质配方 —— **整个材质体系唯一的数据来源**。
 *
 * 三款的意图（用户原话：「丝网重影 / 胶片颗粒 / 印章油墨边」）：
 *  · `screen` 丝网重影：两组**角度差 1.5°** 的细纹。只有一组是「布纹」，两组错开才对——
 *    真实丝网印刷套色没对准，就是这种几乎重合、慢慢「涨开」的摩尔纹。
 *  · `grain` 胶片颗粒：两层平铺圆点（细密偏白 + 稀疏偏黑）。真实胶片颗粒是**明暗都有**的，
 *    只用浅色点会读成「磨砂」而不是「颗粒」。
 *  · `ink` 印章油墨边：一圈径向压暗 + 沿内缘洒的不均匀墨点。关键在**不均匀** ——
 *    匀的一圈是「描边」，深浅不一的点才像印章压出来的油墨。
 *
 * ⚠ 改任何一个数，`tests/sticker-material.test.ts` 会要求样式表里那几行同步（它会报出该贴什么）。
 */
const RECIPES: Record<StickerMaterial, readonly MaterialLayer[]> = {
  screen: [
    { kind: "stripe", angle: 115, pitch: 3, width: 1, ink: WHITE(0.05) },
    { kind: "stripe", angle: 113.5, pitch: 7, width: 2.5, ink: WHITE(0.045) },
  ],
  grain: [
    { kind: "dots", pitch: 3, radius: 0.55, ink: WHITE(0.07) },
    { kind: "dots", pitch: 5, radius: 0.8, ink: BLACK(0.07) },
  ],
  ink: [
    { kind: "edge", from: 8.96, to: 17.92, ink: BLACK(0.14) },
    ...inkBeads(),
  ],
};

/** 一层 → CSS `background-image` 里的一段。
 *  ⚠ 角度的换算见 `paintMaterial` 里那段说明：CSS 的 `Ndeg` 与 canvas 的 `rotate(N-90)` 等价，
 *    两处必须成对改。 */
function layerToCss(layer: MaterialLayer, scale: number): string {
  if (layer.kind === "stripe") {
    const { angle, pitch, width, ink } = layer;
    return `repeating-linear-gradient(${angle}deg, ${cssInk(ink)} 0 ${at(width, scale)}px, transparent ${at(width, scale)}px ${at(pitch, scale)}px)`;
  }
  if (layer.kind === "dots") {
    // `at 0 0`：把圆的圆心钉在**每一格贴片的左上角**，与 canvas 那边「从盒子左上角起按 pitch 铺点」逐格对应。
    // 不写 `at 0 0` 的话圆心会落在贴片正中，两条路径整格错开半格。
    const { radius, ink } = layer;
    const r = at(radius, scale);
    return `radial-gradient(circle at 0 0, ${cssInk(ink)} 0 ${r}px, transparent ${r}px)`;
  }
  if (layer.kind === "blob") {
    const { x, y, radius, ink } = layer;
    const r = at(radius, scale);
    return `radial-gradient(circle at ${at(x, scale)}px ${at(y, scale)}px, ${cssInk(ink)} 0 ${r}px, transparent ${r}px)`;
  }
  const { from, to, ink } = layer;
  return `radial-gradient(circle at ${at(HALF, scale)}px ${at(HALF, scale)}px, transparent 0 ${at(from, scale)}px, ${cssInk(ink)} ${at(to, scale)}px)`;
}

/** 把设计盒里的 px 换算到实际贴纸尺寸，并收成两位小数（CSS 文本里不需要更多位）。 */
function at(value: number, scale: number): number {
  return Math.round(value * scale * 100) / 100;
}

/** 材质 → CSS `background-image` 的值（**逐字**贴进 `redblack-parity.css`，由单测守着）。
 *
 *  ⚠ `size` 必填，且必须传**贴纸的实际边长**（`sticker-sprite.ts::STICKER_SIZE`）：
 *    CSS 的渐变半径是绝对 px、不会随元素缩放，而配方是按 32 设计盒写的 ——
 *    不换算的话贴纸一改尺寸，两条路径的材质就**静默地**不一样了（这正是本轮踩到的坑）。
 *    canvas 那边由 `paintMaterial` 里的 `ctx.scale(size / BOX)` 承担同一件事。
 *  ⚠ 层的顺序与 canvas 的绘制顺序一致：先写的在下（CSS 里第一层在最上，canvas 里后画的在上）——
 *    所以 canvas 那边要**倒着**遍历，见 `paintMaterial`。 */
export function materialBackground(material: StickerMaterial, size: number): string {
  const scale = size / BOX;
  return RECIPES[material].map((layer) => layerToCss(layer, scale)).join(",\n    ");
}

/** 材质 → CSS `background-size` 的值。
 *  只有平铺圆点需要它（一格多大）；其余层默认铺满整个盒子，用 `auto` 占位以保持层序对应。 */
export function materialBackgroundSize(material: StickerMaterial, size: number): string {
  const scale = size / BOX;
  const sizes = RECIPES[material].map((layer) =>
    layer.kind === "dots" ? `${at(layer.pitch, scale)}px ${at(layer.pitch, scale)}px` : "auto",
  );
  // ⚠ 全 `auto` 时**不能**回一个逗号列表：`background-size: auto, auto` 会让浏览器
  //   把第二层也当成「铺满」，与不写这一条等价但更难读。回 `auto` 让它整条省略。
  return sizes.every((size) => size === "auto") ? "auto" : sizes.join(", ");
}

/**
 * 把材质画进**当前已经平移到贴纸左上角**的坐标系（那一格是 `0..size`）。
 *
 * 调用方负责 `ctx.save()/restore()` 与「先铺底色、再调这里」的顺序。
 * 本函数自己 `clip(body)`：任何一层都不许探出轮廓（异形轮廓下尤其明显）。
 */
export function paintMaterial(
  ctx: CanvasRenderingContext2D,
  material: StickerMaterial,
  body: Path2D,
  size: number,
): void {
  ctx.save();
  ctx.clip(body);
  // 配方按 32 盒写死，这里缩到实际尺寸 —— 于是「32 的贴纸」与「14 的分享图」是同一份配方。
  ctx.scale(size / BOX, size / BOX);
  // ⚠ 与 CSS 的层序相反：CSS 里**第一层在最上面**，canvas 里**后画的在上面**，
  //   所以倒着遍历才是同一张画。反了不会报错，只是两种材质的轻重关系互换。
  const layers = RECIPES[material];
  for (let i = layers.length - 1; i >= 0; i -= 1) paintLayer(ctx, layers[i]);
  ctx.restore();
}

function paintLayer(ctx: CanvasRenderingContext2D, layer: MaterialLayer): void {
  if (layer.kind === "stripe") {
    const { angle, pitch, width, ink } = layer;
    ctx.save();
    // ⚠ CSS 的角度约定(0° 朝上、顺时针)与 canvas 的 rotate(0 = +x 轴)差 90°：
    //   CSS `Ndeg` 的渐变线方向 = (sin N, -cos N)；canvas rotate(a) 把 +x 映到 (cos a, sin a)。
    //   令两者相等得 a = N - 90。**改这里必须同时改 `layerToCss`**。
    ctx.rotate(((angle - 90) * Math.PI) / 180);
    ctx.strokeStyle = canvasInk(ink);
    ctx.lineWidth = width;
    ctx.beginPath();
    // 转完之后「沿渐变线的位置」就是 x；铺的范围要盖住旋转后的对角线
    const reach = BOX;
    for (let x = -reach; x <= reach; x += pitch) {
      ctx.moveTo(x + width / 2, -reach);
      ctx.lineTo(x + width / 2, reach);
    }
    ctx.stroke();
    ctx.restore();
    return;
  }
  if (layer.kind === "dots") {
    const { pitch, radius, ink } = layer;
    ctx.fillStyle = canvasInk(ink);
    // 从**盒子左上角**起铺，与 CSS 的 `background-size` 贴片网格同一起点
    for (let x = 0; x < BOX; x += pitch) {
      for (let y = 0; y < BOX; y += pitch) {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    return;
  }
  if (layer.kind === "blob") {
    const { x, y, radius, ink } = layer;
    ctx.fillStyle = canvasInk(ink);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const { from, to, ink } = layer;
  const gradient = ctx.createRadialGradient(HALF, HALF, from, HALF, HALF, to);
  gradient.addColorStop(0, canvasInk({ ...ink, a: 0 }));
  gradient.addColorStop(1, canvasInk(ink));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, BOX, BOX);
}
