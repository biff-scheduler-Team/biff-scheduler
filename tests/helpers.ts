// 测试夹具 —— 构造最小的 Screening / Catalog(**纯数据,不碰 DOM / localStorage**)。
// 只写测试真正关心的字段,其余走默认值,让断言聚焦在口径上。
import type { Catalog, FilmItem, Screening, Venue } from "../src/types";
import { buildFilmIndex } from "../src/data";

/** 一场(默认 2026-10-08 10:00–11:40 @ b1,非 GV) */
export function show(patch: Partial<Screening> & { code: string }): Screening {
  return {
    title_en: "Test Film",
    title_kr: "",
    title_zh: "",
    date: "2026-10-08",
    start_time: "10:00",
    end_time: "11:40",
    duration_min: 100,
    venue_id: "b1",
    venue_display: "BCC Cinema 1",
    is_gv: false,
    ...patch,
  };
}

/** 最小 Catalog:目录 films 默认留空 → `filmNodeKey` 走 `sched:<中文名小写>` 分支,
 *  测试里用 `sched:alpha` 这种可读 key 即可(与线上 `filmNodeKey` 口径一致)。 */
export function catalog(shows: Screening[], films: FilmItem[] = []): Catalog {
  const venues: Venue[] = [
    { id: "b1", name: "BCC Cinema 1", name_kr: "", group: "bcc", short: "BCC 1" },
    { id: "b2", name: "BCC Cinema 2", name_kr: "", group: "bcc", short: "BCC 2" },
  ];
  return {
    schedule: { festival: { name: "BIFF", year: 2026, dates: [] }, screenings: shows },
    dates: [...new Set(shows.map((s) => s.date))].sort(),
    venues,
    venueById: new Map(venues.map((v) => [v.id, v])),
    byCode: new Map(shows.map((s) => [s.code, s])),
    films,
    ...buildFilmIndex(films),
  };
}
