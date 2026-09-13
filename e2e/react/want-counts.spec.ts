import { test, expect } from "@playwright/test";
import { keyOf, ready } from "./helpers";

test("library cards and film dialog show rounded want counts from the API", async ({ page }) => {
  const filmKey = keyOf("008");
  await page.route("**/api/stats/want-counts**", (route) =>
    route.fulfill({
      json: { edition: "biff-2026", counts: { [filmKey]: 2 } },
    }),
  );
  await ready(page, "/library");
  const card = page.locator(`.film-card[data-film-key="${filmKey}"]`);
  await expect(card.locator("[data-want-count]")).toHaveAttribute("data-want-count", "2");
  await expect(card.locator(".want-count")).toContainText("想看");
  await ready(page, `/library/films/${encodeURIComponent(filmKey)}`);
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("[data-want-count]")).toHaveAttribute("data-want-count", "2");
  await expect(dialog.locator(".want-count")).toContainText("想看");
});
