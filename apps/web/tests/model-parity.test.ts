import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFilmIndex } from "../src/data";
import { loadExtras } from "../src/extras";
import { buildFilms, filmInUnit, libraryUnits, searchFilm, unitKey } from "../src/app/model";
import type { Catalog, FilmsFile, ScheduleFile, VenuesFile } from "../src/types";

const films = (JSON.parse(readFileSync("public/films.json", "utf8")) as FilmsFile).films;
const schedule = JSON.parse(readFileSync("public/schedule.json", "utf8")) as ScheduleFile;
const venues = (JSON.parse(readFileSync("public/venues.json", "utf8")) as VenuesFile).venues;
const extras = JSON.parse(readFileSync("public/festival-extras.json", "utf8"));
const catalog: Catalog = {
  films, schedule, venues,
  dates: [...new Set(schedule.screenings.map((s) => s.date))],
  byCode: new Map(schedule.screenings.map((s) => [s.code, s])),
  venueById: new Map(venues.map((v) => [v.id, v])),
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
