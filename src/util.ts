// 通用工具:DOM 辅助 / 时间换算 / 格式化

import type { Catalog, Screening } from "./types";

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
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
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

/** 显示名:优先中文片名,其次豆瓣回填中文,最后英文 */
export function displayTitle(
  s: { title_zh: string; title_en: string },
  mappingTitleCn: string | null | undefined
): string {
  return s.title_zh || mappingTitleCn || s.title_en;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[c];
  });
}

export function escapeHtml(s: string): string {
  return esc(s);
}

/** 影片节点 key —— 全站单一来源(影片库节点合并 / 智能排片 / 选片总览 / 甘特打标共用)。
 *  口径与影片库 catFor 完全一致:①目录中文名(无中文名则原始片名)精确命中 → `cat:<目录 id>`;
 *  ②原始片名 == 排期英文名 → `cat:<id>`;③都不命中(纯排期片)→ `sched:<中文名|英文名 小写>`。
 *  守卫:title_zh 缺失时不做空值相等匹配(否则会与「两个片名都为空」的目录条目假命中);两片名皆缺则退回 code。 */
export function filmNodeKey(cat: Catalog, s: Screening): string {
  const zh = s.title_zh;
  const hit =
    (zh ? cat.films.find((f) => (f.title_zh || f.title_orig) === zh) : undefined) ??
    (s.title_en ? cat.films.find((f) => f.title_orig === s.title_en) : undefined);
  if (hit) return `cat:${hit.id}`;
  return `sched:${(s.title_zh || s.title_en || s.code).toLowerCase().trim()}`;
}
