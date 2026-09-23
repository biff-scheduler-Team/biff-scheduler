import type {Catalog, Mapping, Screening} from './types';
import {displayTitle, fmtEndClock, fmtMinRange, fmtMinRangeMin, hmsToMin} from './util';
import {effEndMin, filmEndMin, gvTalkMin} from './gv';
import {matchesFilters, type FilterState} from './filters';

export const ROW_H = 92;

export const PX_PER_MIN = 3.0;

const AXIS_FALLBACK = { start: 9 * 60, end: 23 * 60 };

const AXIS_LEAD_MIN = 30;

const CARD_INSET_Y = 2;

export const ZOOM_LEVELS: number[] = [0.55, 0.7, 0.9, 1, 1.2];

export const ZOOM_MIN = ZOOM_LEVELS[0];

export const ZOOM_MAX = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

export function stepZoom(z: number, dir: 1 | -1): number {
  if (dir === 1) {
    const up = ZOOM_LEVELS.find((l) => l > z + 1e-6);
    return up ?? ZOOM_MAX;
  }
  const idx = ZOOM_LEVELS.findIndex((l) => l >= z - 1e-6);
  return idx <= 0 ? ZOOM_MIN : ZOOM_LEVELS[idx - 1];
}

export interface RowMetrics {
  /** 行高(px)= ROW_H × 倍率 */
  rowH: number;
  /** 卡片内字号倍率 —— **线性 = 行高倍率**(等比):字号与卡片宽高同比例,排版严格等比不挤乱。 */
  fontScale: number;
  /** 卡片上下留白(随行高收缩,但保底 1px —— 归零后相邻两行卡片会糊成一片) */
  insetY: number;
  /** 是否还画徽章行(等级/字幕/GV/页码/片长)—— 矮到装不下四行时最先舍它(信息在 ⓘ / hover 仍在) */
  showBadges: boolean;
}

export function rowMetrics(z: number): RowMetrics {
  const rowH = Math.round(ROW_H * z);
  return {
    rowH,
    fontScale: z, // 等比:字号倍率 = 行高倍率(线性)
    insetY: Math.max(1, Math.round(CARD_INSET_Y * z)),
    showBadges: rowH >= 80,
  };
}

export function labelMetrics(pxPerMin: number): {
  labelW: number;
  chipW: number;
  fontPx: number;
  padX: number;
} {
  const z = pxPerMin / PX_PER_MIN;
  const fontPx = Math.round(Math.min(22, Math.max(9, 10 * z)));
  const chipW = Math.round(fontPx * 2.8); // 容下 3 字符代码(L10 / BCM)+ 左右边框
  const padX = fontPx; // 列内边距跟着字号走 → 列宽与 chip 严格等比
  return { labelW: chipW + 2 * padX + 1, chipW, fontPx, padX };
}

export function fitZoomLevel(cat: Catalog, date: string, availW: number): number {
  let best = ZOOM_MIN;
  for (const l of ZOOM_LEVELS) {
    if (ganttGeometry(cat, date, l).width <= availW) best = l;
  }
  return best;
}

/** React 渲染器与「适应宽度」控件共用同一份画布实际尺寸。 */
export function ganttGeometry(cat: Catalog, date: string, zoom: number) {
  const { start, end } = axisRangeFor(cat, date);
  const ppm = PX_PER_MIN * zoom;
  const labelW = 148 * zoom;
  return {
    start, end, ppm, labelW,
    rowH: 112 * zoom,
    width: labelW + (end - start) * ppm + TRAIL_PAD,
  };
}

export function axisStartFor(cat: Catalog, date: string): number {
  return axisRangeFor(cat, date).start;
}

/** 轴范围按**给定场次集合**算(纯函数)。
 *  ⚠ 「我的行程」的日程表画布只有自己的场次,轴范围要跟着收紧 —— 若在调用点另算一遍
 *  「首场前 30 分钟取整 / 末场取「官方槽位末」与「GV 含映后结束」的较大者」,
 *  就成了同一口径的第二份实现(见 `axisRangeFor` 与 `docs/vertical-schedule.md`)。
 *  这里抽出按场次集合算的那一半,`axisRangeFor(cat, date)` 只是「先按日期筛一遍」的薄壳。 */
export function axisRangeOf(shows: readonly Screening[]): { start: number; end: number } {
  let first = Infinity;
  let last = -Infinity;
  for (const s of shows) {
    const st = hmsToMin(s.start_time);
    // 轴末取「官方槽位末」与「GV 含映后结束」的较大者 —— 映后时长可配置(gv.ts::gvTalkMin),
    // 调大后谈块会画到官方槽位之外,轴末不跟着外扩就会被右缘裁掉。
    const en = Math.max(hmsToMin(s.end_time), effEndMin(s, true));
    if (st < first) first = st;
    if (en > last) last = en;
  }
  if (!Number.isFinite(first)) return { ...AXIS_FALLBACK };
  const start = Math.max(0, Math.floor((first - AXIS_LEAD_MIN) / 60) * 60);
  const end = Math.max(Math.ceil(last / 60) * 60, start + 2 * 60);
  return { start, end };
}

