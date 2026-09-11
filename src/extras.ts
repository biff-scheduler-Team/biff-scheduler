// 官网「排期之外」的辅助信息:售票批次 / 节目嘉宾 / 开闭幕式。
//
// 数据源 = 静态产物 `public/festival-extras.json`(离线抓取,见 `tools/scrape_biff_extras.py`)。
// 与 `data.ts` 的分工:那个加载**排期**(时间 / 厅 / 片名),这里加载排期页上不印的补充信息。
// 文件缺失 / 解析失败一律**静默降级**(横幅 / 票价 / 嘉宾区自动消失),绝不阻塞主流程 ——
// 它只是增强,不是运行前提。

import type { ExtraProgram, FestivalExtras, Screening } from "./types";

/** 普通场次票价(KRW)—— 官网价目表的基准档;高于它的场次才值得在卡片上单独标价 */
export const BASE_PRICE_KRW = 10000;

let data: FestivalExtras | null = null;
let programByCode = new Map<string, ExtraProgram>();

export async function loadExtras(): Promise<void> {
  try {
    // `default`(而非 `no-cache`):与 data.ts 同口径,交给 PWA 预缓存命中(现场断网可用)
    const res = await fetch("festival-extras.json", { cache: "default" });
    if (!res.ok) return;
    const parsed = (await res.json()) as FestivalExtras;
    if (!parsed || !Array.isArray(parsed.programs)) return;
    data = parsed;
    programByCode = new Map(parsed.programs.map((p) => [p.code, p]));
  } catch {
    /* 缺文件 / 旧部署:保持 null,全站按「无补充信息」渲染 */
  }
}

export function extras(): FestivalExtras | null {
  return data;
}

/** 该场次的活动补充信息(非活动场次 → undefined) */
export function programOf(code: string): ExtraProgram | undefined {
  return programByCode.get(code);
}

/* ---------------- 开票时间 ---------------- */

const MONTHS: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const KST_OFFSET_H = 9;
const BJ_OFFSET_H = 8;

export interface TicketOpen {
  /** 官网原文(如 `Sep 17(Thu) 14:00 (KST)`) */
  raw: string;
  /** 该批包含什么(官网原文) */
  includes: string;
  /** 开票时刻(UTC 毫秒) */
  at: number;
  /** 韩国时间文本 `9/17 14:00` */
  kst: string;
  /** 北京时间文本 `9/17 13:00` */
  bj: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** UTC 毫秒 → 某固定偏移时区的 `M/D HH:MM`(倒计时跨时区显示的唯一口径) */
function fmtInZone(utcMs: number, offsetH: number): string {
  const d = new Date(utcMs + offsetH * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** 解析官网批次文本 → 绝对开票时刻。`year` 来自 festival(官网只印月/日,不带年)。
 *  解析不出来的批次**直接丢弃**(宁可少一条,也不显示一个错的时间)。 */
export function ticketOpens(year: number): TicketOpen[] {
  const batches = data?.ticketing.batches ?? [];
  const out: TicketOpen[] = [];
  for (const b of batches) {
    const m = /^([A-Za-z]{3})\s+(\d{1,2})\([A-Za-z]{3}\)\s+(\d{1,2}):(\d{2})/.exec(b.openText);
    if (!m) continue;
    const mon = MONTHS[m[1].toUpperCase()];
    if (!mon) continue;
    const at = Date.UTC(year, mon - 1, Number(m[2]), Number(m[3]), Number(m[4])) - KST_OFFSET_H * 3600_000;
    out.push({
      raw: b.openText,
      includes: b.includes,
      at,
      kst: fmtInZone(at, KST_OFFSET_H),
      bj: fmtInZone(at, BJ_OFFSET_H),
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** 下一个尚未到达的开票时刻;全部已过 → null(横幅切「售票中」态) */
export function nextTicketOpen(year: number, nowMs: number): TicketOpen | null {
  return ticketOpens(year).find((t) => t.at > nowMs) ?? null;
}

/** 倒计时文案:`6 天 3 小时` / `3 小时 12 分` / `12 分 05 秒`(逐级细化,临近开票看得到秒) */
export function countdownText(remainMs: number): string {
  const s = Math.max(0, Math.floor(remainMs / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const mi = Math.floor((s % 3600) / 60);
  const se = s % 60;
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${mi} 分`;
  if (mi > 0) return `${mi} 分 ${pad2(se)} 秒`;
  return `${se} 秒`;
}

/* ---------------- 票价 ---------------- */

/** 单场票价(KRW)—— **官网节目页优先,其次按场次类型推断**。
 *  推断依据全部来自排期自身:`opening`/`closing` 标签、`Midnight Passion` 块名、
 *  `masterclass` 标签 / `Actors' House` 标题;其余一律普通档。
 *  ⚠ 放映后附带的 Special Talk / Carte Blanche 走普通档 —— 它们的票就是那张放映票。 */
export function priceOf(s: Screening): number {
  const p = programByCode.get(s.code);
  if (p?.priceKrw) return p.priceKrw;
  const tags = s.tags ?? [];
  if (tags.includes("opening") || tags.includes("closing")) return 30000;
  if (/midnight passion/i.test(s.title_en ?? "")) return 20000;
  if (tags.includes("masterclass") || /actors['’] house/i.test(s.title_en ?? "")) return 15000;
  return BASE_PRICE_KRW;
}

/** `15000` → `₩15,000`(韩元无小数;用 ₩ 而不是 ¥ 以免与人民币混淆) */
export function formatKrw(krw: number): string {
  return `₩${krw.toLocaleString("en-US")}`;
}

/** 活动形式的显示名(详情弹层 / 弹层分区标题用) */
export const KIND_LABEL: Record<ExtraProgram["kind"], string> = {
  actors_house: "Actors' House · 演员之家",
  master_class: "Master Class · 大师班",
  cine_class: "Cine Class · 电影课",
  special_talk: "Special Talk · 特别对谈",
};
