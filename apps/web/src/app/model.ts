import type { Catalog, ExtraProgram, FilmItem, Mapping, Screening } from "../types";
import { extras, KIND_LABEL, programOf } from "../extras";
import {
  bilingualTitle,
  catMetaLine,
  filmEnName,
  filmInfoOf,
  filmNodeKey,
  normText,
  unitLabel,
} from "../util";

export interface FilmNode {
  key: string;
  title: string;
  en: string;
  zh: string;
  names: string[];
  meta: string;
  cats: FilmItem[];
  shows: Screening[];
  map?: Mapping;
  poster?: string;
  block?: Screening;
}

export function buildFilms(
  cat: Catalog,
  mappings: Map<string, Mapping>,
): FilmNode[] {
  const nodes = new Map<string, FilmNode>();
  for (const s of [...cat.schedule.screenings].sort(
    (a, b) =>
      a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time),
  )) {
    const key = filmNodeKey(cat, s);
    if (!nodes.has(key)) {
      const info = filmInfoOf(cat, s, mappings.get(s.code));
      nodes.set(key, {
        key,
        ...info,
        shows: [],
        map: mappings.get(s.code),
        poster: info.cats[0]?.poster,
      });
    }
    nodes.get(key)!.shows.push(s);
  }
  for (const f of cat.films) {
    const key = `cat:${f.id}`;
    if (nodes.has(key)) continue;
    const en = filmEnName(f);
    const zh = f.title_zh || en;
    nodes.set(key, {
      key,
      title: bilingualTitle(en, f.title_zh),
      en,
      zh,
      names:
        f.title_orig &&
        ![normText(en), normText(zh)].includes(normText(f.title_orig))
          ? [f.title_orig]
          : [],
      meta: catMetaLine(f),
      cats: [f],
      shows: [],
      poster: f.poster,
      map: mappings.get(f.id),
      block: f.block_code ? cat.byCode.get(f.block_code) : undefined,
    });
  }
  const order = new Map(cat.films.map((f, i) => [`cat:${f.id}`, i]));
  return [...nodes.values()].sort(
    (a, b) =>
      (order.get(a.key) ?? 1e9) - (order.get(b.key) ?? 1e9) ||
      a.zh.localeCompare(b.zh, "zh"),
  );
}

export function searchFilm(node: FilmNode, query: string): boolean {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return true;
  if ([node.title, ...node.names, node.meta].some((s) => normText(s).includes(keyword))) return true;
  return node.shows.some((s) => {
    if (s.code.toLowerCase().includes(keyword)) return true;
    const program = programOf(s.code);
    return Boolean(program && [KIND_LABEL[program.kind], program.guest ?? "", program.guestZh ?? ""]
      .some((value) => normText(value).includes(keyword)));
  });
}

/** The same normalization as the legacy picker: merge spelling variants, not sub-sections. */
export function unitKey(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  const en = value.match(/^([A-Za-z][A-Za-z'&.\- ]*?)\s*(?=[\u4e00-\u9fa5])/);
  if (en?.[1].trim()) return en[1].trim();
  if (value.includes("年度亚洲电影人奖")) return "亚洲电影人奖";
  return value || "未标注单元";
}

export function filmInUnit(film: FilmNode, unit: string): boolean {
  if (unit.startsWith("act:")) return film.shows.some((s) => programOf(s.code)?.kind === unit.slice(4));
  return film.cats.some((item) => unitKey(item.unit) === unit);
}

export function libraryUnits(films: FilmItem[]) {
  const counts = new Map<string, number>();
  for (const film of films) {
    const key = unitKey(film.unit);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const units = [...counts].map(([key, count]) => ({ key, count, label: unitLabel(key) }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key, "zh"));
  const kinds: ExtraProgram["kind"][] = ["actors_house", "master_class", "cine_class", "special_talk"];
  for (const kind of kinds) {
    const count = extras()?.programs.filter((p) => p.kind === kind).length ?? 0;
    if (count) units.push({ key: `act:${kind}`, count, label: KIND_LABEL[kind] });
  }
  return units;
}
