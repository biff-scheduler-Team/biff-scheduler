import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  keyOf,
  legacyData,
  legacyRead,
  openExport,
  openViewingPanel,
  ready,
  scheduleHeading,
  seed,
  storage,
} from "./helpers";

test("all legacy storage keys survive initial load, navigation, and reload byte for byte", async ({
  page,
  isMobile,
}) => {
  await seed(page, legacyData);
  // quick=1：浮层打开时才渲染 #viewing-panel（整页 /agenda 无面板）
  await ready(page, "/agenda?date=2026-10-07&quick=1");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    page.getByRole("heading", { name: "我的行程", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("方案 7", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "展开行程 2026-10-07", exact: true }),
  ).toBeVisible();
  if (!isMobile) {
    // 桌面 ≥1100：选片:排片 ≈ 1:3，宽度跟 flex 走，不再等于 biff.pickerw.v1
    const panel = (await page.locator("#viewing-panel").boundingBox())!;
    const schedule = (await page.locator(".schedule-column").boundingBox())!;
    const total = panel.width + schedule.width;
    expect(panel.width / total).toBeGreaterThan(0.2);
    expect(panel.width / total).toBeLessThan(0.35);
  }
  const old = await legacyRead(page);
  expect(old.settings.customPreference).toBe("preserve-me");
  expect(old.picks).toHaveLength(5);
  expect(
    old.picks.find((p: { key: string }) => p.key === keyOf("001")).note,
  ).toContain("旧版备注");
  expect(old.gv["001"]).toBe(false);
  expect(old.gvMin["001"]).toBe(40);
  expect(old.ranks["033"]).toBe(1);
  await page.getByRole("link", { name: "影片库", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "彼此的日夜", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "排片表", exact: true }).click();
  await page.reload();
  await expect(scheduleHeading(page)).toBeVisible();
  expect(await storage(page)).toEqual(legacyData);
});

test("new UI writes remain readable by the original implementation", async ({
  page,
}) => {
  await seed(page, { ...legacyData, "biff.agendafold.v1": "[]" });
  await ready(page, "/picks?q=001");
  const note = page.getByRole("textbox", {
    name: "彼此的日夜 备注",
    exact: true,
  });
  await note.fill("React 改过的备注\n兼容旧版本");
  // /picks 整页时 FAB 隐藏：用主导航进行程，不依赖浮层
  await page.getByRole("navigation", { name: "主要导航" }).getByRole("link", { name: "我的行程", exact: true }).click();
  await page
    .getByRole("button", { name: "提高 008 顺位", exact: true })
    .click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  const alarm = dialog.getByRole("textbox", {
    name: "日历提醒提前量（分钟）",
    exact: true,
  });
  await alarm.fill("90");
  await alarm.press("Tab");
  await dialog.getByRole("button", { name: "保存设置", exact: true }).click();
  const old = await legacyRead(page);
  expect(
    old.picks.find((p: { key: string }) => p.key === keyOf("001")).note,
  ).toBe("React 改过的备注\n兼容旧版本");
  expect(old.ranks["008"]).toBe(1);
  expect(old.ranks["033"]).toBe(2);
  expect(old.settings.alarmMin).toBe(90);
  expect(old.settings.customPreference).toBe("preserve-me");
  expect((await storage(page))["biff.future.v9"]).toBe(
    legacyData["biff.future.v9"],
  );
  await legacyRead(page, true);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "加入场次 033", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "我的行程", exact: true })
      .locator('[data-screening="033"]'),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "日历提醒提前量（分钟）", exact: true }),
  ).toHaveValue("75");
});

