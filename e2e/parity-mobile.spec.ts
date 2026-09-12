import { expect, test } from "@playwright/test";
import { keyOf, ready, seed } from "./helpers";
const picks = (codes: string[]) =>
  JSON.stringify(
    codes.map((code) => ({ key: keyOf(code), picks: [{ code }], note: "" })),
  );

test("single-pane locating returns to the timeline and supports whole-card selection", async ({
  page,
}) => {
  await seed(page, { "biff.picks.v2": picks(["001"]) });
  await ready(page, "/agenda");
  await page.getByRole("button", { name: "定位场次 001", exact: true }).click();
  await expect(page.locator('[data-timeline-code="001"]')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/schedule");
  await page.locator('[data-timeline-code="001"] h3').click();
  await expect(
    page.getByRole("button", { name: "加入场次 001", exact: true }),
  ).toBeVisible();
});
