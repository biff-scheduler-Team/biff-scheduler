import { test, expect } from "@playwright/test";
import { keyOf, openExport, ready, seed, storage } from "./helpers";

test("retired keys are purged on load, unknown keys survive, and ICS import still works", async ({
  page,
}) => {
  await seed(page, {
    "biff.picks.v2": "[]",
    "biff.ranks.v1": '{"008":2,"033":1}',
    "biff.agendafold.v1": '["2026-10-07"]',
    "biff.tickets.v1": '{"001":{"state":"got"}}',
    "biff.future.v9": '{ "preserved": true }',
  });
  await ready(page, "/agenda");
  // ★ 回归(2026-09-30,`PLAN-20260930213528`):抢票顺位 / 行程按日收起 / 票务三态这三套机制的
  //   代码已整体删除,残留键必须在载入时**清掉**。
  //   ⚠ 改版前这里的行为是「把陈旧顺位**剪成空对象**留在盘上」—— 那套「剪枝」随 `rebuildIndex`
  //   里那段 rankOf prune 一起没了,现在走的是 `state.ts::purgeRetiredKeys()`。
  const data = await storage(page);
  expect(data["biff.ranks.v1"]).toBeUndefined();
  expect(data["biff.agendafold.v1"]).toBeUndefined();
  expect(data["biff.tickets.v1"]).toBeUndefined();
  // ⚠ 清理是**白名单**式的:未知键原样保留(与旧版共存的数据契约)
  expect(data["biff.future.v9"]).toBe('{ "preserved": true }');

  // ICS 合并那条链没被牵连:导入后两场都画进行程
  const dialog = await openExport(page);
  await dialog
    .getByRole("textbox", { name: "或粘贴备份 / 日历 / 票务内容", exact: true })
    .fill(
      ["BEGIN:VCALENDAR", "UID:033@biff-2026", "UID:008@biff-2026", "END:VCALENDAR"].join("\n"),
    );
  await dialog.getByRole("button", { name: "合并到当前行程", exact: true }).click();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  const agenda = page.getByRole("region", { name: "我的行程", exact: true });
  await expect(agenda.locator('[data-grid-code="008"]')).toBeVisible();
  await expect(agenda.locator('[data-grid-code="033"]')).toBeVisible();
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

/** 行程播种:`biff.picks.v2` 每场一个 key(与行程页口径一致)。 */
const picks = (...codes: string[]) =>
  JSON.stringify(
    codes.map((code) => ({ key: keyOf(code), picks: [{ code }], note: "" })),
  );

// ⚠ 原用例是 `deleting {all plans / the selected plan} in another tab cancels only its image task`
//   (参数化两条):它用**跨标签页删方案**把在途出图作废。方案已于 2026-09-22 整体下线
//   (`PLAN-20260922105228`),驱动改成同一形状的**跨标签页改行程**。
//
//   它比 `parity-dialogs` 那条同主题用例多守一件事:**被作废那张图的 Blob 比替换图更早 resolve**
//   时也不能浮上来(下面两次 `releaseBlob` 的顺序就是这个交错)—— 这是出图那条链上最难复现的一段。
test("changing the itinerary in another tab cancels only its image task", async ({ page, context }) => {
  await holdPosterBlobs(page);
  await seed(page, { "biff.picks.v2": picks("033") });
  await ready(page, "/agenda");
  const dialog = await openExport(page);
  const generate = dialog.locator("button").filter({ hasText: "生成分享图片" });
  await generate.click();
  await waitForBlobJobs(page, 1);
  await expect(generate).toBeDisabled();

  const other = await context.newPage();
  try {
    await ready(other, "/agenda");
    await other.evaluate((next) => localStorage.setItem("biff.picks.v2", next), picks("001"));
    // 范围那行从 OCT 7(033) 变成 OCT 6(001) ⇒ 本页确认已重新水合,在途那张图随之作废
    await expect(dialog.getByText(/导出范围：当前行程（1 场，OCT 6）/)).toBeVisible();
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
    await expect(canvas).toHaveAttribute("data-export-codes", "001");
    await expect(generate).toBeEnabled();
    await expect(dialog.getByRole("button", { name: "下载 PNG 图片", exact: true })).toBeEnabled();
  } finally {
    await other.close();
  }
});
