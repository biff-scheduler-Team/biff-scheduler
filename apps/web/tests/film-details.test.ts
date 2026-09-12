import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFilmIndex } from "../src/data";
import { loadExtras, programOf } from "../src/extras";
import { buildFilms } from "../src/app/model";
import { filmDetailAnchor, filmDetailNames } from "../src/app/film-details";
import type { Catalog, FilmsFile, ScheduleFile, VenuesFile } from "../src/types";

const films = (JSON.parse(readFileSync("public/films.json", "utf8")) as FilmsFile).films;
const schedule = JSON.parse(readFileSync("public/schedule.json", "utf8")) as ScheduleFile;
const venues = (JSON.parse(readFileSync("public/venues.json", "utf8")) as VenuesFile).venues;
const extras = JSON.parse(readFileSync("public/festival-extras.json", "utf8"));
const catalog: Catalog = {
  films, schedule, venues,
  dates: schedule.festival.dates,
  byCode: new Map(schedule.screenings.map((show) => [show.code, show])),
  venueById: new Map(venues.map((venue) => [venue.id, venue])),
  ...buildFilmIndex(films),
};
const nodes = new Map(buildFilms(catalog, new Map()).map((film) => [film.key, film]));

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => extras })));
  await loadExtras();
});

describe("screening-specific film details", () => {
  it("keeps Mother Mary's ordinary screening separate from its special talk", () => {
    const film = nodes.get("cat:f019");
    const ordinary = filmDetailAnchor(film, "256")!;
    const talk = filmDetailAnchor(film, "021")!;
    expect(ordinary.date).toBe("2026-10-09");
    expect(programOf(ordinary.code)).toBeUndefined();
    expect(programOf(talk.code)?.dateText).toBe("October 7 (Wed) After the 19:00 Screening");
  });

  it("uses the first show for a library card even when a later show has an activity", () => {
    const anchor = filmDetailAnchor(nodes.get("cat:f114"), null)!;
    expect(anchor.code).toBe("162");
    expect(programOf(anchor.code)).toBeUndefined();
    expect(programOf("338")).toBeDefined();
  });

  it("does not borrow another film's screening from a stale detail URL", () => {
    expect(filmDetailAnchor(nodes.get("cat:f002"), "021")).toBeUndefined();
    expect(filmDetailAnchor(nodes.get("cat:f019"), "old-code")).toBeUndefined();
  });

  it("retains both the original Japanese name and the Korean screening title", () => {
    const film = nodes.get("cat:f002")!;
    const anchor = filmDetailAnchor(film, null)!;
    expect(filmDetailNames(film, anchor.title_kr)).toEqual(["ルックバック", "룩백"]);
  });

  it("does not repeat the Korean name when the catalogue already supplied it", () => {
    const film = nodes.get("cat:f001")!;
    const anchor = filmDetailAnchor(film, null)!;
    expect(filmDetailNames(film, anchor.title_kr)).toEqual(["낮과 밤은 서로에게"]);
    expect(filmDetailNames(film, film.en)).not.toContain(film.en);
  });
});
