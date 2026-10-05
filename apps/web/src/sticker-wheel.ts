/**
 * 换款轮盘的**几何**（2026-09-29，PLAN-20260929195500）。
 *
 * 为什么把这几行从组件里拿出来：`StickerSkinWheel.tsx` 一被 import 就带上 React 与
 * `createPortal`，而这里全是纯数学 —— 抽出来之后可以**直接单测**「N 颗节点是不是均匀分布、
 * 第一颗是不是在正上方」。这两条错了都不会报错，只会让那一圈看起来「有点歪」。
 * ⚠ 座位数**不写死**（按 `STICKER_SKIN_KEYS.length` 均分）:上一轮是 5 款,2026-10-05 缩到 3 款,
 *   这一圈自己就重新均分了 —— 所以文档里说的是「N 颗」而不是某一个具体数字。
 *
 * ⚠ 纯函数 + 常量，**import 期不碰 DOM**（`clampAnchor` 只在真调用时才看 `window`）。
 */

/** 环的半径（节点中心到贴纸中心的距离，CSS px）。 */
export const WHEEL_RADIUS = 46;

/** 节点边长。⚠ 44px 是**点击区**的下限（手指按得准），里面的贴纸仍是贴纸自己的尺寸。 */
export const NODE_SIZE = 44;

/** 视口边缘留白：环贴到屏幕边上时至少留这么多，免得节点被切掉一半。 */
const VIEWPORT_MARGIN = 8;

/** 第 `index` 颗节点相对锚点的偏移（CSS px）。
 *
 *  ⚠ `- Math.PI / 2` 让第一颗落在**正上方**（而不是正右方）—— 少了它整圈会顺时针歪 90°，
 *    而那看起来只是「有点不对」，不会报错。
 *  ⚠ 角度按 `count` 均分（不是写死 5）：将来加款时这一圈自己会重新均分。 */
export function wheelSeat(index: number, count: number, radius: number): { dx: number; dy: number } {
  const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
  // 收两位小数：坐标要进内联样式，多余精度只会让 DOM 属性变长，并且每次渲染都「不相等」
  const round = (value: number): number => Math.round(value * 100) / 100;
  return { dx: round(Math.cos(angle) * radius), dy: round(Math.sin(angle) * radius) };
}

/** 环的外沿到锚点的距离 —— 判断「这一圈会不会被切掉」用它，别到处再算一遍。 */
export const WHEEL_REACH = WHEEL_RADIUS + NODE_SIZE / 2;

/** 把锚点夹进视口。
 *
 *  ⚠ 夹过之后环心会**偏离**贴纸中心 —— 这是刻意的：宁可指得不准，也不要节点被切掉一半。
 *  ⚠ 视口比整圈还小的极端情况下（超窄手机 / 放大的浏览器）不做「反向夹取」——
 *    那样会算出比视口还大的边界，反而把锚点推到屏幕外；这里退化成「尽量靠内」。 */
export function clampAnchor(x: number, y: number): { x: number; y: number } {
  if (typeof window === "undefined") return { x, y };
  const reach = WHEEL_REACH + VIEWPORT_MARGIN;
  // 视口比整圈还小时（超窄屏 / 浏览器放大）退化成**居中**：`max - reach` 会小于 `reach`，
  // 那样上下界就反了 —— `Math.min(Math.max(…))` 会算出一个在屏幕外的锚点。
  const clamp = (value: number, max: number): number =>
    max <= reach * 2 ? max / 2 : Math.min(Math.max(value, reach), max - reach);
  return { x: clamp(x, window.innerWidth), y: clamp(y, window.innerHeight) };
}
