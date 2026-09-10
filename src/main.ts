// 入口 — 装配数据/状态/视图,统一事件委托。
// 全量化:仅维护基础骨架(顶栏/面板/弹层根/Toast/底部),所有内部样式由 markup 端 Tailwind utility 表达。

import type { Catalog, Group, Priority, Screening } from "./types";
import { OK_SLACK, dateInfo, el, filmNodeKey, fmtMinRangeMin, hmsToMin, todayIsoLocal } from "./util";
import { loadCatalog } from "./data";
import { computeConflicts, conflictGroupFor, type ConflictResult, type Slot } from "./conflict";
import { buildIcs, downloadIcs, pickEntries, priorityTag } from "./ics";
import { effEndMin, gvTalkMin, talkOnOf } from "./gv";
import {
  clearScreeningSlots,
  codesOfGroup,
  flipGroup,
  gvTalkMinOv,
  loadGvTalk,
  loadGvTalkMin,
  loadPicks,
  loadSettings,
  priorityOfCode,
  removeScreening,
  setCurrentGroup,
  setGvTalk,
  setGvTalkMin,
  setPriorityOfCode,
  setSettings,
  setZoom,
  slotOf,
  store,
  subscribe,
  syncFromCloud,
  toggleScreening,
} from "./state";
import { buildGrid, fitTimeTexts, fitZoom, axisStartFor, clampZoom, stepZoom, LABEL_W, PX_PER_MIN, ZOOM_MAX, ZOOM_MIN } from "./grid";
import { buildAgenda } from "./agenda";
import { abbrTooltip } from "./badges";
import { attachTip } from "./tip";
import { buildGuideBody } from "./legend";
import { scorePlanRows, type ScoredRow } from "./engine";
import { aiReady, clearAiCfg, loadAiCfg, maskKey } from "./ai";
import { closeAllModals, closeModal, openModal, openPriorityPicker, showCatalogFilmModal, showFilmModal } from "./modal";
import { openLibrary, openMyPicks } from "./library";

let cat: Catalog;
let currentDate = "";
let conflicts = new Map<string, ConflictResult>();
/** 甘特时间筛选:点击时间轴整点置为对应小时;null = 不过滤(切日期/再点/重置均清除) */
let hourFilter: number | null = null;
/** 甘特缩放倍率(1 = 100% = PX_PER_MIN):视图偏好,持久化在 store.settings.zoom */
let zoom = 1;
/** 网格横向视口记忆:锚点 = 容器内某个屏幕 x(相对容器左缘)对应的时刻。
 *  网格每次重建都换新滚动容器(scrollLeft 会归零)—— 同日期重建(选片/优先级/分钟推进/缩放)
 *  把锚点时刻重新对回原 x(缩放前后视口不跳);换日期/首渲不恢复(回最左)。
 *  缩放时由 applyZoom 按**旧刻度**预先算好挂在这里(renderGrid 里那时刻度已经变了)。 */
let pendingAnchor: { min: number; screenX: number } | null = null;
let lastGridDate = "";

/** code → 影片节点 key(全站单一 key 口径:grid / agenda / 影片库 / 详情弹层同源);
 *  排期里已没有该 code(数据换版)时返回 null。 */
function filmKeyOfCode(code: string): string | null {
  const s = cat.byCode.get(code);
  return s ? filmNodeKey(cat, s) : null;
}

/** 加入场次 = 强制定档的唯一入口:未打标的片先弹「选择档位」,选定才落场次 —— 「未设」不再产生。
 *  已选(任一方案) → 移出(不需要档位);已有档位 → 直接加入并继承。
 *  网格卡 / GV 谈块 / 详情弹层「加入 X 方案」三处入口全部走它。
 *  `after` = 场次落定后的收尾(仅 GV 谈块用:加入后要一并覆写「放弃映后谈」),移出路径同样执行。 */
function pickScreening(key: string, code: string, after?: () => void): void {
  if (slotOf(code)) {
    toggleScreening(key, code); // 已在任一方案 → 移出(不改档位)
    after?.();
    return;
  }
  const p = store.picks.get(key)?.priority;
  if (p) {
    toggleScreening(key, code, p);
    after?.();
    return;
  }
  const s = cat.byCode.get(code);
  const zh = s ? s.title_zh || s.title_en : code;
  openPriorityPicker(
    zh,
    `「${zh}」还没定档。加入「${store.group} 方案」前先选一个档位 —— 档位是影片级的，该片所有场次同步；之后可在行程行随时改。`,
    (p2) => {
      toggleScreening(key, code, p2);
      after?.();
    }
  );
}

/** 影片详情弹层的公共上下文(网格 ⓘ 与影片库共用)。
 *  不给 slots —— 弹层一律走 slotOf() 实时查询(rebuildIndex 是整体换新 Map,持有引用会读到旧快照)。 */
