// 静态数据加载:schedule.json / venues.json / films.json / douban.json(随部署走静态资源)

import type { Catalog, FilmItem, FilmsFile, Mapping, Screening, Venue, VenuesFile, ScheduleFile } from "./types";
import { hmsToMin, minToHms } from "./util";

async function loadJson<T>(url: string): Promise<T | null> {
  try {
    // `default`(而非 `no-cache`):交给 PWA 的 CacheFirst 策略命中预缓存 —— 电影节现场断网也能打开
    const res = await fetch(url, { cache: "default" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null; // 旧部署缺文件(如 films.json)时容忍
  }
}

/** 豆瓣映射静态文件 `public/douban.json` —— 2026-09-11 起替代 D1 `douban_map`(见 PLAN-20260911001107)。
 *  离线跑 `tools/enrich_douban.py` 后把结果填进 `mappings`;留空即「零映射」,全站走中英文搜索兜底。 */
interface DoubanFile {
  mappings?: Record<
    string,
    {
      subject_id?: number | null;
      title_cn?: string | null;
      douban_url?: string | null;
      rating?: number | null;
      rating_count?: number | null;
    }
  >;
}

/** 读 douban.json → `Mapping[]`(键 = 排期 code 或 `f###` 目录片 id)。
 *  文件缺失 / `mappings` 为空 → `[]`(不报错,与 loadJson 同口径)。 */
export async function loadDoubanMappings(): Promise<Mapping[]> {
  const file = await loadJson<DoubanFile>("douban.json");
  const map = file?.mappings;
  if (!map) return [];
  return Object.entries(map).map(([code, m]) => ({
    code,
    subject_id: m?.subject_id ?? null,
    title_cn: m?.title_cn ?? null,
    douban_url: m?.douban_url ?? null,
    rating: typeof m?.rating === "number" && m.rating > 0 ? m.rating : null,
    rating_count: typeof m?.rating_count === "number" && m.rating_count > 0 ? m.rating_count : null,
  }));
}

export async function loadCatalog(): Promise<Catalog> {
  // 三个只读 JSON 互不依赖 → 并行拉取(旧版串行 await 白等两个 RTT)
  const [schedule, venuesFile, filmsFile] = await Promise.all([
    loadJson<ScheduleFile>("schedule.json"),
    loadJson<VenuesFile>("venues.json"),
    loadJson<FilmsFile>("films.json"),
  ]);

  // 结构守卫:文件存在但字段缺失(空对象 / 换版漏字段)时**显式报错**,
  // 而不是让 `schedule.screenings` 为 undefined 在下游崩成难定位的 TypeError。
  if (!schedule || !Array.isArray(schedule.screenings)) throw new Error("schedule.json 加载失败或格式不正确");
  if (!venuesFile || !Array.isArray(venuesFile.venues)) throw new Error("venues.json 加载失败或格式不正确");

  const venueById = new Map<string, Venue>();
  for (const v of venuesFile.venues) venueById.set(v.id, v);

  // 跨午夜场唯一归一化闸门 —— 数据端一律 24+ 时制(end_time ≥ "24:00",如 23:59 场 → "29:35")。
  // 前端全部算术(轴界 / 卡片宽度 / 排序 / 整点筛选 / 冲突 / ICS 进位)都建立在 end > start 上;
  // 这里原地补 24h,既兜解析器漏改,也让手改 / 旧版 JSON 自愈(所有消费方读的是同一批对象)。
  for (const s of schedule.screenings) {
    const st = hmsToMin(s.start_time);
    const en = hmsToMin(s.end_time);
    if (!Number.isFinite(st) || !Number.isFinite(en)) continue; // 脏数据:不写回 "NaN:NaN",交由下游原样暴露
    if (en <= st) s.end_time = minToHms(en + 24 * 60);
  }

  // 原册有一部分场次**只印韩文片名**(2025 版 M1–M4 南浦洞共 41 场),title_en 为空 →
  // 片名(displayTitle 的**英文位**就是 title_en,缺则整条空白)会丢。原地用 title_kr 兜底,
  // 单一入口,不动 util / library 各自的取值链(它们读的是同一批对象)。
  for (const s of schedule.screenings) {
    if (!s.title_en) s.title_en = s.title_kr;
  }

  const byCode = new Map<string, Screening>();
  for (const s of schedule.screenings) byCode.set(s.code, s);

  // Set 去重(旧版 `dates.includes` 是 O(n·d));dates 按字典序 = 时间序(YYYY-MM-DD)
  const dates = [...new Set(schedule.screenings.map((s) => s.date))].sort();

  const films = filmsFile?.films ?? [];

  return { schedule, dates, venues: venuesFile.venues, venueById, byCode, films, ...buildFilmIndex(films) };
}

/** 影片目录索引:`filmNodeKey` / `filmInfoOf` / `ratingOf` / AI 打包都在按片名线性扫目录
 *  (O(screenings × films))。这里把「目录中文名(无则原始片名)」与「原始片名」两个命中口径
 *  预计算成两张 Map,消费方改走 O(1) 查表。生产(loadCatalog)与测试夹具共用本函数。 */
export function buildFilmIndex(films: FilmItem[]): {
  filmByEn: Map<string, FilmItem>;
  filmByZh: Map<string, FilmItem[]>;
  filmByOrig: Map<string, FilmItem[]>;
} {
  const filmByEn = new Map<string, FilmItem>();
  const filmByZh = new Map<string, FilmItem[]>();
  const filmByOrig = new Map<string, FilmItem[]>();
  const push = (m: Map<string, FilmItem[]>, k: string, f: FilmItem): void => {
    const arr = m.get(k);
    if (arr) arr.push(f);
    else m.set(k, [f]);
  };
  for (const f of films) {
    if (f.title_en) filmByEn.set(f.title_en, f);
    const zhKey = f.title_zh || f.title_orig;
    if (zhKey) push(filmByZh, zhKey, f);
    if (f.title_orig) push(filmByOrig, f.title_orig, f);
  }
  return { filmByEn, filmByZh, filmByOrig };
}

/** 某日各厅的场次,厅顺序按 venues.json 出现顺序(未登记厅排在最后) */
export function screeningsByVenue(cat: Catalog, date: string): { venue: Venue | null; list: Screening[] }[] {
  const day = cat.schedule.screenings.filter((s) => s.date === date);
  const order = new Map<string, number>();
  cat.venues.forEach((v, i) => order.set(v.id, i));
  const venueIds = [...new Set(day.map((s) => s.venue_id))].sort(
    (a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999)
  );
  return venueIds.map((vid) => ({
    venue: cat.venueById.get(vid) ?? null,
    list: day.filter((s) => s.venue_id === vid).sort((a, b) => a.start_time.localeCompare(b.start_time)),
  }));
}
