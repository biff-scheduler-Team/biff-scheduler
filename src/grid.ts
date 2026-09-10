// 选片网格 — 自研 CSS 网格:行=影厅,列=当日时间轴;卡片绝对定位。
// 全量化:网格 / 卡片 / 标签 / 时间标尺 / 转场紧底色提示 / ⓘ / 冲突旗 / 其他旗 全部 Tailwind utility。

import type { Catalog, Group, Mapping, Priority, Screening } from "./types";
import { OK_SLACK, el, fmtMinRange, hmsToMin, minToHms, todayIsoLocal } from "./util";
import { screeningsByVenue } from "./data";
import { codeTip, screeningBadgeKeys } from "./badges";
import { effEndMin, filmEndMin, gvTalkMin } from "./gv";
import { appendMetaRow, durChip, venueTip } from "./legend";
import { PRI_DOT_BG, PRI_LABEL } from "./pick";

export const ROW_H = 92;
const LABEL_W = 148; // 粘性影厅列宽(沿用旧值,不动)
const TRAIL_PAD = 60; // A3:末 tick 右侧 +60px 安全边距(标签半宽 + 呼吸),两端标签永不悬出/被裁
const PX_PER_MIN = 3.0; // D1+再加长:时间刻度固定 3.0px/min(每小时 180px;1.5h≈270px;2h≈360px)。
// 横向更舒展 → 6 chip 徽章行单行排开、短场次(60–95min)不再因行宽不足换行或降级时间;
// 各日期比例一致 → 常规视口必然横向溢出 → 滚动条 + 拖拽平移常态化浏览(沿用 D3)。
const AXIS_FALLBACK = { start: 9 * 60, end: 23 * 60 }; // A1:当日无排片时的时间轴兜底窗口
const AXIS_LEAD_MIN = 30; // A1:首场开映前保留的呼吸时间(轴起点对齐到整点)
const CARD_INSET_Y = 2; // 卡片上下留白(满高泳道:6 → 2px,几乎顶满行;行与行靠 border-line-soft 分隔线区分)

/** 冲突 / 紧转场 / 已选 的红绿灯底色:优先级不参与网格染色(见行程行 seg),故无 p-* 类映射。 */
export interface GridCtx {
  cat: Catalog;
  /** 已选场次投影:code → { 影片 key, 方案 }。判「已选 / 在哪个方案」全走它(唯一数据源) */
  slots: Map<string, { key: string; group: Group }>;
  group: Group;
  mappingOf: (code: string) => Mapping | undefined; // 豆瓣映射(回填中文名)
  conflictCodes: Set<string> | undefined; // 当日、当前方案冲突 code
  transitMin: number; // 跨馆转场缓冲(1a 余量判定)
  /** GV 映后谈是否参加(全局默认 + 单场覆写解析后):决定正片/整场拆分、紧转场按哪段结束算 */
  gvTalkOf: (code: string) => boolean;
  /** 该片档位(必看/备选/随缘):undefined = 未打标 —— 与红绿灯底色正交,只画标题行前的档位色点 */
  wishOf?: (s: Screening) => Priority | undefined;
  hourFilter?: number | null; // 点击时间轴整点 → 只看该小时段场次(其余 hour-dim);null = 不过滤
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
  const pxPerMin = PX_PER_MIN; // D1:固定刻度,不再按视口压缩(各日期比例一致)
  const trackW = axisMin * pxPerMin;
  const totalW = LABEL_W + trackW + TRAIL_PAD;
  const nowPx = todayIsoLocal() === date ? nowPxFor(axis, pxPerMin) : null;

  // D3:横向溢出常态化 → 原生滚动条始终可用 + cursor-grab 拖拽平移恒挂(attachPan 内部对装得下的容器自行守卫)
  const scroll = el("div", "overflow-x-auto pb-[6px] cursor-grab");
  const min = el("div", "w-max min-w-full");
  min.style.width = `${totalW}px`;

