import { test, expect } from "@playwright/test";
import { ready, scheduleHeading } from "./helpers";

test("loads the production app and renders a Spectrum dialog", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page);
  await expect(scheduleHeading(page)).toBeVisible();
  await page.getByRole("link", { name: "影片库", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "影片库", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-film-key]").first()).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "设置", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(errors).toEqual([]);
});
