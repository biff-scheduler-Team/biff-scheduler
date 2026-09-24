import { test, expect } from "@playwright/test";
import { agendaCards, keyOf, ready, seed, storage } from "./helpers";

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

// ⚠ 本条原先测的是「预览顺位修复」弹层（点「预览顺位修复」→ 弹层里预览 + 「应用修复」）。
//   那一整块（冲突组顺位提示 + 逐组让路按钮 + `autoFixRanks` 的 UI 出口）已于 2026-09-22 删除
//   （`PLAN-20260922123138`，用户口径「我的行程**不需要显示**冲突组顺位这个组件 直接铺满」），
//   于是这条断言在 main 上一直卡在「按钮找不到 → click 超时」—— 报出来像功能坏了，其实是测试在点一个不存在的入口。
//   顺位机制**本身没动**（`biff.ranks.v1` / `plans.ts` / `setRanks` 全部保留），入口只剩
//   **卡片视图**里顺位卡的拖拽 / 上移 / 下移，故这里对齐现状：钉住「日程表没有这个入口」
//   + 「卡片视图里顺位仍能就地改」。
test("顺位修改入口只在卡片视图:日程表上没有已下线的「预览顺位修复」", async ({ page }) => {
  await seed(page, {
    "biff.picks.v2": JSON.stringify(
      ["008", "033"].map((code) => ({
        key: keyOf(code),
        picks: [{ code }],
        note: "",
      })),
    ),
    "biff.ranks.v1": JSON.stringify({ "008": 1, "033": 2 }),
  });
  await ready(page, "/agenda");
  // ① 日程表（默认视图）里不该再有这个入口
  await expect(
    page.getByRole("button", { name: "预览顺位修复", exact: true }),
  ).toHaveCount(0);

  // ② 卡片视图里顺位还在,且能就地改（提高 033 → 它成为第 1 顺位）
  await agendaCards(page);
  const group = page.locator(".rank-group").first();
  await expect(group).toBeVisible();
  await group
    .getByRole("button", { name: "提高 033 顺位", exact: true })
    .click();
  expect(JSON.parse((await storage(page))["biff.ranks.v1"])).toEqual({
    "033": 1,
    "008": 2,
  });
});

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
