// 通用工具:DOM 辅助 / 时间换算 / 格式化 / 影片信息(片名 + 元信息行)

import type { Catalog, FilmItem, Mapping, Screening } from "./types";
import { unitDef } from "./units";

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

/** 首屏默认日期(纯函数,便于单测 —— 「今天」在展期内时窗口极短,靠实测覆盖不到)。
 *  - 窄屏(`mobile = true`):**今天**在 `dates` 内就用今天,否则回落 `dates[0]`(展期外 / 日期缺失);
 *  - 宽屏:`dates[0]` 恒定(桌面默认口径刻意未动,2026-09-12,PLAN-20260912002532)。
 *  空数组返回空串(调用方按「排期为空」处理)。 */
export function pickDefaultDate(dates: string[], today: string, mobile: boolean): string {
  const first = dates[0] ?? "";
  if (!mobile || !dates.includes(today)) return first;
  return today;
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
const MON_EN = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** '2026-10-08' → { label: 'OCT 8', weekday: '周四', date }（本地时区安全解析）
 *  `label` = **全站唯一日期显示口径** —— 官方排期页「Schedule by Date」的写法(月份英文缩写 + 日,如 `OCT 8`),
 *  日**不补零**(与官方一致)。顶栏日期条 / 网格标题 / 选片日期筛选 / 行程日期头 / 分享文案一律取它,
 *  不再各写 `10/8` 这类数字写法(2026-09-11 用户:「时间表示不统一 改成 OCT 这种 和甘特用一样的」)。
 *  中文 `weekday` 作为附带信息紧随其后(如 `OCT 8 周四`),不参与「日期写法」本身。 */
export function dateInfo(iso: string): { label: string; weekday: string; date: Date } {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return { label: `${MON_EN[m - 1]} ${d}`, weekday: WEEK[date.getDay()], date };
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

/** 片名显示口径(全站唯一来源,2026-09-11 需求):**英文名在前,中文名以「 · 」跟在后面**。
 *  两侧任一缺失只留存在的一侧;两侧同名(纯排期片的 `zh` 会退化成英文名)只印一次 ——
 *  绝不会产出「Foo · Foo」或首尾带分隔符的空片名。 */
export function bilingualTitle(en: string | null | undefined, zh: string | null | undefined): string {
  const e = (en ?? "").trim();
  const z = (zh ?? "").trim();
  if (!e) return z;
  if (!z || normText(z) === normText(e)) return e;
  return `${e} · ${z}`;
}

/** 显示名:排期场次 → 「**英文名 · 中文名**」(口径见 `bilingualTitle`)。
 *  英文名取排期官方英文名(`data.ts::loadCatalog` 保证非空:官方只印韩文时用韩文名兜底);
 *  中文名取值链 = 排期中文名 → 豆瓣回填中文名。
 *  ⚠ 全站片名展示(网格卡 / 资料弹层 / 行程卡 / 复制清单 / tooltip / ICS)一律走它或
 *    `bilingualTitle`,不要再各写一份「中文优先」的取值链。 */
export function displayTitle(
  s: { title_zh: string; title_en: string },
  mappingTitleCn: string | null | undefined
): string {
  return bilingualTitle(s.title_en, s.title_zh || mappingTitleCn);
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

/** 影片节点 key —— 全站单一来源(影片库节点合并 / 选片总览 / 甘特打标共用)。
 *  口径与影片库 catFor 完全一致:①目录中文名(无中文名则原始片名)精确命中 → `cat:<目录 id>`;
 *  ②原始片名 == 排期英文名 → `cat:<id>`;③都不命中(纯排期片)→ `sched:<中文名|英文名 小写>`。
 *  守卫:title_zh 缺失时不做空值相等匹配(否则会与「两个片名都为空」的目录条目假命中);两片名皆缺则退回 code。 */
export function filmNodeKey(cat: Catalog, s: Screening): string {
  const zh = s.title_zh;
  // ① **官网英文名**(目录已由官网片目生成,这一路必然命中) → ② 目录中文名 → ③ 原始片名。
  // 走目录索引(O(1));旧实现每次 `cat.films.find` 线性扫描 → 全站 O(screenings × films)
  const hit =
    (s.title_en ? cat.filmByEn.get(s.title_en) : undefined) ??
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
  /** 展示用片名 = **英文名 · 中文名**(口径见 `bilingualTitle`)—— 卡片头 / 行程卡片名行唯一取值 */
  title: string;
  /** 英文名:排期官方英文名;目录片无排期时退回原始片名 */
  en: string;
  /** 中文名:目录中文名 → 排期中文名 → 豆瓣回填中文名;
   *  无中文时退化为英文名(排期片恒非空 —— AI 打包 / 排序 / 搜索都依赖它) */
  zh: string;
  /** 与 `title` 不重复的其余片名(原始片名 / 韩文),去重保序 */
  names: string[];
  /** 单元 · 国家 · 年份 · 导演(目录信息;纯排期片为空串) */
  meta: string;
  /** 命中的目录条目(一般 1 条;空数组 = 纯排期片,无目录信息) */
  cats: FilmItem[];
}

/** 目录条目的「英文位」片名 —— 目录片没有排期时取不到 `title_en`,这里兜住两种 schema:
 *  新 schema(官网片目合并,`title_en` + `title_orig` 为原始韩/日文名)优先 `title_en`;
 *  旧 schema 只有 `title_orig`(英/日/韩混排)。两者皆缺 = 该片无英文名(卡片只印中文名)。
 *  ⚠ 与排期片的英文名口径一致:一律取**官方英文名**,不拿原始韩/日文名冒充。 */
export function filmEnName(f: FilmItem): string {
  const maybe = f as FilmItem & { title_en?: string };
  return maybe.title_en || f.title_orig;
}

/** 单元显示名 = 「**英文 section 名 · 中文单元名**」—— 与片名 `bilingualTitle` 同一排版。
 *  对照表在 `units.ts`(数据来源与口径见该文件头);查不到 → 原样返回原串,
 *  故新单元 / 脏数据只会少一次对照,绝不会变空。
 *  ⚠ 展示侧**唯一**取用口:卡片副标题(`catMetaLine`)、单元下拉筛选(`library.ts`)都走它,
 *    别再各写一份「原样印 unit」。 */
export function unitLabel(raw: string | null | undefined): string {
  const def = unitDef(raw);
  return def ? bilingualTitle(def.en, def.zh) : (raw ?? "").trim();
}

/** 目录条目的「单元 · 国家 · 年份 · 导演」元信息(空位自动省略,全空则空串)。
 *  单元走 `unitLabel()`(中英对照)—— 原先直接印 `cat.unit`,同一份片单里
 *  「有的单元是英文、有的是中文」,读起来像两套语言。 */
export function catMetaLine(cat: FilmItem): string {
  const bits = [unitLabel(cat.unit), cat.country];
  if (cat.year) bits.push(String(cat.year));
  if (cat.director) bits.push(cat.director);
  return bits.filter(Boolean).join(" · ");
}

/** 排期场次 → 影片信息。目录命中规则与 `filmNodeKey` **逐字一致**
 *  (①目录中文名(无则原始片名)精确命中 ②原始片名 == 排期英文名),否则三处 key / 片名会漂移。 */
export function filmInfoOf(cat: Catalog, s: Screening, map?: Mapping): FilmInfo {
  // 命中优先级与 filmNodeKey **逐字一致**(①官网英文名 → ②中文名 → ③原始片名),否则三处会漂
  const byEn = s.title_en ? cat.filmByEn.get(s.title_en) : undefined;
  const zhKey = s.title_zh;
  const byName = byEn ? [] : zhKey ? (cat.filmByZh.get(zhKey) ?? []) : [];
  const cats = byEn ? [byEn] : byName.length ? byName : s.title_en ? (cat.filmByOrig.get(s.title_en) ?? []) : [];
  const hit = cats[0];
  const zh = hit?.title_zh || s.title_zh || map?.title_cn || s.title_en;
  // 英文名 = 排期官方英文名(缺则退回目录的官方英文名)—— 与网格卡 / 弹层 / 复制清单同一口径
  const en = s.title_en || (hit ? filmEnName(hit) : "");

  const names = new Set<string>();
  const pushName = (x: string): void => {
    const t = (x ?? "").trim();
    if (!t) return;
    const k = normText(t);
    if (k !== normText(zh) && k !== normText(en)) names.add(t);
  };
  for (const c of cats) pushName(c.title_orig);
  // 纯排期片(无目录条目):排期英文名已进 title,韩文名留作副标题
  if (!hit) pushName(s.title_kr);
  return { title: bilingualTitle(en, zh), en, zh, names: [...names], meta: hit ? catMetaLine(hit) : "", cats };
}

/** 元信息行文案:「其余片名 · 单元 · 国家 · 年份 · 导演」(空位自动省略)。
 *  ⚠ 片名(`title`)已由卡片头片名行给出,故这里**只放其余片名与目录元信息**,不重复印英文名。
 *  空串 = 无任何可展示信息(理论上不会:纯排期片至少有英文名)。 */
export function filmInfoText(info: FilmInfo): string {
  return [...info.names, info.meta].filter(Boolean).join(" · ");
}

/** 评价人数展示:≥1 万写成 `1.6万`,否则原样数字。0 / 非有限不该进来。 */
export function fmtVoters(n: number): string {
  if (n >= 10000) {
    const w = n / 10000;
    const s = w >= 10 ? String(Math.round(w)) : w.toFixed(1).replace(/\.0$/, "");
    return `${s}万`;
  }
  return String(n);
}

export interface DoubanScore {
  rating: number;
  count: number | null;
}

/** 豆瓣分:目录优先,映射兜底;没有分或 ≤0 当无(暂无评分不要画成 0.0)。 */
export function doubanScoreOf(film?: FilmItem | null, map?: Mapping | null): DoubanScore | null {
  const rating = film?.rating ?? map?.rating ?? null;
  if (rating == null || !(rating > 0)) return null;
  const raw = film?.rating_count ?? map?.rating_count ?? null;
  const count = raw != null && raw > 0 ? raw : null;
  return { rating, count };
}