function filmModalCtx() {
  return { cat, group: store.group, mappings: store.mappings, toggle: pickScreening };
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

function renderAll(): void {
  conflicts = computeConflictsForCurrentGroup();
  renderChips();
  renderGroupSeg();
  renderGrid();
  renderAgenda();
  renderBadge();
  renderSync();
  renderPicksBadge();
  renderZoomCtl();
}

/** 日期 chip 类名(idle / 选中 — 背景/边框色 走 IDLE/ON 各自完整串,避免同类叠加后写者赢) */
const CHIP_DATE_BASE = "border rounded-[7px] px-3 py-1 text-[13px] whitespace-nowrap hover:border-biff";
const CHIP_DATE_IDLE = `${CHIP_DATE_BASE} border-line bg-card text-ink`;
const CHIP_DATE_ON = `${CHIP_DATE_BASE} border-biff bg-biff text-on-brand font-semibold`;

function renderChips(): void {
  const bar = document.getElementById("date-chips")!;
  bar.innerHTML = "";
  for (const d of cat.dates) {
    const { label, weekday } = dateInfo(d);
    const dayShows = cat.schedule.screenings.filter((s) => s.date === d).length;
    const cls = d === currentDate ? CHIP_DATE_ON : CHIP_DATE_IDLE;
    const btn = el("button", cls, `${label} ${weekday}`);
    btn.title = `${dayShows} 场排片`;
    btn.dataset.date = d;
    bar.appendChild(btn);
  }
}

/** A/B 方案切换按钮:on 用红填充;off 白底 */
const SEG_BTN_BASE = "border-0 px-3 py-[5px] text-[13px] transition-colors";
const SEG_BTN_ON = "bg-biff text-on-brand font-bold";
const SEG_BTN_OFF = "bg-card text-ink";

function renderGroupSeg(): void {
  document.querySelectorAll<HTMLButtonElement>("#group-switch button").forEach((b) => {
    const on = b.dataset.g === store.group;
    b.className = `${SEG_BTN_BASE} ${on ? SEG_BTN_ON : SEG_BTN_OFF}`;
  });
}

/* ---------------- 甘特缩放 ---------------- */

/** 视口锚点:容器内屏幕 x(clientX 缺省 = 视口中心)对应的时刻。
 *  轨道在容器内从 x = LABEL_W 起算(左侧粘性影厅列宽),故 x 至少取到影厅列右缘 ——
 *  光标落在粘性列上时锚定列缘,避免算出轴界之外的负数时刻。 */
function gridAnchor(scroll: HTMLElement, clientX?: number): { min: number; screenX: number } {
  const px = PX_PER_MIN * zoom;
  const rel = clientX == null ? scroll.clientWidth / 2 : clientX - scroll.getBoundingClientRect().left;
  const screenX = Math.max(rel, LABEL_W);
  return { min: axisStartFor(cat, currentDate) + (scroll.scrollLeft + screenX - LABEL_W) / px, screenX };
}

/** 缩放:改刻度并就地重绘网格。**只重绘网格** —— 缩放不影响行程/角标,走 notify → renderAll 是白干,
 *  且必须先按旧刻度算锚点再改倍率(见 pendingAnchor 注释)。
 *  clientX 给出时锚定光标下的时刻,否则锚定视口中心;fromLeft = 从轴起点贴左(「适应」用)。 */
function applyZoom(next: number, opts: { clientX?: number; fromLeft?: boolean } = {}): void {
  const z = clampZoom(next);
  const changed = Math.abs(z - zoom) > 1e-4;
  if (!changed && !opts.fromLeft) {
    renderZoomCtl();
    return;
  }
  const scroll = document.getElementById("grid-scroll");
  pendingAnchor = opts.fromLeft
    ? { min: axisStartFor(cat, currentDate), screenX: LABEL_W }
    : scroll
      ? gridAnchor(scroll, opts.clientX)
      : null;
  if (changed) {
    zoom = z;
    setZoom(z); // 持久化视图偏好(不广播 —— 下面这行自己重绘)
  }
  renderGrid();
  renderZoomCtl();
}

/** 缩放控件(网格标题行右侧):− / 当前百分比(=复位) / + / 适应宽度。到两端置灰。 */
const ZBTN_CLS =
  "border-0 bg-card px-[8px] py-[3px] text-[12px] font-bold leading-[1.5] text-ink-2 hover:bg-[var(--bg-hover-soft)] disabled:opacity-30 disabled:cursor-not-allowed";
const ZMID_CLS =
  "border-0 border-x border-line-soft bg-card px-[6px] py-[3px] text-[12px] font-bold tabular-nums text-ink min-w-[48px] leading-[1.5] hover:bg-[var(--bg-hover-soft)]";
const ZFIT_CLS =
  "border-0 border-l border-line-soft bg-card px-[9px] py-[3px] text-[12px] font-bold leading-[1.5] text-ink-2 hover:bg-[var(--bg-hover-soft)]";

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
  host.replaceChildren(
    zoomBtn("−", "out", `缩小时间轴(当前 ${pct})\n也可按住 Ctrl / ⌘ 滚轮(触控板双指捏合)`, zoom <= ZOOM_MIN + 1e-6, ZBTN_CLS),
    zoomBtn(pct, "reset", `当前缩放 ${pct} —— 点击回到 100%`, false, ZMID_CLS),
    zoomBtn("+", "in", `放大时间轴(当前 ${pct})\n也可按住 Ctrl / ⌘ 滚轮(触控板双指捏合)`, zoom >= ZOOM_MAX - 1e-6, ZBTN_CLS),
    zoomBtn("适应", "fit", "适应宽度:尽量把当天整条时间轴塞进视口,左缘对齐轴起点(到 35% 下限为止;更长则保留小量横向滚动)", false, ZFIT_CLS)
  );
}

