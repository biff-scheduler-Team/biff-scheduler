// 选片网格 — 自研 CSS 网格:行=影厅,列=当日时间轴;卡片绝对定位。
// 全量化:网格 / 卡片 / 标签 / 时间标尺 / 转场紧底色提示 / ⓘ / 冲突旗 / 其他旗 全部 Tailwind utility。

import type { Catalog, Group, Mapping, PlanEntry, Priority, Screening } from "./types";
import { OK_SLACK, el, escapeHtml, fmtMinRange, hmsToMin } from "./util";
import { screeningsByVenue } from "./data";
import { codeTip, screeningBadgeKeys } from "./badges";
import { appendMetaRow, durChip, venueTip } from "./legend";

export const AXIS_START = 9 * 60; // 09:00
export const AXIS_END = 23 * 60; // 23:00
export const ROW_H = 92;
const LABEL_W = 148; // 粘性影厅列宽(沿用旧值,不动)
const LAST_TICK_BUMP = 14; // 给最末 tick 的 label 半宽留位,避免右缘切掉
const DEFAULT_PX_PER_MIN = 1.5; // 装得下默认走这个(每小时 90px)
const MIN_PX_PER_MIN = 0.7; // 压缩下限:低于此卡片过密,改回默认 + 横向滚动

/** 优先级 → --pc 变量类(@utility p-must/maybe/wild 定义于 style.css;须完整字面量,勿动态拼接) */
const PRI_PC: Record<Priority, string> = { must: "p-must", maybe: "p-maybe", wild: "p-wild" };

export interface GridCtx {
  cat: Catalog;
  plan: Map<string, PlanEntry>;
  group: Group;
  mappingOf: (code: string) => Mapping | undefined; // 豆瓣映射(回填中文名)
  conflictCodes: Set<string> | undefined; // 当日、当前方案冲突 code
  transitMin: number; // 跨馆转场缓冲(1a 余量判定)
  avail: number; // grid-scroll 可用宽度(px)——渲染前由 caller 测好
}

/** 视口足够宽 → 装得下默认 1.5;否则压缩 px/min 直到装下;压缩仍过密 → 退回默认 + 横向滚动 */
function computePxPerMin(avail: number): number {
  const axisMin = AXIS_END - AXIS_START;
  const defaultW = LABEL_W + axisMin * DEFAULT_PX_PER_MIN + LAST_TICK_BUMP;
  if (avail >= defaultW) return DEFAULT_PX_PER_MIN;
  const fitPx = (avail - LABEL_W - LAST_TICK_BUMP) / axisMin;
  if (fitPx >= MIN_PX_PER_MIN) return fitPx;
  return DEFAULT_PX_PER_MIN;
}

function titleFor(s: Screening, map: Mapping | undefined): string {
  return s.title_zh || map?.title_cn || s.title_en;
}

const LABEL_BOX_CLS =
  "sticky left-0 z-[3] bg-card border-r border-line px-[10px] py-[6px] flex flex-col justify-center min-h-[28px]";

const ROW_BASE_CLS = "grid grid-cols-[148px_1fr]";

