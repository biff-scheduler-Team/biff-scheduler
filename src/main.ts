// 入口 — 装配数据/状态/视图,统一事件委托。
// 全量化:仅维护基础骨架(顶栏/面板/弹层根/Toast/底部),所有内部样式由 markup 端 Tailwind utility 表达。

import type { Catalog } from "./types";
import { OK_SLACK, dateInfo, el, filmNodeKey, hmsToMin, pickDefaultDate, todayIsoLocal } from "./util";
import { loadCatalog } from "./data";
import { computeConflicts, conflictGroupFor, type ConflictResult, type Slot } from "./conflict";
import { buildPlanSet, type PlanSet } from "./plans";
import { effEndMin, talkOnOf } from "./gv";
import {
  allCodes,
  loadAgendaFold,
  loadGvTalk,
  loadGvTalkMin,
  loadMappings,
  loadPicks,
  loadRanks,
  loadSavedPlans,
  loadSettings,
  rankOf,
  removeScreening,
  setGvTalk,
  setZoom,
  slotOf,
  store,
  subscribe,
  toggleScreening,
  type ChangeDomain,
} from "./state";
import {
  buildGrid,
  drawConflictLinks,
  fitTimeTexts,
  fitZoomLevel,
  axisStartFor,
  clampZoom,
  stepZoom,
  rowMetrics,
  labelMetrics,
  gridGeometryKey,
  patchGridStates,
  PX_PER_MIN,
  ZOOM_MAX,
  ZOOM_MIN,
  type GridCtx,
} from "./grid";
import { buildAgenda } from "./agenda";
import { buildTimeline } from "./timeline";
import { abbrTooltip } from "./badges";
import { attachTip } from "./tip";
import { buildGuideBody } from "./legend";
import {
  hasActiveFilter,
  loadFilters,
  makeFilterState,
  matchesFilters,
  renderFilterBar,
  saveFilters,
  venueAllowed,
  venueFilterKey,
} from "./filters";
import { scorePlanRows, type ScoredRow } from "./score";
import { closeAllModals, openModal, showCatalogFilmModal, showFilmModal } from "./modal";
import { closePickerDrawer, ensurePickerOpen, isMobileDrawer, isPickerDrawerOpen, openFilmPicker, setAgendaRenderer, setPickerTab, setPickerToggleHandler } from "./library";
import { openSettings, openTalkMinModal } from "./settings";
import { initTheme, isThemePref, setThemePref, themePref } from "./theme";
import { openExportPanel } from "./export-panel";
import { formatKrw, loadExtras, priceOf } from "./extras";
import { openTicketingModal, startTicketTicker } from "./ticketing";
import { downloadBackup } from "./backup";
import { openImportBackupModal } from "./backup-panel";
import { toast } from "./toast";
import { BAR_IDLE, BAR_ON } from "./chips";
import { SEG_OFF, SEG_ON, ZBTN, ZFIT, ZMID } from "./ui";

let cat: Catalog;
let currentDate = "";
let conflicts = new Map<string, ConflictResult>();
/** 顺位 → 全部无冲突方案(与 `conflicts` 同轮派生,见 `computePlanSet`) */
let plans: PlanSet = {
  groups: [],
  common: [],
  rankOf: new Map(),
  options: [],
  total: 0,
  truncated: false,
  broken: new Set(),
  droppedSameFilm: 0,
  rankClashes: [],
};
/** 甘特时间筛选:点击时间轴整点置为对应小时;null = 不过滤(切日期/再点/重置均清除) */
let hourFilter: number | null = null;
/** **甘特图那套**排片筛选(字幕 / 影厅 / GV)—— 与时间筛选**正交**,三者之间是「与」,每道内部是「或」。
 *  刻意不随切日期清空:筛选说的是「我想看什么样的场」,跨日有效。
 *  字幕 / GV 两道与 hourFilter 同一机制:不通过者只是 `hour-dim` 淡出,几何与 DOM 都不动(不跳版);
 *  **影厅**那道另有一层效果 —— 决定纵轴**整行**的去留(见 grid.ts::buildGrid)。
 *  ⚠ 状态与控件都在 `filters.ts`,但**只有甘特图在用这一份**:影片库抽屉另有一份独立状态
 *    (`library.ts::libFilters`,持久化键也不同)—— 两处各筛各的,互不影响(2026-09-11 用户要求)。 */
const filters = makeFilterState();
/** 甘特缩放 —— **横纵共用的单一倍率**(整体等比):横向时间刻度 = PX_PER_MIN × zoom,
 *  纵向行高 = ROW_H × zoom,卡片内字号 / 留白 / 色点 / 徽章行全部按同一倍率**线性**缩 ——
 *  卡片变小的时候内部排版严格等比,不会挤乱。持久化在 store.settings.zoom(视图偏好)。 */
let zoom = 1;
/** 网格**横向**视口记忆:锚点 = 容器内某个屏幕 x(相对容器左缘)对应的时刻。
 *  网格每次重建都换新滚动容器(scrollLeft 会归零)—— 同日期重建(选片/优先级/分钟推进/缩放)
 *  把锚点时刻重新对回原 x(缩放前后视口不跳);换日期/首渲不恢复(回最左)。
 *  缩放时由 applyZoom 按**旧倍率**预先算好挂在这里(renderGrid 里那时 zoom 已经变了)。
 *  纵向另有一套:走 rowAnchor() 的实测行号 + window.scrollBy(见下)。 */
let pendingAnchor: { min: number; screenX: number } | null = null;
let lastGridDate = "";
/** 上一次**全量重建**时的几何签名(见 grid.ts::gridGeometryKey)。
 *  与当前签名相同 ⇒ 网格结构可整体复用,`renderGrid` 只走 `patchGridStates` 重刷状态。 */
let lastGridKey = "";
/** 最近一次在网格里点选的场次 code —— 抽屉会因这次点选滑出并把网格挤窄,
 *  用它把那张卡带回视野(见 boot 里的 setPickerToggleHandler)。 */
let lastToggledCode: string | null = null;

/** code → 影片节点 key(全站单一 key 口径:grid / agenda / 影片库 / 详情弹层同源);
 *  排期里已没有该 code(数据换版)时返回 null。 */
function filmKeyOfCode(code: string): string | null {
  const s = cat.byCode.get(code);
  return s ? filmNodeKey(cat, s) : null;
}

/** 影片**资料**弹层的公共上下文(网格 ⓘ 与影片库共用)。
 *  弹层只给「资料 + 豆瓣」—— 场次列表唯一入口在影片库行内展开(见 library.ts::LibraryCtx.onToggle)。 */
function filmModalCtx() {
  return { cat, mappings: store.mappings };
}

/** 影片库 / 我的选片 共用上下文 —— 同一份数据(store.picks)的两个视图,两处入口行为一致 */
function libraryCtx() {
  return {
    cat,
    picks: store.picks,
    slots: store.slotIndex,
    mappings: store.mappings,
    onLocate: jumpToScreening,
    onToggle: toggleScreening, // 唯一场次列表(影片库行内展开)的加入/移出 → 与网格整卡点选同源
    // ⚠ 排片筛选**不在这里传**:抽屉有自己那份状态(`library.ts::libFilters`),与甘特图
    //    (`main.ts::filters`)互相独立 —— 在时间轴上点掉几家影院,影片库列表不会跟着变。
    //    控件与判定仍是同一套(filters.ts),只是状态两份(2026-09-11 用户要求「分开」)。
    onFilm: (code: string) => {
      // 详情压在列表之上(弹层栈),「← 返回」回列表 —— 不再 closeModal() 把列表销毁
      // f### = 目录片 id(暂无排期):走目录片弹层,可先关联豆瓣
      if (/^f\d{3}$/.test(code)) showCatalogFilmModal(code, filmModalCtx());
      else showFilmModal(code, filmModalCtx());
    },
  };
}

/* ---------------- 状态 -> 视图 ---------------- */

/** GV 映后谈是否参加:单场覆写(gvTalk)优先,缺省跟随 Settings.gvTalkOn(默认含)。
 *  解析收口在 gv.ts::talkOnOf(引擎 / 导出也要用同一口径);talk=0(非 GV / 映后时长配成 0)
 *  的场次无拆分无开关,调用方按需守卫。 */
function gvTalkOf(code: string): boolean {
  return talkOnOf(code);
}

function computeAllConflicts(): Map<string, ConflictResult> {
  const slots: Slot[] = [];
  for (const code of allCodes()) {
    const s = cat.byCode.get(code);
    if (!s) continue;
    // 有效结束:放弃映后谈 → 正片末(该场与后场冲突/需缓冲即刻按单卡重判)
    slots.push({
      code,
      date: s.date,
      start: hmsToMin(s.start_time),
      end: effEndMin(s, gvTalkOf(code)),
      venue: s.venue_id,
    });
  }
  return computeConflicts(slots, (a, b) => (a === b ? 0 : store.settings.transitMin));
}