export interface GridCtx {
  cat: Catalog;
  /** 横向刻度(px/min)= PX_PER_MIN × 缩放倍率。由 main 侧算好传入 —— 缩放是视图偏好,grid 只负责画 */
  pxPerMin: number;
  /** 行几何(行高 / 字号倍率 / 留白 / 徽章行开关)—— 由 main 侧 `rowMetrics(缩放倍率)` 算好传入 */
  row: RowMetrics;
  /** 已选场次投影:code → 影片 key。判「是否已选」全走它(唯一数据源) */
  slots: Map<string, { key: string }>;
  mappingOf: (code: string) => Mapping | undefined; // 豆瓣映射(回填中文名)
  conflictCodes: Set<string> | undefined; // 当日冲突 code
  /** 当日冲突 pair(与 conflictCodes 同源)—— 卡片 hover 说明 + 跨行连线都读它 */
  conflictPairs?: [string, string][];
  transitMin: number; // 跨馆转场缓冲(1a 余量判定)
  /** GV 映后谈是否参加(全局默认 + 单场覆写解析后):决定正片/整场拆分、紧转场按哪段结束算 */
  gvTalkOf: (code: string) => boolean;
  hourFilter?: number | null; // 点击时间轴整点 → 只看该小时段场次(其余 hour-dim);null = 不过滤
  /** **甘特图那套**排片筛选(字幕 / 影厅 / GV)—— 判定与控件在 `filters.ts`;
   *  网格只读它算「淡不淡」与「哪些影厅行要整行去掉」。缺省 = 不过滤。
   *  ⚠ 影片库抽屉另有一份**独立**状态(见 filters.ts 文件头),不从这里传。 */
  filters?: FilterState;
}

function axisRangeFor(cat: Catalog, date: string): { start: number; end: number } {
  return axisRangeOf(cat.schedule.screenings.filter((s) => s.date === date));
}

function talkTimeRange(s: Screening): string {
  return fmtMinRangeMin(filmEndMin(s), filmEndMin(s) + gvTalkMin(s));
}

export interface TalkState {
  /** 是否参加映后谈 */
  on: boolean;
  /** 谈块状态类 */
  stateCls: string;
  /** 主标签文案(参加且在行程中 → 带 ✓) */
  label: string;
  /** 谈段区间文案 */
  range: string;
  /** 是否被时间筛选淡化 */
  dim: boolean;
  /** hover 说明 */
  tip: string;
}

export interface CardState {
  /** 待选(未选且不冲突)—— 文字降一档灰阶 */
  isIdle: boolean;
  isConflict: boolean;
  /** 已选(绿底) */
  inCurrent: boolean;
  /** 整卡状态类(按 CARD_STATE_VOCAB 组合) */
  stateCls: string;
  /** 时间筛选:该场不在所选小时段内 → 淡化 */
  dim: boolean;
  /** 冲突角标(与 isConflict 同源,单独列出便于 patch 直接 toggle) */
  warn: boolean;
  /** 冲突卡的 hover 说明(列出每一个冲突对方;undefined = 不冲突) */
  conflictTip: string | undefined;
  /** GV 谈块(undefined = 该场无谈段,不建块也不 patch) */
  talk: TalkState | undefined;
}

function conflictTipOf(s: Screening, ctx: GridCtx, isConflict: boolean): string | undefined {
  if (!isConflict || !ctx.conflictPairs?.length) return undefined;
  const others = ctx.conflictPairs
    .filter(([a, b]) => a === s.code || b === s.code)
    .map(([a, b]) => (a === s.code ? b : a));
  if (others.length === 0) return undefined;
  const lines = others.map((c) => {
    const o = ctx.cat.byCode.get(c);
    if (!o) return c;
    const title = displayTitle(o, ctx.mappingOf(c)?.title_cn);
    const v = ctx.cat.venueById.get(o.venue_id);
    const vTxt = v ? v.code ?? v.id.toUpperCase() : o.venue_display;
    // ⚠ 区间文案一律走 `fmtMinRange`：手拼 `slice(0,5)` 会在午夜场把 24+ 时制的原值
    //   ("29:35")直接印给用户(2026-09-23,PLAN-20260923111748,R5 —— 这条也是本文件里的第二份实现)。
    return `${c}《${title}》${fmtMinRange(o.start_time, o.end_time)} · ${vTxt}`;
  });
  return ["时间重叠 — 与下列场次无法同时观看", ...lines].join("\n");
}