function renderGrid(): void {
  const host = document.getElementById("grid-scroll")!;
  // 换节点前先记视口锚点:缩放走 applyZoom 预算好的(那时刻度还是旧值),其余同日期重建按当前刻度就地算;
  // 切日期/首渲 anchor = null → 回最左
  const anchor = pendingAnchor ?? (currentDate === lastGridDate ? gridAnchor(host) : null);
  pendingAnchor = null;
  const conf = conflicts.get(currentDate);
  const pxPerMin = PX_PER_MIN * zoom;
  const grid = buildGrid(
    {
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
    },
    currentDate
  );
  host.replaceWith(grid);
  grid.id = "grid-scroll";
  // 锚点回算:同一日期内刻度可能变了(缩放),故必须用新刻度重算 scrollLeft,不能沿用旧 scrollLeft
  if (anchor) {
    const left = (anchor.min - axisStartFor(cat, currentDate)) * pxPerMin - (anchor.screenX - LABEL_W);
    grid.scrollLeft = Math.max(0, Math.min(left, grid.scrollWidth - grid.clientWidth));
  }
  lastGridDate = currentDate;
  fitTimeTexts(grid); // 挂载后量测:窄卡时间文本降级,绝不截断

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
      "ml-[8px] border border-biff bg-biff-soft text-biff rounded-full px-[8px] py-px text-[12px] font-bold align-middle cursor-pointer hover:bg-biff-line whitespace-nowrap",
      `只看 ${hh}:00 段 · 取消`
    );
    pill.dataset.clearHour = "1";
    pill.title = "点击取消时间筛选";
    countEl.appendChild(pill);
  }
}

function renderAgenda(): void {
  const host = document.getElementById("agenda")!;
  const agenda = buildAgenda({
    cat,
    slots: store.slotIndex,
    picks: store.picks,
    group: store.group,
    mappings: store.mappings,
    transitMin: store.settings.transitMin,
    gvTalkOf,
    conflicts,
    slotDate: currentDate, // C1:行程行同步网格整点筛选(命中高亮 / 未命中淡化)
    slotHour: hourFilter,
  });
  host.replaceWith(agenda);
  agenda.id = "agenda";

  const picked = codesOfGroup(store.group);
  const nConf = totalConflictPairs();
  const sum = document.getElementById("agenda-summary")!;
  sum.textContent = `${store.group} 方案 ${picked.length} 场${nConf ? ` · ${nConf} 处冲突` : ""}`;
  // P0-2:当前方案实时质量分(与引擎同权重;仅展示,不改排序)。档位来自影片级记录 → 同片多场必然同档。
  const rows: ScoredRow[] = [];
  for (const code of picked) {
    const s = cat.byCode.get(code);
    if (s) rows.push({ priority: priorityOfCode(code) ?? null, screening: s });
  }
  if (rows.length) {
    // 质量分同口径:上一场按有效结束算紧转场(GV 放弃映后谈 → 正片末,实时放宽)
    const sc = scorePlanRows(rows, store.settings.transitMin, OK_SLACK, (s) => effEndMin(s, gvTalkOf(s.code)));
    const pill = el(
      "span",
      "inline-flex items-center ml-[6px] border border-line rounded-full bg-card px-[8px] leading-[1.7] text-[11.5px] font-extrabold tabular-nums text-ink-2 whitespace-nowrap cursor-default hover:border-biff hover:text-biff",
      `分 ${sc.total}`
    );
    pill.title =
      `行程质量分:必看 ${sc.pri.must}×3 · 备选 ${sc.pri.maybe}×2 · 随缘 ${sc.pri.wild}×1` +
      `${sc.unset ? ` · 未分级 ${sc.unset}×0` : ""}` +
      `${sc.gv ? ` · GV +${sc.gv}` : ""}${sc.tight ? ` · 紧转场 −${sc.tight}` : ""} = ${sc.total}`;
    sum.appendChild(pill);
  }
}

function renderBadge(): void {
  const n = totalConflictPairs();
  const badge = document.getElementById("conflict-badge")!;
  badge.classList.toggle("is-hidden", n === 0);
  document.getElementById("conflict-count")!.textContent = String(n);
}