  // 时间标尺(ruler):底部强描边与场馆行分隔。粘性列空占位(动态轴首根整点标签左锚定画在轨道内,
  // 替代旧「9:00 放粘性列」的写法 —— 轴界不再固定 9 点,只有当日首场那一格需要贴左)。
  const ruler = el("div", `${ROW_BASE_CLS} border-b border-line`);
  ruler.append(el("div", LABEL_BOX_CLS), buildRulerTicks(ctx, axis, pxPerMin, trackW, nowPx));
  min.appendChild(ruler);

  const cardEls = new Map<string, HTMLElement>();
  const talkEls = new Map<string, HTMLElement>(); // GV 映后谈块(与正片卡同 code 关联)
  let venueIdx = 0;
  for (const { venue, list } of rows) {
    const row = el(
      "div",
      `${ROW_BASE_CLS}${venueIdx > 0 ? " border-t border-line-soft" : ""}`
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
      c.dataset.tip = `影院代码 ${venue.code}\n官方日程表的场馆缩写 — 与官方 Catalogue 对表(2025 届同馆口径 mock;2026 以官网为准)`;
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
      const { card, talkEl } = appendCard(tracks, s, ctx, pxPerMin, axis.start);
      cardEls.set(s.code, card);
      if (talkEl) talkEls.set(s.code, talkEl);
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

  if (rows.length > 0) markTightPairs(ctx, date, cardEls, talkEls); // §14 1a:转场紧 → 问题卡淡底色提示

  if (rows.length === 0) {
    min.appendChild(el("div", "py-[26px] px-3 text-center text-muted", "当日暂无排片"));
  }

  scroll.appendChild(min);
  attachPan(scroll); // D3:按住鼠标左右拖 = 平移时间轴(滚动条同时可用;容器无横向溢出时守卫自动跳过)
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
    if (scroll.scrollWidth <= scroll.clientWidth + 1) return; // D1:超宽屏装得下 → 无需平移,不接管(避免拖动吞点击)
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

/** §14 1a:当前方案同日相邻场次,余量 slack=间隔−跨馆缓冲 <OK_SLACK 时,把「衔接的两场」整卡淡黄底标出 ——
 *  时间紧张(不足=扣除缓冲后为负 / 偏紧=0≤余量<15)同一黄色系;红只保留给「完全冲突」(时间重叠,
 *  由冲突视觉独立覆盖,此函数跳过)。通过 card.style.background 内联覆盖 in-plan 绿底(黄 > 绿)。
 *  整卡面积提示 → 不遮文字、不受间隔宽窄与同馆/跨馆影响;hover 卡片即时浮窗看完整算式(data-tip)。
 *  中间片同时接两对紧转场时取更严重状态(不足 盖 偏紧,浮窗文案区分),浮窗列出其参与的所有衔接。 */
const TIGHT_BG = "color-mix(in srgb, var(--color-tight) 24%, var(--color-card))";

interface TightMark {
  bad: boolean; // 是否已到"缓冲后不足"(bad 覆盖 tight)
  notes: string[]; // 参与衔接的说明行(hover 浮窗)
}

function markTightPairs(
  ctx: GridCtx,
  date: string,
  cardEls: Map<string, HTMLElement>,
  talkEls?: Map<string, HTMLElement>
): void {
  const picks: Screening[] = [];
  for (const [code, slot] of ctx.slots) {
    if (slot.group !== ctx.group) continue;
    const s = ctx.cat.byCode.get(code);
    if (s && s.date === date) picks.push(s);
  }
  picks.sort((a, b) => hmsToMin(a.start_time) - hmsToMin(b.start_time));

  const marks = new Map<string, TightMark>();
  for (let i = 0; i + 1 < picks.length; i++) {
    const a = picks[i];
    const b = picks[i + 1];
    if (ctx.conflictCodes?.has(a.code) || ctx.conflictCodes?.has(b.code)) continue; // 冲突已由 conf 视觉覆盖
    // GV 放弃映后谈 → 该场按正片末算有效结束,紧转场随之放宽
    const endA = effEndMin(a, ctx.gvTalkOf?.(a.code) ?? true);
    const startB = hmsToMin(b.start_time);
    const gap = startB - endA;
    if (gap <= 0) continue; // 防御:重叠必已在冲突组
    const need = a.venue_id !== b.venue_id ? ctx.transitMin : 0;
    const slack = gap - need;
    if (slack >= OK_SLACK) continue;

    const bad = slack < 0;
    const endATxt = minToHms(endA);
    const note = `${a.code} ${endATxt}结束${endATxt !== a.end_time ? "(已弃映后)" : ""} → ${b.code} ${b.start_time}开始 · 间隔 ${gap}min${
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
    // 黄盖绿(时间紧张的已选卡整卡淡黄底,不叠优先级色 — 网格不再按优先级染色):
    // in-plan 的 !important 绿底须用同等级 inline !important 才能压过 → setProperty(..., "important")
    card.style.setProperty("background", TIGHT_BG, "important");
    card.dataset.tip =
      (m.bad ? "时间紧张 · 转场不足(缓冲后赶不上)" : "时间紧张 · 衔接偏紧(余量 <15min)") +
      "\n" +
      m.notes.join("\n");
    // GV 映后谈块:仍在参加谈后(有效结束=槽位末)才镜像同款紧张底色,保证"两张一起选中"的整体感
    const talkEl = talkEls?.get(code);
    if (talkEl && (ctx.gvTalkOf?.(code) ?? true)) {
      talkEl.style.setProperty("background", TIGHT_BG, "important");
      talkEl.dataset.tip = card.dataset.tip;
    }
  }
}

/** GV 映后谈块上的两行小字时间区(谈段区间,如 15:45–16:10);块窄,字号再降一级 */
function talkTimeRange(s: Screening): string {
  return fmtMinRange(minToHms(filmEndMin(s)), s.end_time);
}

function appendCard(
  tracks: HTMLElement,
  s: Screening,
  ctx: GridCtx,
  pxPerMin: number,
  axisStart: number
): { card: HTMLElement; talkEl: HTMLElement | null } {
  const start = hmsToMin(s.start_time);
  const end = hmsToMin(s.end_time);
  const talk = gvTalkMin(s); // GV 映后谈分钟(数据推导;0 = 不拆,普通整卡)
  const talkOn = (ctx.gvTalkOf?.(s.code) ?? true) && talk > 0;
  const slot = ctx.slots.get(s.code);
  const isConflict = Boolean(ctx.conflictCodes?.has(s.code));
  const inCurrent = Boolean(slot && slot.group === ctx.group);
  const inOther = Boolean(slot && slot.group !== ctx.group);

  // 基底 + 选中 / 冲突 / 其他方案 等状态组合在构造时一次算完(JS 后续不需 toggle)
  const parts: string[] = ["group"];
  parts.push(
    "absolute bg-card rounded-[5px] px-[7px] pb-1 pt-[5px] overflow-hidden cursor-pointer flex flex-col gap-px transition-[box-shadow,border-color] duration-[120ms] ease-in-out hover:shadow-[var(--shadow-hover)] hover:z-[2]"
  );
  if (isConflict) {
    // 完全冲突(时间重叠,无法同看):红底 in-conf + 2px 红框,红标题 + ⚠;与绿/黄同一整卡底色语法
    parts.push("border-2 border-conf in-conf");
  } else {
    parts.push("border border-line");
    if (inCurrent) parts.push("in-plan"); // 已选 = 绿底(优先级不参与网格染色 — 见行程行 seg)
    else if (inOther) parts.push("in-other");
  }

  const card = el("div", parts.join(" "));
  card.dataset.code = s.code;
  // GV 拆分:主卡只画「正片段」(结束=正片末),谈段由右侧紧贴的 talk 块承接 → 视觉两张拼接
  const cardEnd = talk > 0 ? filmEndMin(s) : end;
  card.style.left = `${(start - axisStart) * pxPerMin + 2}px`;
  card.style.top = `${CARD_INSET_Y}px`;
  card.style.width = `${(cardEnd - start) * pxPerMin - 4}px`;
  card.style.height = `${ROW_H - CARD_INSET_Y * 2}px`;

  // 时间筛选:非选中小时段的场次淡化(hour-dim),保留上下文与 hover 可读(槽位整段含谈判定)
  if (ctx.hourFilter != null) {
    const inHour = start < (ctx.hourFilter + 1) * 60 && end > ctx.hourFilter * 60;
    if (!inHour) card.classList.add("hour-dim");
  }

  // 身份行:CODE + 起止时间(排片核心信息,时间升格加墨;时间 span 独立便于 fitTimeTexts 量测降级,
  // 窄卡放不下完整 "09:00–10:40" 时由挂载后实测降级为只显开始时间,完整时间移入 hover —— 绝不硬裁)。
  // E1:pr-[20px] 把行尾让给右上角标(ⓘ 右 3~18px / ⚠ 右 22px+),角标悬浮于预留空白,不遮挡时间文本。
  const t1 = el("span", "flex items-center gap-[3px] text-[12px] text-muted whitespace-nowrap overflow-hidden pr-[20px]");
  const codeB = el("b", "shrink-0 text-ink text-[12px]", s.code);
  codeB.dataset.tip = codeTip(s.code);
  const filmEndTxt = minToHms(filmEndMin(s));
  const cardRange = talk > 0 ? `${s.start_time}–${filmEndTxt}` : fmtMinRange(s.start_time, s.end_time);
  const timeSpan = el("span", "card-time shrink-0 text-[12px] font-semibold text-ink tabular-nums", cardRange);
  timeSpan.dataset.full = cardRange;
  timeSpan.dataset.short = s.start_time; // 降级备选:只显开始时刻
  t1.append(codeB, timeSpan);
  card.appendChild(t1);

  // D2 重排:顺序 = 身份行(CODE+时间)→ 中文片名 → 英文名 → 徽章流沉底。
  // 徽章流不再横插在时间与片名之间 —— 宽卡下单行放下,不再 wrap 挤压标题区;
  // mt-auto 把徽章贴到卡底,与标题区形成天然分组。信息零删除,各徽章 data-tip 悬停即示义。
  const zh = titleFor(s, ctx.mappingOf(s.code));
  const ttlCls = `text-[13px] font-bold truncate flex-1 min-w-0${isConflict ? " text-conf" : ""}`;
  // 「我的选片」档位色点(7px):标题行最前 —— 与红绿灯整卡底色正交,一眼看出"这是我标的必看/随缘"
  const wishP = ctx.wishOf?.(s);
  const ttlRow = el("span", "flex items-center gap-[4px] min-w-0");
  if (wishP) {
    const dot = el("span", `shrink-0 w-[7px] h-[7px] rounded-full ${PRI_DOT_BG[wishP]}`);
    dot.dataset.tip = `我的选片 · ${PRI_LABEL[wishP]}(在「我的选片」可总览/取消)`;
    ttlRow.appendChild(dot);
  }
  ttlRow.appendChild(el("span", ttlCls, zh));
  const sub = el("span", "text-[11px] text-muted truncate", s.title_en !== zh ? s.title_en : `${s.duration_min}min`);
  card.append(ttlRow, sub);

  // 徽章行:等级 → 字幕 → 特性(GV/首映…) → 页码 → 片长。无任何徽章(理论仅 mock 缺字段)时不创建,避免空行。
  if (s.rating || s.subs || typeof s.page === "number" || screeningBadgeKeys(s).length) {
    const bdgRow = el("span", "mt-auto flex gap-[3px] flex-wrap items-center leading-none");
    appendMetaRow(bdgRow, s);
    bdgRow.appendChild(durChip(s.duration_min));
    card.appendChild(bdgRow);
  }

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
        slot!.group
      )
    );
  if (isConflict) card.appendChild(el("span", "absolute right-[22px] top-[2px] text-[11px] text-conf", "⚠"));

  tracks.appendChild(card);

  // ---- GV 映后谈块(拼接卡右侧;talk=0 不创建)----
  if (talk > 0) {
    const talkEl = el("div");
    talkEl.dataset.code = s.code; // 双向 hover 联动(与正片卡同高亮);点击经 [data-talk] 分支拦截
    talkEl.dataset.talk = "1";
    // 几何:紧贴正片卡右缘(无间隙拼接),右缘与整场槽位右缘对齐
    const filmW = (filmEndMin(s) - start) * pxPerMin - 4;
    talkEl.style.left = `${(start - axisStart) * pxPerMin + 2 + filmW}px`;
    talkEl.style.top = `${CARD_INSET_Y}px`;
    talkEl.style.width = `${talk * pxPerMin}px`;
    talkEl.style.height = `${ROW_H - CARD_INSET_Y * 2}px`;

    // 状态外观:冲突沿用红(整场都在冲突区);已选且参加 → 同 in-plan 绿 = 两张一起选中;
    // 放弃映后谈 → gv-talk-off 灰虚线淡出(块仍占槽位,只表示"我不参加")
    const stateTokens: string[] = [];
    if (isConflict) stateTokens.push("border-2 border-conf in-conf");
    else if (inCurrent && talkOn) stateTokens.push("border border-line in-plan");
    else if (inOther && talkOn) stateTokens.push("border border-line in-other");
    else if (!talkOn) stateTokens.push("border border-dashed border-line gv-talk-off");
    else stateTokens.push("border border-line");
    talkEl.className =
      "absolute overflow-hidden cursor-pointer select-none flex flex-col items-center justify-center gap-[1px] rounded-[5px] " +
      stateTokens.join(" ");

    // 谈段斜纹底(透明层,不抢父级背景色,优先级染色/紧张底色仍整块生效)
    const hatch = el("span", "absolute inset-0 pointer-events-none rounded-[5px]");
    hatch.style.backgroundImage =
      "repeating-linear-gradient(-45deg, color-mix(in srgb, var(--color-ink) 6%, transparent) 0 5px, transparent 5px 10px)";
    talkEl.appendChild(hatch);

    const rng = el(
      "span",
      "relative text-[8.5px] tabular-nums leading-[1.2] whitespace-nowrap text-ink-2",
      talkTimeRange(s)
    );
    const lab = el(
      "span",
      "relative text-[9px] font-bold whitespace-nowrap leading-[1.3] text-ink",
      talkOn && inCurrent ? `✓ 映后 ${talk}′` : `映后 ${talk}′`
    );
    if (!talkOn) lab.classList.add("text-muted", "line-through");
    talkEl.append(rng, lab);

    talkEl.dataset.tip = talkTip(s, talk, talkOn, inCurrent);
    // 时间筛选联动:与正片卡同一套 hour-dim(谈段同样淡化,状态语言一致)
    if (ctx.hourFilter != null) {
      const inHour = start < (ctx.hourFilter + 1) * 60 && end > ctx.hourFilter * 60;
      if (!inHour) talkEl.classList.add("hour-dim");
    }
    tracks.appendChild(talkEl);
    return { card, talkEl };
  }

  return { card, talkEl: null };
}

/** 映后谈块 hover 说明(按当前状态切换文案;第 1 行标题 = 谈段区间,其余分点) */
function talkTip(s: Screening, talk: number, talkOn: boolean, inCurrent: boolean): string {
  const filmEnd = minToHms(filmEndMin(s));
  const range = `${filmEnd}–${s.end_time} 映后谈 ${talk}min(GV 嘉宾到场)`;
  if (!inCurrent)
    return [
      range,
      "你还没加入本场 — 点正片 = 连映后谈一起加入",
      `点这里 = 只看正片(放弃映后谈,该场按 ${filmEnd} 结束,转场 / 冲突即时放宽)`,
    ].join("\n");
  return talkOn
    ? [
        range,
        "已在行程中 — 默认连映后谈一起选",
        `点这里放弃 → 该场按 ${filmEnd} 结束,后续转场按正片末算`,
      ].join("\n")
    : [range, `已放弃 — 仅正片,${filmEnd} 结束`, `点这里恢复参加 → 按 ${s.end_time} 结束`].join("\n");
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