export function buildGrid(ctx: GridCtx, date: string): HTMLElement {
  const rows = screeningsByVenue(ctx.cat, date);
  const pxPerMin = computePxPerMin(ctx.avail);
  const axisMin = AXIS_END - AXIS_START;
  const trackW = axisMin * pxPerMin;
  const totalW = LABEL_W + trackW + LAST_TICK_BUMP;
  const overflows = totalW > ctx.avail + 1;

  // 装得下 → 不加 cursor-grab、不接 attachPan(横向拖动无意义);装不下 → 保留
  const scroll = el("div", overflows ? "overflow-x-auto pb-[6px] cursor-grab" : "overflow-x-auto pb-[6px]");
  const min = el("div", "w-max min-w-full");
  min.style.width = `${totalW}px`;

  // 时间标尺(ruler):底部强描边与场馆行分隔
  const ruler = el("div", `${ROW_BASE_CLS} border-b border-line`);
  // 粘性影厅列内右对齐放 AXIS_START 标签(原 h=9 tick 会落在 x=0 被粘性列遮住,只露出 ":00" → 看上去像 "00");
  // 把首根小时标签放进粘性列内,标尺里从 h=10 起画,左缘截断问题消除。
  const rulerLabel = el("div", LABEL_BOX_CLS);
  rulerLabel.innerHTML = `<span class="self-end text-[10.5px] text-muted tabular-nums pr-[6px]">9:00</span>`;
  const rulerTicks = el("div", "relative");
  rulerTicks.style.width = `${trackW + LAST_TICK_BUMP}px`;
  for (let h = AXIS_START / 60 + 1; h <= AXIS_END / 60; h++) {
    const t = el(
      "span",
      "absolute top-[2px] text-[10.5px] text-muted -translate-x-1/2 tabular-nums",
      `${h}:00`
    );
    t.style.left = `${(h * 60 - AXIS_START) * pxPerMin}px`;
    rulerTicks.appendChild(t);
  }
  ruler.append(rulerLabel, rulerTicks);
  min.appendChild(ruler);

  const cardEls = new Map<string, HTMLElement>();
  let venueIdx = 0;
  for (const { venue, list } of rows) {
    const row = el(
      "div",
      `${ROW_BASE_CLS}${venueIdx > 0 ? " border-t border-line-faint" : ""}`
    );
    const label = el("div", LABEL_BOX_CLS);
    const vname = venue ? venue.name : list[0]?.venue_id ?? "?";
    // 只展示英文场馆名,去掉韩语副标(name_kr)
    label.innerHTML = `<span class="text-[12px] font-semibold leading-[1.3]">${escapeHtml(vname)}</span>`;
    row.appendChild(label);

    const tracks = el("div", "relative");
    tracks.style.width = `${trackW + LAST_TICK_BUMP}px`;
    tracks.style.height = `${ROW_H}px`;
    const hourPx = 60 * pxPerMin;
    const halfPx = 30 * pxPerMin;
    tracks.style.backgroundImage = `repeating-linear-gradient(90deg, transparent 0 ${hourPx - 1}px, var(--line-soft) ${hourPx - 1}px ${hourPx}px), repeating-linear-gradient(90deg, transparent 0 ${halfPx - 1}px, var(--line-faint) ${halfPx - 1}px ${halfPx}px)`;

    for (const s of list) {
      const card = appendCard(tracks, s, ctx, pxPerMin);
      cardEls.set(s.code, card);
    }
    row.appendChild(tracks);
    min.appendChild(row);
    venueIdx++;
  }

  if (rows.length > 0) markTightPairs(ctx, date, cardEls); // §14 1a:转场紧 → 问题卡淡底色提示

  if (rows.length === 0) {
    min.appendChild(el("div", "py-[26px] px-3 text-center text-muted", "当日暂无排片"));
  }

  scroll.appendChild(min);
  if (overflows) attachPan(scroll); // 鼠标按住左右拖 = 平移时间轴;装得下时无意义,不挂
  return scroll;
}

/* ---------------- 时间轴鼠标拖动平移 ---------------- */
/** 位移超过该 px 判定为拖动(否则视为点击,交给委托点选) */
const PAN_DRAG_PX = 5;

/** 拖完吞掉随之而来的 click,避免误触发卡片点选 / ⓘ 弹层等(位移 < 阈值时放行)。 */
let panSuppress = false;
document.addEventListener(
  "click",
  (ev: MouseEvent) => {
    if (!panSuppress) return;
    panSuppress = false;
    ev.stopPropagation();
    ev.preventDefault();
  },
  true
);

/**
 * 鼠标拖拽平移:pointerdown 记录起点;move/up 临时挂到 document(不用 setPointerCapture,
 * 否则 pointerup 会被重定向到容器,浏览器合成的 click 落在公共祖先,破坏卡片点选委托)。
 * 拖动中 @utility panning 置 grabbing 光标并禁用子元素 pointer-events(hover 联动不再闪烁)。
 * 触摸/触控板走原生 overflow 滚动,不接管。
 */