function renderSync(): void {
  const dot = document.getElementById("sync-dot")!;
  dot.classList.toggle("bg-ok", store.online);
  dot.classList.toggle("bg-disabled", !store.online);
  dot.title = store.online ? "D1 云端同步中" : "云端不可用 · 仅本地保存";
}

/** 顶栏「我的选片」实时计数 = 影片记录数(打标 / 点选场次 → commit 广播 → renderAll → 这里刷新;0 时角标隐藏) */
function renderPicksBadge(): void {
  const n = store.picks.size;
  const cnt = document.getElementById("my-picks-count");
  if (!cnt) return;
  cnt.textContent = String(n);
  cnt.classList.toggle("is-hidden", n === 0);
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
      renderAgenda();
      return;
    }

    // 甘特时间筛选:点击时间轴整点 → 只看该小时段;再点同一小时取消(行程侧同步高亮/淡化)
    const hourHit = t.closest<HTMLElement>("#grid-scroll [data-hour]");
    if (hourHit) {
      const h = Number(hourHit.dataset.hour);
      hourFilter = hourFilter === h ? null : h;
      renderGrid();
      renderAgenda();
      return;
    }
    // 标题旁「只看 X 段 · 取消」pill
    const clearHour = t.closest<HTMLElement>("[data-clear-hour]");
    if (clearHour) {
      hourFilter = null;
      renderGrid();
      renderAgenda();
      return;
    }

    // 甘特缩放:− / + 走档位阶梯(视口中心锚定);点百分比复位 100%;「适应」把整天塞进视口
    const zc = t.closest<HTMLElement>("#zoom-ctl [data-zoom]");
    if (zc) {
      const act = zc.dataset.zoom;
      if (act === "in") applyZoom(stepZoom(zoom, 1));
      else if (act === "out") applyZoom(stepZoom(zoom, -1));
      else if (act === "reset") applyZoom(1);
      else if (act === "fit") {
        const scroll = document.getElementById("grid-scroll");
        if (scroll) applyZoom(fitZoom(cat, currentDate, scroll.clientWidth), { fromLeft: true });
      }
      return;
    }

    // 方案切换
    const g = t.closest<HTMLElement>("#group-switch [data-g]");
    if (g) {
      setCurrentGroup(g.dataset.g as Group);
      return;
    }

    // 影片库:浏览全部影片 / 搜索 → 定位或详情
    if (t.closest("#library-btn")) {
      openLibrary(libraryCtx());
      return;
    }

    // 我的选片:影片库打标清单总览(筛选 / 详情 / 定位 / 取消打标)
    if (t.closest("#my-picks-btn")) {
      openMyPicks(libraryCtx());
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
        // 档位按该片已有记录继承;从未打标 → 先弹「选择档位」(强制定档),选定后一并落场次 + 弃映后
        const key = filmKeyOfCode(code);
        if (key) pickScreening(key, code, () => setGvTalk(code, false));
      }
      return;
    }
    const card = t.closest<HTMLElement>("#grid-scroll [data-code]");
    if (card) {
      // 新加入按该片已有档位继承(影片库打标 / 详情弹层设过);从未打标 → 先弹「选择档位」(强制定档)
      const code = card.dataset.code!;
      const key = filmKeyOfCode(code);
      if (key) pickScreening(key, code);
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
      else if (act.dataset.act === "gv-talk-min") openTalkMinModal(code); // 本场映后时长覆写(小弹层)
      return;
    }

    // 行程日期头 -> 跳到网格
    const jump = t.closest<HTMLElement>("[data-jump]");
    if (jump) {
      currentDate = jump.dataset.jump!;
      hourFilter = null;
      renderChips();
      renderGrid();
      renderAgenda();
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    // 冲突角标 -> 滚动到行程
    if (t.closest("#conflict-badge")) {
      document.getElementById("agenda-wrap")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    // 导出按钮 / 菜单
    if (t.closest("#export-btn")) {
      document.getElementById("export-menu")!.classList.toggle("is-hidden");
      return;
    }
    const ex = t.closest<HTMLElement>("#export-menu button");
    if (ex) {
      if (ex.dataset.which === "PICK") copyPicklist();
      else exportIcs(ex.dataset.which as "A" | "B" | "ALL");
      return;
    }
    if (!t.closest("[data-export-wrap]")) {
      document.getElementById("export-menu")!.classList.add("is-hidden");
    }

    // 设置
    if (t.closest("#settings-btn")) {
      openSettings();
    }
  });

  // §14 1b/2a:文档级委托,grid 卡 ↔ agenda 行 双向 hover(冲突组联动一并处理)
  document.addEventListener("mouseover", (ev) => onHoverLinkMove(ev, true));
  document.addEventListener("mouseout", (ev) => onHoverLinkMove(ev, false));

  // 甘特缩放:Ctrl / ⌘ + 滚轮(macOS 触控板双指捏合同为 ctrl+wheel)→ 以光标下的时刻为锚点走一档。
  // 必须 passive:false 才能 preventDefault 掉浏览器整页缩放。deltaY 累加到 60 才走一档 ——
  // 一次捏合会连发几十个 wheel 事件,不累积会瞬间从 100% 跳到 300%。
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
      applyZoom(stepZoom(zoom, dir), { clientX: ev.clientX });
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
function jumpToScreening(code: string): void {
  const s = cat.byCode.get(code);
  if (!s) return;
  closeAllModals(); // 整栈关闭:列表/详情任何一层都不能还盖着网格
  if (currentDate !== s.date) {
    currentDate = s.date;
    hourFilter = null;
    renderChips();
    renderGrid();
    renderAgenda();
  }
  // 页面滚到排片面板(顶部被吸顶栏盖住的部分留出)
  const wrap = document.getElementById("grid-wrap");
  if (wrap) {
    const top = wrap.getBoundingClientRect().top + window.scrollY - 64;
    window.scrollTo({ top: Math.max(top, 0), behavior: "smooth" });
  }
  // 等两帧布局稳定后:横向滚到卡片 + 闪烁高亮
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const scroll = document.getElementById("grid-scroll");
      const card = scroll?.querySelector<HTMLElement>(`[data-code="${code}"]`);
      if (!scroll || !card) return;
      const sRect = scroll.getBoundingClientRect();
      const cRect = card.getBoundingClientRect();
      const x = cRect.left - sRect.left + scroll.scrollLeft;
      scroll.scrollTo({
        left: Math.max(0, x - scroll.clientWidth / 2 + cRect.width / 2),
        behavior: "smooth",
      });
      card.classList.add("flash");
    })
  );
}

