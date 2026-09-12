import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, type Page } from "@playwright/test";
import { buildFilmIndex } from "../../apps/web/src/data";
import { filmNodeKey } from "../../apps/web/src/util";
import type {
  Catalog,
  FilmsFile,
  ScheduleFile,
  VenuesFile,
} from "../../apps/web/src/types";

const schedule = JSON.parse(
  readFileSync("apps/web/public/schedule.json", "utf8"),
) as ScheduleFile;
const venues = (
  JSON.parse(readFileSync("apps/web/public/venues.json", "utf8")) as VenuesFile
).venues;
const films = (
  JSON.parse(readFileSync("apps/web/public/films.json", "utf8")) as FilmsFile
).films;
export const catalog: Catalog = {
  schedule,
  dates: schedule.festival.dates,
  venues,
  venueById: new Map(venues.map((v) => [v.id, v])),
  films,
  byCode: new Map(schedule.screenings.map((s) => [s.code, s])),
  ...buildFilmIndex(films),
};
export const keyOf = (code: string) =>
  filmNodeKey(catalog, catalog.byCode.get(code)!);
export const codeKeys = Object.fromEntries(
  schedule.screenings.map((s) => [s.code, keyOf(s.code)]),
);
export const legacyData: Record<string, string> = {
  "biff.picks.v2": JSON.stringify([
    {
      key: keyOf("001"),
      picks: [{ code: "001", group: "B" }],
      note: "旧版备注，保留换行\n和标点 ; , \\",
      priority: "must",
    },
    ...["008", "033", "037"].map((code) => ({
      key: keyOf(code),
      picks: [{ code, group: "A" }],
      note: code === "008" ? "等嘉宾" : "",
    })),
    { key: "cat:f002", picks: [], note: "只选电影，未排场" },
  ]),
  "biff.settings.v1": JSON.stringify({
    alarmMin: 60,
    transitMin: 20,
    gvTalkOn: true,
    gvTalkMin: 35,
    theme: "dark",
    zoom: 0.7,
    customPreference: "preserve-me",
  }),
  "biff.gvtalk.v1": JSON.stringify({ "001": false, "008": true, "037": false }),
  "biff.gvtalkmin.v1": JSON.stringify({ "001": 40, "008": 30 }),
  "biff.ranks.v1": JSON.stringify({ "008": 2, "033": 1, "037": 3 }),
  "biff.agendafold.v1": JSON.stringify(["2026-10-07"]),
  "biff.savedplans.v1": JSON.stringify([
    {
      id: "legacy-plan",
      name: "方案 7",
      codes: ["001", "008"],
      createdAt: 1789000000000,
    },
  ]),
  "biff.filters.v1": JSON.stringify({
    subs: ["KE"],
    venues: ["c5"],
    venueMode: "exclude",
    gv: "plain",
  }),
  "biff.libfilters.v1": JSON.stringify({
    subs: ["none"],
    venues: ["br"],
    venueMode: "include",
    gv: "gv",
  }),
  "biff.pickerw.v1": "640",
  "biff.future.v9": '{"unknown":"原样保留"}',
  "unrelated.application": "do-not-touch",
};

export async function seed(page: Page, data: Record<string, string>) {
  await page.addInitScript((values) => {
    if (sessionStorage.getItem("e2e-seeded")) return;
    for (const [key, value] of Object.entries(values))
      localStorage.setItem(key, value);
    sessionStorage.setItem("e2e-seeded", "yes");
  }, data);
}
export async function storage(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() =>
    Object.fromEntries(
      Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)!]),
    ),
  );
}
export async function ready(page: Page, path = "/schedule") {
  await page.goto(path);
  await expect(
    page.getByRole("navigation", { name: "主要导航" }),
  ).toBeVisible();
}
export async function openExport(page: Page) {
  await page.getByRole("button", { name: "导出与分享", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "导出与分享" })).toBeVisible();
  return page.getByRole("dialog", { name: "导出与分享" });
}
export async function choose(page: Page, label: string, option: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

const oldSource = readFileSync(
  "e2e/react/fixtures/legacy-state.ts.txt",
  "utf8",
).replace(
  /import \{ loadDoubanMappings \} from "\.\/data";/,
  "const loadDoubanMappings = async () => [];",
);
const legacyScript =
  ts
    .transpileModule(oldSource, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    })
    .outputText.replace(/\bexport /g, "") +
  `\nreturn {store, loadPicks, loadSettings, loadRanks, loadGvTalk, loadGvTalkMin, loadAgendaFold, loadSavedPlans, rankOf, gvTalk, gvTalkMinOv, agendaFolded, savedPlans, toggleScreening, setSettings, setGvTalk, setGvTalkMin, setRanks, savePlan};`;

/** Execute the unmodified legacy state implementation captured from 8a95215 in the browser. */
export async function legacyRead(page: Page, mutate = false) {
  return page.evaluate(
    ({ source, keys, mutate }) => {
      const old = new Function(source)();
      old.loadSettings();
      old.loadGvTalk();
      old.loadGvTalkMin();
      old.loadRanks();
      old.loadSavedPlans();
      old.loadAgendaFold();
      // Match main.ts boot: loadPicks rebuilds the index and prunes loaded ranks.
      old.loadPicks((code: string) => keys[code] ?? null);
      if (mutate) {
        old.toggleScreening(keys["033"], "033");
        old.setSettings({ alarmMin: 75 });
        old.setGvTalk("001", true);
        old.setGvTalkMin("001", 55);
      }
      return {
        picks: [...old.store.picks.values()],
        settings: old.store.settings,
        ranks: Object.fromEntries(old.rankOf),
        gv: Object.fromEntries(old.gvTalk),
        gvMin: Object.fromEntries(old.gvTalkMinOv),
        folded: [...old.agendaFolded],
        plans: old.savedPlans,
      };
    },
    { source: legacyScript, keys: codeKeys, mutate },
  );
}