/** 顺位 → N 套方案(见 `plans.ts`)。**与 `conflicts` 同轮派生** —— 两者必须同源,
 *  否则「拖动顺位」之后方案对比会与冲突红标对不上。
 *  组内兜底排序键只取**开始时刻**:冲突组按 `date` 分桶,组内必然同一天(见 plans.ts 文件头)。
 *  影片 key 走 `filmKeyOfCode`(与网格 / 影片库 / 详情弹层同一口径)—— 同一套方案里同片只留一场。 */
function computePlanSet(): PlanSet {
  return buildPlanSet(
    allCodes(),
    conflicts,
    rankOf,
    (code) => {
      const s = cat.byCode.get(code);
      return s ? hmsToMin(s.start_time) : 0;
    },
    filmKeyOfCode
  );
}

function totalConflictPairs(): number {
  let n = 0;
  conflicts.forEach((c) => (n += c.pairs.length));
  return n;
}

/** 状态 → 视图。`domain` = 本次变更域(见 state.ts::ChangeDomain)。
 *
 *  **唯一可安全跳过的域是 `"theme"`**:全站配色由 CSS token 驱动(`:root[data-theme]`),
 *  主题切换只改 token,不改变任何 DOM 结构 —— 故只需刷新顶栏那枚选择器的选中态。
 *  其余域(含 `"settings"`:`transitMin` 影响紧转场、`gvTalkMin` 影响几何)都必须走网格重绘,
 *  网格内部再按几何签名决定「全量重建」还是「就地 patch」(见 renderGrid)。 */
function renderAll(domain: ChangeDomain = "all"): void {
  if (domain === "theme") {
    renderThemeSeg();
    return;
  }
  // 行程按日收起 / 展开:纯抽屉内视图折叠 —— 网格 / 顶栏 / 角标全不受影响,
  // 由 library.ts 的抽屉订阅重绘 agenda tab(不在这里做任何重建,避免白刷整张网格)。
  if (domain === "agenda") return;
  conflicts = computeAllConflicts();
  plans = computePlanSet();
  renderChips();
  renderFilters();
  renderBadge();
  renderPicksBadge();
  renderThemeSeg();
  // 选片抽屉**不隐藏**网格 / 行程(它只挤压宽度),故这里无条件重建 —— 旧的「页面打开时早退」
  // 已随页面形态一起作废;抽屉开合导致的宽度变化由 library.ts 回调 renderGrid() 补(见 setPickerToggleHandler)。
  renderGrid();
  // 2026-09-10 起「我的行程」从主页面 #agenda-wrap 搬到选片抽屉的第三个 tab(`PLAN-20260910190916`):
  //   抽屉 agenda tab 通过 `setAgendaRenderer(buildAgendaHost)` 注入,store 变化时由抽屉的
  //   `subscribe` 自动重绘 —— 不需要在这里调用。
  renderZoomCtl();
}

/* 顶栏日期 chip 的字面量已收敛到 `chips.ts`(BAR_IDLE / BAR_ON)。 */

function renderChips(): void {
  const bar = document.getElementById("date-chips")!;
  bar.innerHTML = "";
  for (const d of cat.dates) {
    const { label, weekday } = dateInfo(d);
    const dayShows = cat.schedule.screenings.filter((s) => s.date === d).length;
    const cls = d === currentDate ? BAR_ON : BAR_IDLE;
    const btn = el("button", cls, label);
    btn.dataset.tip = `${label} ${weekday} · ${dayShows} 场排片`;
    btn.dataset.date = d;
    bar.appendChild(btn);
  }
}

/* ---------------- 排片筛选(字幕 / 影厅 / GV) ----------------
 * 控件与判定都在 `filters.ts`(网格与影片库共用);这里只负责「往哪画 + 画完重绘什么」。
 * 网格侧永远铺开三行(宽度够);影片库那侧在窄抽屉里,走可折叠形态(见 library.ts)。 */

/** **甘特图那套**排片筛选变化的唯一收口:
 *  ① 落盘 —— 「记住你的选项」(见 filters.ts::saveFilters);
 *  ② 重画网格筛选条(选中态)+ 网格。
 *  ⚠ **不再同步抽屉**:两处状态已分开(见 `libraryCtx` 注释与 `library.ts::libFilters`),
 *    抽屉那边有自己的筛选条与重绘时机,不该被时间轴上的改动带着重画。
 *  ⚠ 影厅那道会改**纵轴行集合**,故 renderGrid 会走全量重建(几何签名含 venueFilterKey);
 *    字幕 / GV 两道只改状态,走 patch 不跳版。 */
function onFiltersChanged(): void {
  saveFilters(filters);
  renderFilters();
  renderGrid();
}

/** 网格筛选条:任何一道变化 → 重画筛选条 + 重绘网格(影厅那道会改行集合 → 重建) */
function renderFilters(): void {
  const host = document.getElementById("grid-filters");
  if (!host) return;
  renderFilterBar(host, filters, {
    venues: cat.venues,
    onChange: onFiltersChanged,
  });
}

/* ---------------- 甘特缩放 ---------------- */

/** **横向**视口锚点:容器视口中心对应的时刻。
 *  轨道在容器内从 x = labelW 起算(左侧粘性影厅列宽,随缩放倍率变),故 x 至少取到影厅列右缘 ——
 *  视口比影厅列还窄时锚定列缘,避免算出轴界之外的负数时刻。
 *  列宽一律取自 `grid.ts::labelMetrics`(与 buildGrid 同源),这里按**当前** zoom 取旧列宽。 */
function gridAnchor(scroll: HTMLElement): { min: number; screenX: number } {
  const px = PX_PER_MIN * zoom;
  const lw = labelMetrics(px).labelW;
  const screenX = Math.max(scroll.clientWidth / 2, lw);
  return { min: axisStartFor(cat, currentDate) + (scroll.scrollLeft + screenX - lw) / px, screenX };
}

/** 网格工作台视口高度(2026-09-11 工作台化):限高后横向滚动条常驻容器底部、纵向滚动条落在容器右缘 ——
 *  旧版横向滚动条长在「标尺 + 29 行」这整块内容的最底部,要横向滚动必须先滚到页面最底,
 *  且 overlay 滚动条会浮在最后一行卡片上。
 *  高度 = 视口高 − 网格顶边在**页面坐标**中的位置 − 底部呼吸位(用页面坐标,页面已滚动也不受影响)。
 *  ⚠ 必须在挂载后量(`getBoundingClientRect` 要真实布局);窗口缩放 / 顶栏折行 / 抽屉开合
 *    (改网格宽度 → 上方标题行可能折行)都会让顶边位置变,需重算。 */
function fitGridHeight(grid: HTMLElement): void {
  const wrapTop = grid.getBoundingClientRect().top + window.scrollY;
  grid.style.maxHeight = `${Math.max(320, Math.round(window.innerHeight - wrapTop - 20))}px`;
}

/** **纵向**视口锚点:参考线(网格视口顶边;网格顶若还在参考线下方则用网格顶)落在第几行(小数行号)。
 *  ★ 2026-09-11 工作台化:纵向滚动从**页面**移到**网格容器**(`#grid-scroll` 限高 + `overflow-auto`),
 *  于是参考线由「视口顶 0」改为「容器顶边」,回补由 `window.scrollBy` 改为容器 `scrollTop`。
 *  仍必须记锚点:重建会换新容器(scrollTop 归零),正在看的第 20 厅会瞬间跳回第 0 行。
 *  行高从相邻两行的 top 差**实测**,不读任何常量(将来改行高公式也不会失效)。 */
function rowAnchor(grid: HTMLElement): { row: number; refY: number } | null {
  const rows = grid.querySelectorAll<HTMLElement>("[data-vrow]");
  if (rows.length < 2) return null;
  const top = rows[0].getBoundingClientRect().top;
  const h = rows[1].getBoundingClientRect().top - top;
  if (!(h > 1)) return null;
  // 网格顶还在参考线下方(没滚到它)→ 以网格顶为参考线,锚点即第 0 行
  const refY = Math.max(top, grid.getBoundingClientRect().top);
  return { row: (refY - top) / h, refY };
}

/** 重建后把锚点行拉回参考线:delta > 0 = 该行跑到参考线下方了 → 向上滚。
 *  视口够不着(已到容器两端)时浏览器会自行 clamp,这是预期行为,不再补偿。 */
function applyRowAnchor(grid: HTMLElement, a: { row: number; refY: number }): void {
  const rows = grid.querySelectorAll<HTMLElement>("[data-vrow]");
  if (rows.length < 2) return;
  const top = rows[0].getBoundingClientRect().top;
  const h = rows[1].getBoundingClientRect().top - top;
  if (!(h > 1)) return;
  const delta = top + a.row * h - a.refY;
  if (Math.abs(delta) > 0.5) grid.scrollTop += delta;
}

/** 缩放:改**横纵共用**的倍率并就地重绘网格(整体等比)。**只重绘网格** —— 缩放不影响行程 / 角标,
 *  走 notify → renderAll 是白干。横向视口锚点按**旧**倍率预算好(见 pendingAnchor);纵向视口由
 *  renderGrid 里的 rowAnchor 兜住。fromLeft = 轴起点贴左(「适应」用)。 */
