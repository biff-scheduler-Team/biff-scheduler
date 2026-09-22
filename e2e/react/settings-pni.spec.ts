// P&I(Press & Industry)记者 / 业界场的显示开关(2026-09-16,`PLAN-20260916182254`)。
//
// 为什么单开一条 E2E:这个开关的作用面是**整站** —— 排片表 / 片单 / 行程 / 冲突 / 导出
// 读的都是同一份 catalog(`app/store.tsx::derive()` 的入口合并)。而「勾了没反应」与
// 「没勾就混进来」都只有跑起来才看得见。断言一律走 DOM(`data-badge` / 计数),不靠截图。
import { expect, test, type Page } from "@playwright/test";
import { ready } from "./helpers";

/** P&I 徽章 —— `ScreeningCard.tsx::Badges` 把每个特性渲染成 `[data-badge="<key>"]`。 */
const pniBadges = (page: Page) => page.locator('[data-badge="pni"]');

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** 勾 / 取消勾「显示 P&I 场次」并保存。
 *  ⚠ 复选的可点区是外层 `<label>`(input 被视觉层盖住,裸点会被拦指针)——
 *    与 `share-export.spec.ts` 等既有写法一致。 */
async function togglePni(page: Page) {
  const dialog = await openSettings(page);
  await dialog.locator("label", { hasText: "显示 P&I 场次" }).click();
  await dialog.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "设置" })).toHaveCount(0);
}

test.describe("P&I 场次的显示开关", () => {
  test("默认不显示:排片表里没有任何 P&I 徽章", async ({ page }) => {
    await ready(page, "/schedule?date=2026-10-07");
    await expect(pniBadges(page)).toHaveCount(0);
  });

  test("勾选后与普通场次一起出现,取消后完全消失", async ({ page }) => {
    // 2026-10-07 册子 BD(Indieplus)/ CGV 7 两列共 6 场 —— 见 public/pni.json
    await ready(page, "/schedule?date=2026-10-07");
    await expect(pniBadges(page)).toHaveCount(0);

    await togglePni(page);
    await expect(pniBadges(page).first()).toBeVisible();
    expect(await pniBadges(page).count()).toBeGreaterThan(0);

    // 设置要落盘(`biff.settings.v1`)—— 否则刷新就丢,开关形同虚设
    const raw = await page.evaluate(() => localStorage.getItem("biff.settings.v1"));
    expect((JSON.parse(raw ?? "{}") as { showPni?: boolean }).showPni).toBe(true);

    // 取消勾选 → 场次必须**完全**消失(不是只把徽章藏起来)
    await togglePni(page);
    await expect(pniBadges(page)).toHaveCount(0);
  });

  test("勾选会同时带出 P&I 的两个厅(BD / CGV 7)的泳道", async ({ page }) => {
    await ready(page, "/schedule?date=2026-10-07");
    await expect(page.getByText("BCC Indieplus", { exact: true })).toHaveCount(0);

    await togglePni(page);
    await expect(page.getByText("BCC Indieplus", { exact: true }).first()).toBeVisible();
  });
});
