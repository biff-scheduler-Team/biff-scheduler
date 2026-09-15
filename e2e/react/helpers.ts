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
    // 单场片（蓦然回首 f002，排期里只有 10-07 的 003 一场）：新版载入时会自动补进行程
    // （2026-09-16，PLAN-20260916004024），所以基线直接写「已排唯一场次」的样子 ——
    // 写成空记录的话，`storage(page) toEqual legacyData` 一类的字节级断言会被补齐打破。
    { key: "cat:f002", picks: [{ code: "003" }], note: "单场片，加入即排场" },
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
    // 用真场馆 id(官方 2026 代码 `bt` = Roof Theater):`br` 是旧抓取脚本自造的 id,
    // 已经不在 venues.json 里 —— include 模式下留个不存在的 id 会让影片库整片为空。
    venues: ["bt"],
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
/** 应用数据契约快照：排除 iffday.workspace.* 账号缓存（AGENTS.md §5）。 */
export async function storage(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() =>
    Object.fromEntries(
      Object.keys(localStorage)
        .filter((k) => !k.startsWith("iffday."))
        .map((k) => [k, localStorage.getItem(k)!]),
    ),
  );
}
export async function ready(page: Page, path = "/schedule") {
  await page.goto(path);
  await expect(
    page.getByRole("navigation", { name: "主要导航" }),
  ).toBeVisible();
}
/** 排片表页标题含年月（「排片表 2026 年 10 月」）。 */
export function scheduleHeading(page: Page) {
  return page.getByRole("heading", { name: /^排片表/ });
}
/** 记录画布上**画过的文字** —— 海报是 canvas 手绘,没有 DOM 可断言,只能挂 `fillText`。
 *  装上后每次 `fillText` 都把文本追加进 `window.__paintedTexts`。
 *  ⚠ 必须在首次 `goto` 之前调用;数组**跨多次出图累加** —— 要断言「这一张图上有什么」,
 *  前后各读一次 `paintedTexts()`,比对新增的部分(或直接断言「现在包含 / 不含」)。 */
export async function trackPaintedTexts(page: Page) {
  await page.addInitScript(() => {
    const state = window as typeof window & { __paintedTexts: string[] };
    state.__paintedTexts = [];
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (
      text,
      ...args: [number, number, number?]
    ) {
      state.__paintedTexts.push(text);
      return fillText.call(this, text, ...args);
    };
  });
}

/** 已画到画布上的全部文字(换行拼接;配合 `trackPaintedTexts` 用) */
export async function paintedTexts(page: Page): Promise<string> {
  return page.evaluate(() =>
    (window as typeof window & { __paintedTexts: string[] }).__paintedTexts.join("\n"),
  );
}

/** 打开「我的观影」浮层；整页路由上 FAB 被隐藏时先回排片表。 */
export async function openViewingPanel(page: Page) {
  if (await page.locator("#viewing-panel").count()) return;
  const fab = page.getByRole("button", { name: "打开我的观影", exact: true });
  if (await fab.isVisible()) {
    await fab.click();
    return;
  }
  await page.getByRole("link", { name: "排片表", exact: true }).click();
  await fab.click();
}
/** 纵向排片默认档 zoom（与 SchedulePage SIZE_OPTIONS「默认」一致）。 */
export const DEFAULT_SCHEDULE_ZOOM = 0.55;
export const VERTICAL_PX_PER_MIN = 4;
export const hourTickPx = (zoom = DEFAULT_SCHEDULE_ZOOM) =>
  60 * VERTICAL_PX_PER_MIN * zoom;
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