/* ---------------- 设置 ----------------
 *  排版口径(2026-09-10 优化):① 标题 + 控件同行**流式左对齐**(控件紧贴标题,标签长短不一也不会
 *  散成右侧一列);② 单位(分钟)移到**框外**做后缀,标题里不再带括号;③ 说明另起一行 12px muted、
 *  行高 1.6;④ 字段之间 14px,分组之间浅灰分割线 —— 一整片文字被切成两块,密度显著下降。 */

/** 设置项数字输入框:统一宽度 / 居中数字 / focus 红描边(与 modal.ts 豆瓣输入框同一口径)。
 *  单位不进框内 —— 由 settingsField 的 unit 参数渲染在框外,避免「分钟」被当成可编辑内容。 */
function settingsInput(value: string, max: number): HTMLInputElement {
  const inp = el(
    "input",
    "w-[76px] text-center tabular-nums border border-line rounded-[8px] px-2 py-[5px] text-[13px] " +
      "focus:border-biff focus:[outline:2px_solid_color-mix(in_srgb,var(--color-biff)_30%,var(--color-card))]"
  ) as HTMLInputElement;
  inp.type = "number";
  inp.min = "0";
  inp.max = String(max);
  inp.value = value;
  return inp;
}

/** 设置项骨架:标题 + 控件同一行(左对齐流式),可选单位后缀,说明另起一行小字。
 *  ⚠ `tag` 默认 `label`(点标题即聚焦输入框);**内含 button 的控件(分段选择器)必须传 `"div"`** ——
 *  否则点标题会冒泡到 label 内首个 button,表现为「点文字误选了选项」。 */
function settingsField(
  label: string,
  hint: string,
  control: HTMLElement,
  unit = "",
  tag: "label" | "div" = "label"
): HTMLElement {
  const box = el(tag, "flex flex-col gap-[3px]");
  const row = el("div", "flex items-center gap-[8px]");
  row.appendChild(el("span", "font-semibold text-[13.5px] whitespace-nowrap", label));
  row.appendChild(control);
  if (unit) row.appendChild(el("span", "text-[12.5px] text-ink-2", unit));
  box.append(row, el("div", "text-muted text-[12px] leading-[1.6]", hint));
  return box;
}

/** iOS 风分段选择器:低饱和灰轨道 + 白色滑块(选中),替代旧「品牌红实底白字」胶囊 ——
 *  设置项里的次要开关不该比「保存设置」这个主按钮更抢眼。两段互斥,点击即切换;
 *  类名口径收口在 cls(),初渲与后续重绘共用一份。 */
function segmented<T extends string>(
  opts: { value: T; label: string }[],
  cur: T,
  onPick: (v: T) => void
): HTMLElement {
  const cls = (on: boolean): string =>
    "border-0 rounded-[6px] px-[10px] py-[4px] text-[12.5px] font-semibold whitespace-nowrap " +
    "transition-[background-color,color,box-shadow] duration-[120ms] " +
    (on ? "bg-card text-ink shadow-[var(--shadow-card)]" : "bg-transparent text-muted hover:text-ink");
  const track = el("div", "inline-flex items-center gap-[2px] p-[2px] rounded-[8px] bg-raised");
  const btns = new Map<T, HTMLElement>();
  const set = (v: T): void => {
    btns.forEach((b, k) => (b.className = cls(k === v)));
  };
  for (const o of opts) {
    const b = el("button", cls(o.value === cur), o.label);
    b.type = "button";
    b.addEventListener("click", () => {
      onPick(o.value);
      set(o.value);
    });
    btns.set(o.value, b);
    track.appendChild(b);
  }
  return track;
}

