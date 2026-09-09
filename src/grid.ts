// 选片网格 — 自研 CSS 网格:行=影厅,列=当日时间轴;卡片绝对定位。
// 全量化:网格 / 卡片 / 标签 / 时间标尺 / 转场紧底色提示 / ⓘ / 冲突旗 / 其他旗 全部 Tailwind utility。

import type { Catalog, Group, Mapping, PlanEntry, Priority, Screening } from "./types";
import { OK_SLACK, el, fmtMinRange, hmsToMin, todayIsoLocal } from "./util";
import { screeningsByVenue } from "./data";
import { codeTip, screeningBadgeKeys } from "./badges";
import { appendMetaRow, durChip, venueTip } from "./legend";

export const ROW_H = 92;
const LABEL_W = 148; // 粘性影厅列宽(沿用旧值,不动)
const TRAIL_PAD = 60; // A3:末 tick 右侧 +60px 安全边距(标签半宽 + 呼吸),两端标签永不悬出/被裁
const DEFAULT_PX_PER_MIN = 1.5; // 装得下默认走这个(每小时 90px)
const MIN_PX_PER_MIN = 0.7; // 压缩下限:低于此卡片过密,改回默认 + 横向滚动
const AXIS_FALLBACK = { start: 9 * 60, end: 23 * 60 }; // A1:当日无排片时的时间轴兜底窗口
const AXIS_LEAD_MIN = 30; // A1:首场开映前保留的呼吸时间(轴起点对齐到整点)

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
  hourFilter?: number | null; // 点击时间轴整点 → 只看该小时段场次(其余 hour-dim);null = 不过滤
}

/** 视口足够宽 → 装得下默认 1.5;否则压缩 px/min 直到装下;压缩仍过密 → 退回默认 + 横向滚动 */
function computePxPerMin(avail: number, axisMin: number): number {
  const defaultW = LABEL_W + axisMin * DEFAULT_PX_PER_MIN + TRAIL_PAD;
  if (avail >= defaultW) return DEFAULT_PX_PER_MIN;
  const fitPx = (avail - LABEL_W - TRAIL_PAD) / axisMin;
  if (fitPx >= MIN_PX_PER_MIN) return fitPx;
  return DEFAULT_PX_PER_MIN;
}

/** A1 动态时间轴:轴界由「当日最早开映 − 呼吸时间」与「最晚散场」对齐整点推导,不再写死 09:00–23:00 ——
 *  早场 / 午夜场(00:xx 收场)自动外扩;整点标签取模 24 显示(24:00 → "00:00"),配合 TRAIL_PAD 不被右缘裁成 "00"。 */
function axisRangeFor(cat: Catalog, date: string): { start: number; end: number } {
  let first = Infinity;
  let last = -Infinity;
  for (const s of cat.schedule.screenings) {
    if (s.date !== date) continue;
    const st = hmsToMin(s.start_time);
    const en = hmsToMin(s.end_time);
    if (st < first) first = st;
    if (en > last) last = en;
  }
  if (!Number.isFinite(first)) return { ...AXIS_FALLBACK };
  const start = Math.max(0, Math.floor((first - AXIS_LEAD_MIN) / 60) * 60);
  const end = Math.max(Math.ceil(last / 60) * 60, start + 2 * 60);
  return { start, end };
}

/** A5「现在」时刻在该日时间轴内的像素位;不在轴内(或非当天)返回 null(角标/红线随每次渲染取当前时间) */
function nowPxFor(axis: { start: number; end: number }, pxPerMin: number): number | null {
  const d = new Date();
  const m = d.getHours() * 60 + d.getMinutes();
  return m >= axis.start && m <= axis.end ? (m - axis.start) * pxPerMin : null;
}

function titleFor(s: Screening, map: Mapping | undefined): string {
  return s.title_zh || map?.title_cn || s.title_en;
}

const LABEL_BOX_CLS =
  "sticky left-0 z-[3] bg-card border-r border-line px-[10px] py-[6px] flex flex-col justify-center min-h-[28px]";

const ROW_BASE_CLS = "grid grid-cols-[148px_1fr]";