function applyZoom(next: number, opts: { fromLeft?: boolean } = {}): void {
  const z = clampZoom(next);
  if (Math.abs(z - zoom) <= 1e-4 && !opts.fromLeft) {
    renderZoomCtl();
    return;
  }
  const scroll = document.getElementById("grid-scroll");
  // fromLeft:轴起点贴左 → screenX 取**新**倍率下的列宽(renderGrid 用同一个值回算 ⇒ scrollLeft 恰为 0);
  // 其余路径按**旧**倍率算锚点(此刻 zoom 尚未改,gridAnchor 读到的就是旧列宽)。
  pendingAnchor = opts.fromLeft
    ? { min: axisStartFor(cat, currentDate), screenX: labelMetrics(PX_PER_MIN * z).labelW }
    : scroll
      ? gridAnchor(scroll)
      : null;
  zoom = z;
  setZoom(z); // 持久化视图偏好(不广播 —— 下面这行自己重绘)
  renderGrid();
  renderZoomCtl();
}

/** 「1:1」:回到原始比例 100%(横向刻度与纵向行高一起回基准)。 */
function resetZoom(): void {
  applyZoom(1);
}

/** 缩放控件(网格标题行右侧):− / 读数(**纯读数,非按钮**) / + / 适应宽度 / 1:1。
 *  − / + 沿缩放阶梯走(横纵一起缩),到两端置灰;读数常显「缩放 xx%」。
 *  「适应宽度」把当天整条时间轴塞进视口(横纵一起缩),「1:1」回基准比例。 */
/* 缩放控件的字面量已收敛到 `ui.ts`(ZBTN / ZMID / ZFIT)。 */

function zoomBtn(label: string, act: string, tip: string, dis: boolean, cls: string): HTMLButtonElement {
  const b = el("button", cls, label);
  b.dataset.zoom = act;
  b.dataset.tip = tip;
  if (dis) b.disabled = true;
  return b;
}

function renderZoomCtl(): void {
  const host = document.getElementById("zoom-ctl");
  if (!host) return;
  // ★ 窄屏 = 单日时间线:**整枚缩放控件隐藏** —— 时间线没有「横向刻度」,缩放无意义
  //   (2026-09-12,PLAN-20260912002532)。隐藏而不是禁用:留着四枚灰按钮只是噪声。
  if (isMobileDrawer()) {
    host.classList.add("is-hidden");
    host.replaceChildren();
    return;
  }
  host.classList.remove("is-hidden");
  const pct = `${Math.round(zoom * 100)}%`;
  const readout = el("span", ZMID, `缩放 ${pct}`);
  readout.dataset.tip =
    `整体等比缩放 ${pct} —— 横向时间刻度与纵向行高一起缩,卡片内字号 / 留白 / 色点 / 徽章行全部同倍率线性缩,` +
    `排版严格等比(矮到放不下时徽章行收起,等级 / 字幕 / 页码在 ⓘ 与悬停里仍在)`;
  host.replaceChildren(
    zoomBtn("−", "out", `缩小(当前 ${pct})—— 一屏看到更多影厅,时间轴同步收窄\n也可按住 Ctrl / ⌘ 滚轮(触控板双指捏合)`, zoom <= ZOOM_MIN + 1e-6, ZBTN),
    readout,
    zoomBtn("+", "in", `放大(当前 ${pct})—— 卡片更舒展、徽章行更清楚,时间轴同步展宽\n也可按住 Ctrl / ⌘ 滚轮(触控板双指捏合)`, zoom >= ZOOM_MAX - 1e-6, ZBTN),
    zoomBtn("适应", "fit", "适应宽度:在缩放阶梯里挑一个刚好把当天整条时间轴塞进视口的档(横纵一起缩,左缘对齐轴起点)", false, ZFIT),
    zoomBtn("1:1", "reset", `回到原始比例 100%(当前 ${pct})\n横向时间刻度与纵向行高一起回到基准`, false, ZFIT)
  );
}

/** 网格标题行(日期标题 + 场次数 + 「只看 X 段」pill)—— 全量重建与就地 patch **都要**刷新 */
function renderGridMeta(): void {
  const { label, weekday } = dateInfo(currentDate);
  const dayList = cat.schedule.screenings.filter((s) => s.date === currentDate);
  const dayShows = dayList.length;
  const pickedOnDay = allCodes().filter((c) => cat.byCode.get(c)?.date === currentDate).length;
  document.getElementById("grid-date-title")!.textContent = `${label} ${weekday} · 排片总览`;
  const countEl = document.getElementById("grid-count")!;
  // 有筛选时把「命中 / 当日总数」摆出来 —— 否则用户会以为当天只有这么几场(淡出不是隐藏)
  const shown = hasActiveFilter(filters) ? dayList.filter((s) => matchesFilters(s, filters)).length : dayShows;
  countEl.textContent = hasActiveFilter(filters)
    ? `${shown}/${dayShows} 场(已筛选)· 本组已选 ${pickedOnDay} 场`
    : `${dayShows} 场 · 本组已选 ${pickedOnDay} 场`;
  if (hourFilter != null) {
    const hh = String(hourFilter).padStart(2, "0");
    const pill = el(
      "button",
      "ml-[8px] border border-biff bg-biff-soft text-biff-ink rounded-5 px-[8px] py-px text-12 font-bold align-middle cursor-pointer hover:bg-biff-line whitespace-nowrap",
      `只看 ${hh}:00 段 · 取消`
    );
    pill.dataset.clearHour = "1";
    pill.dataset.tip = "点击取消时间筛选";
    countEl.appendChild(pill);
  }
}

/** 网格几何签名(见 grid.ts::gridGeometryKey)+「现在」线的当前分钟。
 *  分钟进签名是**刻意**的:「现在」线画在网格内部,分钟一变位置就变 ——
 *  与旧版每 20s 轮询、分钟变化即重建整网格的行为逐字一致(不是本轮引入的回归)。 */
function gridKeyNow(): string {
  // 影厅筛选进签名:它决定纵轴**行集合**(行数会变 ⇒ 必须全量重建,见 grid.ts::buildGrid)
  const base = gridGeometryKey(
    cat,
    currentDate,
    PX_PER_MIN * zoom,
    rowMetrics(zoom).rowH,
    venueFilterKey(filters)
  );
  if (todayIsoLocal() !== currentDate) return base;
  const d = new Date();
  return `${base}|now:${d.getHours() * 60 + d.getMinutes()}`;
}

/** 窄屏时间线是否已挂载 —— 切回宽屏 / 跨断点时要作废,让二维网格走全量重建。 */
let timelineMounted = false;

/** **窄屏(≤768px)的单日纵向时间线** —— 二维网格在手机上不可用(26 厅 × 时间轴),故整块替换。
 *
 *  与 `renderGrid` 的分工:那个走「几何签名 → 就地 patch」;时间线**始终全量重建**
 *  (单日 ≈75 场,重建成本可接受;它也没有「几何未变」这个概念 —— 底色随选片实时变)。
 *  ⚠ 刻意**不碰** `lastGridDate` / `lastGridKey` / `pendingAnchor` 这些二维网格的模块级状态:
 *    分支在最前面,宽屏路径逐字未动;`timelineMounted` 只用来告诉 `renderGrid`「二维容器没了」。
 *  ⚠ 容器 id 仍为 `grid-scroll`、仍带 `data-grid="1"`:既有定位(`jumpToScreening`)、
 *    闪烁回执(`flashScreening`)、`fitTimeTexts` 等一律照常工作,不需要第二套锚点口径。
 *  ⚠ **不限高**(二维网格的 `fitGridHeight` 不调用):手机上「页面滚动」比「容器内嵌套滚动」自然,
 *    限高后还要在一条 390px 宽、内容却是长列表的容器里再滚一次,手势容易打架。 */
function renderTimeline(): void {
  const host = document.getElementById("grid-scroll");
  if (!host) return;
  const grid = buildTimeline(timelineCtx(), currentDate);
  grid.id = "grid-scroll";
  host.replaceWith(grid);
  grid.style.maxHeight = ""; // 覆盖可能残留的二维网格限高
  timelineMounted = true;
  lastGridDate = ""; // 作废二维网格的复用标记(切回宽屏必须全量重建)
  lastGridKey = "";
  renderGridMeta();
}

/** 时间线上下文 —— 与二维网格**同一份**筛选 / 已选 / 冲突(时间线不是第二个视图,是同一个视图的窄屏形态) */
function timelineCtx() {
  return {
    cat,
    filters,
    slots: store.slotIndex,
    gvTalkOf,
    transitMin: store.settings.transitMin,
    conflictCodes: conflicts.get(currentDate)?.codeSet,
  };
}

