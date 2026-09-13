import { test, expect } from "@playwright/test";
import { ready, seed, storage, openExport, keyOf } from "./helpers";

const settings = {
  alarmMin: 45,
  transitMin: 0,
  gvTalkOn: true,
  gvTalkMin: 25,
  theme: "light",
  zoom: 0.7,
  retained: "unknown-setting",
};
const plans = [
  { id: "one", name: "方案 1", codes: ["001"], createdAt: 1 },
  { id: "two", name: "方案 2", codes: ["033"], createdAt: 2 },
];
const pickerLabel = /导出方案/;

test("cancel discards settings drafts and reopening reads current preferences", async ({
  page,
  isMobile,
}) => {
  await seed(page, { "biff.settings.v1": JSON.stringify(settings) });
  await ready(page, "/schedule");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "设置", exact: true });
  let alarm = dialog.getByRole("textbox", {
    name: "日历提醒提前量（分钟）",
    exact: true,
  });
  await alarm.fill("90");
  await alarm.press("Tab");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  expect(JSON.parse((await storage(page))["biff.settings.v1"])).toEqual(
    settings,
  );
  if (!isMobile) {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const appearance = page.getByRole("dialog", { name: "设置", exact: true });
    await appearance.getByRole("button", { name: /外观/ }).click();
    await page.getByRole("option", { name: "暗色", exact: true }).click();
    await appearance.getByRole("button", { name: "保存设置", exact: true }).click();
    await page.getByRole("group", { name: "排片大小" }).getByRole("button", { name: "大", exact: true }).click();
  }
  await page.getByRole("button", { name: "设置", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "设置", exact: true });
  alarm = dialog.getByRole("textbox", {
    name: "日历提醒提前量（分钟）",
    exact: true,
  });
  await expect(alarm).toHaveValue("45");
  await dialog.getByRole("button", { name: "保存设置", exact: true }).click();
  expect(JSON.parse((await storage(page))["biff.settings.v1"])).toEqual({
    ...settings,
    ...(!isMobile ? { theme: "dark", zoom: 0.75 } : {}),
  });
});

test("restoring GV duration preserves attendance, and editing requires confirmation", async ({
  page,
}) => {
  await seed(page, {
    "biff.picks.v2": JSON.stringify([
      { key: keyOf("001"), picks: [{ code: "001" }], note: "GV" },
    ]),
    "biff.gvtalk.v1": '{"001":false}',
    "biff.gvtalkmin.v1": '{"001":40}',
  });
  await ready(page, "/agenda");
  await page.getByRole("region", {name: "我的行程", exact: true})
    .getByRole("button", { name: "调整 001 映后时长", exact: true })
    .click();
  let dialog = page.getByRole("dialog", { name: "001 映后谈", exact: true });
  await dialog
    .getByRole("button", { name: "跟随默认（25 分钟）", exact: true })
    .click();
  expect(JSON.parse((await storage(page))["biff.gvtalk.v1"])).toEqual({
    "001": false,
  });
  expect(JSON.parse((await storage(page))["biff.gvtalkmin.v1"])).toEqual({});
  await page.getByRole("region", {name: "我的行程", exact: true})
    .getByRole("button", { name: "调整 001 映后时长", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "001 映后谈", exact: true });
  const input = dialog.getByRole("textbox", {
    name: "本场映后时长（分钟）",
    exact: true,
  });
  await input.fill("55");
  await input.press("Tab");
  expect(JSON.parse((await storage(page))["biff.gvtalkmin.v1"])).toEqual({});
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("region", {name: "我的行程", exact: true})
    .getByRole("button", { name: "调整 001 映后时长", exact: true })
    .click();
  await expect(input).toHaveValue("");
  await input.fill("55");
  await input.press("Tab");
  await dialog
    .getByRole("button", { name: "保存映后时长", exact: true })
    .click();
  expect(JSON.parse((await storage(page))["biff.gvtalkmin.v1"])).toEqual({
    "001": 55,
  });
  expect(JSON.parse((await storage(page))["biff.gvtalk.v1"])).toEqual({
    "001": false,
  });
});

