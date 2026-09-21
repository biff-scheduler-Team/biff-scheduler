import { test, expect } from "@playwright/test";
import { agendaCards, legacyData, openViewingPanel, ready, seed, storage, keyOf } from "./helpers";

test("legacy entry is an independent old app and reads the same localStorage", async ({
  page,
}) => {
  await seed(page, legacyData);
  await ready(page, "/agenda");
  const initial = await storage(page);
  await page.evaluate(() => {
    (window as typeof window & { pageMarker?: boolean }).pageMarker = true;
  });
  await page.getByRole("link", { name: "回到旧版", exact: true }).click();
  await expect(page).toHaveURL(/\/legacy\/$/);
  await expect(page.locator("#topbar")).toBeVisible();
  await expect(page.locator("#grid-scroll")).toBeVisible();
  await expect(page.locator("#root")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as typeof window & { pageMarker?: boolean }).pageMarker,
    ),
  ).toBeUndefined();
  expect(await storage(page)).toEqual(initial);
  await page.getByRole("link", { name: "体验新版", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "主要导航" }),
  ).toBeVisible();
  expect(await storage(page)).toEqual(initial);
});

test("the bare legacy URL redirects to the original app and legacy picks appear in the rewrite", async ({
  page,
  isMobile,
}) => {
  await page.goto("/legacy");
  await expect(page).toHaveURL(/\/legacy\/$/);
  await expect(page.locator("#topbar")).toBeVisible();
  const card = page.locator(
    isMobile
      ? '#grid-scroll [data-card][data-code="001"]'
      : '#grid-scroll [data-card="1"][data-code="001"]',
  );
  // Before the festival both viewports start at the first day.
  await expect(card).toBeVisible();
  await card.click({ position: { x: 15, y: 15 } });
  await expect
    .poll(async () =>
      JSON.parse((await storage(page))["biff.picks.v2"] ?? "[]").flatMap(
        (p: { picks: { code: string }[] }) => p.picks.map((s) => s.code),
      ),
    )
    .toContain("001");
  await page.getByRole("link", { name: "体验新版", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "主要导航" }),
  ).toBeVisible();
  await openViewingPanel(page);
  await page.locator("#viewing-panel").getByRole("link", { name: /^我的行程/ }).click();
  // 场次卡只在卡片视图(2026-09-21 起「我的行程」默认日程表,见 PLAN-20260921223658)
  await agendaCards(page);
  await expect(
    page
      .getByRole("region", { name: "我的行程", exact: true })
      .locator('[data-screening="001"]'),
  ).toBeVisible();
  expect(JSON.parse((await storage(page))["biff.picks.v2"])).toEqual([
    { key: keyOf("001"), picks: [{ code: "001" }], note: "" },
  ]);
});

test("legacy relative data requests resolve to the shared root data", async ({
  page,
}) => {
  const paths: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith(".json"))
      paths.push(new URL(request.url()).pathname);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/legacy/");
  await expect(page.locator("#grid-scroll")).toBeVisible();
  expect(paths).toContain("/schedule.json");
  expect(paths).toContain("/venues.json");
  expect(paths.filter((path) => path.startsWith("/legacy/"))).toEqual([]);
  expect(errors).toEqual([]);
});
