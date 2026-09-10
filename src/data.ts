// 静态数据加载:schedule.json / venues.json / films.json(随部署走静态资源)

import type { Catalog, FilmsFile, Screening, Venue, VenuesFile, ScheduleFile } from "./types";
import { hmsToMin, minToHms } from "./util";

async function loadJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null; // 旧部署缺文件(如 films.json)时容忍
  }
}

export async function loadCatalog(): Promise<Catalog> {
  const schedule = await loadJson<ScheduleFile>("schedule.json");
  const venuesFile = await loadJson<VenuesFile>("venues.json");
  const filmsFile = await loadJson<FilmsFile>("films.json");

  if (!schedule || !venuesFile) throw new Error("schedule.json / venues.json 加载失败");

  const venueById = new Map<string, Venue>();
  for (const v of venuesFile.venues) venueById.set(v.id, v);

  // 跨午夜场唯一归一化闸门 —— 数据端一律 24+ 时制(end_time ≥ "24:00",如 23:59 场 → "29:35")。
  // 前端全部算术(轴界 / 卡片宽度 / 排序 / 整点筛选 / 冲突 / ICS 进位)都建立在 end > start 上;
  // 这里原地补 24h,既兜解析器漏改,也让手改 / 旧版 JSON 自愈(所有消费方读的是同一批对象)。
  for (const s of schedule.screenings) {
    const st = hmsToMin(s.start_time);
    const en = hmsToMin(s.end_time);
    if (en <= st) s.end_time = minToHms(en + 24 * 60);
  }

  const byCode = new Map<string, Screening>();
  for (const s of schedule.screenings) byCode.set(s.code, s);

  const dates: string[] = [];
  for (const s of schedule.screenings) {
    if (!dates.includes(s.date)) dates.push(s.date);
  }
  dates.sort();

  return { schedule, dates, venues: venuesFile.venues, venueById, byCode, films: filmsFile?.films ?? [] };
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
