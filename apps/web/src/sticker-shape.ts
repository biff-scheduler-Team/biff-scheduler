/**
 * 贴纸的**形状族**(2026-09-29,PLAN-20260929195500)。
 *
 * 为什么把「一个函数」改成「一族注册表 + 一条推导」:
 * 用户要求贴纸不再是清一色的正圆 —— 红榜要票根 / 胶片齿孔,黑榜要胶片残片 / 胶卷盘,
 * 多枚并排时还得**交替**出现撕裂边与手工剪裁感,否则又变回「数据图表的圆点阵」。
 *
 * ⚠ **形状只有一个表达:SVG path 的 `d` 字符串。** 它同时是三种消费端的合法输入 ——
 *   ① CSS 的 `clip-path: path("…")`(我贴的那一枚);
 *   ② Canvas 的 `new Path2D(d)`(卡片群点 sprite / 分享图);
 *   ③ 内联 `<svg><path d="…"/></svg>`。
 *   于是「一处定义、四处消费」成立,CSS 文件里**不出现任何硬编码路径**
 *   (这条被 `tests/sticker-shape.test.ts` 机械守住)。
 *
 * ⚠ **坐标是绝对坐标(0..`SHAPE_BOX`),不随尺寸缩放** —— 这是 `clip-path: path()` 的硬约束。
 *   需要别的尺寸时**不要重描路径**,走 `shapePath(shape, size)`:它按比例换算所有数字。
 *
 * ⚠ 纯函数 + 常量表,**import 期不碰 DOM**:可被 node 单测直接 import。
 */

/** 形状族。⚠ 2026-09-29 起**红黑共用同一套**（见 `ALL_SHAPES`），不再按颜色拆子集。
 *  ⚠ 2026-09-30 换款：`reel`（胶卷盘）下线，新上 `clap`（场记板）；`torn` 留着 ——
 *    它虽然不再是「一款皮肤」，但**金棕榈复用它当轮廓**（见 `sticker-skin.ts`），
 *    所以形状与皮肤**不是一一对应**的关系：形状可以被多款复用，皮肤是「形状+图标+材质」的组合。 */
export type StickerShape = "torn" | "stub" | "sprocket" | "scrap" | "clap";

/** 设计盒边长。所有形状的顶点都在 `0..SHAPE_BOX` 内描画,与贴纸尺寸同值(32px)。 */
export const SHAPE_BOX = 32;

/** 一个轮廓顶点。
 *  `sharp` 为真 = **尖角**(进出这一段都用直线),用来做票根撕口 / 锯齿 / 方齿孔;
 *  缺省 = **平滑**(用三次贝塞尔过渡),用来做撕裂圆片与胶片残片那圈有机曲线。 */
interface Vertex {
  x: number;
  y: number;
  sharp?: boolean;
}

/* ---------------- 轮廓 → path d ---------------- */

/** 保留两位小数并去掉多余的 0。
 *  ⚠ 必须**确定性地**产出字符串:同一个形状每次构建都要一模一样,否则单测无法比对,
 *    CSS 变量的值也会每帧都「变」一次(白触发一次样式失效)。 */
