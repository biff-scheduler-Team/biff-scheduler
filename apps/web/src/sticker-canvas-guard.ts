/**
 * 画布的**重绘守护**(2026-09-22,PLAN-20260922145815)。
 *
 * 症状:滚动时父级会有各种无关的 re-render(顶部统计刷新、贴纸上报后的票数重拉……),
 * 画布组件每次 render 都 `clearRect` + 全量重画的话,一屏 5 张卡 × 上百枚贴纸就是白烧的长任务。
 * 做法:把「上一次真正画下去时用的参数」记下来,参数**按值**变了才重画。
 *
 * ⚠ 判据必须按**值**比:`counts` 每次 render 都是新对象(由 `filmCounts` 现算),
 *   拿对象引用比等于没守护。票数用 `redblack.ts::countsSignature()`(与「有新贴纸」提示同一套口径)。
 * ⚠ 单独成文件是为了让它能被 node 环境的单测覆盖 —— `StickerCanvas` 本身碰 DOM,进不了单测。
 */

/** 一次绘制用到的全部关键参数(全都是**值**,没有对象引用) */
export interface DrawKey {
  filmKey: string;
  /** 设备像素比 —— 跨屏拖窗 / 浏览器缩放后必须重画,否则贴纸发糊 */
  dpr: number;
  /** backing store 的物理像素宽 */
  width: number;
  /** backing store 的物理像素高 */
  height: number;
  /** 票数签名(`redblack.ts::countsSignature`) */
  counts: string;
}

/** 是否需要重画:没有上一次(首次 / 刚从视口外回来)或任一参数变了 → 要。 */
export function needsRedraw(prev: DrawKey | null, next: DrawKey): boolean {
  if (!prev) return true;
  return (
    prev.filmKey !== next.filmKey ||
    prev.dpr !== next.dpr ||
    prev.width !== next.width ||
    prev.height !== next.height ||
    prev.counts !== next.counts
  );
}
