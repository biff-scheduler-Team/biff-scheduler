// 入口 — 装配数据/状态/视图,统一事件委托。
// 全量化:仅维护基础骨架(顶栏/面板/弹层根/Toast/底部),所有内部样式由 markup 端 Tailwind utility 表达。

import type { Catalog, Group, Priority } from "./types";
import { OK_SLACK, dateInfo, el, filmNodeKey, hmsToMin, todayIsoLocal } from "./util";
import { loadCatalog } from "./data";
import { computeConflicts, conflictGroupFor, type ConflictResult, type Slot } from "./conflict";
import { buildIcs, downloadIcs, pickEntries } from "./ics";
import { effEndMin, talkOnOf } from "./gv";
import {
  codesOfGroup,
  flipGroup,
  loadGvTalk,
  loadGvTalkMin,
  loadMappings,
  loadPicks,
  loadSettings,
  priorityOfCode,
  removeScreening,
  setCurrentGroup,
  setGvTalk,
  setPriorityOfCode,
  setZoom,
  slotOf,
  store,
  subscribe,
  toggleScreening,
  type ChangeDomain,
} from "./state";
import {
  buildGrid,
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
import { abbrTooltip } from "./badges";
import { attachTip } from "./tip";
import { buildGuideBody } from "./legend";
import { scorePlanRows, type ScoredRow } from "./score";
import { closeAllModals, openModal, showCatalogFilmModal, showFilmModal } from "./modal";
import { closePickerDrawer, isMobileDrawer, isPickerDrawerOpen, openFilmPicker, setAgendaRenderer, setPickerTab, setPickerToggleHandler } from "./library";
import { openSettings, openTalkMinModal } from "./settings";
import { initTheme, isThemePref, setThemePref, themePref } from "./theme";
import { copyPicklist } from "./picklist";
import { toast } from "./toast";
import { BAR_IDLE, BAR_ON } from "./chips";
import { SEG_OFF, SEG_ON, ZBTN, ZFIT, ZMID } from "./ui";

let cat: Catalog;
let currentDate = "";
let conflicts = new Map<string, ConflictResult>();
/** 甘特时间筛选:点击时间轴整点置为对应小时;null = 不过滤(切日期/再点/重置均清除) */
let hourFilter: number | null = null;
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
    group: store.group,
    mappings: store.mappings,
    onLocate: jumpToScreening,
    onToggle: toggleScreening, // 唯一场次列表(影片库行内展开)的加入/移出 → 与网格整卡点选同源
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

function computeConflictsForCurrentGroup(): Map<string, ConflictResult> {
  const slots: Slot[] = [];
  for (const code of codesOfGroup(store.group)) {
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
  conflicts = computeConflictsForCurrentGroup();
  renderChips();
  renderGroupSeg();
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
    const btn = el("button", cls, `${label} ${weekday}`);
    btn.dataset.tip = `${dayShows} 场排片`;
    btn.dataset.date = d;
    bar.appendChild(btn);
  }
}

/* A/B 方案切换段按钮的字面量已收敛到 `ui.ts`(SEG_ON / SEG_OFF)。 */

function renderGroupSeg(): void {
  document.querySelectorAll<HTMLButtonElement>("#group-switch button").forEach((b) => {
    const on = b.dataset.g === store.group;
    b.className = on ? SEG_ON : SEG_OFF;
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

/** **纵向**视口锚点:参考线(视口顶 y = 0;网格顶若还在视口下方则用网格顶)落在第几行(小数行号)。
 *  纵向是**页面**在滚(`#grid-scroll` 只有 overflow-x-auto),而网格每次重建都换新容器、行高一缩
 *  页面总高就变 —— 浏览器会把 window.scrollY 直接 clamp 到新范围,正在看的第 20 厅会瞬间飞出屏幕
 *  (29 行 × 41px ≈ 1189px 的位移)。故重建前记行号、重建后补回。
 *  行高从相邻两行的 top 差**实测**,不读任何常量(将来改行高公式也不会失效)。 */
function rowAnchor(grid: HTMLElement): { row: number; refY: number } | null {
  const rows = grid.querySelectorAll<HTMLElement>("[data-vrow]");
  if (rows.length < 2) return null;
  const top = rows[0].getBoundingClientRect().top;
  const h = rows[1].getBoundingClientRect().top - top;
  if (!(h > 1)) return null;
  const refY = Math.max(top, 0); // 网格顶还在视口下方(没滚到它)→ 以网格顶为参考线,锚点即第 0 行
  return { row: (refY - top) / h, refY };
}

/** 重建后把锚点行拉回参考线:delta > 0 = 该行跑到参考线下方了 → 向上滚。
 *  视口够不着(已到页面两端)时浏览器会自行 clamp,这是预期行为,不再补偿。 */
function applyRowAnchor(grid: HTMLElement, a: { row: number; refY: number }): void {
  const rows = grid.querySelectorAll<HTMLElement>("[data-vrow]");
  if (rows.length < 2) return;
  const top = rows[0].getBoundingClientRect().top;
  const h = rows[1].getBoundingClientRect().top - top;
  if (!(h > 1)) return;
  const delta = top + a.row * h - a.refY;
  if (Math.abs(delta) > 0.5) window.scrollBy(0, delta);
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
  const dayShows = cat.schedule.screenings.filter((s) => s.date === currentDate).length;
  const pickedOnDay = codesOfGroup(store.group).filter(
    (c) => cat.byCode.get(c)?.date === currentDate
  ).length;
  document.getElementById("grid-date-title")!.textContent = `${label} ${weekday} · 排片总览`;
  const countEl = document.getElementById("grid-count")!;
  countEl.textContent = `${dayShows} 场 · 本组已选 ${pickedOnDay} 场`;
  if (hourFilter != null) {
    const hh = String(hourFilter).padStart(2, "0");
    const pill = el(
      "button",
      "ml-[8px] border border-biff bg-biff-soft text-biff-ink rounded-full px-[8px] py-px text-12 font-bold align-middle cursor-pointer hover:bg-biff-line whitespace-nowrap",
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
  const base = gridGeometryKey(cat, currentDate, PX_PER_MIN * zoom, rowMetrics(zoom).rowH);
  if (todayIsoLocal() !== currentDate) return base;
  const d = new Date();
  return `${base}|now:${d.getHours() * 60 + d.getMinutes()}`;
}

function renderGrid(opts: { force?: boolean } = {}): void {
  const host = document.getElementById("grid-scroll")!;
  const conf = conflicts.get(currentDate);
  const pxPerMin = PX_PER_MIN * zoom;
  const ctx: GridCtx = {
    cat,
    pxPerMin,
    slots: store.slotIndex,
    group: store.group,
    mappingOf: (c) => store.mappings.get(c),
    conflictCodes: conf?.codeSet,
    transitMin: store.settings.transitMin,
    gvTalkOf,
    wishOf: (s) => store.picks.get(filmNodeKey(cat, s))?.priority ?? undefined,
    hourFilter,
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
  fitTimeTexts(grid); // 挂载后量测:窄卡时间文本降级,绝不截断
  renderGridMeta();
}

// 2026-09-10 起「我的行程」从主页面 #agenda-wrap 搬到选片抽屉的第三个 tab(`PLAN-20260910190916`):
//  原 `renderAgenda()`(把 `buildAgenda` 挂到 `#agenda`、写 `#agenda-summary`、追加质量分药丸)
//  全部迁到下方的 `buildAgendaHost()`,由 `setAgendaRenderer()` 注入给抽屉,抽屉内 agenda tab
//  每次重绘时调用。主页面不再有 `#agenda-wrap` / `#agenda-summary` / `#agenda` 挂载点。

/** 「我的行程」抽屉 agenda tab 的**注入渲染函数**(2026-09-10,`PLAN-20260910190916`):
 *  - 摘要行(A 方案 N 场 · ⚠M + 质量分药丸)替代原来的 `#agenda-summary`(被删)
 *  - 行程 body = `buildAgenda(...)`,保留 `id="agenda"` 以让 `HOVER_SEL` 仍然命中。
 *  - 每次抽屉 agenda tab 重绘时调用,读 main 的 `conflicts` / `gvTalkOf` / `currentDate` / `hourFilter` 闭包值。 */
function buildAgendaHost(): HTMLElement {
  const wrap = el("div", "grid gap-[8px]");

  // 摘要行(原 #agenda-summary,现在是 agenda tab 顶部的一行)
  const picked = codesOfGroup(store.group);
  const nConf = totalConflictPairs();
  const sum = el(
    "div",
    "px-3 pt-[2px] pb-[2px] text-12 text-meta flex items-center gap-[6px] flex-wrap",
    `${store.group} 方案 ${picked.length} 场${nConf ? ` · ${nConf} 处冲突` : ""}`
  );
  // 质量分药丸(P0-2:与引擎同权重;仅展示,不改排序)
  const rows: ScoredRow[] = [];
  for (const code of picked) {
    const s = cat.byCode.get(code);
    if (s) rows.push({ priority: priorityOfCode(code) ?? null, screening: s });
  }
  if (rows.length) {
    const sc = scorePlanRows(rows, store.settings.transitMin, OK_SLACK, (s) => effEndMin(s, gvTalkOf(s.code)));
    const pill = el(
      "span",
      "inline-flex items-center border border-line rounded-full bg-card px-[8px] leading-[1.7] text-12 font-extrabold tabular-nums text-ink-2 whitespace-nowrap cursor-default hover:border-biff hover:text-biff-ink",
      `分 ${sc.total}`
    );
    pill.dataset.tip =
      `行程质量分 ${sc.total} —— 必看 ×3 · 备选 ×2 · 随缘 ×1 · GV +1 · 紧转场 −1(未分级不计分)\n` +
      `必看 ${sc.pri.must}×3 · 备选 ${sc.pri.maybe}×2 · 随缘 ${sc.pri.wild}×1` +
      `${sc.unset ? ` · 未分级 ${sc.unset}×0` : ""}` +
      `${sc.gv ? ` · GV +${sc.gv}` : ""}${sc.tight ? ` · 紧转场 −${sc.tight}` : ""} = ${sc.total}`;
    sum.appendChild(pill);
  }
  wrap.appendChild(sum);

  // 行程 body
  const body = buildAgenda({
    cat,
    slots: store.slotIndex,
    picks: store.picks,
    group: store.group,
    mappings: store.mappings,
    transitMin: store.settings.transitMin,
    gvTalkOf,
    conflicts,
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
 *  只刷选中态(与顶栏 A/B 方案共用 ui.ts 的 SEG_ON / SEG_OFF,单一视觉来源);
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

    // 方案切换
    const g = t.closest<HTMLElement>("#group-switch [data-g]");
    if (g) {
      setCurrentGroup(g.dataset.g as Group);
      return;
    }

    // 「影片库 · 选片」:左侧挤压抽屉(左 = 全部影片可搜可筛 / 我的选片两个 tab)。
    // 已打开时再点 = 收起(而不是重建内容丢搜索 / 筛选状态)。
    // ⚠ 不在这里补 renderGrid():抽屉的开 / 收自己会回调(见 setPickerToggleHandler),
    //   否则同一次开合会重绘网格两遍。
    if (t.closest("#library-btn")) {
      if (isPickerDrawerOpen()) closePickerDrawer();
      else openFilmPicker(libraryCtx());
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
      const hit = slotOf(code);
      if (hit && hit.group === store.group) {
        // 已在当前方案:翻转含↔弃(覆写落 localStorage,不删场次、不动全局默认)
        setGvTalk(code, !talkOnOf(code));
      } else {
        // 未在当前方案(含在另一方案):一枪「只要正片」= 加入当前方案 + 覆写放弃映后谈;
        // 档位按该片已有记录继承(从未打标 → null 未设)
        const key = filmKeyOfCode(code);
        if (key) toggleScreening(key, code, store.picks.get(key)?.priority ?? null);
        setGvTalk(code, false);
      }
      return;
    }
    const card = t.closest<HTMLElement>("#grid-scroll [data-code]");
    if (card) {
      // 新加入按该片已有档位继承(影片库打标 / 详情弹层设过);从未打标 → null(未设,不再默认备选)
      const code = card.dataset.code!;
      const key = filmKeyOfCode(code);
      if (key) toggleScreening(key, code, store.picks.get(key)?.priority ?? null);
      return;
    }

    // 行程行操作(§14 2c:优先级走三段 seg 直接定位;grp/del 原样;gv-talk 翻转本场映后谈)
    const act = t.closest<HTMLElement>("[data-act]");
    if (act) {
      const code = act.closest<HTMLElement>("[data-code]")?.dataset.code;
      if (!code) return;
      if (act.dataset.act === "pri") {
        // 再点当前档 = 取消 → 回到「未设」(与「我的选片」打标 seg 同语义,否则设过档就再也回不到未设)
        // 档位在影片级 → 改的是该片档位,同片所有场次同步(这正是「一套数据」的核心)
        const p = act.dataset.pri as Priority;
        setPriorityOfCode(code, (priorityOfCode(code) ?? null) === p ? null : p);
      } else if (act.dataset.act === "grp") flipGroup(code);
      else if (act.dataset.act === "del") removeScreening(code);
      else if (act.dataset.act === "gv-talk") setGvTalk(code, !talkOnOf(code));
      else if (act.dataset.act === "gv-talk-min") openTalkMinModal(code, cat); // 本场映后时长覆写(小弹层)
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
      else openFilmPicker(libraryCtx());
      return;
    }

    // 导出按钮 / 菜单
    if (t.closest("#export-btn")) {
      document.getElementById("export-menu")!.classList.toggle("is-hidden");
      return;
    }
    const ex = t.closest<HTMLElement>("#export-menu button");
    if (ex) {
      if (ex.dataset.which === "PICK") copyPicklist(cat, gvTalkOf);
      else exportIcs(ex.dataset.which as "A" | "B" | "ALL");
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
}

function exportIcs(which: "A" | "B" | "ALL"): void {
  document.getElementById("export-menu")!.classList.add("is-hidden");
  const entries = pickEntries(store.picks, cat, which);
  if (entries.length === 0) {
    toast(which === "ALL" ? "还没有任何选片" : `${which} 方案还没有选片`);
    return;
  }
  const ics = buildIcs(cat, entries, store.mappings, store.settings.alarmMin, gvTalkOf);
  downloadIcs(ics, `biff2026-${which.toLowerCase()}.ics`);
  toast(`已导出 ${entries.length} 场(${which === "ALL" ? "A+B" : which}),导入日历后按手机时区显示`);
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

/** 横向把某张卡滚到视口中央(「定位」的落点口径,单场 / 批量共用)。
 *  `scroll.clientWidth` 取的是**当前**宽度 —— 抽屉挤压后网格变窄,用它算仍是正中。 */
function centerCardX(scroll: HTMLElement, card: HTMLElement): void {
  const sRect = scroll.getBoundingClientRect();
  const cRect = card.getBoundingClientRect();
  const x = cRect.left - sRect.left + scroll.scrollLeft;
  scroll.scrollTo({
    left: Math.max(0, x - scroll.clientWidth / 2 + cRect.width / 2),
    behavior: "smooth",
  });
}

/** 页面滚到排片面板(顶部被吸顶栏盖住的部分留出)—— jumpToScreening / jumpToDate 共用 */
function scrollGridTop(): void {
  const wrap = document.getElementById("grid-wrap");
  if (!wrap) return;
  const top = wrap.getBoundingClientRect().top + window.scrollY - 64;
  window.scrollTo({ top: Math.max(top, 0), behavior: "smooth" });
}

/** 等两帧布局稳定后执行 —— 切日期 / 缩放会整体重建网格容器,须等新节点落位再量尺寸 */
function afterLayout(fn: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(fn));
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
  closeAllModals(); // 整栈关闭:详情弹层任何一层都不能还盖着网格
  // ⚠ **不收起选片抽屉**(2026-09-10 改):抽屉是 `#main-col` 的 **flex 兄弟节点**,不是浮层 ——
  // 网格里的卡片永远不可能被它挡住,故没有「必须收起」的理由;而收起会让「定位 A → 看一眼时间轴 →
  // 再定位 B」每次都要重新打开抽屉(正是「有去无回」那条老毛病)。网格变窄由下面的居中逻辑自然
  // 吸收:`scroll.clientWidth` 已是挤压后的宽度,卡片照样居中。
  gotoDate(s.date);
  scrollGridTop();
  // 等两帧布局稳定后:横向滚到卡片 + 带底色闪烁 3s(1s × 3)
  afterLayout(() => {
    const scroll = document.getElementById("grid-scroll");
    const card = scroll?.querySelector<HTMLElement>(`[data-code="${code}"]`);
    if (!scroll || !card) return;
    centerCardX(scroll, card);
    flashScreening(scroll, code); // 正片卡 + 映后谈块一起闪
  });
}

/* ---------------- 「我的行程」日期头:切到该日 + 当天场次**批量**闪烁 ---------------- */
/** 「在网格中查看这一天」:把甘特切到该日期,横向滚到**当天最早一场**并居中,再把当天行程里的
 *  所有场次卡片批量闪烁 3s。
 *  与 `jumpToScreening` 同一套 `flash-locate` 动画 / 同 3s 时长 / 同一套横向居中口径
 *  (`centerCardX`),区别只在**批量**:一天的场次一起闪。
 *  ⚠ 一天多场没法同时居中,取**最早一场**当落点 —— 它是「这一天的起点」,也是列表首行,
 *    与行程 section 的阅读顺序一致(用户原话:「你可以定位到最早的那场的位置吗」)。
 *  (历史:这里原先是抽屉内 `scrollIntoView`,但行程搬进抽屉后目标行本就在视口里 →
 *   等于什么都没发生,故用户反馈「没有起效」;现在改为真正切网格日期 + 横向居中 + 批量回执。) */
function jumpToDate(date: string): void {
  gotoDate(date);
  scrollGridTop(); // 与 jumpToScreening 同口径
  // 当天行程(当前方案)的场次 code —— 与 agenda 的日期 section 同源(都是 codesOfGroup)
  const codes = codesOfGroup(store.group).filter((c) => cat.byCode.get(c)?.date === date);
  if (codes.length === 0) return;
  // 最早一场 = 横向落点(start_time 是 "HH:MM:SS" 定宽字符串,可直接字典序比较)
  const earliest = codes.reduce((a, b) =>
    (cat.byCode.get(a)?.start_time ?? "") <= (cat.byCode.get(b)?.start_time ?? "") ? a : b);
  // 等两帧布局稳定后(切日期会整体重建网格容器)再横向定位 + 批量打动画
  afterLayout(() => {
    const scroll = document.getElementById("grid-scroll");
    if (!scroll) return;
    const anchor = scroll.querySelector<HTMLElement>(`[data-code="${earliest}"]`);
    if (anchor) centerCardX(scroll, anchor); // 居中到当天最早一场(与「定位 ▸」同口径)
    for (const code of codes) flashScreening(scroll, code); // 每场正片卡 + 映后谈块一起闪
  });
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
  // 缩放倍率随设置恢复(renderAll 里的 renderZoomCtl 同步控件态)。
  // 旧版存的可能是横向倍率(如 3 / 0.5)或旧行高倍率,clampZoom 统一钳进 [0.55, 1.2] —— 无需迁移。
  zoom = clampZoom(store.settings.zoom ?? 1);
  cat = await loadCatalog();
  currentDate = cat.dates[0] ?? "";
  // 选片记录(唯一数据源)必须在 cat 就绪之后载入:首次迁移要用 filmNodeKey(cat, s)
  // 把旧的场次级 plan 归并到影片级记录(旧两套 → 一套)
  loadPicks(filmKeyOfCode);
  // 豆瓣映射 = 静态 douban.json(2026-09-11,D1 退役):在首渲前灌好,避免片名「先英文后中文」跳变。
  await loadMappings();

  subscribe((domain) => renderAll(domain));
  // 选片抽屉开 / 收会改变网格可用宽度 → 补一次 renderGrid(横向锚点由 renderGrid 内的
  // pendingAnchor / gridAnchor 机制保住)。放在这里注入,library.ts 不必反向依赖 main。
  setPickerToggleHandler(() => {
    // 抽屉开合会改 `#grid-scroll` 的可用宽度(clientWidth),而**宽度不进几何签名** ——
    // 故这里强制重建,让横向锚点机制按新宽度重新居中(与旧版行为一致)。
    renderGrid({ force: true });
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
  // 图例「ⓘ 日程表说明」:hover 快速多行提示(单源自 badges.ts abbrTooltip);点击打开总览弹层。
  // 末条分点提示「可点开总览」—— 不挂原生 title(它会先弹一条样式不可控的长横条,与本 tooltip 打架)
  const abbrHelp = document.getElementById("abbr-help");
  if (abbrHelp) {
    abbrHelp.dataset.tip = `${abbrTooltip()}\n点击打开完整说明总览(字段 / 等级 / 字幕 / 影院代码)`;
    abbrHelp.addEventListener("click", () => openModal("排片表说明 · 图例总览", buildGuideBody(cat), true));
  }
  renderAll();
  // 窄屏(≤768px)**列表优先**:首次进入直接打开抽屉,网格降级为次级入口 ——
  // 手机竖屏看二维甘特(29 厅 × 时间轴)在缩放下限下几乎不可用(见 library.ts::isMobileDrawer)。
  if (isMobileDrawer()) openFilmPicker(libraryCtx());
  updatePickerLabel();
  toast(currentDate ? "排片为 MOCK 数据 — 官方 Catalogue 发布后一键替换" : "schedule.json 为空");

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