// 圆角胶囊 chip(单元筛选 / 我的选片档位 / AI 日期选择)类名单一来源。
// ⚠ 顶栏「日期条」chip 视觉不同(7px 圆角 / 13px / 品牌红实底),刻意不并入 —— 见 main.ts::CHIP_DATE_*。
// Tailwind v4 只生成源码里完整字面量出现的类,故这里必须是完整串,不可拼接。

export const PILL_BASE =
  "border rounded-full px-[10px] py-[3px] text-12 font-semibold whitespace-nowrap hover:border-biff";
export const PILL_IDLE = `${PILL_BASE} border-line bg-card text-muted hover:text-ink`;
/** ⚠ 实底走 `ink-solid`(不是 `ink`/`bg-ink`):后者在暗色下被提亮成近白,与白字撞成「白底白字」 */
export const PILL_ON = `${PILL_BASE} border-ink-solid bg-ink-solid text-on-brand`;

/** 顶栏「日期条」chip —— 与上面的胶囊 chip **视觉不同**(7px 圆角 / 13px / 选中走品牌红实底),
 *  故刻意不并入 PILL_*(避免「统一」把顶栏日期条的选中态改掉)。 */
export const BAR_BASE = "border rounded-7 px-3 py-1 text-13 whitespace-nowrap hover:border-biff";
export const BAR_IDLE = `${BAR_BASE} border-line bg-card text-ink`;
export const BAR_ON = `${BAR_BASE} border-biff bg-biff text-on-brand font-semibold`;
