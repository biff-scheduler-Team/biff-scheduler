// 通用工具:DOM 辅助 / 时间换算 / 格式化 / 影片信息(片名 + 元信息行)

import type { Catalog, FilmItem, Mapping, Screening } from "./types";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** "HH:MM" → 当日分钟。**24+ 时制**:跨午夜场的 end_time 可 ≥ "24:00"(如 "29:35" = 次日 05:35),
 *  故返回值域为 0..2880 —— 排序 / 轴界 / 卡片宽度 / 冲突 / ICS 进位全部依赖这一点。 */
export function hmsToMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** 显示用:分钟折回 24h 内(1775 → "05:35")。 */
export function minToClock(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** 跨午夜标记:终点分钟 ≥ 1440(次日)→ "次日 ",否则空串。 */
export function nextDayTag(min: number): string {
  return min >= 1440 ? "次日 " : "";
}

/** 终点显示(自动带「次日」):1775 → "次日 05:35";770 → "12:50"。 */
export function fmtEndClock(min: number): string {
  return nextDayTag(min) + minToClock(min);
}

/** 本地时区 'YYYY-MM-DD'(与 dateInfo 同用本地时间,避免 UTC 解析偏移) */
export function todayIsoLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 分钟 → "HH:MM" **保留 24+ 时制**(1775 → "29:35")。
 *  ⚠️ 这是「跨午夜信息」的载体:供 `data.ts` 归一化回写与 `ics.ts` 的 `toUtcStamp`(靠 `Date.UTC` 自动进位次日)使用。
 *  **面向用户的显示一律走 `minToClock` / `fmtEndClock` / `fmtMinRange`**,否则会印出 "29:35"。 */
export function minToHms(min: number): string {
  // 先整体取整再拆分:否则小数分钟(如 1439.6)的 `min % 60` 会 round 成 60 → 产出 "23:60"
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** '2026-10-08' → { label: '10/08', weekday: '周四' }（本地时区安全解析） */
export function dateInfo(iso: string): { label: string; weekday: string; date: Date } {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return { label: `${m}/${d}`, weekday: WEEK[date.getDay()], date };
}

/** 起止区间文本。同日 → "09:00–10:40"(与旧实现逐字节一致);
 *  跨午夜 → "23:59–次日 05:35"(兼容未归一化的旧数据:end < start 也判为次日)。 */
export function fmtMinRange(a: string, b: string): string {
  const end = hmsToMin(b);
  const cross = end >= 1440 || end < hmsToMin(a);
  return `${a}–${cross ? "次日 " : ""}${minToClock(end)}`;
}

/** 起止区间文本(分钟入参版,两端都带跨日标记):1530,1800 → "次日 01:30–次日 02:00"。
 *  GV 拆分卡的「正片 + 映后谈」两段落在次日时用它,避免出现 "25:30" 这类 24+ 原始值。 */
export function fmtMinRangeMin(a: number, b: number): string {
  return `${nextDayTag(a)}${minToClock(a)}–${nextDayTag(b)}${minToClock(b)}`;
}

/** 转场余量阈值(§14 1a / 16-D):余量 ≥OK_SLACK 视为宽裕,0≤余量<OK_SLACK 偏紧,<0 不足 */
export const OK_SLACK = 15;

/** 相邻两场的转场余量判定结果 */
export interface SlackResult {
  /** 间隔 = 后场开始 − 前场结束(前场结束由调用方给「有效结束」口径) */
  gap: number;
  /** 需要的缓冲:跨馆 = transitMin,同馆 = 0 */
  need: number;
  /** 余量 = gap − need */
  slack: number;
  /** bad = 缓冲后赶不上(<0);tight = 偏紧(0 ≤ slack < okSlack);ok = 宽裕 */
  verdict: "ok" | "tight" | "bad";
}

/** 相邻两场的转场余量判定 —— **单一来源**:网格黄卡(`grid.ts::markTightPairs`)、
 *  行程连接件(`agenda.ts::gapConnector`)、质量分(`score.ts::scorePlanRows`)共用同一口径。
 *  ⚠ 时间重叠(gap ≤ 0)由冲突体系单独表达;本函数仍如实返回 `slack < 0`(verdict = bad)。 */
export function slackBetween(
  prevEndMin: number,
  nextStartMin: number,
  sameVenue: boolean,
  transitMin: number,
  okSlack: number = OK_SLACK
): SlackResult {
  const gap = nextStartMin - prevEndMin;
  const need = sameVenue ? 0 : transitMin;
  const slack = gap - need;
  const verdict = slack < 0 ? "bad" : slack < okSlack ? "tight" : "ok";
  return { gap, need, slack, verdict };
}

/** 显示名:优先中文片名,其次豆瓣回填中文,最后英文 */
export function displayTitle(
  s: { title_zh: string; title_en: string },
  mappingTitleCn: string | null | undefined
): string {
  return s.title_zh || mappingTitleCn || s.title_en;
}

/** 搜索 / 命中比较用的归一化:小写 + 去首尾空白(全站单一来源,勿各写一份 `.toLowerCase().trim()`)。 */
export function normText(s: string): string {
  return s.toLowerCase().trim();
}

/** 按某字段把**已排序**列表相邻归并成日期分节(`[日期, 条目[]][]`;输入需先按日期排好)。 */
export function groupByDate<T>(list: T[], dateOf: (x: T) => string): [string, T[]][] {
  const out: [string, T[]][] = [];
  for (const item of list) {
    const d = dateOf(item);
    const last = out[out.length - 1];
    if (last && last[0] === d) last[1].push(item);
    else out.push([d, [item]]);
  }
  return out;
}

/** 影片节点 key —— 全站单一来源(影片库节点合并 / 智能排片 / 选片总览 / 甘特打标共用)。
 *  口径与影片库 catFor 完全一致:①目录中文名(无中文名则原始片名)精确命中 → `cat:<目录 id>`;
 *  ②原始片名 == 排期英文名 → `cat:<id>`;③都不命中(纯排期片)→ `sched:<中文名|英文名 小写>`。
 *  守卫:title_zh 缺失时不做空值相等匹配(否则会与「两个片名都为空」的目录条目假命中);两片名皆缺则退回 code。 */
export function filmNodeKey(cat: Catalog, s: Screening): string {
  const zh = s.title_zh;
  // 走目录索引(O(1));旧实现每次 `cat.films.find` 线性扫描 → 全站 O(screenings × films)
  const hit =
    (zh ? cat.filmByZh.get(zh)?.[0] : undefined) ??
    (s.title_en ? cat.filmByOrig.get(s.title_en)?.[0] : undefined);
  if (hit) return `cat:${hit.id}`;
  return `sched:${(s.title_zh || s.title_en || s.code).toLowerCase().trim()}`;
}

/* ---------------- 影片信息(片名 + 元信息行) ----------------
 * 「影片库 / 我的选片」卡片与「我的行程」卡片**必须同一口径**:片名在上、元信息行在下
 * (2026-09-10 需求原话「我的行程中电影卡片 片名应该要和我的选片中样式一样 片名在上方
 *  然后有类似于『cons · France · 2025 · Olivier ASSAYAS』这种影片信息样式」)。
 * 原先这段拼装只活在 `library.ts::buildFilmList` 里,行程卡无从取用 → 上提到这里做单一来源,
 * 两处调同一函数,片名 / 其余片名 / 元信息不可能再漂移。 */

/** 影片信息:片名 + 其余片名 + 目录元信息 */
export interface FilmInfo {
  /** 展示用片名:目录中文名 → 排期中文名 → 豆瓣回填中文名 → 排期英文名 */
  zh: string;
  /** 与 zh 不同的其余片名(原始片名 / 英文 / 韩文),去重保序 */
  names: string[];
  /** 单元 · 国家 · 年份 · 导演(目录信息;纯排期片为空串) */
  meta: string;
  /** 命中的目录条目(一般 1 条;空数组 = 纯排期片,无目录信息) */
  cats: FilmItem[];
}

/** 目录条目的「单元 · 国家 · 年份 · 导演」元信息(空位自动省略,全空则空串) */
export function catMetaLine(cat: FilmItem): string {
  const bits = [cat.unit, cat.country];
  if (cat.year) bits.push(String(cat.year));
  if (cat.director) bits.push(cat.director);
  return bits.filter(Boolean).join(" · ");
}

/** 排期场次 → 影片信息。目录命中规则与 `filmNodeKey` **逐字一致**
 *  (①目录中文名(无则原始片名)精确命中 ②原始片名 == 排期英文名),否则三处 key / 片名会漂移。 */
export function filmInfoOf(cat: Catalog, s: Screening, map?: Mapping): FilmInfo {
  const zhKey = s.title_zh;
  const byName = zhKey ? (cat.filmByZh.get(zhKey) ?? []) : [];
  const cats = byName.length ? byName : s.title_en ? (cat.filmByOrig.get(s.title_en) ?? []) : [];
  const hit = cats[0];
  const zh = hit?.title_zh || s.title_zh || map?.title_cn || s.title_en;

  const names = new Set<string>();
  const pushName = (x: string): void => {
    if (x && x.toLowerCase().trim() !== zh.toLowerCase().trim()) names.add(x);
  };
  for (const c of cats) pushName(c.title_orig);
  if (hit) {
    // 目录条目无原始片名时,退回排期英文名
    if (!hit.title_orig) pushName(s.title_en);
  } else {
    pushName(s.title_en);
    pushName(s.title_kr);
  }
  return { zh, names: [...names], meta: hit ? catMetaLine(hit) : "", cats };
}

/** 元信息行文案:「其余片名 · 单元 · 国家 · 年份 · 导演」(空位自动省略)。
 *  空串 = 无任何可展示信息(理论上不会:纯排期片至少有英文名)。 */
export function filmInfoText(info: FilmInfo): string {
  return [...info.names, info.meta].filter(Boolean).join(" · ");
}
