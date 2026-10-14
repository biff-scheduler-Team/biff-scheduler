// 官网「排期之外」的辅助信息:票价 / 节目嘉宾 / 开闭幕式。
//
// 数据源 = 静态产物 `public/festival-extras.json`(离线抓取,见 `tools/scrape_biff_extras.py`)。
// 与 `data.ts` 的分工:那个加载**排期**(时间 / 厅 / 片名),这里加载排期页上不印的补充信息。
// 文件缺失 / 解析失败一律**静默降级**(票价 / 嘉宾区自动消失),绝不阻塞主流程 ——
// 它只是增强,不是运行前提。

import type { ExtraProgram, FestivalExtras, Screening } from "./types";

/** 普通场次票价(KRW)—— 官网价目表的基准档;高于它的场次才值得在卡片上单独标价 */
export const BASE_PRICE_KRW = 10000;

let data: FestivalExtras | null = null;
let programByCode = new Map<string, ExtraProgram>();

export async function loadExtras(): Promise<void> {
  try {
    // `default`(而非 `no-cache`):与 data.ts 同口径,交给 PWA 预缓存命中(现场断网可用)
    const res = await fetch("/festival-extras.json", { cache: "default" });
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