function openSettings(): void {
  const body = el("div", "flex flex-col");

  // ---- 分组 1:导出 / 转场 ----
  const alarm = settingsInput(String(store.settings.alarmMin), 180);
  const f1 = settingsField(
    "提醒提前量",
    "导出 .ics 日历时的闹钟提醒，建议 30 - 60 分钟。",
    alarm,
    "分钟"
  );

  const transit = settingsInput(String(store.settings.transitMin), 120);
  const f2 = settingsField(
    "跨场馆转场缓冲",
    "仅用于判定跨影院场次的冲突，同一影院不受影响（默认 0 为仅判定时间重叠）。",
    transit,
    "分钟"
  );

  const group1 = el("div", "flex flex-col gap-[14px]");
  group1.append(f1, f2);

  // ---- 分组 2:GV 映后谈(浅灰分割线分组,不另加小标题 —— 标签已自解释,少一层文字) ----
  let gvDef = store.settings.gvTalkOn;
  const seg = segmented(
    [
      { value: "on", label: "参加 (含映后)" },
      { value: "off", label: "不参加 (仅正片)" },
    ],
    gvDef ? "on" : "off",
    (v) => {
      gvDef = v === "on";
    }
  );
  const f3 = settingsField(
    "GV 场默认映后谈",
    "新增 GV 场次时默认选中的状态（后续可在具体行程中单独切换）。",
    seg,
    "",
    "div"
  );

  // f4:GV 映后谈时长(全局默认)—— 改这里 = 谈段长度 / 有效结束 / 转场 / 冲突 / .ics 全链路跟着变
  const talkMin = settingsInput(String(store.settings.gvTalkMin), 240);
  const f4 = settingsField(
    "GV 映后谈默认时长",
    "官方排期包含 25 分钟映后谈，设为 0 则不拆分映后段（可逐场覆写）。",
    talkMin,
    "分钟"
  );

  const group2 = el("div", "flex flex-col gap-[14px] mt-[16px] pt-[16px] border-t border-line-soft");
  group2.append(f3, f4);

  // ---- 分组 3:AI 排片 Key(只读状态 + 清除)----
  //  填写 / 更换的入口收在「影片库 ▸ 智能排片 ▸ AI 排片」:那里有隐私说明与自定义偏好同屏,
  //  设置里不放输入框 —— 避免误触,也让「Key 只在本机」的说明紧贴使用场景。
  const aiState = el("span", "text-[12.5px] font-semibold");
  const aiClear = el(
    "button",
    "border border-line rounded-[7px] px-[8px] py-[3px] text-[11.5px] font-semibold bg-card text-ink hover:border-line-strong hover:bg-hover whitespace-nowrap",
    "清除 Key"
  );
  aiClear.dataset.ai = "settings-clear";
  aiState.dataset.ai = "settings-state";
  const paintAi = (): void => {
    const c = loadAiCfg();
    if (aiReady(c)) {
      aiState.className = "text-[12.5px] font-semibold text-ok";
      aiState.textContent = `已配置 · ${c.model} · ${maskKey(c.key)}`;
      aiClear.classList.remove("is-hidden");
    } else {
      aiState.className = "text-[12.5px] font-semibold text-muted";
      aiState.textContent = "未配置";
      aiClear.classList.add("is-hidden");
    }
  };
  aiClear.addEventListener("click", () => {
    if (!window.confirm("清除本机保存的 AI 排片 API Key?(其它设置与选片不受影响)")) return;
    clearAiCfg();
    paintAi();
    toast("已清除本机保存的 API Key");
  });
  paintAi();
  const aiCtl = el("div", "flex items-center gap-[8px] flex-wrap");
  aiCtl.append(aiState, aiClear);
  const f5 = settingsField(
    "AI 排片 · 模型 API Key",
    "只保存在本机浏览器（localStorage），不上传本站服务器、也不进任何本站请求。填写 / 更换请到「影片库 ▸ 智能排片 ▸ AI 排片」。",
    aiCtl,
    "",
    "div"
  );
  const group3 = el("div", "flex flex-col gap-[14px] mt-[16px] pt-[16px] border-t border-line-soft");
  group3.append(f5);

  // ---- 底部主操作:全弹层唯一的亮色按钮(右对齐)----
  const apply = el(
    "button",
    "border-0 rounded-[6px] px-[16px] py-[7px] text-[13px] font-bold text-on-brand bg-[linear-gradient(135deg,var(--biff-red)_0%,var(--biff-red-2)_100%)] hover:brightness-[1.05] active:translate-y-px",
    "保存设置"
  );
  apply.addEventListener("click", () => {
    setSettings({
      alarmMin: clampNum(alarm.value, 45),
      transitMin: clampNum(transit.value, 0),
      gvTalkOn: gvDef,
      gvTalkMin: Math.max(0, Math.round(clampNum(talkMin.value, 25))),
    });
    closeModal();
    toast("设置已保存");
  });
  const actions = el("div", "flex justify-end mt-[18px]");
  actions.appendChild(apply);

  // ---- 危险操作:降级为无边框/无底色的灰色文字按钮,并挪到弹窗最底部单独区域,
  //      与主按钮之间再隔一条分割线 —— 视觉权重拉低 + 误触路径物理隔开 ----
  const danger = el(
    "button",
    "border-0 bg-transparent p-0 text-[12px] text-muted underline-offset-2 hover:text-conf hover:underline",
    "清空全部已排场次(A+B)"
  );
  danger.title = "只清场次 —— 「我的选片」的选片意向(档位)保留,清完仍可一键智能排片";
  danger.addEventListener("click", () => {
    if (window.confirm("确定清空 A/B 两个方案的「全部已排场次」?选片意向(必看/备选/随缘)会保留。")) {
      clearScreeningSlots();
      closeModal();
      toast("已清空全部已排场次(选片意向保留)");
    }
  });
  const dangerZone = el("div", "flex mt-[14px] pt-[12px] border-t border-line-soft");
  dangerZone.appendChild(danger);

  body.append(group1, group2, group3, actions, dangerZone);

  openModal("设置", body);
}

