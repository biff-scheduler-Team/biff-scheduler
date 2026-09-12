import type { FilmNode } from "./model";
import { normText } from "../util";

/** Library cards use the first show; screening buttons keep the exact show they opened. */
export function filmDetailAnchor(film: FilmNode | undefined, code: string | null) {
  return code ? film?.shows.find((show) => show.code === code) : film?.shows[0];
}

/** Catalogue original titles and the screening's Korean title are different fields. */
export function filmDetailNames(film: FilmNode, koreanTitle?: string) {
  const seen = new Set([normText(film.en), normText(film.zh)]);
  return [...film.names, koreanTitle ?? ""].filter((name) => {
    const key = normText(name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
