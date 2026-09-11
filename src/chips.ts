// 圆角胶囊 chip(单元筛选 / 我的选片日期筛选)类名单一来源。
// ⚠ 顶栏「日期条」chip 视觉不同(7px 圆角 / 13px / 品牌红实底),刻意不并入 —— 见 main.ts::CHIP_DATE_*。
// Tailwind v4 只生成源码里完整字面量出现的类,故这里必须是完整串,不可拼接。

export const PILL_BASE =
  "border rounded-full px-[10px] py-[3px] text-12 font-semibold whitespace-nowrap hover:border-biff";
export const PILL_IDLE = `${PILL_BASE} border-line bg-card text-muted hover:text-ink`;
/** ⚠ 实底走 `ink-solid`(不是 `ink`/`bg-ink`):后者在暗色下被提亮成近白,与白字撞成「白底白字」 */
export const PILL_ON = `${PILL_BASE} border-ink-solid bg-ink-solid text-on-brand`;

/** 顶部「日期条」chip —— 2026-09-11 起按官方排期页「Schedule by Date」重做:
 *  整条是一个**浅灰圆角轨道**(`#date-chips` 容器自带 `bg-raised` + `rounded-full` + 内边距),
 *  日期本身是**无边框文字钮**;选中项 = 轨道上浮起的一枚**白底胶囊 + 品牌红粗体字**(官方同款)。
 *  ⚠ 不再用描边 / 实底 —— 描边钮放进灰轨道会像「一排小方框」,失掉官方的胶囊质感。
 *  故刻意不并入 PILL_*(那是描边胶囊语义)。 */
export const BAR_BASE =
  "border-0 rounded-full px-[13px] py-[6px] text-13 whitespace-nowrap cursor-pointer " +
  "transition-colors bg-transparent";
export const BAR_IDLE = `${BAR_BASE} text-ink-2 hover:text-ink`;
export const BAR_ON = `${BAR_BASE} bg-card text-biff font-bold shadow-[0_1px_2px_rgb(0_0_0/0.10)]`;
