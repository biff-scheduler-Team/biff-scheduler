import type { FilmCatalogue } from "../types";
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

/** 首映码 → 中文。2026 官方册子只印这两个码(`tools/extract_catalogue_films.py` 实测
 *  WP 80 / IP 9);未登记的码**原样回显**,不猜含义 —— 换年份加码时先补表再展示。 */
const PREMIERE_LABEL: Record<string, string> = {
  WP: "世界首映",
  IP: "国际首映",
};

/** 色彩码 → 中文(册子印 `color` / `b&w`)。 */
const COLOR_LABEL: Record<string, string> = {
  color: "彩色",
  "b&w": "黑白",
};

/** 官方节目册介绍页的元信息行:「格式 · 色彩 · 首映 · 册页 N」(空位自动省略,全空则空串)。
 *  数据源 = `FilmItem.catalogue`(册子 p22–96 的影片介绍页,官网片目页不印这些)。 */
export function catalogueLine(c: FilmCatalogue): string {
  const bits = [
    c.format,
    c.color ? (COLOR_LABEL[c.color] ?? c.color) : "",
    c.premiere ? (PREMIERE_LABEL[c.premiere] ?? c.premiere) : "",
    c.page ? `册页 ${c.page}` : "",
  ];
  return bits.filter(Boolean).join(" · ");
}