function renderGrid(opts: { force?: boolean } = {}): void {
  // ★ 窄屏 = 单日时间线(2026-09-12,PLAN-20260912002532):整块替换二维网格,分支放在最前。
  if (isMobileDrawer()) {
    renderTimeline();
    return;
  }
  if (timelineMounted) {
    // 刚从窄屏切回宽屏:时间线容器还在,`host.dataset.grid` 也是 "1" —— 必须强制全量重建
    timelineMounted = false;
    opts = { force: true };
  }
  const host = document.getElementById("grid-scroll")!;
  const conf = conflicts.get(currentDate);
  const pxPerMin = PX_PER_MIN * zoom;
  const ctx: GridCtx = {
    cat,
    pxPerMin,
    slots: store.slotIndex,
    mappingOf: (c) => store.mappings.get(c),
    conflictCodes: conf?.codeSet,
    conflictPairs: conf?.pairs,
    transitMin: store.settings.transitMin,
    gvTalkOf,
    hourFilter,
    filters, // 字幕 / 影厅 / GV 三道筛选(状态在 filters.ts,网格与影片库共用)
    row: rowMetrics(zoom), // 行几何(行高 / 字号倍率 / 留白 / 徽章行开关)单一来源,随缩放倍率
  };
  const key = gridKeyNow();

  // ★ 几何未变 → **就地 patch**(点选 / 移出 / 改档位 / 冲突 / 紧转场 / 时间筛选 / 切方案都不再重建 DOM)。
  //   不换节点 ⇒ scrollLeft 与页面滚动位置天然保持,连锚点回算都不需要。
  //   `pendingAnchor` 非空(缩放 / 「适应宽度」预算过锚点)时必须走重建 —— 见下方 anchor 消费。
  if (
    !opts.force &&
    pendingAnchor === null &&
    host.dataset.grid === "1" &&
    currentDate === lastGridDate &&
    key === lastGridKey
  ) {
    patchGridStates(host, ctx, currentDate);
    drawConflictLinks(host, conf); // 冲突组变化 → 跨行连线随之重画(挂载后实测,不读常量)
    renderGridMeta();
    return;
  }

  // ---- 以下 = 全量重建(换日期 / 缩放 / 改映后时长 / 抽屉开合 / 首渲)----
  // 换节点前先记**两个方向**的视口锚点(必须都在 replaceWith 之前量 —— 新容器一挂上,旧 rect 就没了):
  //   横向 —— 缩放走 applyZoom 预算好的(那时 zoom 还是旧值),其余同日期重建按当前倍率就地算;
  //   纵向 —— 行高一变页面总高就变,不记行号会被浏览器的 scrollY clamp 甩到别处(见 rowAnchor);
  //   切日期 / 首渲两者都为空 → 横向回最左、纵向不补偿(保持页面滚动位置)。
  const anchor = pendingAnchor ?? (currentDate === lastGridDate ? gridAnchor(host) : null);
  pendingAnchor = null;
  const vAnchor = currentDate === lastGridDate ? rowAnchor(host) : null;
  const newLw = labelMetrics(pxPerMin).labelW; // 影厅列宽随缩放倍率 —— 回算 scrollLeft 必须用**新**列宽
  const grid = buildGrid(ctx, currentDate);
  host.replaceWith(grid);
  grid.id = "grid-scroll";
  // 横向锚点回算:同一日期内刻度可能变了(「适应宽度」/「1:1」),故必须用新刻度重算 scrollLeft
  if (anchor) {
    const left = (anchor.min - axisStartFor(cat, currentDate)) * pxPerMin - (anchor.screenX - newLw);
    grid.scrollLeft = Math.max(0, Math.min(left, grid.scrollWidth - grid.clientWidth));
  }
  // 纵向锚点回算:必须在挂载后量(行高要实测);放在横向之后 —— scrollBy 改页面滚动、scrollLeft 改容器,
  // 两者互不干扰,但先定横向再补纵向更贴近「用户看到的那一屏」
  if (vAnchor) applyRowAnchor(grid, vAnchor);
  lastGridDate = currentDate;
  lastGridKey = key;
  fitGridHeight(grid); // ★ 工作台化:限高(横向滚动条常驻容器底部 + 纵向滚动条落在右缘)—— 必须挂载后量
  fitTimeTexts(grid); // 挂载后量测:窄卡时间文本降级,绝不截断
  drawConflictLinks(grid, conf); // 挂载后量测:把同一冲突组的两张卡跨行连起来(隔着几十行也看得见)
  renderGridMeta();
}

// 2026-09-10 起「我的行程」从主页面 #agenda-wrap 搬到选片抽屉的第三个 tab(`PLAN-20260910190916`):
//  原 `renderAgenda()`(把 `buildAgenda` 挂到 `#agenda`、写 `#agenda-summary`、追加质量分标签)
//  全部迁到下方的 `buildAgendaHost()`,由 `setAgendaRenderer()` 注入给抽屉,抽屉内 agenda tab
//  每次重绘时调用。主页面不再有 `#agenda-wrap` / `#agenda-summary` / `#agenda` 挂载点。

/** 「我的行程」抽屉 agenda tab 的**注入渲染函数**(2026-09-10,`PLAN-20260910190916`):
 *  - 摘要行(N 场 · M 处冲突 + 质量分标签)替代原来的 `#agenda-summary`(被删)
 *  - 行程 body = `buildAgenda(...)`,保留 `id="agenda"` 以让 `HOVER_SEL` 仍然命中。
 *  - 每次抽屉 agenda tab 重绘时调用,读 main 的 `conflicts` / `plans` / `gvTalkOf` / `currentDate` / `hourFilter` 闭包值。 */
function buildAgendaHost(): HTMLElement {
  const wrap = el("div", "grid gap-[8px]");

  // 摘要行(原 #agenda-summary,现在是 agenda tab 顶部的一行)
  const picked = allCodes();
  const nConf = totalConflictPairs();
  const sum = el(
    "div",
    "px-3 pt-[2px] pb-[2px] text-12 text-meta flex items-center gap-[6px] flex-wrap",
    `${picked.length} 场${nConf ? ` · ${nConf} 处冲突` : ""}`
  );
  // 总花费估算 —— 按官网价目表逐场累加(开闭幕 ₩30,000 / 午夜 ₩20,000 / 大师班 ₩15,000 / 普通 ₩10,000)
  const totalKrw = picked.reduce((n, code) => {
    const s = cat.byCode.get(code);
    return n + (s ? priceOf(s) : 0);
  }, 0);
  if (totalKrw > 0) {
    const cost = el(
      "span",
      "inline-flex items-center border border-line rounded-5 bg-card px-[8px] leading-[1.7] text-12 font-extrabold tabular-nums text-ink-2 whitespace-nowrap cursor-help",
      `票 ${formatKrw(totalKrw)}`
    );
    cost.dataset.tip =
      `按官网价目表估算的全部票价 ${formatKrw(totalKrw)}\n` +
      "开闭幕式 ₩30,000 · Midnight Passion ₩20,000 · Actors' House / Master Class ₩15,000 · 普通场次 / Cine Class ₩10,000\n" +
      "不含折扣(老人 / 残障 / 退伍军人可减 ₩3,000,需证件);以购票页实付为准";
    sum.appendChild(cost);
  }
  // 质量分标签(P0-2:仅展示,不改排序)
  const rows: ScoredRow[] = [];
  for (const code of picked) {
    const s = cat.byCode.get(code);
    if (s) rows.push({ screening: s });
  }
  if (rows.length) {
    const sc = scorePlanRows(rows, store.settings.transitMin, OK_SLACK, (s) => effEndMin(s, gvTalkOf(s.code)));
    const pill = el(
      "span",
      "inline-flex items-center border border-line rounded-5 bg-card px-[8px] leading-[1.7] text-12 font-extrabold tabular-nums text-ink-2 whitespace-nowrap cursor-default hover:border-biff hover:text-biff-ink",
      `分 ${sc.total}`
    );
    pill.dataset.tip =
      `行程质量分 ${sc.total} —— 排了就算数:每场 +1 · GV +1 · 紧转场 −1\n` +
      `场次 ${sc.count}${sc.gv ? ` + GV ${sc.gv}` : ""}${sc.tight ? ` − 紧转场 ${sc.tight}` : ""} = ${sc.total}`;
    sum.appendChild(pill);
  }
  wrap.appendChild(sum);

  // 行程 body
  const body = buildAgenda({
    cat,
    slots: store.slotIndex,
    mappings: store.mappings,
    transitMin: store.settings.transitMin,
    gvTalkOf,
    conflicts,
    plans, // 顺位 → N 套方案(与 conflicts 同轮派生;见 computePlanSet)
    filmKeyOf: filmKeyOfCode, // 顺位撞车检测 / 一键修复(与网格 / 影片库同一 key 口径)
    slotDate: currentDate,
    slotHour: hourFilter,
  });
  body.id = "agenda"; // HOVER_SEL "#agenda [data-code]" 仍命中
  wrap.appendChild(body);

  return wrap;
}

function renderBadge(): void {
  const n = totalConflictPairs();
  const badge = document.getElementById("conflict-badge")!;
  badge.classList.toggle("is-hidden", n === 0);
  document.getElementById("conflict-count")!.textContent = String(n);
}