/** GV 映后谈单场时长覆写小弹层:留空 / 点「跟随默认」= 清除覆写(回到跟随全局默认)。
 *  只有 is_gv 场次有入口(非 GV 无谈段);改完走 state 的 notify → renderAll 重绘网格 / 行程。 */
function openTalkMinModal(code: string): void {
  const s = cat.byCode.get(code);
  if (!s) return;
  const def = store.settings.gvTalkMin;
  const cur = gvTalkMinOv.get(code);
  const body = el("div", "grid gap-3");

  const inp = settingsInput(cur == null ? "" : String(cur), 240);
  inp.placeholder = String(def);
  const f = settingsField(
    `本场映后谈时长 · ${code}`,
    `留空 = 跟随全局默认 ${def}′;仅本场生效（其它 GV 场不动），设 0 则不拆映后段。`,
    inp,
    "分钟"
  );
  body.appendChild(f);

  const actions = el("div", "flex gap-[10px] mt-1");
  const ok = el(
    "button",
    "border-0 rounded-[6px] px-[14px] py-[6px] text-[13px] font-bold text-on-brand bg-[linear-gradient(135deg,var(--biff-red)_0%,var(--biff-red-2)_100%)] hover:brightness-[1.05]",
    "保存"
  );
  const follow = el(
    "button",
    "border border-line rounded-[6px] px-[12px] py-[6px] text-[13px] font-bold bg-card text-ink hover:border-biff",
    `跟随默认(${def}′)`
  );
  const apply = (min: number | null): void => {
    setGvTalkMin(code, min);
    closeModal();
    toast(min == null ? `已恢复跟随全局默认(${def}′)` : `本场映后谈已设为 ${min}′`);
  };
  ok.addEventListener("click", () => {
    const raw = inp.value.trim();
    apply(raw === "" ? null : Math.max(0, Math.round(clampNum(raw, def))));
  });
  follow.addEventListener("click", () => apply(null));
  actions.append(ok, follow);
  body.appendChild(actions);

  openModal("映后谈时长", body);
}

