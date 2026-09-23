import type { Catalog, ExtraProgram, FilmItem, Mapping, Screening } from "../types";
import { extras, KIND_LABEL, programOf } from "../extras";
import {
  bilingualTitle,
  catMetaLine,
  doubanMappingOf,
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

/** `buildFilms` 的**带缓存**版本：只在「目录 / 映射版本 / P&I 开关」变化时才重建。
 *
 *  ★ 为什么需要（2026-09-23，`PLAN-20260923113659` T3）：`store.tsx::derive` 的 useMemo 依赖
 *    `[cat, version]`，而 `version` 在**任何**一次变更（点一场片、改一个设置）后都会自增 ——
 *    于是「点选一场」就要重算整届 `buildFilms`（795 场 → 影片节点）。
 *    而 films 只依赖目录与豆瓣映射，**与选片无关**，本可整段跳过。
 *
 *  ⚠ 缓存键必须用 `state.ts::store.mappingRevision`（每次写 mappings 时自增），
 *    **不能**用 `mappings.size`（映射若被覆盖重写，size 不变而内容已变 → 读到过期映射），
 *    更**不能**只按 `cat` 缓存（同一个坑的更粗略版本）。
 *  ⚠ 键用 `base`（稳定的那份目录）而不是 `effective`：`withPni()` 每次调用都返回**新对象**，
 *    拿它当键会永远命中不了；P&I 是否并进来改用 `pni` 标记参与判定。 */
const filmsCache = new WeakMap<Catalog, { revision: number; pni: boolean; films: FilmNode[] }>();

export function buildFilmsCached(
  base: Catalog,
  effective: Catalog,
  mappings: Map<string, Mapping>,
  revision: number,
): FilmNode[] {
  const pni = effective !== base;
  const cached = filmsCache.get(base);
  if (cached && cached.revision === revision && cached.pni === pni) return cached.films;
  const films = buildFilms(effective, mappings);
  filmsCache.set(base, { revision, pni, films });
  return films;
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
        // 有场次:先按场次 code 查,未命中再退目录片 id(口径见 `util.ts::doubanMappingOf`)
        map: doubanMappingOf(mappings, { code: s.code, filmId: info.cats[0]?.id }),
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
      // 纯目录片(无排期):没有场次 code 可查,只剩目录片 id 这一条腿
      map: doubanMappingOf(mappings, { filmId: f.id }),
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

/** 片节点 key → **唯一**场次（只有排期里**恰好一场**的片才有条目；多场 / 无排期不入表）。
 *
 *  ★ 语义：**只有一场的影片「选了 = 排了」**（2026-09-16，`PLAN-20260916004024`）——
 *    它没有「挑场次」这一步，所以三处都按这一个判据行事：
 *      ① 载入时把空选片记录补上那一场（`state.ts::fillSoleShowPicks`）；
 *      ② 影片库入口直接落进行程（`LibraryPage`）；
 *      ③ 取消这一场 = 连选片记录一起移除，**先给用户提示**（`screening-actions.ts`）。
 *  ⚠ 三处必须同一判据：这里按 `filmNodeKey` 分组算一次，与 `buildFilms()` 的 `shows` 同口径。
 *  ⚠ 分组遍历是 O(场次)；调用方（启动链 / 需要时）各算一次即可，别放进逐卡片渲染。 */
export function soleShowIndex(cat: Catalog): Map<string, Screening> {
  const groups = new Map<string, Screening[]>();
  for (const s of cat.schedule.screenings) {
    const key = filmNodeKey(cat, s);
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
  const sole = new Map<string, Screening>();
  for (const [key, list] of groups) {
    if (list.length === 1) sole.set(key, list[0]);
  }
  return sole;
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

/** 一部目录片**归属的全部单元键**(主单元 ∪ 联映块单元)。
 *
 *  为什么不是单值:午夜单元的成员是「块内成员片」,而官网只给每部片一个主单元 ——
 *  实测 4 部(Sapiens / Angel′s Egg / The Spiral / Jim Queen)主单元在别处,却在午夜块里放,
 *  只看 `unit` 会让午夜单元少数这 4 部(5 部 vs 官网 9 部,`PLAN-20260915144335`)。
 *  ⚠ **计数(`libraryUnits`)与筛选(`filmInUnit`)必须同源走这里** —— 否则会出现
 *    「下拉说 9 部、点进去只有 5 张卡」。`unit` 本身仍是唯一身份,本函数不改它。
 */
export function unitsOfFilm(film: FilmItem): string[] {
  return [...new Set([film.unit, ...(film.also_units ?? [])])].map(unitKey);
}

export function filmInUnit(film: FilmNode, unit: string): boolean {
  if (unit.startsWith("act:")) return film.shows.some((s) => programOf(s.code)?.kind === unit.slice(4));
  return film.cats.some((item) => unitsOfFilm(item).includes(unit));
}

export function libraryUnits(films: FilmItem[]) {
  const counts = new Map<string, number>();
  for (const film of films) {
    // 一部片可能归属多个单元(联映块成员)—— 每个单元各计一次,不是「择一」
    for (const key of unitsOfFilm(film)) counts.set(key, (counts.get(key) ?? 0) + 1);
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