/** 顶栏「影片库 · 选片」实时计数 = 影片记录数(打标 / 点选场次 → commit 广播 → renderAll → 这里刷新;0 时角标隐藏) */
function renderPicksBadge(): void {
  const n = store.picks.size;
  const cnt = document.getElementById("picker-count");
  if (!cnt) return;
  cnt.textContent = String(n);
  cnt.classList.toggle("is-hidden", n === 0);
}

/** 顶栏「外观」三段选择器(2026-09-11):跟随系统 / 亮色 / 暗色 —— **点哪段就是哪段**。
 *  只刷选中态(与顶栏其它段按钮共用 ui.ts 的 SEG_ON / SEG_OFF,单一视觉来源);
 *  文案 / tooltip 是静态的,写在 index.html 上,故这里不重建节点(保住悬停 tooltip 不闪)。
 *  切主题的实际落盘 / 重绘在 theme.ts(改 data-theme + setSettings → 广播 → 本函数刷新选中态)。 */
function renderThemeSeg(): void {
  document.querySelectorAll<HTMLButtonElement>("#theme-switch [data-theme-pref]").forEach((b) => {
    b.className = b.dataset.themePref === themePref() ? SEG_ON : SEG_OFF;
  });
}

/** 顶栏抽屉按钮文案(2026-09-10,PLAN-20260910235000)——
 *  窄屏「列表优先」时抽屉就是**主视图**,文案必须表达「点了会去哪」:
 *  抽屉开着 → 「时间轴 ▸」(回网格);关着 → 「列表 · 行程」(去列表)。
 *  宽屏维持「选片 · 行程」(抽屉是并列的辅助面板,不涉及主次切换)。 */
function updatePickerLabel(): void {
  const label = document.getElementById("picker-btn-label");
  if (!label) return;
  label.textContent = !isMobileDrawer()
    ? "选片 · 行程"
    : isPickerDrawerOpen()
      ? "时间轴 ▸"
      : "列表 · 行程";
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents(): void {
  document.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;

    // 日期条(切日期同时清除时间筛选)
    const chip = t.closest<HTMLElement>("[data-date]");
    if (chip) {
      currentDate = chip.dataset.date!;
      hourFilter = null;
      renderChips();
      renderGrid();
      // 行程已搬进抽屉(2026-09-10):抽屉 agenda tab 通过 subscribe 自动重绘 —— 无需调 renderAgenda
      return;
    }

    // 甘特时间筛选:点击时间轴整点 → 只看该小时段;再点同一小时取消(行程侧同步高亮/淡化)
    const hourHit = t.closest<HTMLElement>("#grid-scroll [data-hour]");
    if (hourHit) {
      const h = Number(hourHit.dataset.hour);
      hourFilter = hourFilter === h ? null : h;
      renderGrid();
      return;
    }
    // 标题旁「只看 X 段 · 取消」pill
    const clearHour = t.closest<HTMLElement>("[data-clear-hour]");
    if (clearHour) {
      hourFilter = null;
      renderGrid();
      return;
    }

    // 甘特缩放:− / + 沿缩放阶梯走(横纵一起缩);「适应」把整天塞进视口(横纵一起缩);「1:1」回基准比例
    const zc = t.closest<HTMLElement>("#zoom-ctl [data-zoom]");
    if (zc) {
      const act = zc.dataset.zoom;
      if (act === "in") applyZoom(stepZoom(zoom, 1));
      else if (act === "out") applyZoom(stepZoom(zoom, -1));
      else if (act === "reset") resetZoom();
      else if (act === "fit") {
        const scroll = document.getElementById("grid-scroll");
        if (scroll) applyZoom(fitZoomLevel(cat, currentDate, scroll.clientWidth), { fromLeft: true });
      }
      return;
    }

    // 顶栏「选片 · 行程」= 左侧挤压抽屉的开关(三个 tab:影片库 / 我的选片 / 我的行程)。
    // 已打开时再点 = 收起(而不是重建内容丢搜索 / 筛选状态)。
    // ⚠ 落点**固定「我的选片」**(2026-09-11,用户反馈「行程应该跳我的选片,不要跳到影片库」):
    //   旧写法 `openFilmPicker()` 走「上次停留的 tab」,而 `pickerTab` 初值是 `lib` ——
    //   首开(以及上次停在影片库时)都落到影片库,与按钮文案不符。
    //   现在这条入口落在工作台的**中段**:「我的选片」= 已收的片 + 每片全部可选场次,
    //   进可挑场次、退可看已选;要看全部影片点旁边「影片库」tab 即可(一点即达)。
    // ⚠ 不在这里补 renderGrid():抽屉的开 / 收自己会回调(见 setPickerToggleHandler),
    //   否则同一次开合会重绘网格两遍。
    if (t.closest("#library-btn")) {
      if (isPickerDrawerOpen()) closePickerDrawer();
      else openFilmPicker(libraryCtx(), "pick");
      return;
    }

    // 网格卡片:详情钮优先;其次 GV 映后谈块(拼接卡右侧,点它 = 只加正片 / 翻转让弃);
    // 再其次整卡选中/取消
    const info = t.closest<HTMLElement>("[data-info]");
    if (info) {
      showFilmModal(info.dataset.info!, filmModalCtx());
      return;
    }
    const talkHit = t.closest<HTMLElement>("#grid-scroll [data-talk]");
    if (talkHit) {
      const code = talkHit.dataset.code!;
      if (slotOf(code)) {
        // 已选:翻转含↔弃(覆写落 localStorage,不删场次、不动全局默认)
        setGvTalk(code, !talkOnOf(code));
      } else {
        // 未选:一枪「只要正片」= 加入行程 + 覆写放弃映后谈
        const key = filmKeyOfCode(code);
        if (key) toggleScreening(key, code);
        setGvTalk(code, false);
        // 新加入 → 抽屉滑出显示行程(2026-09-11);⚠ 窄屏不弹(同上一分支,见 PLAN-20260912002532)
        if (!isMobileDrawer()) ensurePickerOpen(libraryCtx());
      }
      return;
    }
    const card = t.closest<HTMLElement>("#grid-scroll [data-code]");
    if (card) {
      const code = card.dataset.code!;
      lastToggledCode = code; // 这次点选可能让抽屉滑出 → 记下来,供「把它带回视野」的兜底用
      const key = filmKeyOfCode(code);
      if (key) {
        toggleScreening(key, code);
        // 加入(而非移出)行程 → 抽屉滑出显示行程;移出不弹(2026-09-11,PLAN-20260911140342)
        // ⚠ 窄屏**不弹**:抽屉是全屏覆盖,点一张卡就把人从时间线里拽走(2026-09-12,PLAN-20260912002532)。
        //   窄屏的卡片底色 / 顶栏计数已是即时回执,要去看列表点顶栏按钮即可。
        if (!isMobileDrawer() && slotOf(code)) ensurePickerOpen(libraryCtx());
      }
      return;
    }

    // 行程行操作(✕ 移出 / gv-talk 翻转本场映后谈 / 本场映后时长)
    const act = t.closest<HTMLElement>("[data-act]");
    if (act) {
      const code = act.closest<HTMLElement>("[data-code]")?.dataset.code;
      if (!code) return;
      if (act.dataset.act === "del") removeScreening(code);
      else if (act.dataset.act === "gv-talk") setGvTalk(code, !talkOnOf(code));
      else if (act.dataset.act === "gv-talk-min") openTalkMinModal(code, cat); // 本场映后时长覆写(小弹层)
      return;
    }

    // 行程冲突行的 CODE 标签 → 在网格里定位到冲突对方(跨影厅时不用来回滚动找)
    const jumpCode = t.closest<HTMLElement>("[data-jump-code]");
    if (jumpCode) {
      jumpToScreening(jumpCode.dataset.jumpCode!);
      return;
    }

    // 行程日期头「在网格中查看这一天」-> 网格切到该日期 + 当天行程场次卡片批量闪烁 3s。
    // (原先是抽屉内 `scrollIntoView` —— 行程已在抽屉里、目标行本就在视口内,等于没反应,故改为切网格。)
    const jump = t.closest<HTMLElement>("[data-jump]");
    if (jump) {
      jumpToDate(jump.dataset.jump!);
      return;
    }

    // 冲突角标 -> 打开抽屉(若关着) + 切到「我的行程」tab(2026-09-10,`PLAN-20260910190916`)。
    // 抽屉已开时只切 tab(保留当前 grid 日期);关着时打开抽屉(默认 tab),用户从 选片 进 行程 多一步。
    if (t.closest("#conflict-badge")) {
      if (isPickerDrawerOpen()) setPickerTab("agenda");
      // 关着时走 ensurePickerOpen(只开不收)+ 指定 agenda —— 旧写法 `openFilmPicker()` 用的是
      // 「上次停留的 tab」,与本节注释「切到「我的行程」」相左(2026-09-11 顺手修正)。
      else ensurePickerOpen(libraryCtx(), "agenda");
      return;
    }

    // 导出按钮 / 菜单
    if (t.closest("#export-btn")) {
      document.getElementById("export-menu")!.classList.toggle("is-hidden");
      return;
    }
    const ex = t.closest<HTMLElement>("#export-menu button");
    if (ex) {
      // 菜单统一在这里收起(重复 add 同一类是幂等的)—— 换取「新加一项忘了关菜单」这个坑不必再记。
      document.getElementById("export-menu")!.classList.add("is-hidden");
      const which = ex.dataset.which;
      if (which === "BACKUP") downloadBackup();
      else if (which === "RESTORE") openImportBackupModal();
      // 导出 / 分享三项(.ics / 文案 / 图)统一走弹层:**先选已保存方案,再选出口**(2026-09-12)
      else openExportPanel(cat, gvTalkOf);
      return;
    }
    if (!t.closest("[data-export-wrap]")) {
      document.getElementById("export-menu")!.classList.add("is-hidden");
    }

    // 外观:三段选择器 —— 点哪段切哪段(不做循环);setSettings 广播 → renderAll 刷新选中态
    const th = t.closest<HTMLElement>("#theme-switch [data-theme-pref]");
    if (th) {
      const pref = th.dataset.themePref;
      if (isThemePref(pref)) setThemePref(pref);
      return;
    }

    // 顶栏开票倒计时横幅 → 「抢票信息」弹层(开票批次 / 票价 / 须知 / 开闭幕式 / 开票日历)
    if (t.closest("#ticket-banner")) {
      openTicketingModal();
      return;
    }

    // 设置
    if (t.closest("#settings-btn")) {
      openSettings();
    }
  });

  // §14 1b/2a:文档级委托,grid 卡 ↔ agenda 行 双向 hover(冲突组联动一并处理)
  document.addEventListener("mouseover", (ev) => onHoverLinkMove(ev, true));
  document.addEventListener("mouseout", (ev) => onHoverLinkMove(ev, false));

  // 甘特缩放:Ctrl / ⌘ + 滚轮(macOS 触控板双指捏合同为 ctrl+wheel)→ 沿缩放阶梯走一档(横纵一起缩)。
  // 必须 passive:false 才能 preventDefault 掉浏览器整页缩放。deltaY 累加到 60 才走一档 ——
  // 一次捏合会连发几十个 wheel 事件,不累积会瞬间从 100% 跳到 120%。
  let wheelAcc = 0;
  document.addEventListener(
    "wheel",
    (ev: WheelEvent) => {
      if (!ev.ctrlKey && !ev.metaKey) return; // 普通滚轮不接管(仍走页面纵向滚动 / 容器横向滚动)
      const scroll = (ev.target as HTMLElement | null)?.closest?.("#grid-scroll");
      if (!scroll) return;
      ev.preventDefault();
      wheelAcc += ev.deltaY;
      if (Math.abs(wheelAcc) < 60) return;
      const dir: 1 | -1 = wheelAcc < 0 ? 1 : -1;
      wheelAcc = 0;
      applyZoom(stepZoom(zoom, dir));
    },
    { passive: false }
  );

  // 工作台限高随视口变化重算(窗口缩放 / 顶栏折行都会改网格顶边位置);节流到停止 resize 后一次。
  // ⚠ 窄屏 = 时间线,它**不限高**(见 renderTimeline)→ 这里直接跳过,不要给时间线写 maxHeight。
  let resizeTimer: number | undefined;
  window.addEventListener("resize", () => {
    if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (isMobileDrawer()) return;
      const grid = document.getElementById("grid-scroll");
      if (grid) fitGridHeight(grid);
    }, 120);
  });

  // ★ 跨断点(宽屏 ↔ 窄屏)重画(2026-09-12,PLAN-20260912002532):
  //   两个形态是**同一块容器**的两种画法(`#grid-scroll`),不重画就会「网格 ↔ 时间线」混着显示。
  //   断点值与 `library.ts::isMobileDrawer()` / `style.css` 的 `@media (max-width: 768px)` **逐字一致**。
  //   ⚠ 桌面自身不受影响:这条监听只在「跨越 768px」时触发一次,不参与任何桌面渲染路径。
  window.matchMedia("(max-width: 768px)").addEventListener("change", () => {
    hourFilter = null; // 时间线没有小时筛选;切形态时一并清掉,免得留下一个看不见的筛选
    renderZoomCtl();
    renderGrid();
    updatePickerLabel();
  });
}

