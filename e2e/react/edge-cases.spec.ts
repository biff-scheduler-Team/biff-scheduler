import { test, expect } from "@playwright/test";
import { keyOf, ready, seed, storage } from "./helpers";

test("failed catalog requests show a recovery page and can be retried", async ({
  page,
}) => {
  await page.route("**/schedule.json", (route) =>
    route.fulfill({ status: 503, body: "Unavailable" }),
  );
  await page.goto("/library/films/cat%3Af001");
  await expect(
    page.getByRole("heading", { name: "排期加载失败", exact: true }),
  ).toBeVisible();
  await page.unroute("**/schedule.json");
  await page.getByRole("link", { name: "重新加载", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "主要导航" }),
  ).toBeVisible();
});

test("unknown film URLs have a usable return action", async ({ page }) => {
  await ready(page, "/library/films/cat%3Aunknown");
  await expect(
    page.getByRole("dialog", { name: "找不到这部影片", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(page).toHaveURL(/\/library$/);
});

/* 「顺位修改入口只在卡片视图」整条已删除(2026-09-30,`PLAN-20260930213528`)。
 * 它的两半现在都没有宿主:①「预览顺位修复」按钮早在 2026-09-22 随 `RankClashes` 下线;
 * ② 顺位卡(拖拽 / 上移 / 下移 → `biff.ranks.v1`)随卡片视图一起整体删除 ——
 * 抢票顺位这套机制已经不存在,不再是「只有卡片视图能改」的问题。 */

test("screening location reveals the correct day and target", async ({
  page,
}) => {
  await seed(page, {
    "biff.picks.v2": JSON.stringify([
      { key: keyOf("008"), picks: [{ code: "008" }], note: "" },
    ]),
  });
  // 「定位场次」入口现在只挂在「我的选片」的场次卡上(行程卡片已于 2026-09-21 摘掉,
  // 见 PLAN-20260921223658 修订 1)——场次卡要先展开那部片才渲染
  await ready(page, `/picks?expand=${encodeURIComponent(keyOf("008"))}`);
  await page.getByRole("button", { name: "定位场次 008", exact: true }).click();
  await expect(page).toHaveURL(
    /\/schedule\?.*date=2026-10-07.*focus=008/,
  );
  await expect(page.locator('[data-grid-code="008"]')).toBeVisible();
  await expect(page.locator('[data-grid-code="008"]')).toBeFocused();
});

test("film details retain the legacy informational role", async ({ page }) => {
  await ready(page, "/library/films/cat%3Af001");
  const detail = page.getByRole("dialog", { name: "彼此的日夜", exact: true });
  await expect(detail).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(detail.locator("[data-screening]")).toHaveCount(0);
  await expect(
    detail.getByRole("button", { name: /加入.*场次|调整.*映后/ }),
  ).toHaveCount(0);
  await detail.getByRole("button", { name: "返回", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
