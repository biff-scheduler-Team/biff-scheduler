import { expect, test } from "@playwright/test";
import { catalog, keyOf, ready } from "./helpers";
import type { GuestResult } from "@biff/contracts/guest";

const screening = catalog.byCode.get("222")!;
const fixture: GuestResult = {
  date: screening.date, availableDates: [screening.date], dateOpen: true, checkedAt: "2026-10-09T01:00:00Z",
  screenings: [
    { code: screening.code, filmId: "3000001823", title: screening.title_en, date: screening.date, time: screening.start_time.slice(0, 5), venue: "Cinema", hall: "3", remaining: 3, status: "available" },
    { code: "999", filmId: "999", title: "官方未知库存场次", date: screening.date, time: "18:00", venue: "Cinema", hall: "1", remaining: null, status: "unknown" },
  ],
};

for (const [channel, label] of [["guest", "GUEST"], ["general", "普通票"]] as const) {
test(`${label} 复用影片资料与想看人数，支持筛选且刷新失败不保留旧库存`, async ({ page }) => {
  let failed = false;
  await page.route(`**/api/${channel}**`, (route) => route.fulfill({ status: failed ? 502 : 200, json: failed ? { error: "UPSTREAM_FAILED" } : fixture }));
  await page.route("**/api/stats/want-counts**", (route) => route.fulfill({ json: { counts: { [keyOf("222")]: 12 } } }));
  await ready(page, `/${channel}`);
  const rows = page.locator(`[data-${channel}-code]`);
  const matched = page.locator(`[data-${channel}-code='222']`);
  await expect(page.getByRole("heading", { name: `${label} 查票`, exact: true })).toBeVisible();
  await expect(rows).toHaveCount(2);
  await expect(matched.locator(".screening-card")).toBeVisible();
  await expect(matched.locator(".guest-stock")).toContainText(`${label} 3 张`);
  await expect(matched.locator("[data-want-count='12']")).toHaveText("12 人想看");
  await expect(page.locator(`[data-${channel}-code='999']`)).toContainText("想看人数未知");
  await page.getByRole("button", { name: "场次 222 影片资料", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Spectrum 的原生 input 被视觉控件覆盖，点击实际可见的 label。
  await page.locator("label", { hasText: "只看有票" }).click();
  await expect(page.getByRole("checkbox", { name: "只看有票" })).toBeChecked();
  await expect(rows).toHaveCount(1);
  await page.getByRole("searchbox", { name: "片名、场次编号或影片 ID" }).fill("没有这部电影");
  await expect(rows).toHaveCount(0);
  await page.getByRole("searchbox", { name: "片名、场次编号或影片 ID" }).fill("222");
  await expect(rows).toHaveCount(1);
  failed = true;
  await page.getByRole("button", { name: "刷新余票" }).click();
  await expect(page.getByRole("alert").filter({ hasText: `${label} 查询失败` })).toBeVisible();
  await expect(rows).toHaveCount(0);
  failed = false;
  await page.getByRole("button", { name: "刷新余票" }).click();
  await expect(rows).toHaveCount(1);
});

test(`${label} 未开放日期显示未知，不显示售罄`, async ({ page }) => {
  await page.route(`**/api/${channel}**`, (route) => route.fulfill({ json: { ...fixture, dateOpen: false, screenings: [] } }));
  await ready(page, `/${channel}`);
  await expect(page.getByText(`该日期 ${label} 尚未开放查询，余量未知。`, { exact: true })).toBeVisible();
  await expect(page.locator(`[data-${channel}-code]`)).toHaveCount(0);
});
}

test("切换查票渠道不混用库存，零想看人数可显示", async ({ page }) => {
  await page.route("**/api/general**", (route) => route.fulfill({ json: fixture }));
  await page.route("**/api/guest**", (route) => route.fulfill({ json: { ...fixture, screenings: [{ ...fixture.screenings[0], remaining: 27 }] } }));
  await page.route("**/api/stats/want-counts**", (route) => route.fulfill({ json: { counts: {} } }));
  await ready(page, "/general");
  await expect(page.locator("[data-general-code='222'] [data-want-count='0']")).toHaveText("0 人想看");
  await page.getByRole("navigation", { name: "查票渠道" }).getByRole("link", { name: "GUEST 查票" }).click();
  await expect(page.locator("[data-guest-code='222'] .guest-stock")).toContainText("GUEST 27 张");
  await expect(page.locator("[data-general-code]")).toHaveCount(0);
});

test("想看统计失败不伪装成零，也不阻断普通票查询", async ({ page }) => {
  await page.route("**/api/general**", (route) => route.fulfill({ json: fixture }));
  await page.route("**/api/stats/want-counts**", (route) => route.fulfill({ status: 502, json: {} }));
  await ready(page, "/general");
  await expect(page.locator("[data-general-code='222'] .guest-stock")).toContainText("普通票 3 张");
  await expect(page.locator("[data-general-code='222'] .want-count")).toHaveText("想看人数未知");
  await expect(page.locator("[data-want-count]")).toHaveCount(0);
});

test("最新快照显示保存时间，后台提示存在而页面没有历史入口", async ({ page }) => {
  await page.clock.install();
  const urls: string[] = [];
  await page.route("**/api/general**", (route) => {
    urls.push(route.request().url());
    return route.fulfill({ json: { ...fixture, checkedAt: new Date().toISOString(), snapshot: {
      id: "snapshot-fixture", capturedAt: new Date().toISOString(), source: "scheduled", status: "ok",
    } } });
  });
  await ready(page, "/general");
  await expect(page.getByText(/已保存 · 后台定时采集/)).toBeVisible();
  await expect(page.getByText(/后台每 5 分钟采集并保存快照/)).toBeVisible();
  await expect(page.getByRole("button", { name: /历史/ })).toHaveCount(0);
  expect(new URL(urls[0]).searchParams.has("refresh")).toBe(false);
  await page.getByRole("button", { name: "刷新余票" }).click();
  await expect.poll(() => urls.some(url => new URL(url).searchParams.get("refresh") === "1")).toBe(true);
  await page.clock.fastForward(60_000);
  await expect.poll(() => urls.length).toBeGreaterThan(2);
  expect(new URL(urls.at(-1)!).searchParams.has("refresh")).toBe(false);
});

test("GUEST 只有韩国当天和次日快捷日期", async ({ page }) => {
  await page.route("**/api/guest**", (route) => route.fulfill({ json: fixture }));
  await ready(page, "/guest");
  const shortcuts = page.locator('.guest-dates button');
  await expect(shortcuts).toHaveCount(2);
  const input = page.locator('input[type="date"]');
  const minimum = await input.getAttribute("min");
  const maximum = await input.getAttribute("max");
  expect(minimum).toBeTruthy();
  expect(maximum).toBeTruthy();
  expect(Date.parse(maximum!) - Date.parse(minimum!)).toBe(86_400_000);
  await expect(shortcuts.first()).toHaveText(minimum!);
  await expect(shortcuts.last()).toHaveText(maximum!);
});