export function cardStateOf(s: Screening, ctx: GridCtx): CardState {
  const start = hmsToMin(s.start_time);
  const end = hmsToMin(s.end_time);
  const talk = gvTalkMin(s);
  const talkOn = (ctx.gvTalkOf?.(s.code) ?? true) && talk > 0;
  const slot = ctx.slots.get(s.code);
  const isConflict = Boolean(ctx.conflictCodes?.has(s.code));
  const inCurrent = Boolean(slot);
  // 待选(未选且不冲突):画布灰底上的白卡 —— 极淡边框 + 中灰文字,视为「待激活容器」;
  // hover 时描边加深(叠既有 shadow-hover 投影 + hl-card 红晕),文字不恢复墨色(激活靠点选后的整卡底色)。
  const isIdle = !isConflict && !inCurrent;
  // 淡化:时间筛选(非选中小时段)+ 字幕/影厅/GV 三道筛选不通过者 —— 两条来源共用一个 dim,
  // 因为对用户而言它们是同一件事:「这场现在不在我的视野里」。
  const hourDim = ctx.hourFilter != null && !(start < (ctx.hourFilter + 1) * 60 && end > ctx.hourFilter * 60);
  const dim = hourDim || (ctx.filters ? !matchesFilters(s, ctx.filters) : false);

  let stateCls: string;
  if (isConflict) {
    // 完全冲突(时间重叠,无法同看):红底 in-conf + 2px 红框,红标题 + ⚠;与绿/黄同一整卡底色语法
    stateCls = "border-2 border-conf in-conf";
  } else {
    stateCls = isIdle ? "border border-line hover:border-line-strong" : "border border-line";
    if (inCurrent) stateCls += " in-plan"; // 已选 = 绿底(优先级不参与网格染色 — 见行程行 seg)
  }

  let talkState: TalkState | undefined;
  if (talk > 0) {
    // 状态外观:冲突沿用红(整场都在冲突区);已选且参加 → 同 in-plan 绿 = 两张一起选中;
    // 放弃映后谈 → gv-talk-off 灰虚线淡出(块仍占槽位,只表示"我不参加")
    let cls: string;
    if (isConflict) cls = "border-2 border-conf in-conf";
    else if (inCurrent && talkOn) cls = "border border-line in-plan";
    else if (!talkOn) cls = "border border-dashed border-line gv-talk-off";
    else cls = "border border-line";
    talkState = {
      on: talkOn,
      stateCls: cls,
      label: talkOn && inCurrent ? `✓ 映后 ${talk}′` : `映后 ${talk}′`,
      range: talkTimeRange(s),
      dim,
      tip: talkTip(s, talk, talkOn, inCurrent),
    };
  }

  return {
    isIdle,
    isConflict,
    inCurrent,
    stateCls,
    dim,
    warn: isConflict,
    conflictTip: conflictTipOf(s, ctx, isConflict),
    talk: talkState,
  };
}

export function gridGeometryKey(
  cat: Catalog,
  date: string,
  pxPerMin: number,
  rowH: number,
  venueKey = ""
): string {
  let acc = `${date}|${pxPerMin.toFixed(4)}|${rowH}|${venueKey}|`;
  for (const s of cat.schedule.screenings) {
    if (s.date !== date) continue;
    // duration_min 决定正片末(GV 拆分卡主卡的宽度),gvTalkMin 决定谈块宽度与轴末 —— 都必须在签名里
    acc += `${s.code}:${s.start_time}:${s.end_time}:${s.duration_min}:${s.is_gv ? gvTalkMin(s) : 0};`;
  }
  return acc;
}

function talkTip(s: Screening, talk: number, talkOn: boolean, inCurrent: boolean): string {
  const endMin = filmEndMin(s) + talk; // 谈段末 = 正片末 + 配置时长(时长可全局改 / 逐场覆写)
  const filmEnd = fmtEndClock(filmEndMin(s));
  const range = `${fmtMinRangeMin(filmEndMin(s), endMin)} 映后谈 ${talk}min(GV 嘉宾到场)`;
  const howTo = "映后时长可在设置里改默认值,或在行程行点映后标签的数字逐场覆写";
  if (!inCurrent)
    return [
      range,
      "你还没加入本场 — 点正片 = 连映后谈一起加入",
      `点这里 = 只看正片(放弃映后谈,该场按 ${filmEnd} 结束,转场 / 冲突即时放宽)`,
      howTo,
    ].join("\n");
  return talkOn
    ? [
        range,
        "已在行程中 — 默认连映后谈一起选",
        `点这里放弃 → 该场按 ${filmEnd} 结束,后续转场按正片末算`,
        howTo,
      ].join("\n")
    : [
        range,
        `已放弃 — 仅正片,${filmEnd} 结束`,
        `点这里恢复参加 → 按 ${fmtEndClock(endMin)} 结束`,
        howTo,
      ].join("\n");
}

const TRAIL_PAD = 60;
