import { expect, test, type Page } from "@playwright/test";
import { catalog, DEFAULT_SCHEDULE_ZOOM, ready } from "./helpers";

test.use({ viewport: { width: 1440, height: 1000 }, timezoneId: "Asia/Seoul" });

async function timeAtCenter(page: Page, zoom: number) {
  return page.locator(".gantt-canvas").evaluate((el, zoom) =>
    (64 + (innerHeight - 64) / 2 - el.getBoundingClientRect().top - 18) / (4 * zoom), zoom);
}

test("wheel zoom preserves page time and has no internal vertical scrolling", async ({ page }) => {
  await ready(page, "/schedule?date=2026-10-07");
  const grid = page.locator(".gantt-scroll");
  await grid.evaluate(el => { el.scrollLeft = 700; window.scrollTo(0, el.getBoundingClientRect().top + scrollY + 400); });
  const before = await timeAtCenter(page, DEFAULT_SCHEDULE_ZOOM);
  await grid.evaluate(el => el.dispatchEvent(new WheelEvent("wheel", {bubbles: true, cancelable: true, ctrlKey: true, deltaY: 60})));
  // deltaY>0 → 缩小一档 →「小」0.45
  await expect(page.getByRole("group", { name: "排片大小" }).getByRole("button", { name: "小", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(Math.abs(await timeAtCenter(page, 0.45) - before)).toBeLessThan(1);
  expect(await grid.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  await expect(grid).toHaveJSProperty("scrollTop", 0);
});

test("external zoom settings preserve the time under the page center", async ({page, context}) => {
  await ready(page, "/schedule?date=2026-10-07");
  const other = await context.newPage();
  await ready(other, "/schedule?date=2026-10-07");
  await page.locator(".gantt-scroll").evaluate(el => window.scrollTo(0, el.getBoundingClientRect().top + scrollY + 400));
  const before = await timeAtCenter(page, DEFAULT_SCHEDULE_ZOOM);
  await other.evaluate(() => localStorage.setItem("biff.settings.v1", JSON.stringify({...JSON.parse(localStorage.getItem("biff.settings.v1") ?? "{}"), zoom: 0.75})));
  await expect(page.getByRole("group", { name: "排片大小" }).getByRole("button", { name: "大", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(Math.abs(await timeAtCenter(page, 0.75) - before)).toBeLessThan(1);
  await other.close();
});

test("fit resets horizontal position and the venue header stays synchronized", async ({page}) => {
  await ready(page, "/schedule?date=2026-10-07");
  const grid = page.locator(".gantt-scroll");
  await grid.evaluate(el => {el.scrollLeft = 700;});
  expect((await page.locator(".vertical-venue").first().boundingBox())!.x).toBe((await page.locator(".gantt-row").first().boundingBox())!.x);
  // 无「适应」按钮：换日重置横向滚动
  await page.getByRole("button", {name: "选择日期 2026-10-08", exact: true}).click();
  await expect(grid).toHaveJSProperty("scrollLeft", 0);
  await expect(page.locator(".venue-header-scroll")).toHaveJSProperty("scrollLeft", 0);
});

test("a date initialized without a query survives both responsive layouts", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-10T12:00:00+09:00") });
  await ready(page, "/schedule");
  await expect(page.getByRole("button", { name: "选择日期 2026-10-06", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".gantt-scroll")).toBeVisible();
  await expect(page.getByRole("button", { name: "选择日期 2026-10-06", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "选择日期 2026-10-06", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator(".gantt-scroll")).toBeVisible();
  await expect(page.getByRole("button", { name: "选择日期 2026-10-06", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("the mobile default survives midnight, selecting a screening, and resizing to desktop", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install({ time: new Date("2026-10-10T23:59:59+09:00") });
  await ready(page, "/schedule");
  await expect(page.getByRole("button", { name: "选择日期 2026-10-10", exact: true })).toHaveAttribute("aria-pressed", "true");
  const first = page.locator("[data-grid-code]").first();
  const code = await first.getAttribute("data-grid-code");
  await page.clock.fastForward(2000);
  await first.click();
  await expect(page.locator(`[data-grid-code="${code}"][aria-pressed="true"]`)).toBeVisible();
  await expect(page.getByRole("button", { name: "选择日期 2026-10-10", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator(".gantt-scroll")).toBeVisible();
  await expect(page.getByRole("button", { name: "选择日期 2026-10-10", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("crossing into phone layout clears the hour and restores the entire day", async ({ page }) => {
  await ready(page, "/schedule?date=2026-10-07");
  await page.getByRole("button", { name: "筛选 09:00 时段", exact: true }).click();
  await expect(page.getByText("正在查看 09:00 时段", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => new URL(page.url()).searchParams.has("hour")).toBe(false);
  await expect(page.locator("[data-grid-code]")).toHaveCount(
    catalog.schedule.screenings.filter((screening) => screening.date === "2026-10-07").length,
  );
  await expect(page.getByRole("button", { name: "选择日期 2026-10-07", exact: true })).toHaveAttribute("aria-pressed", "true");
});
