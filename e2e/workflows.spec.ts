import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { keyOf, legacyData, openExport, ready, seed, storage } from "./helpers";

test("search, select a film, add a screening, edit notes, refresh and remove", async ({
  page,
}) => {
  await ready(page, "/library");
  await page.getByRole("searchbox", { name: "搜索影片" }).fill("彼此的日夜");
  const film = page.locator('[data-film-key="cat:f001"]');
  await expect(page.locator("[data-film-key]")).toHaveCount(1);
  await film
    .getByRole("button", { name: "加入我的选片 彼此的日夜", exact: true })
    .click();
  expect(JSON.parse((await storage(page))["biff.picks.v2"])).toEqual([
    { key: "cat:f001", picks: [], note: "" },
  ]);
  await film
    .getByRole("button", { name: "已在选片，去排场次", exact: true })
    .click();
  await expect(page).toHaveURL(/\/picks\?/);
  await page.getByRole("button", { name: "加入场次 001", exact: true }).click();
  await page
    .getByRole("textbox", { name: "彼此的日夜 备注", exact: true })
    .fill("与朋友一起");
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "彼此的日夜 备注", exact: true }),
  ).toHaveValue("与朋友一起");
  if (!await page.locator("#viewing-panel").count()) await page.getByRole("button", {name: "打开我的观影", exact: true}).click();
  await page.getByRole("link", { name: /^我的行程/ }).click();
  await expect(
    page
      .getByRole("region", { name: "我的行程", exact: true })
      .locator('[data-screening="001"]'),
  ).toBeVisible();
  await page.getByRole("button", { name: "移出场次 001", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "还没有安排场次", exact: true }),
  ).toBeVisible();
  expect(JSON.parse((await storage(page))["biff.picks.v2"])).toEqual([
    { key: "cat:f001", picks: [], note: "与朋友一起" },
  ]);
});

