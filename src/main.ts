// 入口 — 装配数据/状态/视图,统一事件委托。
// 全量化:仅维护基础骨架(顶栏/面板/弹层根/Toast/底部),所有内部样式由 markup 端 Tailwind utility 表达。

import type { Catalog, Group, PlanEntry, Priority, Screening } from "./types";
import { dateInfo, el, hmsToMin } from "./util";
import { loadCatalog } from "./data";
import { computeConflicts, conflictGroupFor, type ConflictResult, type Slot } from "./conflict";
import { buildIcs, downloadIcs, pickEntries } from "./ics";
import {
  clearPlan,
  flipGroup,
  loadSettings,
  loadWish,
  removeCode,
  setCurrentGroup,
  setPriority,
  setSettings,
  store,
  subscribe,
  syncFromCloud,
  toggleCode,
} from "./state";
import { buildGrid } from "./grid";
import { buildAgenda } from "./agenda";
import { abbrTooltip } from "./badges";
import { attachTip } from "./tip";
import { buildGuideBody } from "./legend";
import { scorePlanRows, type ScoredRow } from "./engine";
import { closeModal, openModal, showCatalogFilmModal, showFilmModal } from "./modal";
import { openLibrary } from "./library";

let cat: Catalog;
let currentDate = "";
let conflicts = new Map<string, ConflictResult>();

/** 影片详情弹层的公共上下文(网格 ⓘ 与影片库共用) */
function filmModalCtx() {
  return { cat, plan: store.plan, group: store.group, mappings: store.mappings, toggle: toggleCode };
}

