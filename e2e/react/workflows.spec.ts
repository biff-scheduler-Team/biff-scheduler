import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { agendaCards, keyOf, openExport, openViewingPanel, ready, seed, storage } from "./helpers";

test("search, select a film, add a screening, edit notes, refresh and remove", async ({
  page,
}) => {
  await ready(page, "/library");
  await page.getByRole("searchbox", { name: "搜索影片" }).fill("彼此的日夜");
  const film = page.locator('[data-film-key="cat:f001"]');
  await expect(page.locator("[data-film-key]")).toHaveCount(1);
  await film
    .getByRole("button", { name: "想看 彼此的日夜", exact: true })
    .click();
  expect(JSON.parse((await storage(page))["biff.picks.v2"])).toEqual([
    { key: "cat:f001", picks: [], note: "" },
  ]);
  await film
    .getByRole("button", { name: "已在选片，去排场次", exact: true })
    .click();
  await expect(page).toHaveURL(/\/picks\?/);
  await page.getByRole("button", { name: "排进行程 场次 001", exact: true }).click();
  await page
    .getByRole("textbox", { name: "彼此的日夜 备注", exact: true })
    .fill("与朋友一起");
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "彼此的日夜 备注", exact: true }),
  ).toHaveValue("与朋友一起");
  await page.getByRole("navigation", { name: "主要导航" }).getByRole("link", { name: "我的行程", exact: true }).click();
  // 场次卡只在「卡片」视图(2026-09-21 起「我的行程」默认日程表,见 PLAN-20260921223658)
  await agendaCards(page);
  await expect(
    page
      .getByRole("region", { name: "我的行程", exact: true })
      .locator('[data-screening="001"]'),
  ).toBeVisible();
  await page.getByRole("button", { name: "移出行程 场次 001", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "还没有安排场次", exact: true }),
  ).toBeVisible();
  expect(JSON.parse((await storage(page))["biff.picks.v2"])).toEqual([
    { key: "cat:f001", picks: [], note: "与朋友一起" },
  ]);
});

