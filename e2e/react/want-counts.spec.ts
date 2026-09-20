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
  // ⚠ 徽章措辞从「想看 2」改成「2 人想看」(2026-09-20,PLAN-20260920203010):
  //   按钮也叫「想看」之后,「想看 2」会被读成「点这里会变成 2」—— 而它其实是**别人**的人数。
  await expect(card.locator(".want-count")).toContainText("2 人想看");
  await ready(page, `/library/films/${encodeURIComponent(filmKey)}`);
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("[data-want-count]")).toHaveAttribute("data-want-count", "2");
  await expect(dialog.locator(".want-count")).toContainText("2 人想看");
});
