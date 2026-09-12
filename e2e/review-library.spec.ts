import { expect, test } from "@playwright/test";
import { catalog, ready } from "./helpers";

test("screening detail links retain the exact show through refresh", async ({ page }) => {
  await ready(page, "/library?q=Mother%20Mary");
  const library = page.getByRole("region", { name: "影片库", exact: true });
  await library.getByRole("button", { name: "场次 256 影片资料", exact: true }).click();
  await expect(page).toHaveURL(/filmCode=256/);
  const detail = page.getByRole("dialog", { name: "圣母玛利亚", exact: true });
  await expect(detail).toBeVisible();
  await expect(detail).not.toContainText("Special Talk");
  await page.reload();
  await expect(detail).toBeVisible();
  await expect(detail).not.toContainText("Special Talk");
  await expect(detail).toContainText("마더 메리");
  await detail.getByRole("button", { name: "返回", exact: true }).click();
  await expect(page).not.toHaveURL(/\/films\//);
  await library.getByRole("button", { name: "场次 021 影片资料", exact: true }).click();
  await expect(page).toHaveURL(/filmCode=021/);
  await expect(detail).toContainText("Special Talk");
  await expect(detail).toContainText("October 7 (Wed) After the 19:00 Screening");
});

test("library details use their first show and preserve original and Korean titles", async ({ page }) => {
  await ready(page, "/library?q=雾中的大象&filmCode=338");
  await page.getByRole("button", { name: "雾中的大象 影片资料", exact: true }).click();
  await expect(page).not.toHaveURL(/filmCode=/);
  await expect(page.getByRole("dialog", { name: "雾中的大象", exact: true })).not.toContainText("Special Talk");
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(page).not.toHaveURL(/\/films\//);
  await page.getByRole("searchbox", { name: "搜索影片" }).fill("Look Back");
  await page.getByRole("button", { name: "蓦然回首 影片资料", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "蓦然回首", exact: true });
  await expect(detail).toContainText("ルックバック / 룩백");
});

test("related films open their own screening instead of inheriting the previous code", async ({ page }) => {
  await page.route("**/douban-related.json", (route) => route.fulfill({ json: {
    recs: { "36323221": [
      { id: "37269723", title: "蓦然回首", year: "2026", url: "https://movie.douban.com/subject/37269723/" },
    ] },
  } }));
  await page.goto("/library/films/cat%3Af019?filmCode=256");
  await expect(page.getByRole("dialog", { name: "圣母玛利亚", exact: true })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "蓦然回首，2026", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "蓦然回首", exact: true })).toBeVisible();
  const code = new URL(page.url()).searchParams.get("filmCode");
  expect(catalog.byCode.get(code ?? "")?.title_en).toBe("Look Back");
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(page).toHaveURL(/filmCode=256/);
  await expect(page.getByRole("dialog", { name: "圣母玛利亚", exact: true })).not.toContainText("Special Talk");
});

for (const height of [650, 450]) test(`returning from a related film restores reading at ${height}px height`, async ({ page }) => {
  await page.setViewportSize({ width: page.viewportSize()!.width, height });
  await page.goto("/library/films/cat%3Af001?filmCode=001");
  const detail = page.getByRole("dialog", { name: "彼此的日夜", exact: true });
  await expect(detail).toBeVisible();
  const related = detail.getByRole("button", { name: "终极面试，2026", exact: true });
  await related.scrollIntoViewIfNeeded();
  await related.focus();
  const readingPosition = () => detail.locator(".film-detail").evaluate((node) => ({
    content: node.parentElement!.scrollTop,
    dialog: node.closest<HTMLElement>('[role="dialog"]')!.scrollTop,
  }));
  const before = await readingPosition();
  expect(before.content + before.dialog).toBeGreaterThan(0);
  await related.click();
  await expect(page.getByRole("dialog", { name: "终极面试", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(detail).toBeVisible();
  await expect.poll(readingPosition).toEqual(before);
  await expect(related).toBeInViewport();
});
