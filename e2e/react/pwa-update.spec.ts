import { test, expect } from "@playwright/test";

// 发版提示条(2026-09-22,PLAN-20260922100704)。
//
// e2e 里真「发一版新 SW」做不到(要两次构建 + 两个 server),所以这里验的是**接线**:
// 在「加载时已被 SW 控制」的前提下,一次 controllerchange 就该被当成新版接管。
// 判定逻辑本身 —— 含「首次安装的 claim 不算新版」这道防误报前提 ——
// 由 `apps/web/tests/pwa-update.test.ts` 覆盖。

/** 本仓库默认工程是 `serviceWorkers: "block"`,需要 SW 的用例得自己开一个 context。 */
async function withServiceWorker(browser: import("@playwright/test").Browser) {
  const context = await browser.newContext({ serviceWorkers: "allow" });
  const page = await context.newPage();
  await page.goto("/schedule");
  await expect(page.getByRole("navigation", { name: "主要导航" })).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  return { context, page };
}

test("新版接管本页后顶部出提示条,点「刷新」会重新加载", async ({ browser }) => {
  const { context, page } = await withServiceWorker(browser);
  try {
    const banner = page.locator(".update-banner");
    await expect(banner).toHaveCount(0);

    // 本页已被 SW 控制 → 这一次 controllerchange 只能是「换了一版」
    await page.evaluate(() => {
      navigator.serviceWorker.dispatchEvent(new Event("controllerchange"));
    });

    await expect(banner).toBeVisible();
    await expect(banner).toContainText("有新版本");

    // 「刷新」必须真的重新加载:在 <html> 上留个标记,reload 之后它会消失
    await page.evaluate(() => {
      document.documentElement.dataset.reloadMarker = "1";
    });
    await banner.getByRole("button", { name: "刷新", exact: true }).click();
    await page.waitForFunction(() => !document.documentElement.dataset.reloadMarker);
    await expect(page.getByRole("navigation", { name: "主要导航" })).toBeVisible();
    await expect(page.locator(".update-banner")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("点「稍后」只收起提示条,不重新加载", async ({ browser }) => {
  const { context, page } = await withServiceWorker(browser);
  try {
    const banner = page.locator(".update-banner");
    await page.evaluate(() => {
      navigator.serviceWorker.dispatchEvent(new Event("controllerchange"));
    });
    await expect(banner).toBeVisible();

    await page.evaluate(() => {
      document.documentElement.dataset.reloadMarker = "1";
    });
    await banner.getByRole("button", { name: "稍后", exact: true }).click();

    await expect(banner).toHaveCount(0);
    // 标记还在 = 没有发生导航
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.reloadMarker))
      .toBe("1");
  } finally {
    await context.close();
  }
});

test("没有被 SW 接管时,同样的 controllerchange 不出提示(首次安装的 claim 不算新版)", async ({
  page,
}) => {
  // 默认工程 `serviceWorkers: "block"` → 本页不该被 SW 接管;这是本用例的前提,先钉死它
  await page.goto("/schedule");
  await expect(page.getByRole("navigation", { name: "主要导航" })).toBeVisible();
  await page.evaluate(() => {
    if (navigator.serviceWorker.controller) throw new Error("本用例要求页面未被 SW 接管");
    navigator.serviceWorker.dispatchEvent(new Event("controllerchange"));
  });

  await expect(page.locator(".update-banner")).toHaveCount(0);
});