/* ---------------- 影片库反向定位:跳日期 + 滚到卡片高亮 ---------------- */
/** 给某场次的**所有网格元素**打「定位回执」闪烁 —— 正片卡 + 右侧 GV 映后谈块。
 *  两者同带 `data-code`(见 grid.ts)且视觉上是一张拼接卡;只闪正片、留谈块不闪会「半张亮」,
 *  故统一按 `data-code` 全量取。
 *  先摘类 + 强制回流:同一场连点两次时 class 已在,不重排不会重播动画。 */
function flashScreening(root: ParentNode, code: string): void {
  for (const node of root.querySelectorAll<HTMLElement>(`[data-code="${code}"]`)) {
    node.classList.remove("flash-locate");
    void node.offsetWidth;
    node.classList.add("flash-locate");
  }
}

/** 卡片在**容器内容坐标系**里的「正中」落点(横向居中 + 纵向居中于**标尺以下的可见净区**)。
 *  ⚠ 纵向净区必须扣掉吸顶标尺(`[data-grid-ruler]`):标尺 `sticky top-0` 盖在容器顶部一条,
 *    按 `clientHeight / 2` 居中会让卡片整体**偏上**(用户反馈「定位到的卡片不在显示的中点」)。
 *  ⚠ **两个轴必须一次 `scrollTo` 给全**,不可拆成「先滚 x 再滚 y」两次调用 ——
 *    同一元素上的第二次 `scrollTo` 会**取消**第一次正在进行的平滑滚动,前一个轴停在动画中途
 *    (症状:纵向到位了、横向没到,或反之)。这正是本文件旧写法(centerCardX → centerCardY)的坑。
 *  `scroll.clientWidth` 取的是**当前**宽度 —— 抽屉挤压后网格变窄,用它算仍是正中。 */
function scrollTargetFor(scroll: HTMLElement, card: HTMLElement): { left: number; top: number } {
  const sRect = scroll.getBoundingClientRect();
  const cRect = card.getBoundingClientRect();
  const x = cRect.left - sRect.left + scroll.scrollLeft; // 卡片在内容坐标系里的 x
  const y = cRect.top - sRect.top + scroll.scrollTop; // 卡片在内容坐标系里的 y
  const rulerH = scroll.querySelector<HTMLElement>("[data-grid-ruler]")?.offsetHeight ?? 0;
  const netH = Math.max(0, scroll.clientHeight - rulerH); // 标尺以下的可见净高
  return {
    left: Math.max(0, x - scroll.clientWidth / 2 + cRect.width / 2),
    top: Math.max(0, y - rulerH - netH / 2 + cRect.height / 2),
  };
}

/** 把某张卡滚到可视区**正中**(横向 + 纵向一次到位)—— 「定位」的唯一落点口径。
 *  `instant` = 用 `behavior:"auto"` **直接到位**,不做平滑动画。
 *  ⚠ 什么时候必须 instant:网格容器刚被**整体重建**(换日期 / 改影厅筛选 → `replaceWith`),
 *    新容器的 `scrollTop`/`scrollLeft` 都是 0。此时平滑滚过去 = 让用户先看到「回到左上角」
 *    那一帧再滑到目标 —— 观感就是「整页重新定位了一下,跳了一下」「右边滚动条跳到某个位置」。
 *    容器是**复用**的(同日定位)时起点有意义,平滑动画反而帮用户建立方位感,故保留。 */
function scrollCardIntoCenter(scroll: HTMLElement, card: HTMLElement, instant: boolean): void {
  const t = scrollTargetFor(scroll, card);
  scroll.scrollTo({ left: t.left, top: t.top, behavior: instant ? "auto" : "smooth" });
}

/** 横向把某张卡滚到视口中央(**只横向**,纵向不动;「别跑出视野」的兜底用)。 */
function centerCardX(scroll: HTMLElement, card: HTMLElement): void {
  scroll.scrollTo({ left: scrollTargetFor(scroll, card).left, behavior: "smooth" });
}

/** 让卡片**横向回到视口舒适区**(已在区内则一动不动)—— 与 `centerCardX` 的分工:
 *  那个是「定位」的落点口径(必须居中);这个只是兜底「别让它跑出视野」,
 *  所以只在卡片真的贴边 / 出界时才滚 —— 否则每次点选都把视图挪一下会很烦。
 *  用于抽屉滑出后:网格左缘右移 500+px 且可用宽度收窄,刚点的那张卡很容易被挤出右缘
 *  (用户反馈「点了片子,刚才点的片子就消失在视野之外」)。 */
function ensureCardVisibleX(scroll: HTMLElement, card: HTMLElement): void {
  const sRect = scroll.getBoundingClientRect();
  const cRect = card.getBoundingClientRect();
  const pad = 48; // 左右各留 48px,卡片不紧贴容器边缘
  if (cRect.left >= sRect.left + pad && cRect.right <= sRect.right - pad) return;
  centerCardX(scroll, card);
}