// 只有一场的影片:点「想看」直接落进行程(2026-09-16,PLAN-20260916004024)。
// 回归点 = **少掉的那一步** —— 改前这里会写出 `picks: []` 的空记录,用户还得再跳去
// 「我的选片」再排一次场次;改后存储里应立刻带上那唯一一场,且按钮不再引导去排场次。
// ⚠ 动作文案已于 2026-09-20 统一成「想看」(PLAN-20260920203010)——
//   单场片与多场片**不再各叫一个名字**,副作用改由片信息行的说明文字承担。
test("a single-screening film goes straight into the agenda", async ({ page }) => {
  await ready(page, "/library");
  await page.getByRole("searchbox", { name: "搜索影片" }).fill("蓦然回首");
  const film = page.locator('[data-film-key="cat:f002"]');
  await expect(film).toBeVisible();
  // 副作用必须在点之前就能看见(手机没有悬停,所以写在片信息行里而不是 title)
  await expect(film).toContainText("只有这一场");
  await film
    .getByRole("button", { name: "想看 蓦然回首", exact: true })
    .click();
  expect(JSON.parse((await storage(page))["biff.picks.v2"])).toEqual([
    { key: "cat:f002", picks: [{ code: "003" }], note: "" },
  ]);
  await expect(
    film.getByRole("button", { name: "已在行程，去查看", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "主要导航" })
    .getByRole("link", { name: "我的行程", exact: true })
    .click();
  await agendaCards(page);
  await expect(
    page
      .getByRole("region", { name: "我的行程", exact: true })
      .locator('[data-screening="003"]'),
  ).toBeVisible();
});

// 「只有一场」的影片：选定 = 排定（2026-09-16，PLAN-20260916004024）。
// ① 旧版本只建了空记录 → 载入时补进行程（备注不动）；
// ② 取消这一场必须先提示「会连同选片一起移除」—— 不提示的话用户会以为点一下整部片就没了；
// ③ 确认后连选片记录一起删，且重载**不会**被补回来（这就是不写「补过标记」也没关系的原因）。
test("a single-screening pick is filled on load, and unpicking it asks first", async ({ page }) => {
  await seed(page, {
    "biff.picks.v2": JSON.stringify([
      { key: "cat:f002", picks: [], note: "等朋友" },
    ]),
  });
  await ready(page, "/picks?expand=cat%3Af002");
  const picks = page.getByRole("region", { name: "我的选片", exact: true });
  const film = picks.locator('[data-film-key="cat:f002"]');
  // ① 载入即补齐：唯一场次 003 落进行程
  expect(JSON.parse((await storage(page))["biff.picks.v2"])).toEqual([
    { key: "cat:f002", picks: [{ code: "003" }], note: "等朋友" },
  ]);
  await expect(
    film.getByRole("button", { name: "移出行程 场次 003", exact: true }),
  ).toBeVisible();
  // ② 先取消 → 什么都不发生
  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    expect(dialog.message()).toContain("只有这一场");
    await dialog.dismiss();
  });
  await film.getByRole("button", { name: "移出行程 场次 003", exact: true }).click();
  expect(JSON.parse((await storage(page))["biff.picks.v2"])).toEqual([
    { key: "cat:f002", picks: [{ code: "003" }], note: "等朋友" },
  ]);
  // ③ 确认 → 连选片记录一起移除，重载也不复活
  page.once("dialog", async (dialog) => {
    await dialog.accept();
  });
  await film.getByRole("button", { name: "移出行程 场次 003", exact: true }).click();
  expect(JSON.parse((await storage(page))["biff.picks.v2"])).toEqual([]);
  await page.reload();
  expect(JSON.parse((await storage(page))["biff.picks.v2"])).toEqual([]);
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
  await agendaCards(page);
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
  // 原先这里还点了「保存当前方案」再导出 —— 方案整体下线后(2026-09-22,`PLAN-20260922105228`)
  // 导出范围就是当前行程,这一步没有必要了。
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

// ⚠ 原用例叫「conflict ranks determine the **saved plan** and survive reload」:它把「顺位落盘」
// 与「保存方案」两条链绑在一起来断言。方案已于 2026-09-22 整体下线(`PLAN-20260922105228`),
// 这里只留**顺位**那半段 —— 它与按日折叠的持久化一起,仍是本轮最该守的行为。
test("conflict ranks survive reload and keep driving the card order", async ({
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
  // 「收起行程 N」/ 顺位卡都只在卡片视图 —— 顺位卡自 2026-09-22 起**只剩**这一个落点
  // (画布上的顺位卡与「顺位撞车」提示都已下线,见 `PLAN-20260922123138`),日程表视图没有它。
  await agendaCards(page);
  await expect(page.getByRole("region", { name: /冲突组/ })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "方案对比", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "提高 033 顺位", exact: true })
    .click();
  const data = await storage(page);
  expect(JSON.parse(data["biff.ranks.v1"])).toEqual({ "033": 1, "008": 2 });
  await page.reload();
  // 刷新后视图回默认「日程表」(视图选择只在会话内记着),再切回卡片继续断言
  await agendaCards(page);
  await expect(page.locator("[data-rank-code]").first()).toHaveAttribute(
    "data-rank-code",
    "033",
  );
  await page
    .getByRole("button", { name: "收起行程 2026-10-07", exact: true })
    .click();
  await page.reload();
  await agendaCards(page);
  await expect(
    page.getByRole("button", { name: "展开行程 2026-10-07", exact: true }),
  ).toBeVisible();
});

test("imports ICS by file, previews invalid data, and merges without duplicates", async ({
  page,
}) => {
  await ready(page, "/agenda");
  await agendaCards(page);
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

test("export text and a real PNG come out of the itinerary, and ticket reminders use UTC", async ({
  page,
}) => {
  await seed(page, {
    "biff.picks.v2": JSON.stringify([
      { key: keyOf("001"), picks: [{ code: "001" }], note: "" },
    ]),
  });
  await ready(page, "/agenda");
  const dialog = await openExport(page);
  // ⚠ 导出范围只剩「当前行程」一项(2026-09-22,`PLAN-20260922105228`):
  //   原先这里要先在「导出范围」下拉里选一个已保存方案,下拉已换成静态说明行。
  await expect(dialog.getByText(/导出范围：当前行程/)).toBeVisible();
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
    // /library 整页隐藏 FAB：回排片表再开浮层
    await page.getByRole("link", { name: "排片表", exact: true }).click();
    await openViewingPanel(page);
    expect((await storage(page))["biff.pickerw.v1"]).toBe("640");
    // 桌面分栏不再按 pickerw 定宽；比例契约与 floating-panel / desktop 一致
    const panel = (await page.locator("#viewing-panel").boundingBox())!;
    const schedule = (await page.locator(".schedule-column").boundingBox())!;
    const total = panel.width + schedule.width;
    expect(panel.width / total).toBeGreaterThan(0.2);
    expect(panel.width / total).toBeLessThan(0.35);
    await page.getByRole("button", {name: "收起选片面板", exact: true}).click();
    await page.getByRole("group", { name: "排片大小" }).getByRole("button", { name: "大", exact: true }).click();
    expect(JSON.parse((await storage(page))["biff.settings.v1"]).zoom).toBe(
      0.75,
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
  // 入口从「设置」按钮变成了「更多 → 设置」(2026-09-22,`PLAN-20260922105228`)。
  // 键盘用户走同一条路:焦点落在「更多」上,Enter 开菜单,菜单项的 Enter 才进设置。
  const trigger = page.getByRole("button", { name: "更多", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "设置", exact: true }).focus();
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
