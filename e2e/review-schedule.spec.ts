import { expect, test, type Page } from "@playwright/test";
import { catalog, ready } from "./helpers";

test.use({ viewport: { width: 1440, height: 1000 }, timezoneId: "Asia/Seoul" });

async function bottomRight(page: Page) {
  const grid = page.locator(".gantt-scroll");
  await grid.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    element.scrollTop = element.scrollHeight;
  });
  return grid;
}

async function expectAtBottomRight(page: Page) {
  await expect.poll(() => page.locator(".gantt-scroll").evaluate((element) => Math.max(
    Math.abs(element.scrollWidth - element.clientWidth - element.scrollLeft),
    Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
  ))).toBeLessThanOrEqual(1);
}

test("zoom buttons preserve the right and bottom anchors before the canvas shrinks", async ({ page }) => {
  await ready(page, "/schedule?date=2026-10-07");
  await bottomRight(page);
  await page.getByRole("button", { name: "缩小排片表", exact: true }).click();
  await expect(page.getByLabel("缩放比例", { exact: true })).toHaveText("90%");
  await expectAtBottomRight(page);

  await page.getByRole("button", { name: "放大排片表", exact: true }).click();
  await page.getByRole("button", { name: "放大排片表", exact: true }).click();
  await expect(page.getByLabel("缩放比例", { exact: true })).toHaveText("120%");
  await bottomRight(page);
  await page.getByRole("button", { name: "1:1", exact: true }).click();
  await expect(page.getByLabel("缩放比例", { exact: true })).toHaveText("100%");
  await expectAtBottomRight(page);
});

test("wheel and external settings use the same pre-resize scroll snapshot", async ({ page, context }) => {
  await ready(page, "/schedule?date=2026-10-07");
  const grid = await bottomRight(page);
  await grid.evaluate((element) => element.dispatchEvent(new WheelEvent("wheel", {
    bubbles: true, cancelable: true, ctrlKey: true, deltaY: 60,
  })));
  await expect(page.getByLabel("缩放比例", { exact: true })).toHaveText("90%");
  await expectAtBottomRight(page);

  await page.getByRole("button", { name: "1:1", exact: true }).click();
  await expect(page.getByLabel("缩放比例", { exact: true })).toHaveText("100%");
  const other = await context.newPage();
  await ready(other, "/schedule?date=2026-10-07");
  await bottomRight(page);
  await other.evaluate(() => {
    const key = "biff.settings.v1";
    const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(key, JSON.stringify({ ...settings, zoom: 0.9 }));
  });
  await expect(page.getByLabel("缩放比例", { exact: true })).toHaveText("90%");
  await expectAtBottomRight(page);
  await other.close();
});

test("fit starts at the left and shrinking at the top does not scroll the first row away", async ({ page }) => {
  await ready(page, "/schedule?date=2026-10-07");
  const grid = page.locator(".gantt-scroll");
  await page.getByRole("button", { name: "缩小排片表", exact: true }).click();
  await expect(grid).toHaveJSProperty("scrollTop", 0);
  await bottomRight(page);
  await page.getByRole("button", { name: "适应", exact: true }).click();
  await expect(grid).toHaveJSProperty("scrollLeft", 0);
});

test("a date initialized without a query survives both responsive layouts", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-10T12:00:00+09:00") });
  await ready(page, "/schedule");
  await expect(page.locator(".schedule-date")).toContainText("OCT 6");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".timeline")).toBeVisible();
  await expect(page.getByRole("button", { name: "选择日期 2026-10-06", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".schedule-date")).toContainText("OCT 6");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator(".gantt-scroll")).toBeVisible();
  await expect(page.locator(".schedule-date")).toContainText("OCT 6");
});

test("the mobile default survives midnight, selecting a screening, and resizing to desktop", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install({ time: new Date("2026-10-10T23:59:59+09:00") });
  await ready(page, "/schedule");
  await expect(page.locator(".schedule-date")).toContainText("OCT 10");
  const first = page.locator("[data-timeline-code]").first();
  const code = await first.getAttribute("data-timeline-code");
  await page.clock.fastForward(2000);
  await first.locator("h3").click();
  await expect(page.getByRole("button", { name: `移出场次 ${code}`, exact: true })).toBeVisible();
  await expect(page.locator(".schedule-date")).toContainText("OCT 10");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator(".gantt-scroll")).toBeVisible();
  await expect(page.locator(".schedule-date")).toContainText("OCT 10");
});

test("crossing into the phone timeline clears the hour and restores the entire day", async ({ page }) => {
  await ready(page, "/schedule?date=2026-10-07");
  await page.getByRole("button", { name: "筛选 09:00 时段", exact: true }).click();
  await expect(page.getByText("正在查看 09:00 时段", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => new URL(page.url()).searchParams.has("hour")).toBe(false);
  await expect(page.locator("[data-timeline-code]")).toHaveCount(
    catalog.schedule.screenings.filter((screening) => screening.date === "2026-10-07").length,
  );
  await expect(page.locator(".schedule-date")).toContainText("OCT 7");
});