/* ---------------- 状态 -> 视图 ---------------- */
function computeConflictsForCurrentGroup(): Map<string, ConflictResult> {
  const slots: Slot[] = [];
  for (const e of store.plan.values()) {
    if (e.group !== store.group) continue;
    const s = cat.byCode.get(e.code);
    if (!s) continue;
    slots.push({
      code: e.code,
      date: s.date,
      start: hmsToMin(s.start_time),
      end: hmsToMin(s.end_time),
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
}

/** 日期 chip 类名(idle / 选中 — 背景/边框色 走 IDLE/ON 各自完整串,避免同类叠加后写者赢) */
const CHIP_DATE_BASE = "border rounded-full px-3 py-1 text-[13px] whitespace-nowrap hover:border-biff";
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

function renderGrid(): void {
  const host = document.getElementById("grid-scroll")!;
  const conf = conflicts.get(currentDate);
  const grid = buildGrid(
    {
      cat,
      plan: store.plan,
      group: store.group,
      mappingOf: (c) => store.mappings.get(c),
      conflictCodes: conf?.codeSet,
      transitMin: store.settings.transitMin,
    },
    currentDate
  );
  host.replaceWith(grid);
  grid.id = "grid-scroll";

  const { label, weekday } = dateInfo(currentDate);
  const dayShows = cat.schedule.screenings.filter((s) => s.date === currentDate).length;
  const pickedOnDay = [...store.plan.values()].filter(
    (e) => e.group === store.group && cat.byCode.get(e.code)?.date === currentDate
  ).length;
  document.getElementById("grid-date-title")!.textContent = `${label} ${weekday} · 排片总览`;
  document.getElementById("grid-count")!.textContent = `${dayShows} 场 · 本组已选 ${pickedOnDay} 场`;
}

function renderAgenda(): void {
  const host = document.getElementById("agenda")!;
  const agenda = buildAgenda({
    cat,
    plan: store.plan,
    group: store.group,
    mappings: store.mappings,
    transitMin: store.settings.transitMin,
    conflicts,
  });
  host.replaceWith(agenda);
  agenda.id = "agenda";

  const picked = [...store.plan.values()].filter((e) => e.group === store.group);
  const nConf = totalConflictPairs();
  const sum = document.getElementById("agenda-summary")!;
  sum.textContent = `${store.group} 方案 ${picked.length} 场${nConf ? ` · ${nConf} 处冲突` : ""}`;
  // P0-2:当前方案实时质量分(与引擎同权重;仅展示,不改排序)
  const rows: ScoredRow[] = [];
  for (const e of picked) {
    const s = cat.byCode.get(e.code);
    if (s) rows.push({ priority: e.priority, screening: s });
  }
  if (rows.length) {
    const sc = scorePlanRows(rows, store.settings.transitMin);
    const pill = el(
      "span",
      "inline-flex items-center ml-[6px] border border-line rounded-full bg-card px-[8px] leading-[1.7] text-[11.5px] font-extrabold tabular-nums text-ink-2 whitespace-nowrap cursor-default hover:border-biff hover:text-biff",
      `分 ${sc.total}`
    );
    pill.title =
      `行程质量分:必看 ${sc.pri.must}×3 · 备选 ${sc.pri.maybe}×2 · 随缘 ${sc.pri.wild}×1` +
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

/* ---------------- 事件绑定 ---------------- */
function bindEvents(): void {
  document.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;

    // 日期条
    const chip = t.closest<HTMLElement>("[data-date]");
    if (chip) {
      currentDate = chip.dataset.date!;
      renderChips();
      renderGrid();
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
      openLibrary({
        cat,
        plan: store.plan,
        group: store.group,
        mappings: store.mappings,
        onLocate: jumpToScreening,
        onFilm: (code) => {
          closeModal();
          // f### = 目录片 id(暂无排期):走目录片弹层,可先关联豆瓣
          if (/^f\d{3}$/.test(code)) showCatalogFilmModal(code, filmModalCtx());
          else showFilmModal(code, filmModalCtx());
        },
      });
      return;
    }

    // 网格卡片:详情钮优先,其次整卡选中/取消
    const info = t.closest<HTMLElement>("[data-info]");
    if (info) {
      showFilmModal(info.dataset.info!, filmModalCtx());
      return;
    }
    const card = t.closest<HTMLElement>("#grid-scroll [data-code]");
    if (card) {
      toggleCode(card.dataset.code!);
      return;
    }

    // 行程行操作(§14 2c:优先级走三段 seg 直接定位;grp/del 原样)
    const act = t.closest<HTMLElement>("[data-act]");
    if (act) {
      const code = act.closest<HTMLElement>("[data-code]")?.dataset.code;
      if (!code) return;
      if (act.dataset.act === "pri") setPriority(code, act.dataset.pri as Priority);
      else if (act.dataset.act === "grp") flipGroup(code);
      else if (act.dataset.act === "del") removeCode(code);
      return;
    }

    // 行程日期头 -> 跳到网格
    const jump = t.closest<HTMLElement>("[data-jump]");
    if (jump) {
      currentDate = jump.dataset.jump!;
      renderChips();
      renderGrid();
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
}

function exportIcs(which: "A" | "B" | "ALL"): void {
  document.getElementById("export-menu")!.classList.add("is-hidden");
  const entries = pickEntries([...store.plan.values()], cat, which);
  if (entries.length === 0) {
    toast(which === "ALL" ? "还没有任何选片" : `${which} 方案还没有选片`);
    return;
  }
  const ics = buildIcs(cat, entries, store.mappings, store.settings.alarmMin);
  downloadIcs(ics, `biff2026-${which.toLowerCase()}.ics`);
  toast(`已导出 ${entries.length} 场(${which === "ALL" ? "A+B" : which}),导入日历后按手机时区显示`);
}

/* ---------------- 影片库反向定位:跳日期 + 滚到卡片高亮 ---------------- */
function jumpToScreening(code: string): void {
  const s = cat.byCode.get(code);
  if (!s) return;
  closeModal();
  if (currentDate !== s.date) {
    currentDate = s.date;
    renderChips();
    renderGrid();
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

/* ---------------- 设置 ---------------- */
function settingsField(label: string, hint: string): { box: HTMLElement; row: HTMLElement } {
  const box = el("label", "grid gap-1");
  const row = el("div", "flex items-center gap-[10px]");
  row.appendChild(el("span", "font-semibold text-[13.5px]", label));
  box.append(row);
  box.appendChild(el("div", "text-muted text-[12px]", hint));
  return { box, row };
}

function openSettings(): void {
  const body = el("div", "grid gap-3");

  const f1 = settingsField("提醒提前量(分钟)", "导出 .ics 的闹钟,建议 30–60");
  const alarm = el("input", "w-[90px] border border-line rounded-[8px] px-2 py-[5px] text-[13px]") as HTMLInputElement;
  alarm.type = "number";
  alarm.min = "0";
  alarm.max = "180";
  alarm.value = String(store.settings.alarmMin);
  f1.row.appendChild(alarm);

  const f2 = settingsField("跨场馆转场缓冲(分钟)", "跨影院场次按此值判定冲突;同影院不受影响。默认 0 = 仅判时间重叠");
  const transit = el("input", "w-[90px] border border-line rounded-[8px] px-2 py-[5px] text-[13px]") as HTMLInputElement;
  transit.type = "number";
  transit.min = "0";
  transit.max = "120";
  transit.value = String(store.settings.transitMin);
  f2.row.appendChild(transit);

  const actions = el("div", "flex gap-[10px] mt-1");
  const apply = el(
    "button",
    "border-0 rounded-[6px] px-[14px] py-[6px] text-[13px] font-bold text-on-brand bg-[linear-gradient(135deg,var(--biff-red)_0%,var(--biff-red-2)_100%)] hover:brightness-[1.05]",
    "保存设置"
  );
  apply.addEventListener("click", () => {
    setSettings({ alarmMin: clampNum(alarm.value, 45), transitMin: clampNum(transit.value, 0) });
    closeModal();
    toast("设置已保存");
  });
  const danger = el(
    "button",
    "border rounded-[6px] px-[10px] py-1 text-[12px] font-bold bg-biff-soft text-conf border-biff-line",
    "清空全部选片(A+B)"
  );
  danger.addEventListener("click", () => {
    if (window.confirm("确定清空 A/B 两个方案的全部选片?")) {
      clearPlan();
      closeModal();
      toast("已清空全部选片");
    }
  });
  actions.append(apply, danger);
  body.append(f1.box, f2.box, actions);

  openModal("设置", body);
}

function clampNum(v: string, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* ---------------- §14 4b:抢票顺位清单(复制) ---------------- */
const PRI_TAG: Record<Priority, string> = { must: "必看", maybe: "备选", wild: "随缘" };
const PRI_RANK: Record<Priority, number> = { must: 0, maybe: 1, wild: 2 };

function copyPicklist(): void {
  document.getElementById("export-menu")!.classList.add("is-hidden");
  const group = store.group;
  const rows: { e: PlanEntry; s: Screening }[] = [];
  for (const e of store.plan.values()) {
    if (e.group !== group) continue;
    const s = cat.byCode.get(e.code);
    if (s) rows.push({ e, s });
  }
  if (rows.length === 0) {
    toast(`「${group} 方案」还没有选片,先在网格里点选场次`);
    return;
  }
  rows.sort(
    (a, b) =>
      PRI_RANK[a.e.priority] - PRI_RANK[b.e.priority] ||
      Number(Boolean(b.s.is_gv)) - Number(Boolean(a.s.is_gv)) ||
      a.s.date.localeCompare(b.s.date) ||
      a.s.start_time.localeCompare(b.s.start_time)
  );
  const cnt: Record<Priority, number> = { must: 0, maybe: 0, wild: 0 };
  rows.forEach((r) => cnt[r.e.priority]++);

  const lines: string[] = [];
  lines.push(`【BIFF 2026 抢票顺位 · ${group} 方案】共 ${rows.length} 场`);
  lines.push(`必看 ${cnt.must} · 备选 ${cnt.maybe} · 随缘 ${cnt.wild}(同优先级 GV/映后优先,同日按开场时间)`);
  lines.push("──");
  rows.forEach(({ e, s }, i) => {
    const { label, weekday } = dateInfo(s.date);
    const title = s.title_zh || store.mappings.get(s.code)?.title_cn || s.title_en;
    lines.push(
      `${i + 1}. [${PRI_TAG[e.priority]}] ${s.code} ${title} ${label} ${weekday} ${s.start_time}–${s.end_time} ${s.venue_display}${s.is_gv ? "(GV)" : ""}`
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
function restoreLocalPlan(): void {
  try {
    const raw = localStorage.getItem("biff.plan.v1");
    if (!raw) return;
    const arr = JSON.parse(raw) as { code: string; group: string; priority: string; note: string }[];
    for (const r of arr) {
      if (!r.code || (r.group !== "A" && r.group !== "B")) continue;
      store.plan.set(r.code, {
        code: r.code,
        group: r.group,
        priority: r.priority === "must" || r.priority === "wild" ? r.priority : "maybe",
        note: r.note ?? "",
      });
    }
  } catch {
    /* ignore */
  }
}

async function boot(): Promise<void> {
  loadSettings();
  loadWish();
  restoreLocalPlan();
  cat = await loadCatalog();
  currentDate = cat.dates[0] ?? "";

  subscribe(renderAll);
  bindEvents();
  attachTip(); // 缩写说明悬停 tooltip(data-tip 文档级委托,渲染重建无需重绑)
  // 图例「ⓘ 日程表说明」:hover 快速多行提示(单源自 badges.ts abbrTooltip);点击打开总览弹层
  const abbrHelp = document.getElementById("abbr-help");
  if (abbrHelp) {
    abbrHelp.dataset.tip = abbrTooltip();
    abbrHelp.addEventListener("click", () => openModal("排片表说明 · 图例总览", buildGuideBody(cat), true));
  }
  renderAll();
  void syncFromCloud();
  toast(currentDate ? "排片为 MOCK 数据 — 官方 Catalogue 发布后一键替换" : "schedule.json 为空");
}

boot();