function num(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** 顶点环 → 闭合的 path `d`(Catmull-Rom 转三次贝塞尔,张力固定 1/6)。
 *
 * ⚠ **两种转场**由顶点的 `sharp` 决定,这是整个形状族的表达力来源:
 *   · 两端都平滑 → `C`(曲线过点,张力 1/6 是 Catmull-Rom 的标准取法);
 *   · 任一端是尖角 → `L`(直线)。所以「全 sharp」的顶点环退化成多边形 ——
 *     胶片残片与票根正是靠这个做出硬边。
 * ⚠ `k = size / SHAPE_BOX` 是唯一的缩放点:要别的尺寸就传 `size`,不要另描一份路径。 */
function outline(vertices: readonly Vertex[], size: number): string {
  const k = size / SHAPE_BOX;
  const count = vertices.length;
  // 环形取值:闭合环上「前一个 / 后一个 / 再后一个」都要能跨过首尾
  const at = (index: number): Vertex => vertices[((index % count) + count) % count];

  const parts: string[] = [`M${num(at(0).x * k)} ${num(at(0).y * k)}`];
  for (let i = 0; i < count; i++) {
    const prev = at(i - 1);
    const cur = at(i);
    const next = at(i + 1);
    const after = at(i + 2);

    if (cur.sharp || next.sharp) {
      parts.push(`L${num(next.x * k)} ${num(next.y * k)}`);
      continue;
    }

    parts.push(
      `C${num((cur.x + (next.x - prev.x) / 6) * k)} ${num((cur.y + (next.y - prev.y) / 6) * k)}` +
        ` ${num((next.x - (after.x - cur.x) / 6) * k)} ${num((next.y - (after.y - cur.y) / 6) * k)}` +
        ` ${num(next.x * k)} ${num(next.y * k)}`,
    );
  }
  parts.push("Z");
  return parts.join("");
}

/* ---------------- 五个形状 ---------------- */

/** 撕裂圆片:主体是圆,右下四分之一处把 5 个顶点交错推里推外并打成尖角 —— 读作「手撕边」。
 *  ⚠ 抖动**不能用 `Math.random`**:形状是「这一枚长什么样」的一部分,必须可复现。 */
function tornVertices(): Vertex[] {
  const out: Vertex[] = [];
  const COUNT = 26;
  for (let i = 0; i < COUNT; i++) {
    const angle = (i / COUNT) * Math.PI * 2;
    // 经典整数哈希:同一个 i 永远同一个抖动值
    const raw = Math.sin(i * 12.9898) * 43758.5453;
    const jitter = ((raw % 1) + 1) % 1;
    // 撕裂段取 i=5..9:角度约 69°~125°,即**右下**那一片(canvas 的 y 轴朝下)
    const torn = i >= 5 && i <= 9;
    const radius = torn ? (i % 2 === 0 ? 13.3 : 15.7) : 15 + (jitter - 0.5) * 1.1;
    out.push({
      x: SHAPE_BOX / 2 + Math.cos(angle) * radius,
      y: SHAPE_BOX / 2 + Math.sin(angle) * radius,
      sharp: torn,
    });
  }
  return out;
}

/** 票根切角:左右两条长边正中各挖一个 V 形撕口,四角带圆 —— 电影院撕票的那张纸。 */
function stubVertices(): Vertex[] {
  const left = 3;
  const right = 29;
  const top = 6;
  const bottom = 26;
  return [
    { x: 6.5, y: top, sharp: true },
    { x: 25.5, y: top, sharp: true },
    { x: right, y: 9.5 },
    { x: right, y: 12.5, sharp: true },
    // 撕口往内收 3.6,形成 V 形缺口
    { x: 25.4, y: SHAPE_BOX / 2 },
    { x: right, y: 19.5, sharp: true },
    { x: right, y: 22.5 },
    { x: 25.5, y: bottom, sharp: true },
    { x: 6.5, y: bottom, sharp: true },
    { x: left, y: 22.5 },
    { x: left, y: 19.5, sharp: true },
    { x: 6.6, y: SHAPE_BOX / 2 },
    { x: left, y: 12.5, sharp: true },
    { x: left, y: 9.5 },
  ];
}

/** 胶片齿孔:圆角方框,左右两边缘各打 4 个**方形**齿孔(35mm 胶片两侧的齿孔排)。 */
function sprocketVertices(): Vertex[] {
  const left = 4.5;
  const right = 27.5;
  const top = 4.5;
  const bottom = 27.5;
  const depth = 2.6; // 齿孔深度
  const height = 2.8; // 齿孔高度
  const rows = [9, 14, 19, 24];
  const out: Vertex[] = [
    { x: left + 2, y: top, sharp: true },
    { x: right - 2, y: top, sharp: true },
    { x: right, y: top + 2 },
  ];
  for (const center of rows) {
    out.push({ x: right, y: center - height / 2, sharp: true });
    out.push({ x: right - depth, y: center - height / 2, sharp: true });
    out.push({ x: right - depth, y: center + height / 2, sharp: true });
    out.push({ x: right, y: center + height / 2, sharp: true });
  }
  out.push({ x: right, y: bottom - 2 });
  out.push({ x: right - 2, y: bottom, sharp: true });
  out.push({ x: left + 2, y: bottom, sharp: true });
  out.push({ x: left, y: bottom - 2 });
  // 回程(自下而上)要**倒序**取行号,否则会在左下角折回去
  for (const center of [...rows].reverse()) {
    out.push({ x: left, y: center + height / 2, sharp: true });
    out.push({ x: left + depth, y: center + height / 2, sharp: true });
    out.push({ x: left + depth, y: center - height / 2, sharp: true });
    out.push({ x: left, y: center - height / 2, sharp: true });
  }
  out.push({ x: left, y: top + 2 });
  return out;
}

/** 剪片遗弃的胶片:一条**斜置**的窄胶片,两端是撕断的锯齿 —— 全尖角,所以是硬边的多边形。 */
function scrapVertices(): Vertex[] {
  const out: Vertex[] = [];
  const halfWidth = 11;
  const halfHeight = 6.2;
  // -16°:斜一点才像「随手撕下来扔在板上的半截胶片」
  const rot = (-16 * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const put = (lx: number, ly: number): void => {
    out.push({ x: SHAPE_BOX / 2 + lx * cos - ly * sin, y: SHAPE_BOX / 2 + lx * sin + ly * cos, sharp: true });
  };
  put(-halfWidth, -halfHeight);
  put(halfWidth, -halfHeight);
  // 右端撕口:三点交错
  put(halfWidth + 1.4, -halfHeight / 3);
  put(halfWidth - 0.6, halfHeight / 3);
  put(halfWidth + 1.0, halfHeight);
  put(-halfWidth, halfHeight);
  // 左端撕口
  put(-halfWidth - 1.2, halfHeight / 3);
  put(-halfWidth + 0.7, -halfHeight / 3);
  return out;
}

/** 场记板:板身 + 一条**斜的**顶条(挑出板外压住板子上沿) —— 32px 下就靠这两件事认出它。
 *
 *  ⚠ **不画顶条上的斜条纹**:条纹在这个尺寸上每道不足 1px,只会糊成一粒噪点,
 *    反而把「板 + 斜条」这个唯一能读出的剪影搞脏(sprite / 分享图里更明显)。
 *  ⚠ 斜度朝**右下**(与真实场记板一致:合板时那一侧先落)。⚠ 轮廓是**单一闭合环**,
 *    做不出「挖空」的条纹 —— 要挖空得像形状族那样支持子路径,那是另一件事,不在本轮。 */
function clapVertices(): Vertex[] {
  return [
    { x: 2.5, y: 4.5, sharp: true }, // 顶条左上
    { x: 29.5, y: 8, sharp: true }, // 顶条右上(低 3.5 = 斜)
    { x: 29.5, y: 14.5, sharp: true }, // 顶条右下
    { x: 27.2, y: 14.2, sharp: true }, // 收进板身右缘(跟着斜边收)
    { x: 27.2, y: 27.2 }, // 板身右下(圆角)
    { x: 4.8, y: 27.2 }, // 板身左下(圆角)
    { x: 4.8, y: 12.8, sharp: true }, // 板身左上(被顶条压住)
    { x: 2.5, y: 11, sharp: true }, // 挑回顶条左下
  ];
}

/** 形状 → 顶点环。⚠ 只在这里登记一次,`shapePath` 与单测都读它。 */
const VERTICES: Record<StickerShape, readonly Vertex[]> = {
  torn: tornVertices(),
  stub: stubVertices(),
  sprocket: sprocketVertices(),
  scrap: scrapVertices(),
  clap: clapVertices(),
};

/** 全部形状。⚠ 2026-09-29 起**不再按颜色分子集**：红黑共用同一套皮肤，只差底色
 *  （用户原话「只是红色跟黑色的区别」）。「哪个形状配哪款皮肤」在 `sticker-skin.ts`。 */
export const ALL_SHAPES: readonly StickerShape[] = ["clap", "torn", "stub", "sprocket", "scrap"];

/** 形状 → 该形状的 SVG path `d`(默认按 `SHAPE_BOX` 原尺寸)。
 *
 *  ⚠ 传 `size` 会**等比换算所有坐标**;不要为另一个尺寸再描一遍路径 ——
 *    那样就又出现两份形状表达了(AGENTS §5)。 */
export function shapePath(shape: StickerShape, size: number = SHAPE_BOX): string {
  return outline(VERTICES[shape], size);
}

/** 形状 → 可直接写进内联 CSS 变量的字面量,形如 `path("M…")`。
 *  CSS 侧**只写** `clip-path: var(--rb-shape)`,不出现任何具体路径。
 *
 *  ⚠ `size` 是**必填**,不能像 `shapePath` 那样给默认值:这里的 `path()` 是**绝对 px**,
 *    不会被元素尺寸缩放(`clip-path` 与 `viewBox` 不是一回事 —— 后者会缩放,前者不会)。
 *    给个默认值就等于「当贴纸正好是这个尺寸时才对」,而贴纸尺寸是**会变**的
 *    (26 → 20 → 32 → 20 已经改过四轮),那时路径会**静默地**只裁出左上角一小块。
 *    必填参数强迫每个调用点回答「这枚贴纸现在多大」。 */
export function shapeClipVar(shape: StickerShape, size: number): string {
  return `path("${shapePath(shape, size)}")`;
}

/** 形状 → `Path2D`(Canvas 侧唯一入口:群点 sprite 与分享图都走它)。 */
export function shapePath2D(shape: StickerShape, size: number = SHAPE_BOX): Path2D {
  return new Path2D(shapePath(shape, size));
}
