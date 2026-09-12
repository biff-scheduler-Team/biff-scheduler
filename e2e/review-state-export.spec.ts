import { test, expect, type Page } from "@playwright/test";
import { keyOf, legacyRead, openExport, ready, seed, storage } from "./helpers";

test("restored stale ranks do not become the first choice of a later ICS import", async ({ page }) => {
  const staleRanks = '{"008":2,"033":1}';
  await seed(page, {
    "biff.picks.v2": "[]",
    "biff.ranks.v1": staleRanks,
    "biff.future.v9": '{ "preserved": true }',
  });
  await ready(page, "/agenda");
  expect(JSON.parse((await storage(page))["biff.ranks.v1"])).toEqual({});
  const dialog = await openExport(page);
  await dialog.getByRole("textbox", { name: "或粘贴备份内容", exact: true }).fill([
    "BEGIN:VCALENDAR", "UID:033@biff-2026", "UID:008@biff-2026", "END:VCALENDAR",
  ].join("\n"));
  await dialog.getByRole("button", { name: "合并到当前行程", exact: true }).click();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator("[data-rank-code]").first()).toHaveAttribute("data-rank-code", "008");
  await page.getByRole("button", { name: "保存当前方案", exact: true }).click();
  expect(JSON.parse((await storage(page))["biff.savedplans.v1"])[0].codes).toEqual(["008"]);
  expect((await storage(page))["biff.future.v9"]).toBe('{ "preserved": true }');

  // Exercise the old implementation against the original input, not already-pruned new data.
  await page.evaluate((ranks) => {
    localStorage.setItem("biff.picks.v2", "[]");
    localStorage.setItem("biff.ranks.v1", ranks);
  }, staleRanks);
  expect((await legacyRead(page)).ranks).toEqual({});
});

test("reopening ticket information after the opening time refreshes its status", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-21T04:59:50Z") });
  await ready(page);
  await page.getByRole("button", { name: /距第 2 批开票/ }).click();
  const dialog = page.getByRole("dialog", { name: "购票信息", exact: true });
  await expect(dialog.locator(".ticket-batch").last()).toContainText("还有");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.clock.fastForward(20_000);
  await page.getByRole("button", { name: /BIFF 2026 售票中/ }).click();
  await expect(dialog.locator(".ticket-batch").last()).toContainText("已开票");
  await expect(dialog.locator(".ticket-batch").last()).not.toContainText("还有");
});

type ImageTestWindow = Window & { __reviewBlobJobs: (() => void)[] };

async function holdPosterBlobs(page: Page) {
  await page.addInitScript(() => {
    const state = window as ImageTestWindow;
    state.__reviewBlobJobs = [];
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      toBlob.call(this, (blob) => {
        state.__reviewBlobJobs.push(() => callback(blob));
      }, ...args);
    };
  });
}

async function waitForBlobJobs(page: Page, count: number) {
  await expect.poll(() => page.evaluate(
    () => (window as ImageTestWindow).__reviewBlobJobs.length,
  )).toBe(count);
}

async function releaseBlob(page: Page) {
  await page.evaluate(() => (window as ImageTestWindow).__reviewBlobJobs.shift()!());
}

for (const removeAll of [false, true]) {
  test(`deleting ${removeAll ? "all plans" : "the selected plan"} in another tab cancels only its image task`, async ({ page, context }) => {
    await holdPosterBlobs(page);
    await seed(page, {
      "biff.picks.v2": JSON.stringify([
        { key: keyOf("033"), picks: [{ code: "033" }], note: "" },
      ]),
      "biff.savedplans.v1": JSON.stringify([
        ...(!removeAll ? [{ id: "remaining", name: "方案 1", codes: ["033"], createdAt: 1 }] : []),
        { id: "deleted", name: "方案 2", codes: ["001"], createdAt: 2 },
      ]),
    });
    await ready(page, "/agenda");
    const dialog = await openExport(page);
    const generate = dialog.locator("button").filter({ hasText: "生成分享图片" });
    await generate.click();
    await waitForBlobJobs(page, 1);
    await expect(generate).toBeDisabled();

    const other = await context.newPage();
    try {
      await ready(other, "/agenda");
      await other.getByRole("button", { name: "删除方案 2", exact: true }).click();
      if (removeAll) {
        await expect(dialog.getByRole("heading", { name: "先保存一个方案", exact: true })).toBeVisible();
        await expect(dialog.locator("[data-pending]" )).toHaveCount(0);
        await other.getByRole("button", { name: "保存当前方案", exact: true }).click();
      }
      await expect(dialog.getByRole("button", { name: /导出方案/ })).toContainText("方案 1");
      await expect(generate).toBeEnabled();
      await expect(dialog.getByRole("button", { name: "下载 PNG 图片", exact: true })).toHaveCount(0);

      await generate.click();
      await waitForBlobJobs(page, 2);
      // Resolve the canceled task while the replacement is still awaiting its Blob.
      await releaseBlob(page);
      await expect(generate).toBeDisabled();
      await expect(dialog.getByRole("button", { name: "下载 PNG 图片", exact: true })).toHaveCount(0);
      await releaseBlob(page);
      const canvas = dialog.getByLabel("行程分享图片", { exact: true });
      await expect(canvas).toBeVisible();
      await expect(canvas).toHaveAttribute("data-plan-codes", "033");
      await expect(generate).toBeEnabled();
      await expect(dialog.getByRole("button", { name: "下载 PNG 图片", exact: true })).toBeEnabled();
    } finally {
      await other.close();
    }
  });
}
