/**
 * B 组「我的观影画像」（2026-09-20，第 2 轮，见 PLAN-20260920203010 修订 1）。
 *
 * ★ 为什么要有「只有我自己」的这一组：
 *   前三组（需求 / 难度 / 供给）都是**全站**口径 —— 它们告诉你「这场难不难」，
 *   但不回答「**我的**这 30 场排得像不像一个正常人」。画像回答的是后者：
 *   我是不是把 5 场都压在同一个影厅、是不是只挑一个单元、一天最多排了几场、
 *   这一届要花多少钱。它是开票前发现「我自己排得不合理」的唯一入口。
 *
 * ★ 为什么叫「画像」而不是「统计」：这一组的每一项都要能对应一个**动作**
 *   （发现单日过密 → 移走一场；发现只挑一个单元 → 去别的单元翻翻），
 *   只堆数字的统计没有价值。
 *
 * ⚠ **口径的边界**：票价合计是**票面总额**（`priceOf` 的档位价 × 场次数），
 *   不是实付金额 —— BIFF 有会员折扣 / 套票，本工具拿不到用户的实付价。
 *   页面必须写明「票面总额」，否则会被当成预算。
 * ⚠ 纯逻辑，import 期不碰 DOM；输入是已经装配好的行，因此本模块**不 import catalog**（好测）。
 */

import { bucketHourOf, hourLabel } from "./rush-analysis";

/** 我的行程里的一场 —— 页面从排期 / 影片目录 / 票价表装配，本模块只认这十个字段。 */
export interface MyShowRow {
  code: string;
  /** 影片身份（`filmNodeKey`）—— 用来数「我排了几部片」 */
  filmKey: string;
  date: string;
  /** 开场时间的**原始小时**（24+ 时制不取模，见 `rush-analysis.ts` 文件头） */
  startHour: number;
  durationMin: number;
  /** 票面价（KRW）；拿不到 → 0（不计入合计，也不编一个价） */
  priceKrw: number;
  venueId: string;
  /** 影院品牌（`Venue.group`：bcc / cgv / lotte / …） */
  venueGroup: string;
  venueLabel: string;
  /** 影片单元原文（人话标签由页面走 `util.ts::unitLabel`） */
  unit: string;
  /** 制产国原文（可能形如 `韩国/法国`，本模块按分隔符拆开各自计数） */
  country: string;
  /** 豆瓣评分（无 → `null`；不计入平均） */
  rating: number | null;
}

export interface CountShare {
  label: string;
  /** 场次数 */
  shows: number;
  /** 占我的总场次比例（0–1） */
  share: number;
}

export interface DayCount {
  date: string;
  shows: number;
}

export interface Portrait {
  /** 排了场次的影片数（同一部片的多场只算一部） */
  films: number;
  shows: number;
  /** 覆盖的放映天数 */
  days: number;
  /** 覆盖的影厅数 */
  venues: number;
  /** 总观影时长（分钟）—— 口径是**正片时长，不含 GV 映后谈**：
   *  `duration_min` 与 `gv.ts::filmEndMin`（正片末 = 开场 + `duration_min`）同一口径；
   *  实测本届 337 场 GV 的「官方槽位长 − `duration_min`」恒为 25 分钟、458 场非 GV 恒为 0
   *  ——即**官方 `end_time` 才含谈**，`duration_min` 不含。要算含谈的「在场时长」得另加
   *  `gv.ts::gvTalkMin`（可配置），故这里刻意不叫「在场时长」。
   *  （2026-09-23 校正：原注释写成「已含 GV 映后谈」，与 `gv.ts` 相矛盾。） */
  minutes: number;
  /** 票面总额（KRW，见文件头的口径边界） */
  priceKrw: number;
  /** 排得最满的那一天；并列取日期较早的 */
  busiest: DayCount | null;
  /** 平均每天几场（= 总场次 ÷ 覆盖天数），保留一位小数由页面决定 */
  avgPerDay: number;
  /** 按日期（升序，供画趋势） */
  byDate: DayCount[];
  /** 按开场时段（复用需求面同一份分桶，跨午夜归「次日」） */
  byHour: Array<{ key: string; label: string; shows: number }>;
  /** 按影院品牌（降序） */
  byVenueGroup: CountShare[];
  /** 按影厅（降序）—— 用来发现「我全排在一个厅」 */
  byVenue: CountShare[];
  /** 按单元（降序）—— 用来发现「我只挑了一个单元」 */
  byUnit: CountShare[];
  /** 按制产国（降序；`韩国/法国` 会同时计给两国） */
  byCountry: CountShare[];
  /** 有评分的那些片的平均分（无评分 → `null`） */
  rated: { average: number; count: number } | null;
}

