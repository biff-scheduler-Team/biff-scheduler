/**
 * 全站「想看 / 排进行程」动作的文案与无障碍标签**唯一来源**
 * （2026-09-20，PLAN-20260920203010，第 1 轮）。
 *
 * ★ 为什么要有这个文件（用户原话：「按钮太多了」）：
 *   同一件事原先在五处各写一套措辞 —— 影片库按钮写「加入我的选片」、单场片写「加入行程」、
 *   场次卡写「加入行程」、网格格子 aria 写「加入场次 CODE」、数据更新弹层写「加入行程」。
 *   用户要自己拼出「这几句话说的是同一件事」，而这本来只是**一个动作**。
 *   收口到这里之后，改措辞只改一处，且再也写不出「第六种说法」。
 *
 * ★ 两套语义（刻意分开，不合并）：
 *   · **影片级**（`WANT_*`）= 「这部片我想看」→ 落进「我的选片」，对应 `state.ts::addPickFilm`；
 *   · **场次级**（`SCHEDULE_*`）= 「这一场我排进行程」→ 落进「我的行程」，对应 `state.ts::toggleScreening`。
 *   两者不是同一步：选片是意向，排场是行动（见 `state.ts` 文件头「选片记录 = 唯一数据源」）。
 *
 * ⚠ **「只有一场」的副作用不靠文案暗示**：单场片点「想看」会**直接排进行程**
 *   （`state.ts::addPickFilm` 的 `soleShowCode` 分支，2026-09-16 拍板）。
 *   该副作用由 `SOLE_SHOW_HINT`（悬停说明）+ 调用方的成功提示共同解释 ——
 *   不要再靠「加入行程」这种把两件事混在一起的措辞去暗示。
 *
 * ⚠ **不改的两处导航文案**（`GO_SCHEDULE_*`）：它们指向的是**页面**（「我的选片」/「我的行程」），
 *   而页面名没改；写成「已想看 / 去排场次」反而丢了「去哪儿」这个信息。
 *   收进本文件只为让相同措辞也只有一份。
 */

/* ---------------- 影片级：想看 ---------------- */

/** 影片级动作：把这部片收进「我的选片」。 */
export const WANT_LABEL = "想看";

/** 影片级反向动作。 */
export const UNWANT_LABEL = "取消想看";

/** 影片级动作的无障碍名（`想看 圣母玛利亚`）。 */
export function wantAria(title: string): string {
  return `${WANT_LABEL} ${title}`;
}

/** 影片级反向动作的无障碍名（`取消想看 圣母玛利亚`）。 */
export function unwantAria(title: string): string {
  return `${UNWANT_LABEL} ${title}`;
}

/** 「取消想看」确认框正文 —— 整片取消会**连带它的全部场次**一起消失，必须说清。
 *  `count === 0`（只是选片、没排场）时不问，与 `LibraryPage` 的既有行为一致。 */
export function unwantConfirm(title: string, count: number): string {
  return count > 0
    ? `《${title}》已排 ${count} 场，确定取消想看（含这些场次）？`
    : `确定取消想看《${title}》？`;
}

/* ---------------- 场次级：排进行程 ---------------- */

/** 场次级动作：把这一场排进「我的行程」。 */
export const SCHEDULE_LABEL = "排进行程";

/** 场次级反向动作。 */
export const UNSCHEDULE_LABEL = "移出行程";

/** 场次级动作的完成态文案（数据更新弹层里替换按钮的那个字样）。 */
export const SCHEDULED_STATE = "已排进行程";

/** 场次级动作的无障碍名。
 *  `title` 只在**网格格子**里给（那枚按钮没有可见文案，读屏只能靠 aria，多一个片名才好认）。 */
export function scheduleAria(scheduled: boolean, code: string, title?: string): string {
  const action = scheduled ? UNSCHEDULE_LABEL : SCHEDULE_LABEL;
  const suffix = title ? ` ${title}` : "";
  return `${action} 场次 ${code}${suffix}`;
}

/* ---------------- 「只有一场」的副作用 ---------------- */

/** 单场片在**片信息行**上的说明。写进可见文案而不是 `title` 悬停提示：
 *  ① S2 的 `Button` 不接 `title`；② 本站在电影节现场主要用手机，**手机没有悬停**。 */
export const SOLE_SHOW_HINT = `只有这一场，点「${WANT_LABEL}」就直接排进行程`;

/** 单场片点完之后的成功提示（`《片名》只有一场，已直接排进行程。`）。 */
export function soleShowToast(title: string): string {
  return `《${title}》只有一场，已直接排进行程。`;
}

/* ---------------- 影片级计数徽章 ---------------- */

/** 「有多少人想看」徽章里数字之后的那半句。
 *  ⚠ 从「想看 12」改成「12 人想看」是**故意的**：按钮叫「想看」之后，
 *    「想看 12」会被读成「点这里会变成 12」，而它其实是**别人**的人数。
 *  ⚠ 单独导出这半句，是为了让需要把数字加粗的调用方（`FilmDialog`）不必再手写一遍措辞。 */
export const WANT_COUNT_SUFFIX = "人想看";

/** 「有多少人想看」的徽章整句（不需要加粗数字时用它）。 */
export function wantCountLabel(count: number): string {
  return `${count} ${WANT_COUNT_SUFFIX}`;
}

/** 影片级动作成功后的提示（非单场片）。 */
export const WANT_TOAST = "已想看，可以在「我的选片」里挑场次。";

/* ---------------- 导航文案（不入动作体系，但收口一份） ---------------- */

/** 影片级动作**已完成**、且需要用户接着去挑场次时的入口文案。 */
export const GO_SCHEDULE_LABEL = "已在选片，去排场次";

/** 单场片动作已完成（已自动排好场次）时的入口文案 —— 再说「去排场次」会让人以为还差一步。 */
export const GO_VIEW_LABEL = "已在行程，去查看";
