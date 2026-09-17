import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFilmIndex, loadDoubanMappings } from "../src/data";
import { loadExtras } from "../src/extras";
import { buildFilms, filmInUnit, libraryUnits, searchFilm, unitKey } from "../src/app/model";
import type { Catalog, FilmsFile, Mapping, ScheduleFile, VenuesFile } from "../src/types";
import { filmInfoOf } from "../src/util";

const films = (JSON.parse(readFileSync("public/films.json", "utf8")) as FilmsFile).films;
const schedule = JSON.parse(readFileSync("public/schedule.json", "utf8")) as ScheduleFile;
const venues = (JSON.parse(readFileSync("public/venues.json", "utf8")) as VenuesFile).venues;
const extras = JSON.parse(readFileSync("public/festival-extras.json", "utf8"));
const catalog: Catalog = {
  films, schedule, venues,
  dates: [...new Set(schedule.screenings.map((s) => s.date))],
  byCode: new Map(schedule.screenings.map((s) => [s.code, s])),
  venueById: new Map(venues.map((v) => [v.id, v])),
  // P&I(记者 / 业界场)留空 = 线上**未勾选**时的口径(它们单独存在 public/pni.json,不混进公开产物)
  pniScreenings: [],
  pniVenues: [],
  ...buildFilmIndex(films),
};
const nodes = buildFilms(catalog, new Map());

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => extras })));
  await loadExtras();
});

describe("legacy library search and section parity", () => {
  it("finds activity types and Chinese guests stored only in festival extras", () => {
    expect(nodes.filter((n) => searchFilm(n, "范冰冰")).map((n) => n.key)).toEqual(["cat:f072"]);
    expect(nodes.filter((n) => searchFilm(n, "李敏镐")).map((n) => n.shows[0].code)).toEqual(["801"]);
    expect(nodes.filter((n) => searchFilm(n, "演员之家"))).toHaveLength(6);
    expect(nodes.filter((n) => searchFilm(n, "大师班"))).toHaveLength(4);
    expect(nodes.filter((n) => searchFilm(n, "电影课"))).toHaveLength(6);
  });

  it("keeps the old contiguous, per-field matching rather than inventing cross-field tokens", () => {
    const node = nodes.find((n) => n.key === "cat:f001")!;
    expect(searchFilm(node, "  NIGHT  ")).toBe(true);
    expect(searchFilm(node, "낮과 밤" )).toBe(true);
    expect(searchFilm(node, "001")).toBe(true);
    expect(searchFilm(node, "彼此的日夜 韩国")).toBe(false);
  });

  it("merges all four award spellings and retains real sub-sections", () => {
    for (const year of [2026, 2027, 2028, 2029]) {
      expect(unitKey(`${year}年度亚洲电影人奖-杨紫琼专题`)).toBe("亚洲电影人奖");
    }
    expect(unitKey("On Screen 单元3部·均为剧集首映")).toBe("On Screen");
    expect(unitKey("广角镜 - 纪录片放映")).not.toBe(unitKey("广角镜 - 纪录片竞赛"));
    expect(unitKey("Vision–Asia")).not.toBe(unitKey("Vision–Korea"));
    const award = libraryUnits(films).filter((u) => u.key === "亚洲电影人奖");
    expect(award).toHaveLength(1);
    expect(award[0].count).toBe(4);
    expect(nodes.filter((n) => filmInUnit(n, award[0].key))).toHaveLength(4);
  });

  it("counts a film in every unit it belongs to, midnight block members included", () => {
    // 2026-09-15(`PLAN-20260915144335`):午夜单元 = 3 个联映块的**成员并集**
    // (官网 `prog_list.asp?c_idx=438` 共 9 部),但其中 4 部的主单元在别处 ——
    // Sapiens = Korean Cinema Today – Special Premiere、Angel′s Egg = 日本动画特别企划、
    // The Spiral = Open Cinema、Jim Queen = World Cinema。只看单值 `unit` 时午夜单元
    // 少数这 4 部(实测 5 部),故单元归属口径 = 主单元 ∪ `also_units`。
    const units = libraryUnits(films);
    expect(units.find((u) => u.key === "Midnight Passion")!.count).toBe(9);
    expect(nodes.filter((n) => filmInUnit(n, "Midnight Passion"))).toHaveLength(9);
    // 另属单元**不夺走**主单元:这 4 部在原单元里照旧各计一次(同一部片两个单元都出现是预期)
    expect(units.find((u) => u.key === "Open Cinema")!.count).toBe(5);
    expect(nodes.filter((n) => filmInUnit(n, "Open Cinema"))).toHaveLength(5);
    expect(units.find((u) => u.key === "World Cinema")!.count).toBe(
      nodes.filter((n) => filmInUnit(n, "World Cinema")).length,
    );
  });

  it("includes ordinary screenings with a special talk in the activity section", () => {
    expect(filmInUnit(nodes.find((n) => n.key === "cat:f072")!, "act:special_talk")).toBe(true);
    expect(libraryUnits(films).filter((u) => u.key.startsWith("act:")).map((u) => u.key)).toEqual([
      "act:actors_house", "act:master_class", "act:cine_class", "act:special_talk",
    ]);
  });

  it("keeps base film search usable and hides activity sections when extras are absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ programs: [] }) })));
    await loadExtras();
    expect(nodes.some((n) => searchFilm(n, "彼此的日夜"))).toBe(true);
    expect(nodes.some((n) => searchFilm(n, "范冰冰"))).toBe(false);
    expect(libraryUnits(films).some((u) => u.key.startsWith("act:"))).toBe(false);
  });
});