function attachPan(scroll: HTMLElement): void {
  let pid = -1;
  let startX = 0;
  let startLeft = 0;
  let moved = false;

  const down = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    pid = e.pointerId;
    startX = e.clientX;
    startLeft = scroll.scrollLeft;
    moved = false;
    panSuppress = false;
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
  };

  const move = (e: PointerEvent) => {
    if (e.pointerId !== pid) return;
    const dx = e.clientX - startX;
    if (!moved && Math.abs(dx) > PAN_DRAG_PX) {
      moved = true;
      panSuppress = true;
      scroll.classList.add("panning");
    }
    if (moved) scroll.scrollLeft = startLeft - dx;
  };

  const up = (e: PointerEvent) => {
    if (e.pointerId !== pid) return;
    pid = -1;
    moved = false;
    scroll.classList.remove("panning");
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", up);
  };

  scroll.addEventListener("pointerdown", down);
}

/** §14 1a:当前方案同日相邻场次,余量 slack=间隔−跨馆缓冲 <OK_SLACK 时,把「衔接的两场」用整卡淡底色标出来:
 *  琥珀=偏紧(tight)/ 红=扣除缓冲后不足(bad),底色叠加在 in-plan 选中态上(左优先级条/光晕仍保留),
 *  整卡面积提示 → 不遮文字、不受间隔宽窄与同馆/跨馆影响;hover 卡片即时浮窗看完整算式(data-tip)。
 *  中间片同时接两对紧转场时取更严重状态(bad 盖 tight),浮窗列出其参与的所有衔接。
 *  重叠冲突已由 conf 视觉覆盖,不重复标;与 agenda 16-D 同阈值/同色。 */
const TIGHT_BG = "color-mix(in srgb, var(--color-maybe) 16%, var(--color-card))";
const BAD_BG = "color-mix(in srgb, var(--color-conf) 13%, var(--color-card))";

interface TightMark {
  bad: boolean; // 是否已到"缓冲后不足"(bad 覆盖 tight)
  notes: string[]; // 参与衔接的说明行(hover 浮窗)
}

function markTightPairs(ctx: GridCtx, date: string, cardEls: Map<string, HTMLElement>): void {
  const picks: Screening[] = [];
  for (const e of ctx.plan.values()) {
    if (e.group !== ctx.group) continue;
    const s = ctx.cat.byCode.get(e.code);
    if (s && s.date === date) picks.push(s);
  }
  picks.sort((a, b) => hmsToMin(a.start_time) - hmsToMin(b.start_time));

  const marks = new Map<string, TightMark>();
  for (let i = 0; i + 1 < picks.length; i++) {
    const a = picks[i];
    const b = picks[i + 1];
    if (ctx.conflictCodes?.has(a.code) || ctx.conflictCodes?.has(b.code)) continue; // 冲突已由 conf 视觉覆盖
    const endA = hmsToMin(a.end_time);
    const startB = hmsToMin(b.start_time);
    const gap = startB - endA;
    if (gap <= 0) continue; // 防御:重叠必已在冲突组
    const need = a.venue_id !== b.venue_id ? ctx.transitMin : 0;
    const slack = gap - need;
    if (slack >= OK_SLACK) continue;

    const bad = slack < 0;
    const note = `${a.code} ${a.end_time}结束 → ${b.code} ${b.start_time}开始 · 间隔 ${gap}min${
      need ? ` · 跨馆需缓冲 ${need}min` : ""
    } · 余量 ${slack}min(${bad ? "不足" : "偏紧"})`;
    for (const code of [a.code, b.code]) {
      const m = marks.get(code);
      if (!m) marks.set(code, { bad, notes: [note] });
      else {
        m.bad = m.bad || bad;
        m.notes.push(note);
      }
    }
  }

  for (const [code, m] of marks) {
    const card = cardEls.get(code);
    if (!card) continue;
    card.style.background = m.bad ? BAD_BG : TIGHT_BG;
    card.dataset.tip =
      (m.bad ? "转场不足 · 缓冲后赶不上" : "转场偏紧 · 间隔较紧") + "\n" + m.notes.join("\n");
  }
}