test("detail URLs, browser back and direct reload preserve library context", async ({
  page,
}) => {
  await ready(page, "/library?q=001&date=2026-10-07");
  await page
    .getByRole("button", { name: "彼此的日夜 影片资料", exact: true })
    .click();
  await expect(page).toHaveURL(/\/library\/films\/cat%3Af001\?/);
  await expect(
    page.getByRole("dialog", { name: "彼此的日夜", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("dialog", { name: "彼此的日夜", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(page).toHaveURL(/\/library\?q=001/);
  await expect(page.getByRole("searchbox", { name: "搜索影片" })).toHaveValue(
    "001",
  );
  await page.getByRole("link", { name: "排片表", exact: true }).click();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "影片库", exact: true }),
  ).toBeVisible();
});

test("grid and library filters persist independently, including exclusion mode", async ({
  page,
}) => {
  await ready(page, "/schedule?date=2026-10-07");
  await page.getByRole("button", { name: "排片筛选", exact: true }).click();
  const schedule = page.getByRole("region", { name: "排片表", exact: true });
  await schedule
    .locator("label")
    .filter({ has: page.getByRole("checkbox", { name: "KE", exact: true }) })
    .click();
  await expect(
    schedule.getByRole("checkbox", { name: "KE", exact: true }),
  ).toBeChecked();
  await schedule.getByRole("button", { name: /影厅筛选方式/ }).click();
  await page.getByRole("option", { name: "排除选中影厅", exact: true }).click();
  await schedule.getByRole("button", { name: "CGV", exact: true }).click();
  const grid = JSON.parse((await storage(page))["biff.filters.v1"]);
  expect(grid.subs).toEqual(["KE"]);
  expect(grid.venueMode).toBe("exclude");
  expect(grid.venues).toContain("c5");
  await page.getByRole("link", { name: "影片库", exact: true }).click();
  await page.getByRole("button", { name: "影片库筛选", exact: true }).click();
  const library = page.getByRole("region", { name: "影片库", exact: true });
  await library
    .locator("label")
    .filter({ has: page.getByRole("checkbox", { name: "NO", exact: true }) })
    .click();
  await expect(
    library.getByRole("checkbox", { name: "NO", exact: true }),
  ).toBeChecked();
  const data = await storage(page);
  expect(JSON.parse(data["biff.filters.v1"])).toEqual(grid);
  expect(JSON.parse(data["biff.libfilters.v1"]).subs).toEqual(["NO"]);
  await page.reload();
  await expect(
    page.getByRole("button", { name: /影片库筛选：字幕 NO/ }),
  ).toBeVisible();
});

test("GV overrides update effective end time and calendar output", async ({
  page,
}) => {
  await seed(page, {
    "biff.picks.v2": JSON.stringify([
      { key: keyOf("001"), picks: [{ code: "001" }], note: "GV 测试" },
    ]),
  });
  await ready(page, "/agenda");
  const card = page
    .getByRole("region", { name: "我的行程", exact: true })
    .locator('[data-screening="001"]');
  await expect(card).toContainText("18:00–19:45");
  await card
    .locator("label")
    .filter({
      has: page.getByRole("checkbox", { name: "参加映后谈", exact: true }),
    })
    .click();
  await expect(
    card.getByRole("checkbox", { name: "参加映后谈", exact: true }),
  ).not.toBeChecked();
  await expect(card).toContainText("18:00–19:20");
  expect(JSON.parse((await storage(page))["biff.gvtalk.v1"])["001"]).toBe(
    false,
  );
  await card
    .getByRole("button", { name: "调整 001 映后时长", exact: true })
    .click();
  const gv = page.getByRole("dialog", { name: "001 映后谈", exact: true });
  const min = gv.getByRole("textbox", {
    name: "本场映后时长（分钟）",
    exact: true,
  });
  await min.fill("40");
  await min.press("Tab");
  await gv.getByRole("button", { name: "保存映后时长", exact: true }).click();
  await card
    .locator("label")
    .filter({
      has: page.getByRole("checkbox", { name: "参加映后谈", exact: true }),
    })
    .click();
  await expect(
    card.getByRole("checkbox", { name: "参加映后谈", exact: true }),
  ).toBeChecked();
  await expect(card).toContainText("18:00–20:00");
  await page.getByRole("button", { name: "保存当前方案", exact: true }).click();
  const dialog = await openExport(page);
  const wait = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "导出 ICS 日历", exact: true })
    .click();
  const file = await wait;
  const text = await readFile((await file.path())!, "utf8");
  expect(text).toContain("UID:001@biff-2026");
  expect(text).toContain("DTSTART:20261006T090000Z");
  expect(text).toContain("DTEND:20261006T110000Z");
  expect(text).toContain("TRIGGER:-PT45M");
});

test("conflict ranks determine the saved plan and survive reload", async ({
  page,
}) => {
  await seed(page, {
    "biff.picks.v2": JSON.stringify(
      ["008", "033"].map((code) => ({
        key: keyOf(code),
        picks: [{ code }],
        note: "",
      })),
    ),
  });
  await ready(page, "/agenda?date=2026-10-07");
  await expect(page.getByRole("region", { name: /冲突组/ })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "方案对比", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "提高 033 顺位", exact: true })
    .click();
  await page.getByRole("button", { name: "保存当前方案", exact: true }).click();
  const data = await storage(page);
  expect(JSON.parse(data["biff.ranks.v1"])).toEqual({ "033": 1, "008": 2 });
  expect(JSON.parse(data["biff.savedplans.v1"])[0].codes).toEqual(["033"]);
  await page.reload();
  await expect(page.locator("[data-rank-code]").first()).toHaveAttribute(
    "data-rank-code",
    "033",
  );
  await expect(page.getByText("方案 1", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "收起行程 2026-10-07", exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "展开行程 2026-10-07", exact: true }),
  ).toBeVisible();
});