/* ---------- 豆瓣映射取用口径对账(2026-09-17,`PLAN-20260917010426`) ----------
 * 回落链收进 `util.ts::doubanMappingOf` 之后,这里拿**真实产物**对账 ——
 * 产物换版导致「场次 code」与「目录片 id」两侧分叉时,这几条会先红。 */
const pni = JSON.parse(readFileSync("public/pni.json", "utf8")) as ScheduleFile;
let mappings: Map<string, Mapping>;

beforeAll(async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    json: async () => JSON.parse(readFileSync(`public${url}`, "utf8")),
  })));
  mappings = new Map((await loadDoubanMappings()).map((m) => [m.code, m] as const));
});

describe("douban mapping resolution", () => {
  it("公开排期:场次 code 与所属目录片 id 两侧逐条同真同假", () => {
    const mismatch = catalog.schedule.screenings
      .filter((s) => {
        const byCode = mappings.get(s.code);
        const byFilm = mappings.get(filmInfoOf(catalog, s, byCode).cats[0]?.id ?? "");
        return Boolean(byCode) !== Boolean(byFilm);
      })
      .map((s) => s.code);
    expect(mismatch).toEqual([]);
    // 产物本身要有量:万一将来 `douban.json` 被清空,上面那条断言会「假绿」
    expect(catalog.schedule.screenings.filter((s) => mappings.get(s.code)).length).toBeGreaterThan(0);
  });

  it("P&I 场次的 code 不在产物里 —— 「退目录片 id」这条腿正是它们的出路", () => {
    // 产物是按**公开排期 code** 生成的,`PI-xx-xx` 天然查不到(实测 37 条全部如此);
    // 少了这条腿,这些场次的「豆瓣 ↗」只能落到搜索结果页。
    const missed = pni.screenings.filter((s) => !mappings.get(s.code));
    const rescued = pni.screenings.filter((s) =>
      mappings.get(filmInfoOf(catalog, s).cats[0]?.id ?? ""),
    );
    expect(missed.length).toBeGreaterThan(0);
    expect(rescued.length).toBeGreaterThan(0);
  });

  it("片节点的 map 走同一口径:有场次按 code,纯目录片按 f###", () => {
    const withMappings = buildFilms(catalog, mappings);
    const withShows = withMappings.find((n) => n.shows.length > 0 && mappings.get(n.shows[0].code))!;
    expect(withShows.map).toBe(mappings.get(withShows.shows[0].code));
    const noShows = withMappings.find((n) => n.shows.length === 0 && mappings.get(n.cats[0]?.id ?? ""))!;
    expect(noShows.map).toBe(mappings.get(noShows.cats[0].id));
  });
});
