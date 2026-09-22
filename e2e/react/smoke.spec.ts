import { test, expect } from "@playwright/test";
import { headerAction, ready, scheduleHeading } from "./helpers";

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
  await headerAction(page, "设置");
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(dialog).toBeVisible();
  // ⚠ 「取消」必须**收进弹层**再点:S2 的菜单浮层自带一个 1×1 裁剪的隐藏按钮也叫「取消」
  //   (`aria-label="取消"`),顶层入口改走「更多」菜单后(2026-09-22,`PLAN-20260922105228`)
  //   全页查询会同时命中它 → 严格模式报「匹配到 3 个」。断言本来就只关心弹层里那一个。
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(errors).toEqual([]);
});
