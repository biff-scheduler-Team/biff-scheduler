import { test, expect } from "@playwright/test";
import { hourTickPx, keyOf, ready, seed, storage } from "./helpers";

test("hover links a conflict group across the agenda and grid; dragging persists its order", async ({
  page,
}) => {
  await seed(page, {
    "biff.picks.v2": JSON.stringify(
      ["008", "033"].map((code) => ({
        key: keyOf(code),
        picks: [{ code }],
        note: "",
      })),
    ),
  });
  await ready(page, "/agenda?date=2026-10-07&quick=1");
  const first = page
    .getByRole("region", { name: "我的行程", exact: true })
    .locator('[data-screening="008"]');
  await first.hover();
  await expect(
    page
      .locator(".gantt-slot")
      .filter({ has: page.locator('[data-grid-code="008"]') }),
  ).toHaveAttribute("data-highlighted", "true");
  await expect(
    page
      .locator(".gantt-slot")
      .filter({ has: page.locator('[data-grid-code="033"]') }),
  ).toHaveAttribute("data-highlighted", "true");
  await page
    .getByRole("button", { name: "拖动场次 033 排序", exact: true })
    .dragTo(page.locator('[data-rank-code="008"]'), {
      targetPosition: { x: 20, y: 4 },
    });
  expect(JSON.parse((await storage(page))["biff.ranks.v1"])).toEqual({
    "033": 1,
    "008": 2,
  });
});

test("time grows downward and screenings at the same time align across venues", async ({ page }) => {
  await ready(page, "/schedule?date=2026-10-07");
  const nine = await page.getByRole("button", {name: "筛选 09:00 时段", exact: true}).boundingBox();
  const ten = await page.getByRole("button", {name: "筛选 10:00 时段", exact: true}).boundingBox();
  expect(ten!.y - nine!.y).toBeCloseTo(hourTickPx(), 0);
  expect(ten!.x).toEqual(nine!.x);
  const film = await page.locator('[data-grid-code="008"]').boundingBox();
  // 正片 135′ × 4px/min × 默认 zoom − 卡片内边距
  expect(film!.height).toBeCloseTo(135 * 4 * 0.55 - 6, 0);
});

test("workspace stays within 1600px max-width on ultra-wide desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await ready(page, "/schedule?date=2026-10-07");
  const box = (await page.locator("#workspace").boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(1600);
  expect(box.x).toBeGreaterThan(0);
  expect(box.x + box.width).toBeLessThan(1920);
});

test("desktop viewing split is about one to three", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await ready(page, "/schedule?date=2026-10-07");
  await page.getByRole("button", { name: "打开我的观影", exact: true }).click();
  const panel = (await page.locator("#viewing-panel").boundingBox())!;
  const schedule = (await page.locator(".schedule-column").boundingBox())!;
  const total = panel.width + schedule.width;
  expect(panel.width / total).toBeGreaterThan(0.2);
  expect(panel.width / total).toBeLessThan(0.35);
  expect(schedule.width / total).toBeGreaterThan(0.65);
});
