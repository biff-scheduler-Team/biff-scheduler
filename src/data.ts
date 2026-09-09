// 静态数据加载:schedule.json / venues.json / films.json(随部署走静态资源)

import type { Catalog, FilmsFile, Screening, Venue, VenuesFile, ScheduleFile } from "./types";

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