/** 网格容器回到最顶(纵向 scrollTop = 0)。
 *  网格 29 厅 × 92px ≈ 2670px,只滚到网格顶部的话目标影厅往往还在视口外 —— 故**单场定位**走
 *  `scrollCardIntoCenter`(纵向居中到该影厅行);本函数只作兜底(卡片找不到)与「整天」定位的纵向落点。
 *  ★ 工作台化后纵向滚动归 `#grid-scroll` 容器(旧版由页面承担),故这里滚容器而不是 `window`。 */
function scrollGridTop(): void {
  document.getElementById("grid-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
}

/** 把网格切到某日期并清掉时间筛选;返回是否真的发生了切换(供调用方决定后续定位) */
function gotoDate(date: string): boolean {
  if (currentDate === date) return false;
  currentDate = date;
  hourFilter = null;
  renderChips();
  renderGrid();
  // 抽屉 agenda tab 通过 subscribe 自动重绘 —— 无需调 renderAgenda
  return true;
}

function jumpToScreening(code: string): void {
  const s = cat.byCode.get(code);
  if (!s) return;
  // 目标场次所在影厅被影厅筛选整行藏起来时,先清掉影厅筛选 —— 否则「定位 ▸」点了毫无反应
  // (卡片根本不在 DOM 里,连闪烁都落空)。只清影厅:字幕 / GV 两道与行的去留无关,
  // 卡片仍在(只是淡化),定位照样成立,不该顺手抹掉用户设的筛选。
  if (filters.venues.size > 0 && !venueAllowed(s.venue_id, filters)) {
    filters.venues.clear();
    saveFilters(filters);
    renderFilters();
    renderGrid(); // 行集合变了 → 必须先重建,否则下面找不到卡片(同日期时 gotoDate 不会重绘)
    toast("已清除影厅筛选 —— 目标场次所在影厅此前被隐藏");
  }
  closeAllModals(); // 整栈关闭:详情弹层任何一层都不能还盖着网格
  // ⚠ **不收起选片抽屉**(2026-09-10 改):抽屉是 `#main-col` 的 **flex 兄弟节点**,不是浮层 ——
  // 网格里的卡片永远不可能被它挡住,故没有「必须收起」的理由;而收起会让「定位 A → 看一眼时间轴 →
  // 再定位 B」每次都要重新打开抽屉(正是「有去无回」那条老毛病)。网格变窄由下面的居中逻辑自然
  // 吸收:`scroll.clientWidth` 已是挤压后的宽度,卡片照样居中。
  //
  // ★ 2026-09-11 修「定位时整页跳一下 / 右边滚动条跳到某个位置」:**定位改为同步完成,不等 rAF**。
  //   换日期 / 刚清完影厅筛选会**整体重建**网格容器(`host.replaceWith(grid)`),新容器的
  //   scrollTop / scrollLeft 都是 0。旧写法把它丢进 `afterLayout`(两帧后)再 `scrollTo({smooth})` ——
  //   浏览器早把「回到左上角」那一帧画出来了,用户看到的是「先跳回顶 / 左,再滑到目标」。
  //   同步定位时浏览器**还没绘制**那个 0 状态,直接落到目标位置,一次到位、零跳变。
  //   ⚠ 容器**复用**(同日定位)时保留平滑动画:起点有意义,滑过去能帮用户建立方位感。
  // ★ 窄屏:抽屉是**全屏覆盖**,「定位」的语义就是「带我去时间轴」—— 必须先收起抽屉,
  //   否则定位完了用户眼前还是那份列表,等于没跳(2026-09-12,PLAN-20260912002532)。
  //   宽屏**不收起**(抽屉是挤压式兄弟节点,网格永远不会被它挡住 —— 见上一条注释);
  //   `closePickerDrawer()` 触发的 toggleHandler 在窄屏只刷新顶栏文案,不会重建时间线
  //   (否则下面的滚动与闪烁回执会被随后的重建清掉)。
  if (isMobileDrawer()) closePickerDrawer();
  const prev = document.getElementById("grid-scroll");
  gotoDate(s.date);
  const scroll = document.getElementById("grid-scroll");
  if (!scroll) return;
  const card = scroll.querySelector<HTMLElement>(`[data-card="1"][data-code="${code}"]`);
  if (!card) {
    scrollGridTop(); // 兜底:卡片没找到时至少把网格带回顶部
    return;
  }
  scrollCardIntoCenter(scroll, card, prev !== scroll); // 容器刚重建 → 直接到位(见函数注释)
  flashScreening(scroll, code); // 正片卡 + 映后谈块一起闪
}

/* ---------------- 「我的行程」日期头:切到该日 + 当天场次**批量**闪烁 ---------------- */
/** 「在网格中查看这一天」:把甘特切到该日期,横向滚到**当天最早一场**并居中,再把当天行程里的
 *  所有场次卡片批量闪烁 3s。
 *  与 `jumpToScreening` 同一套 `flash-locate` 动画 / 同 3s 时长 / 同一套横向居中口径
 *  (`scrollTargetFor().left`),区别只在**批量**:一天的场次一起闪。
 *  ⚠ 一天多场没法同时居中,取**最早一场**当落点 —— 它是「这一天的起点」,也是列表首行,
 *    与行程 section 的阅读顺序一致(用户原话:「你可以定位到最早的那场的位置吗」)。
 *  (历史:这里原先是抽屉内 `scrollIntoView`,但行程搬进抽屉后目标行本就在视口里 →
 *   等于什么都没发生,故用户反馈「没有起效」;现在改为真正切网格日期 + 横向居中 + 批量回执。) */
function jumpToDate(date: string): void {
  // 与 `jumpToScreening` 同一条口径:换日期会**整体重建**网格容器 → 同步定位,不等 rAF,
  // 否则用户先看到「新日期停在左上角」那一帧再滑过去(见 jumpToScreening 的 ★ 注释)。
  // 窄屏:与 `jumpToScreening` 同一条口径 —— 「在网格中查看这一天」的落点是**时间线**,
  // 抽屉必须先让开(2026-09-12,PLAN-20260912002532);宽屏不收起。
  if (isMobileDrawer()) closePickerDrawer();
  const prev = document.getElementById("grid-scroll");
  gotoDate(date);
  const scroll = document.getElementById("grid-scroll");
  if (!scroll) return;
  // 当天行程的场次 code —— 与 agenda 的日期 section 同源(都是 allCodes)
  const codes = allCodes().filter((c) => cat.byCode.get(c)?.date === date);
  if (codes.length === 0) {
    scrollGridTop(); // 当天没有行程场次 → 至少把网格带回顶部
    return;
  }
  // 最早一场 = 横向落点(start_time 是 "HH:MM:SS" 定宽字符串,可直接字典序比较)
  const earliest = codes.reduce((a, b) =>
    (cat.byCode.get(a)?.start_time ?? "") <= (cat.byCode.get(b)?.start_time ?? "") ? a : b);
  const anchor = scroll.querySelector<HTMLElement>(`[data-card="1"][data-code="${earliest}"]`);
  // ⚠ 纵向回顶与横向居中**合并成一次 `scrollTo`**:同一元素上的第二次调用会取消第一次的平滑滚动。
  // ⚠ 「整天」的纵向落点是**顶部**(top: 0,标尺吸顶处),与单场定位的「纵向居中」刻意不同:
  //   要展示的是当天全部场次,停在顶部才读得全。
  scroll.scrollTo({
    left: anchor ? scrollTargetFor(scroll, anchor).left : scroll.scrollLeft, // 居中到当天最早一场(与「定位 ▸」同口径)
    top: 0,
    behavior: prev === scroll ? "smooth" : "auto",
  });
  for (const code of codes) flashScreening(scroll, code); // 每场正片卡 + 映后谈块一起闪
}


/* ---------------- §14 1b/2a:冲突组 & 行程↔网格 双向 hover 联动 ---------------- */
// 全量化后不再有 .card / .a-row 语义类,用结构位置选择:grid 内的卡 / agenda 内的行。
const HOVER_SEL = "#grid-scroll [data-code], #agenda [data-code]";

function applyHoverLink(host: HTMLElement | null): void {
  const nodes = document.querySelectorAll<HTMLElement>(HOVER_SEL);
  if (!host) {
    nodes.forEach((n) => n.classList.remove("hl-card", "hl-row"));
    return;
  }
  const code = host.dataset.code!;
  const s = cat.byCode.get(code);
  const conf = s ? conflicts.get(s.date) : undefined;
  const group = conflictGroupFor(conf, code); // 1b:同冲突组全亮
  const want = new Set<string>([code, ...(group ? [...group] : [])]); // 2a:本体双端(grid↔agenda)同亮
  const hlCls = host.closest("#grid-scroll") !== null ? "hl-card" : "hl-row";
  // 单遍遍历:命中的加类,未命中的**就地清掉** —— 旧实现先全清再全设,同一批节点走两遍
  nodes.forEach((n) => {
    if (want.has(n.dataset.code!)) n.classList.add(hlCls);
    else n.classList.remove("hl-card", "hl-row");
  });
}

function onHoverLinkMove(ev: MouseEvent, entering: boolean): void {
  // 拖动排序进行中 → 不做 hover 联动:同冲突组的每一行都会被 `hl-row` 描边,
  // 盖掉「拿起」那一行的投影(`agenda.ts::attachRankDrag` 置的 body 标记)。
  if (document.body.dataset.rankDragging) return;
  const host = (ev.target as HTMLElement).closest<HTMLElement>(HOVER_SEL) as HTMLElement | null;
  const rel = ev.relatedTarget instanceof Node ? (ev.relatedTarget as HTMLElement).closest<HTMLElement>(HOVER_SEL) : null;
  if (entering) {
    if (host && rel !== host) applyHoverLink(host);
  } else if (!host || rel !== host) {
    applyHoverLink(null); // 离开卡片/行 → 清除
  }
}


/* ---------------- boot ---------------- */
/** 「现在」线定时器句柄 —— 供 `teardown()` 清理(单页运行期不会调用) */
let nowTimer: number | undefined;
let booted = false;

async function boot(): Promise<void> {
  if (booted) return; // 幂等:重复调用会叠加全局事件监听与定时器(测试 / HMR 场景)
  booted = true;
  loadSettings();
  // 外观:设置就绪后立刻落一次 data-theme(index.html 内联脚本已落过,这里兜住旧缓存)并接管系统变化
  initTheme();
  loadGvTalk();
  loadGvTalkMin();
  loadRanks(); // 抢票顺位(场次级;冲突组内的拖动顺序 = 方案编号,见 plans.ts)
  loadSavedPlans(); // 已保存方案(用户手动存的快照;导出 / 分享按方案导出,见 state.ts)
  loadAgendaFold(); // 「我的行程」按日收起(纯视图偏好,与选片 / 排片数据无关)
  // 缩放倍率随设置恢复(renderAll 里的 renderZoomCtl 同步控件态)。
  // 旧版存的可能是横向倍率(如 3 / 0.5)或旧行高倍率,clampZoom 统一钳进 [0.55, 1.2] —— 无需迁移。
  zoom = clampZoom(store.settings.zoom ?? 1);
  cat = await loadCatalog();
  // ★ 窄屏默认日期 = **今天**(仅当今天落在展期窗口内)—— 手机打开就该看到「今天」,
  //   而不是展期第一天(2026-09-12,PLAN-20260912002532;用户口径「今天在展期内就用今天」)。
  //   宽屏维持 `cat.dates[0]`(桌面默认口径刻意未动,需要时另立一轮)。
  currentDate = pickDefaultDate(cat.dates, todayIsoLocal(), isMobileDrawer());
  // 排片筛选**持久化**恢复(「记住你的选项」)—— 必须在 cat 就绪后:影厅 id 要按当前
  // venues.json 校验(换版后不存在的厅留着会让「空集 = 不过滤」失效,表现为「什么都没了」)。
  loadFilters(filters, new Set(cat.venues.map((v) => v.id)));
  // 选片记录(唯一数据源)必须在 cat 就绪之后载入:首次迁移要用 filmNodeKey(cat, s)
  // 把旧的场次级 plan 归并到影片级记录(旧两套 → 一套)
  loadPicks(filmKeyOfCode);
  // 豆瓣映射 = 静态 douban.json(2026-09-11,D1 退役):在首渲前灌好,避免片名「先英文后中文」跳变。
  await loadMappings();
  // 官网「排期之外」的辅助信息(售票批次 / 节目嘉宾 / 开闭幕式):缺失即静默降级,不阻塞主流程。
  await loadExtras();

  subscribe((domain) => renderAll(domain));
  // 选片抽屉开 / 收会改变网格可用宽度 → 补一次 renderGrid(横向锚点由 renderGrid 内的
  // pendingAnchor / gridAnchor 机制保住)。放在这里注入,library.ts 不必反向依赖 main。
  setPickerToggleHandler(() => {
    // ★ 窄屏:抽屉是**全屏覆盖**(`#main-col` 被 `display:none`),开 / 收不改变时间线的任何几何 ——
    //   重绘只会白刷一条 ≈75 行的列表,还会把滚动位置与「定位」的闪烁回执一起清掉。
    //   故这里只刷新顶栏文案(2026-09-12,PLAN-20260912002532)。
    if (isMobileDrawer()) {
      updatePickerLabel();
      return;
    }
    // ★ 2026-09-11:抽屉开合**不再全量重建**。
    //   网格画布是**定宽**的(总宽只由倍率与轴长决定),容器变宽变窄只影响视口 —— 宽度根本不进几何签名。
    //   旧版 `renderGrid({ force: true })` 会让 `replaceWith` 把整棵网格 DOM 重建一遍(视觉上「闪一下」),
    //   且重建后横向锚点按「视口中心对应的时刻」恢复,而不是「你刚点的那张卡」——
    //   抽屉从左滑出会把网格左缘右移 500+px,刚点的卡片很容易被挤出右缘
    //   (用户反馈「拉了很长后点了片子,刚才点的片子就消失在视野之外」)。
    //   现在:走 patch(几何未变,零重建)+ 把刚点的那张卡带回视野。
    renderGrid();
    const grid = document.getElementById("grid-scroll");
    if (grid) {
      fitGridHeight(grid); // 宽度变化可能让上方标题行折行 → 网格顶边下移,限高要重算
      const card = lastToggledCode
        ? grid.querySelector<HTMLElement>(`[data-card="1"][data-code="${lastToggledCode}"]`)
        : null;
      if (card) ensureCardVisibleX(grid, card);
    }
    updatePickerLabel(); // 开 / 收后刷新顶栏按钮文案(窄屏「时间轴 ▸」↔「列表 · 行程」)
  });
  // 「我的行程」从主页面 #agenda-wrap 搬到选片抽屉的第三个 tab(`PLAN-20260910190916`):
  // 把 main 拥有的 `conflicts` / `gvTalkOf` / `currentDate` / `hourFilter` 闭包到 buildAgendaHost,
  // 注入给抽屉;抽屉 agenda tab 每次重绘都读最新值。
  setAgendaRenderer(buildAgendaHost);
  bindEvents();
  attachTip(); // 缩写说明悬停 tooltip(data-tip 文档级委托,渲染重建无需重绑)
  // D1:刻度不再随视口自动压缩(各日期比例一致),改由用户经缩放控件 / Ctrl+滚轮 自选 ——
  // 故仍不挂 ResizeObserver 重渲(重渲 replaceWith 会丢视口锚点;要「塞满宽度」用「适应」按钮)
  // 顶栏 Banner「ⓘ 日程表说明」(2026-09-11 由网格标题行图例条移入):hover 快速多行提示
  // (单源自 badges.ts abbrTooltip);点击打开总览弹层。
  // 末条分点提示「可点开总览」—— 不挂原生 title(它会先弹一条样式不可控的长横条,与本 tooltip 打架)
  const abbrHelp = document.getElementById("abbr-help");
  if (abbrHelp) {
    abbrHelp.dataset.tip = `${abbrTooltip()}\n点击打开完整说明总览(字段 / 等级 / 字幕 / 影院代码)`;
    abbrHelp.addEventListener("click", () => openModal("日程表说明 · 字段与图例", buildGuideBody(cat), "xl"));
  }
  renderAll();
  // ★ 窄屏(≤768px)**不再「列表优先」**(2026-09-12,PLAN-20260912002532):
  //   主视图 = 单日纵向时间线(`renderTimeline`),抽屉退化为**次级**的「列表 · 行程」视图 ——
  //   由顶栏按钮进入(全屏,`#main-col` 仍 `display:none`),抽屉内「◀ 时间线」返回。
  //   旧口径「一打开就全屏影片库」正是用户报的「甘特图被挡住了」(实际是 `#main-col` 被 `display:none`)。
  // 宽屏:行程非空 → 抽屉自动滑出并停在「我的行程」(2026-09-11,PLAN-20260911140342)。
  //   空行程不弹(进界面就弹一块空面板只会挡网格);收起后除「再点选一场」外不会被重弹。
  if (!isMobileDrawer() && store.picks.size > 0) ensurePickerOpen(libraryCtx(), "agenda");
  updatePickerLabel();
  // 顶栏开票倒计时(每秒 tick;无 extras 数据时横幅保持隐藏)
  startTicketTicker(cat.schedule.festival.year);
  toast(currentDate ? "排期取自 BIFF 官网实时页面 — 变动以现场公告为准" : "schedule.json 为空");

  // A5:跨分钟/跨天自动推进「现在」线 —— 仅在时间键变化且仍在看当天时重画网格(角标补零、进出轴窗口随渲染取当前时间)
  let lastNowKey = "";
  nowTimer = window.setInterval(() => {
    const d = new Date();
    const key = `${todayIsoLocal()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    if (key === lastNowKey) return;
    lastNowKey = key;
    if (todayIsoLocal() === currentDate) renderGrid();
  }, 20_000);
}

boot();

/** 清理模块级副作用(定时器)—— 供测试 / HMR 调用;生产单页运行期不需要 */
export function teardown(): void {
  if (nowTimer !== undefined) window.clearInterval(nowTimer);
  nowTimer = undefined;
}