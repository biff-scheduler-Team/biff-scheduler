import { expect, test } from "@playwright/test";
import { catalog, ready } from "./helpers";
import type { GuestResult } from "@biff/contracts/guest";

const screening = catalog.byCode.get("222")!;
const fixture: GuestResult = {
  date: screening.date, availableDates: [screening.date], dateOpen: true, checkedAt: "2026-10-09T01:00:00Z",
  screenings: [
    { code: screening.code, filmId: "3000001823", title: screening.title_en, date: screening.date, time: screening.start_time.slice(0, 5), venue: "Cinema", hall: "3", remaining: 3, status: "available" },
    { code: "999", filmId: "999", title: "官方未知库存场次", date: screening.date, time: "18:00", venue: "Cinema", hall: "1", remaining: null, status: "unknown" },
  ],
};

test("GUEST 复用影片资料，支持筛选且刷新失败不保留旧库存", async ({ page }) => {
  let failed = false;
  await page.route("**/api/guest**", (route) => route.fulfill({ status: failed ? 502 : 200, json: failed ? { error: "GUEST_UPSTREAM_FAILED" } : fixture }));
  await ready(page, "/guest");
  await expect(page.getByRole("heading", { name: "GUEST 查票", exact: true })).toBeVisible();
  await expect(page.locator("[data-guest-code]")).toHaveCount(2);
  await expect(page.locator("[data-guest-code='222'] .screening-card")).toBeVisible();
  await page.getByRole("button", { name: "场次 222 影片资料", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Spectrum 的原生 input 被视觉控件覆盖，点击实际可见的 label。
  await page.locator("label", { hasText: "只看有票" }).click();
  await expect(page.getByRole("checkbox", { name: "只看有票" })).toBeChecked();
  await expect(page.locator("[data-guest-code]")).toHaveCount(1);
  await page.getByRole("searchbox", { name: "片名、场次编号或影片 ID" }).fill("没有这部电影");
  await expect(page.locator("[data-guest-code]")).toHaveCount(0);
  await page.getByRole("searchbox", { name: "片名、场次编号或影片 ID" }).fill("222");
  await expect(page.locator("[data-guest-code]")).toHaveCount(1);
  failed = true;
  await page.getByRole("button", { name: "刷新余票" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "GUEST 查询失败" })).toBeVisible();
  await expect(page.locator("[data-guest-code]")).toHaveCount(0);
  failed = false;
  await page.getByRole("button", { name: "刷新余票" }).click();
  await expect(page.locator("[data-guest-code]")).toHaveCount(1);
});

test("GUEST 未开放日期显示未知，不显示售罄", async ({ page }) => {
  await page.route("**/api/guest**", (route) => route.fulfill({ json: { ...fixture, dateOpen: false, screenings: [] } }));
  await ready(page, "/guest");
  await expect(page.getByText("该日期 GUEST 尚未开放查询，余量未知。", { exact: true })).toBeVisible();
  await expect(page.locator("[data-guest-code]")).toHaveCount(0);
});
