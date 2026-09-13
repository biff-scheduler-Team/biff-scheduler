import { test, expect } from "@playwright/test";

test("the installed PWA reopens a nested route offline with its saved selections", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ serviceWorkers: "allow" });
  const page = await context.newPage();
  try {
    await page.goto(`${baseURL}/agenda`);
    await expect(
      page.getByRole("heading", { name: "我的行程", exact: true }),
    ).toBeVisible();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() =>
      Boolean(navigator.serviceWorker.controller),
    );
    await page.evaluate(() =>
      localStorage.setItem(
        "biff.picks.v2",
        JSON.stringify([
          { key: "cat:f001", picks: [{ code: "001" }], note: "offline note" },
        ]),
      ),
    );
    await context.setOffline(true);
    await page.goto(`${baseURL}/picks?expand=cat%3Af001`);
    await expect(
      page.getByRole("heading", { name: "我的选片", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "彼此的日夜 备注", exact: true }),
    ).toHaveValue("offline note");
  } finally {
    await context.close();
  }
});

test("legacy and rewrite remain switchable offline on the same origin", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ serviceWorkers: "allow" });
  const page = await context.newPage();
  try {
    await page.goto(`${baseURL}/schedule`);
    await expect(
      page.getByRole("navigation", { name: "主要导航" }),
    ).toBeVisible();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() =>
      Boolean(navigator.serviceWorker.controller),
    );
    await context.setOffline(true);
    await page.goto(`${baseURL}/legacy`);
    await expect(page.locator("#topbar")).toBeVisible();
    await expect(page.locator("#grid-scroll")).toBeVisible();
    await page.getByRole("link", { name: "体验新版", exact: true }).click();
    await expect(
      page.getByRole("navigation", { name: "主要导航" }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
