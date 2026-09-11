// 共享 UI 片段:按钮 / 图标按钮 / tab / 分段 / 缩放控件 —— 类名与工厂的**全站单一来源**。
// 2026-09-10 从 ai-panel / library / main / settings 收敛(PLAN-20260910235000):
// 同一视觉此前散落 4~5 处各写一份字面量,改一处就得记得改其余(暗色 / 移动端尤其吃亏)。
// ⚠ Tailwind v4 只生成源码里**完整字面量**出现的类,故这里必须是完整串,不可拼接。
import { el } from "./util";

/* ---------------- 按钮 ---------------- */
/** 主按钮(品牌红渐变实底)—— 弹层底部主操作 / 面板主 CTA。同一屏只应有一枚。 */
export const BTN_PRIMARY =
  "border-0 rounded-6 px-[14px] py-[6px] text-13 font-bold text-on-brand bg-[linear-gradient(135deg,var(--biff-red)_0%,var(--biff-red-2)_100%)] hover:brightness-[1.05] whitespace-nowrap";
/** 主按钮·大号(设置弹层底部「保存设置」:内距略大 + 按下位移) */
export const BTN_PRIMARY_LG =
  "border-0 rounded-6 px-[16px] py-[7px] text-13 font-bold text-on-brand bg-[linear-gradient(135deg,var(--biff-red)_0%,var(--biff-red-2)_100%)] hover:brightness-[1.05] active:translate-y-px";
/** 中断 / 取消(中性灰实底,与主按钮同尺寸以便就地互换) */
export const BTN_ABORT =
  "border border-line rounded-6 px-[14px] py-[6px] text-13 font-bold bg-raised text-ink hover:bg-raised-hover whitespace-nowrap";
/** 小号次要按钮(描边) */
export const BTN_MINI =
  "border border-line rounded-7 px-[8px] py-[3px] text-12 font-semibold bg-card text-ink hover:border-line-strong hover:bg-hover whitespace-nowrap";
/** 主按钮的禁用态(占位,避免 disabled 时改尺寸) */
export const BTN_DISABLED =
  "border-0 rounded-6 px-[14px] py-[6px] text-13 font-bold text-muted bg-raised cursor-not-allowed whitespace-nowrap";
/** 场次行主操作「定位 ▸」—— 去饱和品牌红实底(弱于 BTN_PRIMARY,不与弹层主按钮抢眼)。
 *  **紧凑档**(2026-09-11 四改,由 `BTN_GO` 改名):内距 / 圆角 / 字阶各降一档 ——
 *  场次行第 1 行的宽度要留给章组,主操作也得让出一点(它与「＋ 加入」并排,两枚合计省 ≈30px)。
 *  (旧的 `BTN_GO` 大档已删:抽屉是它唯一调用点,留着就是死代码。) */
export const BTN_GO_SM =
  "border-0 rounded-5 px-[7px] py-[2px] text-11 font-bold whitespace-nowrap " +
  "text-on-brand bg-biff-muted hover:bg-biff-hover transition-colors duration-[120ms] active:translate-y-px";
/** 日期导航 ‹ / › 步进钮(到边界置灰) */
export const NAV_BTN =
  "shrink-0 border border-line bg-card rounded-6 px-[7px] py-[2px] text-13 font-bold text-ink-2 " +
  "hover:border-line-strong hover:text-ink disabled:opacity-35 disabled:cursor-not-allowed";

/* ---------------- 图标按钮 ---------------- */
/** 卡片右上角次要图标(★ / ⓘ / ✕):常态 45% 淡显, hover 卡片才完全显现。
 *  ⚠ `ui-icon-btn` 是**触屏钩子**:触屏没有 hover,`style.css` 的 `@media (hover: none)` 直接拉满透明度。
 *  ⚠ 刻意**不用** `opacity-0`:触屏没有 hover,图标会永远看不见。 */