test("export defaults to the latest plan and reopening never exposes an empty downloadable canvas", async ({
  page,
}) => {
  await seed(page, { "biff.savedplans.v1": JSON.stringify(plans) });
  await ready(page, "/agenda");
  let dialog = await openExport(page);
  await expect(dialog.getByRole("button", { name: pickerLabel })).toContainText(
    "方案 2",
  );
  await dialog
    .getByRole("button", { name: "生成分享图片", exact: true })
    .click();
  const canvas = dialog.getByLabel("行程分享图片", { exact: true });
  await expect(canvas).toBeVisible();
  expect(
    await canvas.evaluate((el: HTMLCanvasElement) => ({
      width: el.width,
      alpha: el.getContext("2d")!.getImageData(0, 0, 1, 1).data[3],
    })),
  ).toMatchObject({ width: 2160, alpha: 255 });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  dialog = await openExport(page);
  await expect(
    dialog.getByRole("button", { name: "下载 PNG 图片", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "生成分享图片", exact: true })
    .click();
  await expect(
    dialog.getByLabel("行程分享图片", { exact: true }),
  ).toBeVisible();
  expect(
    await dialog
      .getByLabel("行程分享图片", { exact: true })
      .evaluate(
        (el: HTMLCanvasElement) =>
          el.getContext("2d")!.getImageData(0, 0, 1, 1).data[3],
      ),
  ).toBe(255);
});

test("changing plans invalidates an in-flight image generation", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeImage = window.Image;
    const state = window as typeof window & {
      __holdImages: boolean;
      __pendingImages: (() => void)[];
      __paintedTexts: string[];
    };
    state.__holdImages = false;
    state.__pendingImages = [];
    state.__paintedTexts = [];
    window.Image = class extends NativeImage {
      set src(value: string) {
        if (state.__holdImages)
          state.__pendingImages.push(() => {
            super.src = value;
          });
        else super.src = value;
      }
      get src() {
        return super.src;
      }
    };
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (
      text,
      ...args: [number, number, number?]
    ) {
      state.__paintedTexts.push(text);
      return fillText.call(this, text, ...args);
    };
  });
  await seed(page, { "biff.savedplans.v1": JSON.stringify(plans) });
  await ready(page, "/agenda");
  const dialog = await openExport(page);
  await dialog.getByRole("button", { name: pickerLabel }).click();
  await page.getByRole("option", { name: /^方案 1/ }).click();
  await page.evaluate(() => {
    (window as typeof window & { __holdImages: boolean }).__holdImages = true;
  });
  await dialog
    .getByRole("button", { name: "生成分享图片", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __pendingImages: unknown[] })
            .__pendingImages.length,
      ),
    )
    .toBeGreaterThan(0);
  await dialog.getByRole("button", { name: pickerLabel }).click();
  await page.getByRole("option", { name: /^方案 2/ }).click();
  await page.evaluate(() => {
    const state = window as typeof window & {
      __holdImages: boolean;
      __pendingImages: (() => void)[];
    };
    state.__holdImages = false;
    state.__pendingImages.forEach((run) => run());
  });
  await expect(
    dialog.getByRole("button", { name: "下载 PNG 图片", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "生成分享图片", exact: true })
    .click();
  await expect(
    dialog.getByLabel("行程分享图片", { exact: true }),
  ).toBeVisible();
  const texts = await page.evaluate(() =>
    (
      window as typeof window & { __paintedTexts: string[] }
    ).__paintedTexts.join("\n"),
  );
  expect(texts).toContain("MEMORIES");
  expect(texts).not.toContain("The Table");
});

test("clipboard image failure automatically downloads the rendered PNG", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write: () => Promise.reject(new Error("denied")) },
    }),
  );
  await seed(page, { "biff.savedplans.v1": JSON.stringify(plans) });
  await ready(page, "/agenda");
  const dialog = await openExport(page);
  await dialog
    .getByRole("button", { name: "生成分享图片", exact: true })
    .click();
  await expect(
    dialog.getByLabel("行程分享图片", { exact: true }),
  ).toBeVisible();
  const event = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "复制图片", exact: true }).click();
  expect((await event).suggestedFilename()).toBe("BIFF2026-看片计划.png");
});

test("clicking a dialog portal never toggles the grid card behind it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const entry = { key: keyOf("001"), picks: [{ code: "001" }], note: "keep" };
  await seed(page, { "biff.picks.v2": JSON.stringify([entry]) });
  await ready(page, "/schedule?date=2026-10-06");
  await page
    .getByRole("button", { name: "调整 001 映后时长", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "001 映后谈", exact: true });
  await dialog
    .getByRole("heading", { name: "001 映后谈", exact: true })
    .click();
  await expect(dialog).toBeVisible();
  expect(JSON.parse((await storage(page))["biff.picks.v2"])).toEqual([entry]);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    page.locator('[data-grid-code="001"][aria-pressed="true"]'),
  ).toBeVisible();
});

test("empty global numeric settings save as zero, matching legacy number inputs", async ({
  page,
}) => {
  await seed(page, { "biff.settings.v1": JSON.stringify(settings) });
  await ready(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  for (const name of [
    "日历提醒提前量（分钟）",
    "跨场馆转场缓冲（分钟）",
    "默认映后时长（分钟）",
  ]) {
    const input = dialog.getByRole("textbox", { name, exact: true });
    await input.fill("");
    await input.press("Tab");
  }
  await dialog.getByRole("button", { name: "保存设置", exact: true }).click();
  expect(JSON.parse((await storage(page))["biff.settings.v1"])).toEqual({
    ...settings,
    alarmMin: 0,
    transitMin: 0,
    gvTalkMin: 0,
  });
});