export function buildGrid(ctx: GridCtx, date: string): HTMLElement {
  const rows = screeningsByVenue(ctx.cat, date);
  const axis = axisRangeFor(ctx.cat, date); // A1:当日动态轴(最早开映→最晚散场,整点对齐)
  const axisMin = axis.end - axis.start;
  const pxPerMin = computePxPerMin(ctx.avail, axisMin);
  const trackW = axisMin * pxPerMin;
  const totalW = LABEL_W + trackW + TRAIL_PAD;
  const overflows = totalW > ctx.avail + 1;
  const nowPx = todayIsoLocal() === date ? nowPxFor(axis, pxPerMin) : null;

  // 装得下 → 不加 cursor-grab、不接 attachPan(横向拖动无意义);装不下 → 保留
  const scroll = el("div", overflows ? "overflow-x-auto pb-[6px] cursor-grab" : "overflow-x-auto pb-[6px]");
  const min = el("div", "w-max min-w-full");
  min.style.width = `${totalW}px`;

  // 时间标尺(ruler):底部强描边与场馆行分隔。粘性列空占位(动态轴首根整点标签左锚定画在轨道内,
  // 替代旧「9:00 放粘性列」的写法 —— 轴界不再固定 9 点,只有当日首场那一格需要贴左)。
  const ruler = el("div", `${ROW_BASE_CLS} border-b border-line`);
  ruler.append(el("div", LABEL_BOX_CLS), buildRulerTicks(ctx, axis, pxPerMin, trackW, nowPx));
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
    // 场馆行:官方代码 chip + 英文名(整行 hover 看 全名/韩名/分区/代码 说明)
    if (venue) label.dataset.tip = venueTip(venue);
    const line = el("div", "flex items-center gap-[5px] min-w-0");
    if (venue?.code) {
      const c = el(
        "i",
        "shrink-0 not-italic text-[10px] font-extrabold text-biff bg-biff-soft border border-biff-line rounded-[3px] px-[3px] py-px",
        venue.code
      );
      c.dataset.tip = `影院代码 ${venue.code} — 官方日程表代码(2025 届同馆口径 mock;2026 以官网为准)`;
      line.appendChild(c);
    }
    line.appendChild(el("span", "text-[12px] font-semibold leading-[1.3] truncate min-w-0", vname));
    label.appendChild(line);
    row.appendChild(label);

    const tracks = el("div", "relative");
    tracks.style.width = `${trackW + TRAIL_PAD}px`;
    tracks.style.height = `${ROW_H}px`;
    const hourPx = 60 * pxPerMin;
    const halfPx = 30 * pxPerMin;
    // A2 甘特列感:整点竖线 ink 10%、半点竖线 ink 4%,贯穿整行(卡片浮于线上);与标尺整点刻度同 x 对齐
    const hourLine = "color-mix(in srgb, var(--color-ink) 10%, transparent)";
    const halfLine = "color-mix(in srgb, var(--color-ink) 4%, transparent)";
    tracks.style.backgroundImage = `repeating-linear-gradient(90deg, transparent 0 ${hourPx - 1}px, ${hourLine} ${hourPx - 1}px ${hourPx}px), repeating-linear-gradient(90deg, transparent 0 ${halfPx - 1}px, ${halfLine} ${halfPx - 1}px ${halfPx}px)`;

    for (const s of list) {
      const card = appendCard(tracks, s, ctx, pxPerMin, axis.start);
      cardEls.set(s.code, card);
    }
    // 「现在」时刻竖线贯穿各行(标尺已画带标签的一段,行内补全高)
    if (nowPx !== null) {
      const rowNow = el("span", "absolute top-0 bottom-0 w-[1.5px] now-line pointer-events-none z-[5]");
      rowNow.style.left = `${nowPx - 0.75}px`;
      tracks.appendChild(rowNow);
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

/** 标尺刻度区:整点标签(A1 加粗表格数字、可点=时间筛选)+ 整点 +6px 短刻度线 + 「现在」线/角标。
 *  A3:首根整点标签左锚定(不居中,左半永不越界);末 tick 之后容器留有 TRAIL_PAD 右侧安全边距。 */
function buildRulerTicks(
  ctx: GridCtx,
  axis: { start: number; end: number },
  pxPerMin: number,
  trackW: number,
  nowPx: number | null
): HTMLElement {
  const ticks = el("div", "relative");
  ticks.style.width = `${trackW + TRAIL_PAD}px`;
  const h0 = axis.start / 60;
  const h1 = axis.end / 60;
  for (let h = h0; h <= h1; h++) {
    const x = (h * 60 - axis.start) * pxPerMin;
    const isFirst = h === h0; // A3:首根左锚定,不 -translate-x-1/2
    const on = ctx.hourFilter === h;
    const label = `${String(h % 24).padStart(2, "0")}:00`; // A1:跨午夜整点按 24h 取模(24:00 → "00:00",不截断)
    const b = el(
      "button",
      "absolute top-[1px] border-0 bg-transparent px-[5px] py-[1px] tabular-nums text-[10.5px] font-bold rounded-[4px] transition-colors cursor-pointer " +
        (isFirst ? "left-0 text-left" : "-translate-x-1/2 ") +
        (on ? "bg-biff text-on-brand" : "text-ink-2 hover:bg-hover hover:text-biff"),
      label
    );
    b.style.left = `${x}px`;
    b.dataset.hour = String(h);
    b.title = `只看 ${label}–${String((h + 1) % 24).padStart(2, "0")}:00 段场次;再点取消`;
    ticks.appendChild(b);
    // A1:整点刻度 +6px 短线(与场馆行内整点竖线同 x,视觉上标尺与行内刻度相连)
    const tickLine = el("span", "absolute bottom-0 w-px h-[6px] bg-ink/25 pointer-events-none");
    tickLine.style.left = `${x - 0.5}px`;
    ticks.appendChild(tickLine);
  }
  // A5「现在」时刻竖线 + 角标:仅当天且当前时刻落在当日轴内时画(主线程跨分钟定时器触发重画推进)
  if (nowPx !== null) {
    const nowMark = el("span", "absolute top-0 bottom-0 w-[1.5px] now-line pointer-events-none z-[5]");
    nowMark.style.left = `${nowPx - 0.75}px`;
    ticks.appendChild(nowMark);
    const d = new Date();
    const nowTag = el(
      "span",
      "absolute top-[1px] -translate-x-1/2 z-[6] pointer-events-none text-[9px] font-extrabold text-on-brand bg-biff leading-[1.3] px-[4px] py-px rounded-[3px] whitespace-nowrap shadow-[0_0_0_1px_var(--color-card)]",
      `现在 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    );
    nowTag.style.left = `${nowPx}px`;
    ticks.appendChild(nowTag);
  }
  return ticks;
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
 *  琥珀=偏紧(tight)/ 红=扣除缓冲后不足(bad);通过 card.style.background 内联覆盖 in-plan 选中态底色
 *  (冲突等级更高;tight/bad 与同冲突组无重叠 — 冲突已由 conf 视觉独立覆盖)。
 *  整卡面积提示 → 不遮文字、不受间隔宽窄与同馆/跨馆影响;hover 卡片即时浮窗看完整算式(data-tip)。
 *  中间片同时接两对紧转场时取更严重状态(bad 盖 tight),浮窗列出其参与的所有衔接。 */
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
    // 同卡若同时为 in-plan,把优先级色(~9%)再叠进 tight/bad 底色 → 红/琥珀/灰 在同色系内仍可区分
    // (避免整卡底色压过优先级提示;同 in-plan 与紧转场两套交互叠用)
    const pcCls = [...card.classList].find((c) => c === "p-must" || c === "p-maybe" || c === "p-wild");
    const pcColor = pcCls === "p-must" ? "must" : pcCls === "p-maybe" ? "maybe" : pcCls === "p-wild" ? "wild" : null;
    const base = m.bad ? BAD_BG : TIGHT_BG;
    card.style.background = pcColor
      ? `color-mix(in srgb, var(--color-${pcColor}) 9%, ${base})`
      : base;
    card.dataset.tip =
      (m.bad ? "转场不足 · 缓冲后赶不上" : "转场偏紧 · 间隔较紧") + "\n" + m.notes.join("\n");
  }
}

function appendCard(tracks: HTMLElement, s: Screening, ctx: GridCtx, pxPerMin: number, axisStart: number): HTMLElement {
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
  card.style.left = `${(start - axisStart) * pxPerMin + 2}px`;
  card.style.top = "6px";
  card.style.width = `${(end - start) * pxPerMin - 4}px`;
  card.style.height = `${ROW_H - 12}px`;

  // 时间筛选:非选中小时段的场次淡化(hour-dim),保留上下文与 hover 可读
  if (ctx.hourFilter != null) {
    const inHour = start < (ctx.hourFilter + 1) * 60 && end > ctx.hourFilter * 60;
    if (!inHour) card.classList.add("hour-dim");
  }

  // 第一行:CODE + 起止时间。时间文本独立 span:
  // 窄卡放不下完整 "09:00–10:40" 时,由 fitTimeTexts(挂载后实测)降级为只显开始时间,完整时间移入 hover。
  const t1 = el("span", "flex items-center gap-[3px] text-[12px] text-muted whitespace-nowrap overflow-hidden");
  const codeB = el("b", "shrink-0 text-ink text-[12px]", s.code);
  codeB.dataset.tip = codeTip(s.code);
  const timeSpan = el(
    "span",
    "card-time shrink-0 text-[11.5px] font-semibold text-ink-2 tabular-nums",
    fmtMinRange(s.start_time, s.end_time)
  );
  timeSpan.dataset.full = fmtMinRange(s.start_time, s.end_time);
  timeSpan.dataset.short = s.start_time; // 降级备选:只显开始时刻
  t1.append(codeB, timeSpan);
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

/**
 * 卡片时间防截断:网格已挂载到 DOM 后调用(此时可同步量 t1.scrollWidth)。
 * 完整 "09:00–10:40" 放不下 → 降级为只显开始时间 "09:00";仍放不下 → 时间文本藏起,
 * 完整区间放入 data-tip(hover 即时可见)——绝不出现 "00:0…" 这类被裁断的中间态。
 */
export function fitTimeTexts(host: HTMLElement): void {
  host.querySelectorAll<HTMLElement>(".card-time").forEach((span) => {
    const row = span.parentElement as HTMLElement | null;
    if (!row) return;
    const full = span.dataset.full ?? "";
    const short = span.dataset.short ?? "";
    const show = (t: string): void => {
      span.textContent = t;
      span.dataset.tip = full; // 完整时间永远可 hover 查看
    };
    show(full);
    if (row.scrollWidth <= row.clientWidth + 1) return; // 完整放得下
    show(short);
    if (row.scrollWidth <= row.clientWidth + 1) return; // 开始时间放得下
    show(""); // 极端窄:藏时间,CODE 与 hover 兜底
  });
}