export const ICON_BTN =
  "ui-icon-btn border-0 bg-transparent p-0 w-[20px] h-[20px] inline-flex items-center justify-center rounded-5 " +
  "text-12 leading-none text-muted opacity-45 group-hover:opacity-100 " +
  "transition-[opacity,background-color,color] duration-[120ms] hover:bg-[var(--bg-hover-soft)]";

/* ---------------- tab / 分段 ---------------- */
const TAB_BASE = "border rounded-6 px-[9px] py-[3px] text-12 font-bold whitespace-nowrap transition-colors";
/** 抽屉 tab 选中(墨底反白)—— ⚠ 实底走 `ink-solid`:见 chips.ts::PILL_ON 注释 */
export const TAB_ON = `${TAB_BASE} border-ink-solid bg-ink-solid text-on-brand`;
/** 抽屉 tab 未选中 */
export const TAB_OFF = `${TAB_BASE} border-line bg-card text-muted hover:text-ink hover:border-line-strong`;

const SEG_BASE = "border-0 px-3 py-[5px] text-13 transition-colors";
/** 顶栏 A/B 方案段按钮:选中(品牌红实底) */
export const SEG_ON = `${SEG_BASE} bg-biff text-on-brand font-bold`;
/** 顶栏 A/B 方案段按钮:未选中 */
export const SEG_OFF = `${SEG_BASE} bg-card text-ink`;

/* ---------------- 甘特缩放控件 ---------------- */
/** − / + 缩放钮(到两端置灰) */
export const ZBTN =
  "border-0 bg-card px-[8px] py-[3px] text-12 font-bold leading-[1.5] text-ink-2 hover:bg-[var(--bg-hover-soft)] disabled:opacity-30 disabled:cursor-not-allowed";
/** 中间百分比读数(**纯读数,非按钮**) */
export const ZMID =
  "border-0 border-x border-line-soft bg-card px-[6px] py-[3px] text-12 font-bold tabular-nums text-ink min-w-[68px] leading-[1.5] text-center select-none whitespace-nowrap";
/** 「适应」/「1:1」 */
export const ZFIT =
  "border-0 border-l border-line-soft bg-card px-[9px] py-[3px] text-12 font-bold leading-[1.5] text-ink-2 hover:bg-[var(--bg-hover-soft)]";

/* ---------------- 工厂 ---------------- */
export interface ButtonOpts {
  /** tooltip 文案(走 data-tip,见 tip.ts) */
  tip?: string;
  /** 追加类 —— **只放布局 / 变体**(间距 `ml-auto` / 对齐 / `hover:` / `disabled:` / `tabular-nums`)。
   *  ⚠ **不要传字号 / 颜色 / 背景 / 圆角**:基础串是该视觉的唯一来源,覆盖它会破坏
   *    「同一视觉只有一份定义」;且同类冲突谁生效取决于 Tailwind 产出顺序(不可预期)。
   *    需要新视觉 → 改 `ui.ts` 里的基础串,而不是在这里打补丁。
   *  (2026-09-11:曾引入 tailwind-merge 自动消解冲突 —— 实测 gzip +10KB 而调用点 0 个,已撤,见 PLAN §7.8) */
  extraCls?: string;
  /** data-* 锚点(无头验收用稳定选择器,避免依赖文案) */
  data?: Record<string, string>;
  /** 置灰(到边界 / 未满足前置条件) */
  disabled?: boolean;
}

/** 通用按钮工厂 —— 收口「新建 button 再逐条赋 tip / dataset / disabled」的样板。 */
export function buttonEl(cls: string, label: string, o: ButtonOpts = {}): HTMLButtonElement {
  const b = el("button", o.extraCls ? `${cls} ${o.extraCls}` : cls, label);
  if (o.tip) b.dataset.tip = o.tip;
  if (o.data) for (const [k, v] of Object.entries(o.data)) b.dataset[k] = v;
  if (o.disabled) b.disabled = true;
  return b;
}

/** 卡片右上角图标按钮(带触屏钩子) */
export function iconButton(label: string, tip: string, extraCls = ""): HTMLButtonElement {
  return buttonEl(ICON_BTN, label, { tip, extraCls });
}
