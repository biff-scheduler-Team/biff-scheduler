import { test, expect } from "@playwright/test";
import { keyOf, ready, seed, storage } from "./helpers";

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
  await ready(page, "/agenda?date=2026-10-07");
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

test("zoom preserves the time in the center of the viewport", async ({
  page,
}) => {
  await ready(page, "/schedule?date=2026-10-07");
  const grid = page.getByLabel("排片时间表", { exact: true });
  await grid.evaluate((el) => {
    el.scrollLeft = 600;
  });
  const before = await grid.evaluate(
    (el) => (el.scrollLeft + el.clientWidth / 2 - 148) / 3,
  );
  await page.getByRole("button", { name: "缩小排片表", exact: true }).click();
  const after = await grid.evaluate(
    (el) => (el.scrollLeft + el.clientWidth / 2 - 148 * 0.9) / (3 * 0.9),
  );
  expect(Math.abs(after - before)).toBeLessThan(1);
});