test("v1 plan migrates once, preserves notes, and never resurrects after clearing", async ({
  page,
}) => {
  await seed(page, {
    "biff.plan.v1": JSON.stringify([
      { code: "001", group: "B", priority: "must", note: "最旧版本备注" },
      { code: "001" },
      { code: "008", note: "第二场" },
      { code: "not-real" },
    ]),
    "biff.wish.v1": JSON.stringify({ "cat:f001": "must" }),
  });
  await ready(page, "/agenda");
  const current = await storage(page);
  const picks = JSON.parse(current["biff.picks.v2"]);
  expect(
    picks.flatMap((p: { picks: { code: string }[] }) =>
      p.picks.map((s) => s.code),
    ),
  ).toEqual(["001", "008"]);
  expect(picks[0].note).toBe("最旧版本备注");
  expect(current["biff.plan.v1"]).toBeUndefined();
  expect(current["biff.wish.v1"]).toBeUndefined();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "清空全部选片", exact: true }).click();
  await page.getByRole("button", { name: "确认清空", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "还没有安排场次", exact: true }),
  ).toBeVisible();
  expect(JSON.parse((await storage(page))["biff.picks.v2"])).toEqual([]);
});

test("an empty v2 remains authoritative over stale legacy v1 records", async ({
  page,
}) => {
  await seed(page, {
    "biff.picks.v2": "[]",
    "biff.plan.v1": '[{"code":"001"}]',
  });
  await ready(page, "/agenda");
  await expect(
    page.getByRole("heading", { name: "还没有安排场次", exact: true }),
  ).toBeVisible();
  expect(JSON.parse((await storage(page))["biff.picks.v2"])).toEqual([]);
});

test("JSON backup exports unknown keys and restores raw values without touching other apps", async ({
  page,
}) => {
  await seed(page, legacyData);
  await ready(page, "/agenda");
  const dialog = await openExport(page);
  const downloadEvent = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "导出数据备份", exact: true })
    .click();
  const file = await downloadEvent;
  const data = JSON.parse(await readFile((await file.path())!, "utf8"));
  expect(data.app).toBe("biff-scheduler");
  expect(data.version).toBe(1);
  expect(data.data).toEqual(
    Object.fromEntries(
      Object.entries(legacyData).filter(([k]) => k.startsWith("biff.")),
    ),
  );
  const replacement = {
    ...data.data,
    "biff.settings.v1": JSON.stringify({
      alarmMin: 12,
      transitMin: 15,
      gvTalkOn: false,
      gvTalkMin: 20,
      theme: "light",
      zoom: 0.9,
    }),
  };
  await dialog
    .getByRole("textbox", { name: "或粘贴备份内容", exact: true })
    .fill(JSON.stringify({ ...data, data: replacement }));
  await dialog
    .getByRole("button", { name: "准备恢复备份", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "确认恢复并刷新", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "我的行程", exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await storage(page)).toEqual({
    ...replacement,
    "unrelated.application": "do-not-touch",
  });
});

test("malformed storage does not block the app or overwrite unreadable data", async ({
  page,
}) => {
  const values = {
    "biff.picks.v2": "not json",
    "biff.settings.v1": "{oops",
    "biff.filters.v1": "null",
    "biff.libfilters.v1": "[]",
    "biff.savedplans.v1": "invalid",
    "biff.gvtalk.v1": "null",
  };
  await seed(page, values);
  await ready(page, "/library");
  await expect(page.locator("[data-film-key]").first()).toBeVisible();
  expect(await storage(page)).toEqual(values);
});

test("new tab changes synchronize without discarding the existing data contract", async ({
  page,
  context,
}) => {
  await seed(page, {
    "biff.picks.v2":
      '[{"key":"cat:f001","picks":[{"code":"001"}],"note":"original"}]',
  });
  await ready(page, "/agenda");
  const other = await context.newPage();
  await ready(other, "/agenda");
  await other
    .getByRole("button", { name: "移出场次 001", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "我的行程", exact: true })
      .locator('[data-screening="001"]'),
  ).toHaveCount(0);
  expect((await legacyRead(page)).picks[0].note).toBe("original");
  await other.close();
});