test("imports ICS by file, previews invalid data, and merges without duplicates", async ({
  page,
}) => {
  await ready(page, "/agenda");
  const dialog = await openExport(page);
  await dialog
    .getByRole("textbox", { name: "或粘贴备份内容", exact: true })
    .fill("invalid JSON");
  await expect(dialog.getByRole("alert")).toContainText("不是有效的 JSON");
  await dialog.getByLabel("选择备份或日历文件").setInputFiles({
    name: "old.ics",
    mimeType: "text/calendar",
    buffer: Buffer.from(
      "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:001@biff-2026\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:001@biff-2026\r\nEND:VEVENT\r\nUID:99999@biff-2026\r\nEND:VCALENDAR",
    ),
  });
  await expect(
    dialog.getByText(/识别到 1 场，1 场已不在当前排期/),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "合并到当前行程", exact: true })
    .click();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "我的行程", exact: true })
      .locator('[data-screening="001"]'),
  ).toBeVisible();
  expect(JSON.parse((await storage(page))["biff.picks.v2"])).toEqual([
    { key: keyOf("001"), picks: [{ code: "001" }], note: "" },
  ]);
});

test("saved plans export text and a real PNG, and ticket reminders use UTC", async ({
  page,
}) => {
  await seed(page, { "biff.savedplans.v1": legacyData["biff.savedplans.v1"] });
  await ready(page, "/agenda");
  const dialog = await openExport(page);
  await dialog.getByRole("button", { name: "分享文案", exact: true }).click();
  await expect(
    dialog.getByRole("textbox", { name: "行程分享文案", exact: true }),
  ).toContainText("001");
  await dialog
    .getByRole("button", { name: "生成分享图片", exact: true })
    .click();
  await expect(
    dialog.getByLabel("行程分享图片", { exact: true }),
  ).toBeVisible();
  const wait = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "下载 PNG 图片", exact: true })
    .click();
  const file = await wait;
  const png = await readFile((await file.path())!);
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(png.length).toBeGreaterThan(10_000);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page
    .getByRole("button", { name: /距第.*批开票|购票信息|售票中/ })
    .click();
  await expect(
    page.getByRole("dialog", { name: "购票信息", exact: true }),
  ).toContainText("北京时间");
  const waitTicket = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出开票提醒", exact: true }).click();
  const ticket = await waitTicket;
  const ics = await readFile((await ticket.path())!, "utf8");
  expect(ics).toContain("BEGIN:VALARM");
  expect(ics).toMatch(/DTSTART:\d{8}T\d{6}Z/);
});

test("desktop zoom and floating panel preserve preferences; mobile never overflows the viewport", async ({
  page,
  isMobile,
}) => {
  await seed(page, {
    "biff.pickerw.v1": "640",
    "biff.settings.v1": '{"zoom":0.7}',
  });
  await ready(page, "/library?date=2026-10-07");
  if (!isMobile) {
    await page.getByRole("button", {name: "打开我的观影", exact: true}).click();
    expect((await storage(page))["biff.pickerw.v1"]).toBe("640");
    expect((await page.locator("#viewing-panel").boundingBox())!.width).toBe(640);
    await page.getByRole("button", {name: "收起选片面板", exact: true}).click();
    await page.getByRole("button", { name: "放大排片表", exact: true }).click();
    expect(JSON.parse((await storage(page))["biff.settings.v1"]).zoom).toBe(
      0.9,
    );
    await page
      .getByRole("button", { name: "筛选 10:00 时段", exact: true })
      .click();
    await expect(
      page.getByText("正在查看 10:00 时段", { exact: true }),
    ).toBeVisible();
  } else {
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("link", { name: "排片表", exact: true }).click();
    await expect(page.getByLabel("排片时间表", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(page.getByLabel("排片时间表", { exact: true })).toBeVisible();
  }
});

test("keyboard can open and dismiss a dialog, restoring focus", async ({
  page,
}) => {
  await ready(page, "/library");
  const trigger = page.getByRole("button", { name: "设置", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