function appendCard(tracks: HTMLElement, s: Screening, ctx: GridCtx): HTMLElement {
  const start = hmsToMin(s.start_time);
  const end = hmsToMin(s.end_time);
  const entry = ctx.plan.get(s.code);
  const isConflict = Boolean(ctx.conflictCodes?.has(s.code));
  const inCurrent = Boolean(entry && entry.group === ctx.group);
  const inOther = Boolean(entry && entry.group !== ctx.group);
  const priority = entry?.priority;

  // 基底 + 选中 / 冲突 / 其他方案 等状态组合在构造时一次算完(JS 后续不需 toggle)
  const parts: string[] = ["group"];
  parts.push(
    "absolute bg-card rounded-[5px] px-[7px] pb-1 pt-[5px] overflow-hidden cursor-pointer flex flex-col gap-px transition-[box-shadow,border-color] duration-[120ms] ease-in-out hover:shadow-[var(--shadow-hover)] hover:z-[2]"
  );
  if (isConflict) {
    // 冲突:粗红描边 + 浅红斜纹底色;title 用红色
    parts.push("border-2 border-conf bg-biff-tint");
    parts.push(
      "bg-[repeating-linear-gradient(-45deg,color-mix(in_srgb,var(--color-biff)_7%,transparent)_0_7px,transparent_7px_14px)]"
    );
  } else {
    parts.push("border border-line");
    if (inCurrent && priority) parts.push(`in-plan ${PRI_PC[priority]}`);
    else if (inOther) parts.push("in-other");
  }

  const card = el("div", parts.join(" "));
  card.dataset.code = s.code;
  card.style.left = `${(start - AXIS_START) * PX_PER_MIN + 2}px`;
  card.style.top = "6px";
  card.style.width = `${(end - start) * PX_PER_MIN - 4}px`;
  card.style.height = `${ROW_H - 12}px`;

  // 第一行:CODE + 起时间(缩写说明:CODE 数字 hover 提示官方场次编号)
  const t1 = el("span", "flex items-center gap-[3px] text-[12px] text-muted whitespace-nowrap");
  t1.innerHTML = `<b class="text-ink text-[12px]">${escapeHtml(s.code)}</b> ${fmtMinRange(s.start_time, s.end_time)}`;
  t1.querySelector("b")!.dataset.tip = codeTip(s.code);
  card.appendChild(t1);

  // 字段徽章行:等级 → 字幕 → 特性(GV/首映…) → 页码 → 片长;各徽章 data-tip 悬停即示义。
  // 无任何徽章(理论仅 mock 缺字段)时不创建,避免空行撑高卡片。
  if (s.rating || s.subs || typeof s.page === "number" || screeningBadgeKeys(s).length) {
    const bdgRow = el("span", "flex gap-[3px] flex-wrap items-center leading-none");
    appendMetaRow(bdgRow, s);
    bdgRow.appendChild(durChip(s.duration_min));
    card.appendChild(bdgRow);
  }

  const zh = titleFor(s, ctx.mappingOf(s.code));
  const ttlCls = `text-[13px] font-semibold truncate${isConflict ? " text-conf" : ""}`;
  const ttl = el("span", ttlCls, zh);
  const sub = el("span", "text-[11px] text-muted truncate", s.title_en !== zh ? s.title_en : `${s.duration_min}min`);
  card.append(ttl, sub);

  // ⓘ 详情钮:in-other 卡片不随 hover 出现 → opacity-40 始终;其它 opacity-0 + group-hover/group-focus-within 触发
  const infoCls = inOther
    ? "absolute top-[3px] right-[3px] border-0 bg-transparent text-muted text-[11px] py-px px-[3px] rounded-[4px] opacity-40 hover:text-biff hover:bg-[var(--biff-red-tint-3)]"
    : "absolute top-[3px] right-[3px] border-0 bg-transparent text-muted text-[11px] py-px px-[3px] rounded-[4px] opacity-0 transition-opacity duration-100 group-hover:opacity-[0.85] group-focus-within:opacity-[0.85] hover:text-biff hover:bg-[var(--biff-red-tint-3)]";
  const infoBtn = el("button", infoCls, "ⓘ");
  infoBtn.dataset.info = s.code;
  infoBtn.dataset.tip = "影片详情 / 豆瓣";
  card.appendChild(infoBtn);

  if (inOther)
    card.appendChild(
      el(
        "span",
        "absolute left-[3px] top-[2px] text-[9px] font-bold text-muted border border-line rounded-[3px] px-[2px]",
        entry!.group
      )
    );
  if (isConflict) card.appendChild(el("span", "absolute right-[22px] top-[2px] text-[11px] text-conf", "⚠"));

  tracks.appendChild(card);
  return card;
}