/** 单元 / 国别这类「多值字段」的分隔符 —— 官方册子与目录都用这几种混写。 */
const MULTI_SEPARATORS = /[/、,·|]+/;

/** 制产国原文 → 国家列表（去空白、去空项）。 */
export function splitCountries(raw: string): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(MULTI_SEPARATORS)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * 我的观影画像。
 *
 * ★ 空行程 → `null`（页面整组不渲染）而不是一份全 0 的画像：
 *   「0 部片 / 0 小时 / ₩0」不是信息，是一个会让人以为站点坏了的样子。
 * ★ 平均分只对**有评分**的片取平均（缺评分是常态：250 部里只有一部分有豆瓣分），
 *   把缺分当 0 会把平均分算成一个毫无意义的低值。
 */
export function buildPortrait(rows: MyShowRow[]): Portrait | null {
  if (rows.length === 0) return null;

  const films = new Set<string>();
  const days = new Set<string>();
  const venues = new Set<string>();
  const byDateMap = new Map<string, number>();
  const byHourMap = new Map<number, number>();
  const byVenueGroupMap = new Map<string, number>();
  const byVenueMap = new Map<string, number>();
  const byUnitMap = new Map<string, number>();
  const byCountryMap = new Map<string, number>();
  let minutes = 0;
  let priceKrw = 0;
  let ratingSum = 0;
  let ratingCount = 0;

  for (const row of rows) {
    films.add(row.filmKey);
    days.add(row.date);
    venues.add(row.venueId);
    byDateMap.set(row.date, (byDateMap.get(row.date) ?? 0) + 1);
    if (Number.isFinite(row.startHour) && row.startHour >= 0) {
      const hour = bucketHourOf(row.startHour);
      byHourMap.set(hour, (byHourMap.get(hour) ?? 0) + 1);
    }
    if (Number.isFinite(row.durationMin) && row.durationMin > 0) minutes += row.durationMin;
    if (Number.isFinite(row.priceKrw) && row.priceKrw > 0) priceKrw += row.priceKrw;
    bump(byVenueGroupMap, row.venueGroup);
    bump(byVenueMap, row.venueLabel);
    bump(byUnitMap, row.unit);
    for (const country of splitCountries(row.country)) bump(byCountryMap, country);
    if (row.rating !== null && Number.isFinite(row.rating)) {
      ratingSum += row.rating;
      ratingCount += 1;
    }
  }

  const byDate = [...byDateMap.entries()]
    .map(([date, shows]) => ({ date, shows }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const busiest = byDate.reduce<DayCount | null>(
    (best, item) => (best === null || item.shows > best.shows ? item : best),
    null,
  );
  const byHour = [...byHourMap.entries()]
    .map(([hour, shows]) => ({ key: String(hour), label: hourLabel(hour), shows }))
    .sort((a, b) => Number(a.key) - Number(b.key));

  return {
    films: films.size,
    shows: rows.length,
    days: days.size,
    venues: venues.size,
    minutes,
    priceKrw,
    busiest,
    avgPerDay: rows.length / days.size,
    byDate,
    byHour,
    byVenueGroup: sharesOf(byVenueGroupMap, rows.length),
    byVenue: sharesOf(byVenueMap, rows.length),
    byUnit: sharesOf(byUnitMap, rows.length),
    byCountry: sharesOf(byCountryMap, rows.length),
    rated: ratingCount > 0 ? { average: ratingSum / ratingCount, count: ratingCount } : null,
  };
}

function bump(map: Map<string, number>, key: string): void {
  const label = typeof key === "string" && key.trim().length > 0 ? key.trim() : "未标注";
  map.set(label, (map.get(label) ?? 0) + 1);
}

/* ---------------- 影片分析（全站片目，不是「我的」） ----------------
 * ★ 与上面「我的观影画像」的区别：这里的每一部片**只数一次**，与我看没看、排没排无关。
 *   两组的数字不该互相解释（「韩国 12 部」是我的行程，「韩国 60 部」是本届片目）。
 */

/** 一部片的可分析属性（页面从 `FilmItem` 装配，本模块不 import 目录）。 */
export interface FilmFacetRow {
  key: string;
  title: string;
  /** 单元原文（本模块按 `/`、`、` 拆）
   *  ⚠ **类型（genre）目前不在产物里** —— 官方册子与豆瓣映射都没有这一列，
   *    故「类型」这个维度的最近替代是单元。要用真类型得回抓豆瓣条目页。 */
  unit: string;
  country: string;
  year: number | null;
  rating: number | null;
  durationMin: number | null;
}

export interface FacetBucket {
  label: string;
  /** 影片数（不是场次数 —— 这一组数的是「片目」） */
  films: number;
  share: number;
}

export interface FilmFacets {
  films: number;
  byCountry: FacetBucket[];
  byUnit: FacetBucket[];
  byYear: FacetBucket[];
  /** 评分分档（<7 / 7–8 / ≥8 / 无评分）—— 比「平均分」更能看出片目的口味分布 */
  byRating: FacetBucket[];
  /** 时长分档（<90 / 90–120 / ≥120 / 未标注） */
  byDuration: FacetBucket[];
}

/** 评分分档的边界。**只此一处**：改这里就是改「长片 / 短片」「高分 / 低分」的口径。 */
export const RATING_BANDS: ReadonlyArray<{ label: string; min: number; max: number }> = [
  { label: "< 7 分", min: -Infinity, max: 7 },
  { label: "7 – 8 分", min: 7, max: 8 },
  { label: "≥ 8 分", min: 8, max: Infinity },
];

export const DURATION_BANDS: ReadonlyArray<{ label: string; min: number; max: number }> = [
  { label: "< 90 分钟", min: 0, max: 90 },
  { label: "90 – 120 分钟", min: 90, max: 120 },
  { label: "≥ 120 分钟", min: 120, max: Infinity },
];

/** 全站片目的属性构成。空片目 → `films: 0` 且各榜为空（页面据此不渲染图）。 */
export function filmFacets(rows: FilmFacetRow[]): FilmFacets {
  const countries = new Map<string, number>();
  const units = new Map<string, number>();
  const years = new Map<string, number>();
  const ratings = new Map<string, number>();
  const durations = new Map<string, number>();
  for (const row of rows) {
    for (const country of splitCountries(row.country)) bump(countries, country);
    for (const unit of splitCountries(row.unit)) bump(units, unit);
    if (typeof row.year === "number" && Number.isFinite(row.year)) bump(years, String(row.year));
    else bump(years, "未标注");
    bump(ratings, bandLabel(RATING_BANDS, row.rating) ?? "无评分");
    bump(durations, bandLabel(DURATION_BANDS, row.durationMin) ?? "未标注");
  }
  const total = rows.length;
  return {
    films: total,
    byCountry: facetsOf(countries, total),
    byUnit: facetsOf(units, total),
    // 年份按**升序**（时间轴语义），其余按数量降序
    byYear: [...years.entries()]
      .map(([label, films]) => ({ label, films, share: total > 0 ? films / total : 0 }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    byRating: orderByBand(ratings, RATING_BANDS, "无评分"),
    byDuration: orderByBand(durations, DURATION_BANDS, "未标注"),
  };
}

/** 计数表 → 片目分档（**键名是 `films` 而不是 `shows`** —— 这一组数的是片目，
 *  与上面「我的画像」数场次是两件事；共用 `sharesOf` 会让人以为它们同一个口径）。 */
function facetsOf(counts: Map<string, number>, total: number): FacetBucket[] {
  return [...counts.entries()]
    .map(([label, films]) => ({ label, films, share: total > 0 ? films / total : 0 }))
    .sort((a, b) => b.films - a.films || a.label.localeCompare(b.label));
}

function bandLabel(bands: ReadonlyArray<{ label: string; min: number; max: number }>, value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return bands.find((band) => value >= band.min && value < band.max)?.label ?? null;
}

/** 分档榜按**档位定义顺序**排（< 7 → 7–8 → ≥ 8），不按数量 —— 顺序本身是语义。 */
function orderByBand(
  counts: Map<string, number>,
  bands: ReadonlyArray<{ label: string }>,
  fallback: string,
): FacetBucket[] {
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const labels = [...bands.map((band) => band.label), fallback];
  return labels
    .filter((label) => (counts.get(label) ?? 0) > 0)
    .map((label) => ({ label, films: counts.get(label) ?? 0, share: total > 0 ? (counts.get(label) ?? 0) / total : 0 }));
}

/** 计数表 → 占比列表（降序，同分按标签稳定）。
 *  ⚠ 国别的分母是**总场次**而不是「国家数」—— 一部合拍片会同时给两国各加 1，
 *    所以占比之和可能 > 100%（页面上要注明，否则会被当成算错了）。 */
function sharesOf(map: Map<string, number>, total: number): CountShare[] {
  return [...map.entries()]
    .map(([label, shows]) => ({ label, shows, share: total > 0 ? shows / total : 0 }))
    .sort((a, b) => b.shows - a.shows || a.label.localeCompare(b.label));
}