function clampNum(v: string, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* ---------------- §14 4b:抢票顺位清单(复制) ---------------- */
/** 顺位排序权重(必看 → 备选 → 随缘);未设档位(null)在清单里排备选位,不参与质量分 */
const PRI_RANK: Record<Priority, number> = { must: 0, maybe: 1, wild: 2 };
const rankOf = (p: Priority | null): number => (p ? PRI_RANK[p] : 1);

function copyPicklist(): void {
  document.getElementById("export-menu")!.classList.add("is-hidden");
  const group = store.group;
  // 一场一行;档位来自影片级记录(同一部片的多场必然同档 —— 这正是「一套数据」)
  const rows: { code: string; priority: Priority | null; s: Screening }[] = [];
  for (const code of codesOfGroup(group)) {
    const s = cat.byCode.get(code);
    if (s) rows.push({ code, priority: priorityOfCode(code) ?? null, s });
  }
  if (rows.length === 0) {
    toast(`「${group} 方案」还没有选片,先在网格里点选场次`);
    return;
  }
  rows.sort(
    (a, b) =>
      rankOf(a.priority) - rankOf(b.priority) ||
      Number(Boolean(b.s.is_gv)) - Number(Boolean(a.s.is_gv)) ||
      a.s.date.localeCompare(b.s.date) ||
      a.s.start_time.localeCompare(b.s.start_time)
  );
  const cnt: Record<Priority, number> = { must: 0, maybe: 0, wild: 0 };
  let unset = 0;
  rows.forEach((r) => {
    if (r.priority == null) unset++;
    else cnt[r.priority]++;
  });

  const lines: string[] = [];
  lines.push(`【BIFF 2026 抢票顺位 · ${group} 方案】共 ${rows.length} 场`);
  lines.push(
    `必看 ${cnt.must} · 备选 ${cnt.maybe} · 随缘 ${cnt.wild}` +
      (unset ? ` · 未分级 ${unset}` : "") +
      "(同优先级 GV/映后优先,同日按开场时间)"
  );
  lines.push("──");
  rows.forEach(({ code, priority, s }, i) => {
    const { label, weekday } = dateInfo(s.date);
    const title = s.title_zh || store.mappings.get(code)?.title_cn || s.title_en;
    // 有效结束 + GV 标记:含映后 / 仅正片(放弃)两种标注,转场口径与网格/行程一致
    const talk = gvTalkMin(s);
    const talkOn = talk > 0 ? gvTalkOf(code) : true;
    // 24+ 时制:跨午夜场终点折回 24h 内并带「次日」标记(如 "23:59–次日 05:35")
    const endMin = effEndMin(s, talkOn);
    const gvMark =
      talk > 0 ? (talkOn ? "(GV·含映后)" : "(GV·仅正片)") : s.is_gv ? "(GV)" : "";
    lines.push(
      `${i + 1}. [${priorityTag(priority)}] ${s.code} ${title} ${label} ${weekday} ${fmtMinRangeMin(hmsToMin(s.start_time), endMin)} ${s.venue_display}${gvMark}`
    );
  });
  void copyText(lines.join("\n")).then((ok) =>
    toast(ok ? `已复制抢票顺位清单(${rows.length} 场),按售票时段抢票` : "复制失败,请手动选择复制")
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* clipboard 权限拒绝时降级 execCommand */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/* ---------------- §14 1b/2a:冲突组 & 行程↔网格 双向 hover 联动 ---------------- */
// 全量化后不再有 .card / .a-row 语义类,用结构位置选择:grid 内的卡 / agenda 内的行。
const HOVER_SEL = "#grid-scroll [data-code], #agenda [data-code]";

function applyHoverLink(host: HTMLElement | null): void {
  const nodes = document.querySelectorAll<HTMLElement>(HOVER_SEL);
  nodes.forEach((n) => {
    n.classList.remove("hl-card");
    n.classList.remove("hl-row");
  });
  if (!host) return;
  const code = host.dataset.code!;
  const s = cat.byCode.get(code);
  const conf = s ? conflicts.get(s.date) : undefined;
  const group = conflictGroupFor(conf, code); // 1b:同冲突组全亮
  const want = new Set<string>([code, ...(group ? [...group] : [])]); // 2a:本体双端(grid↔agenda)同亮
  const isCard = host.closest("#grid-scroll") !== null;
  const hlCls = isCard ? "hl-card" : "hl-row";
  nodes.forEach((n) => {
    if (want.has(n.dataset.code!)) n.classList.add(hlCls);
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


let toastTimer: number | undefined;
function toast(msg: string): void {
  const node = document.getElementById("toast")!;
  node.textContent = msg;
  node.classList.remove("is-hidden");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.classList.add("is-hidden"), 3600);
}

/* ---------------- boot ---------------- */
async function boot(): Promise<void> {
  loadSettings();
  loadGvTalk();
  loadGvTalkMin();
  zoom = clampZoom(store.settings.zoom ?? 1); // 缩放倍率随设置恢复(renderAll 里的 renderZoomCtl 同步控件态)
  cat = await loadCatalog();
  currentDate = cat.dates[0] ?? "";
  // 选片记录(唯一数据源)必须在 cat 就绪之后载入:首次迁移要用 filmNodeKey(cat, s)
  // 把旧的场次级 plan 归并到影片级记录(旧两套 → 一套)
  loadPicks(filmKeyOfCode);

  subscribe(renderAll);
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
  void syncFromCloud();
  toast(currentDate ? "排片为 MOCK 数据 — 官方 Catalogue 发布后一键替换" : "schedule.json 为空");

  // A5:跨分钟/跨天自动推进「现在」线 —— 仅在时间键变化且仍在看当天时重画网格(角标补零、进出轴窗口随渲染取当前时间)
  let lastNowKey = "";
  window.setInterval(() => {
    const d = new Date();
    const key = `${todayIsoLocal()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    if (key === lastNowKey) return;
    lastNowKey = key;
    if (todayIsoLocal() === currentDate) renderGrid();
  }, 20_000);
}

boot();