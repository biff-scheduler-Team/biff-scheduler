import { test, expect } from "@playwright/test";
import { catalog, keyOf, ready, seed, storage } from "./helpers";
import { hmsToMin } from "../../apps/web/src/util";

test("failed catalog requests show a recovery page and can be retried", async ({
  page,
}) => {
  await page.route("**/schedule.json", (route) =>
    route.fulfill({ status: 503, body: "Unavailable" }),
  );
  await page.goto("/library/films/cat%3Af001");
  await expect(
    page.getByRole("heading", { name: "排期加载失败", exact: true }),
  ).toBeVisible();
  await page.unroute("**/schedule.json");
  await page.getByRole("link", { name: "重新加载", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "主要导航" }),
  ).toBeVisible();
});

test("unknown film URLs have a usable return action", async ({ page }) => {
  await ready(page, "/library/films/cat%3Aunknown");
  await expect(
    page.getByRole("dialog", { name: "找不到这部影片", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(page).toHaveURL(/\/library$/);
});

test("rank repairs preview changes before applying them", async ({ page }) => {
  const overlaps = (
    a: (typeof catalog.schedule.screenings)[number],
    b: typeof a,
  ) =>
    a.date === b.date &&
    a.code !== b.code &&
    keyOf(a.code) !== keyOf(b.code) &&
    hmsToMin(a.start_time) < hmsToMin(b.end_time) &&
    hmsToMin(b.start_time) < hmsToMin(a.end_time);
  const shows = catalog.schedule.screenings;
  let sample: string[] | undefined;
  for (const first of shows) {
    const second = shows.find(
      (s) =>
        s.date !== first.date &&
        keyOf(s.code) === keyOf(first.code) &&
        shows.some((other) => overlaps(s, other)),
    );
    const alt1 = shows.find((s) => overlaps(first, s));
    const alt2 =
      second &&
      shows.find(
        (s) =>
          overlaps(second, s) && keyOf(s.code) !== (alt1 && keyOf(alt1.code)),
      );
    if (second && alt1 && alt2) {
      sample = [first.code, alt1.code, second.code, alt2.code];
      break;
    }
  }
  expect(sample).toBeDefined();
  const picks = new Map<
    string,
    { key: string; picks: { code: string }[]; note: string }
  >();
  for (const c of sample!) {
    const key = keyOf(c);
    const item = picks.get(key) ?? { key, picks: [], note: "" };
    item.picks.push({ code: c });
    picks.set(key, item);
  }
  const ranks = Object.fromEntries(sample!.map((c, i) => [c, (i % 2) + 1]));
  await seed(page, {
    "biff.picks.v2": JSON.stringify([...picks.values()]),
    "biff.ranks.v1": JSON.stringify(ranks),
  });
  await ready(page, "/agenda");
  await page.getByRole("button", { name: "预览顺位修复", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "调整抢票顺位",
    exact: true,
  });
  await expect(dialog).toContainText("改为");
  expect(JSON.parse((await storage(page))["biff.ranks.v1"])).toEqual(ranks);
  await dialog.getByRole("button", { name: "应用修复", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(JSON.parse((await storage(page))["biff.ranks.v1"])).not.toEqual(ranks);
});

test("screening location reveals the correct day and target", async ({
  page,
}) => {
  await seed(page, {
    "biff.picks.v2": JSON.stringify([
      { key: keyOf("008"), picks: [{ code: "008" }], note: "" },
    ]),
  });
  await ready(page, "/agenda");
  await page.getByRole("button", { name: "定位场次 008", exact: true }).click();
  await expect(page).toHaveURL(
    /\/schedule\?.*date=2026-10-07.*focus=008/,
  );
  await expect(page.locator('[data-grid-code="008"]')).toBeVisible();
  await expect(page.locator('[data-grid-code="008"]')).toBeFocused();
});

test("film details retain the legacy informational role", async ({ page }) => {
  await ready(page, "/library/films/cat%3Af001");
  const detail = page.getByRole("dialog", { name: "彼此的日夜", exact: true });
  await expect(detail).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(detail.locator("[data-screening]")).toHaveCount(0);
  await expect(
    detail.getByRole("button", { name: /加入.*场次|调整.*映后/ }),
  ).toHaveCount(0);
  await detail.getByRole("button", { name: "返回", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
