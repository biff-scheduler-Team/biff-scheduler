import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { agendaCards, catalog, keyOf, ready, seed, storage } from "./helpers";

function picks(codes: string[]) {
  const entries = new Map<
    string,
    { key: string; picks: { code: string }[]; note: string }
  >();
  for (const code of codes) {
    const key = keyOf(code);
    const entry = entries.get(key) ?? { key, picks: [], note: "" };
    entry.picks.push({ code });
    entries.set(key, entry);
  }
  return JSON.stringify([...entries.values()]);
}

test("first-choice clashes block saving until the user chooses which group yields", async ({
  page,
}) => {
  await seed(page, {
    "biff.picks.v2": picks(["008", "033", "143", "080"]),
    "biff.ranks.v1": JSON.stringify({ "008": 1, "033": 2, "143": 1, "080": 2 }),
  });
  await ready(page, "/agenda");
  const save = page.getByRole("button", { name: "保存当前方案", exact: true });
  await expect(save).toBeDisabled();
  await expect(
    page.getByRole("region", { name: "方案对比", exact: true }),
  ).toHaveCount(0);
  const clashes = page.getByRole("region", { name: "顺位撞车", exact: true });
  await expect(clashes).toContainText("第 1 顺位，2 个冲突组");
  await expect(clashes).toContainText("宛如星辰的你");
  await clashes
    .getByRole("button", { name: "OCT 8 10:00 组改选 080", exact: true })
    .click();
  await expect(save).toBeEnabled();
  await save.click();
  const current = await storage(page);
  expect(JSON.parse(current["biff.savedplans.v1"])[0].codes).toEqual([
    "008",
    "080",
  ]);
  expect(JSON.parse(current["biff.ranks.v1"])).toEqual({
    "008": 1,
    "033": 2,
    "080": 1,
    "143": 2,
  });
});

test("unfixable rank clashes explain why neither group can yield", async ({
  page,
}) => {
  const first = catalog.byCode.get("008")!;
  await page.route("**/schedule.json", (route) =>
    route.fulfill({
      json: {
        ...catalog.schedule,
        screenings: ["008", "033", "143", "080"].map((code) => ({
          ...catalog.byCode.get(code)!,
          title_en: first.title_en,
          title_zh: first.title_zh,
          title_kr: first.title_kr,
        })),
      },
    }),
  );
  await seed(page, {
    "biff.picks.v2": JSON.stringify([
      {
        key: keyOf("008"),
        picks: ["008", "033", "143", "080"].map((code) => ({ code })),
        note: "",
      },
    ]),
  });
  await ready(page, "/agenda");
  await expect(
    page.getByRole("region", { name: "顺位撞车", exact: true }),
  ).toContainText("组内其余场次都是同一部片，无法让路");
  await page.getByRole("button", { name: "预览顺位修复", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "调整抢票顺位",
    exact: true,
  });
  await expect(dialog).toContainText("没有可让路的场次");
  await expect(
    dialog.getByRole("button", { name: "应用修复", exact: true }),
  ).toHaveCount(0);
});

test("a following screening has no misleading gap from one member of a conflict group", async ({
  page,
}) => {
  await seed(page, {
    "biff.picks.v2": picks(["008", "033", "034"]),
    "biff.ranks.v1": JSON.stringify({ "008": 1, "033": 2 }),
    "biff.settings.v1": JSON.stringify({ transitMin: 45 }),
  });
  await ready(page, "/agenda");
  await agendaCards(page);
  await expect(
    page.locator('.agenda-page [data-screening="034"]'),
  ).toBeVisible();
  await expect(page.locator(".agenda-page .gap-label")).toHaveCount(0);
});

test("saved snapshots retain catalog validity, date range, and inspectable codes", async ({
  page,
}) => {
  await seed(page, {
    "biff.savedplans.v1": JSON.stringify([
      {
        id: "old",
        name: "方案 7",
        codes: ["001", "008", "99999"],
        createdAt: 1,
      },
    ]),
  });
  await ready(page, "/agenda");
  const saved = page.getByRole("region", { name: "已保存方案", exact: true });
  await expect(saved).toContainText("2 场，OCT 6–OCT 7，1 场已不在排期");
  // 「查看场次」是弹层(2026-09-14):内容与分享图片同源 —— 有效结束时间 / 片名 / 影院 / GV 标记,
  // 不再是内联 <details> 里的「HH:MM · CODE」纯文本。
  await saved
    .getByRole("button", { name: "查看「方案 7」的场次", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "方案 7", exact: true }),
  ).toBeVisible();
  await expect(dialog).toContainText("OCT 6–OCT 7 · 共 2 场 / 2 部");
  // 001:18:00 起 + 80 分钟正片 + 25 分钟默认映后谈 → 有效结束 19:45(与分享图片同一口径)
  await expect(dialog).toContainText("18:00–19:45");
  await expect(dialog).toContainText("The Table: Day and Night · 彼此的日夜");
  await expect(dialog).toContainText("BCC Roof · 001");
  // GV 文案与分享文案同源(`share.ts::gvMark`):2026-09-16 起「含映后谈」缩成「映后」
  await expect(dialog).toContainText("映后");
  await expect(dialog).toContainText("08:40–11:20");
  await expect(dialog).toContainText("You, Like a Star · 宛如星辰的你");
  await expect(dialog).toContainText("BCC Cinema 1 · 008");
  // 换版残留的 code 不能静默消失
  await expect(dialog).toContainText("1 场已不在当前排期：99999");
  await expect(saved).not.toContainText("已不在当前行程");
});

test("folded days retain daily prices, overlap counts, and their legacy time span", async ({
  page,
}) => {
  await seed(page, { "biff.picks.v2": picks(["008", "033"]) });
  await ready(page, "/agenda");
  await agendaCards(page);
  await page
    .getByRole("button", { name: "收起行程 2026-10-07", exact: true })
    .click();
  const day = page.locator(".agenda-day");
  await expect(day).toContainText("当日 ₩20,000");
  await expect(day).toContainText("1 处时间重叠");
  await expect(day).toContainText("08:40–10:53");
  await page.reload();
  // ⚠ 视图选择只在**会话内**记着(模块级变量),刷新回落默认「日程表」——
  //   折叠状态(`biff.agendafold.v1`)才是落盘的,这里断言的是它没丢。
  await agendaCards(page);
  await expect(day).toContainText("08:40–10:53");
  await expect(day.locator("[data-rank-code]")).toHaveCount(0);
});

test("pointer dragging changes ranks and saves them on touch and mouse", async ({
  page,
  browserName,
  isMobile,
  context,
}) => {
  await page.setViewportSize({ width: isMobile ? 390 : 1512, height: 1400 });
  await seed(page, { "biff.picks.v2": picks(["008", "033"]) });
  await ready(page, "/agenda");
  const handles = page.locator(".drag-handle");
  await handles.first().scrollIntoViewIfNeeded();
  const first = (await handles.first().boundingBox())!;
  const second = (await handles.nth(1).boundingBox())!;
  const x = first.x + first.width / 2;
  const y = first.y + first.height / 2;
  const target = second.y + second.height / 2 + 40;
  if (isMobile && browserName === "chromium") {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    for (let step = 1; step <= 12; step++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y + ((target - y) * step) / 12 }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } else if (isMobile) {
    // WebKit has no CDP touch injection. Exercise the same touch-pointer handler
    // with browser PointerEvents; Chromium above also verifies trusted touch input.
    test
      .info()
      .annotations.push({
        type: "input",
        description:
          "WebKit touch PointerEvents; Chromium covers native CDP touch.",
      });
    await handles
      .first()
      .dispatchEvent("pointerdown", {
        pointerId: 42,
        pointerType: "touch",
        isPrimary: true,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: 1,
      });
    for (let step = 1; step <= 12; step++) {
      await page.evaluate(
        ({ x, y }) =>
          window.dispatchEvent(
            new PointerEvent("pointermove", {
              bubbles: true,
              cancelable: true,
              pointerId: 42,
              pointerType: "touch",
              isPrimary: true,
              clientX: x,
              clientY: y,
              buttons: 1,
            }),
          ),
        { x, y: y + ((target - y) * step) / 12 },
      );
    }
    await page.evaluate(
      ({ x, y }) =>
        window.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            pointerId: 42,
            pointerType: "touch",
            isPrimary: true,
            clientX: x,
            clientY: y,
            button: 0,
          }),
        ),
      { x, y: target },
    );
  } else {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, target, { steps: 12 });
    await page.mouse.up();
  }
  await expect
    .poll(async () => (await storage(page))["biff.ranks.v1"])
    .toBe('{"033":1,"008":2}');
  await page.reload();
  await expect(page.locator("[data-rank-code]").first()).toHaveAttribute(
    "data-rank-code",
    "033",
  );
});

test("ticket details retain translated guidance and a fixed 30-minute ticket alarm", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-09-12T00:00:00Z") });
  await seed(page, { "biff.settings.v1": JSON.stringify({ alarmMin: 90 }) });
  await ready(page, "/agenda");
  const ticketButton = page.getByRole("button", { name: /距第 1 批开票/ });
  await expect(ticketButton.getByRole("timer")).toBeVisible();
  await ticketButton.click();
  const dialog = page.getByRole("dialog", { name: "购票信息", exact: true });
  await expect(dialog).toContainText("北京时间 9/17 13:00");
  await expect(dialog).toContainText("韩国时间 9/17 14:00");
  await expect(dialog).toContainText(
    "65 岁以上（1961 年及以前出生）/ 残障 / 退伍军人，需证件核验",
  );
  await expect(dialog).toContainText("推荐用 Chrome 浏览器购票");
  await expect(dialog).toContainText("每场限购 2 张");
  await expect(dialog).toContainText("观众入场");
  await expect(dialog).toContainText("BCC 周边无指定车位");
  const download = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "导出开票提醒", exact: true })
    .click();
  const file = await download;
  const text = await readFile((await file.path())!, "utf8");
  expect(text).toContain("TRIGGER:-PT30M");
  expect(text).not.toContain("TRIGGER:-PT90M");
});

test("after the final batch the ticket banner says tickets are on sale", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-09-22T00:00:00Z") });
  await ready(page, "/agenda");
  await expect(
    page.getByRole("button", { name: /BIFF 2026 售票中/ }),
  ).toBeVisible();
});

// 「已保存方案」的删除入口(2026-09-22,`PLAN-20260922103307`)。
// 回归的是改动前的两处问题:① 删除按钮飘在卡片右端中部、与方案名隔着整行宽度;
// ② 一点就删,没有二次确认。
test("方案卡片的删除钉在方案名右边，且要先过二次确认", async ({ page }) => {
  await seed(page, {
    "biff.savedplans.v1": JSON.stringify([
      { id: "keep", name: "方案 1", codes: ["008"], createdAt: 1 },
      { id: "gone", name: "方案 2", codes: ["033"], createdAt: 2 },
    ]),
  });
  await ready(page, "/agenda");
  const saved = page.getByRole("region", { name: "已保存方案", exact: true });
  const card = saved.locator(".saved-plan").filter({ hasText: "方案 2" });
  const del = card.getByRole("button", { name: "删除方案 2", exact: true });
  const name = card.locator(".saved-plan-head > strong");

  // ① 与方案名**同一行**(纵向有重叠)、且在片名的右边
  const nameBox = (await name.boundingBox())!;
  const delBox = (await del.boundingBox())!;
  expect(delBox.y).toBeLessThan(nameBox.y + nameBox.height);
  expect(nameBox.y).toBeLessThan(delBox.y + delBox.height);
  expect(delBox.x).toBeGreaterThan(nameBox.x + nameBox.width);

  // ② 点入口只出确认,方案还在
  await del.click();
  const dialog = page.getByRole("dialog", { name: "删除方案 2？", exact: true });
  await expect(dialog).toBeVisible();
  await expect(card).toHaveCount(1);

  // ③ 取消不删
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(saved).toContainText("2 套");

  // ④ 确认才真的删
  await del.click();
  await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(saved).toContainText("1 套");
  await expect(saved).not.toContainText("方案 2");
});

test("agenda cards carry the venue code, place details and a Google Maps entry", async ({
  page,
}) => {
  await seed(page, { "biff.picks.v2": picks(["008", "033"]) });
  await ready(page, "/agenda");
  await agendaCards(page);
  const card = page.locator('[data-screening="008"]');
  const venue = card.locator(".screening-venue");
  await expect(venue).toHaveCount(1);
  // 「影院」前缀用于和卡片顶部的场次代码徽章(001)区分
  await expect(venue.locator(".venue-code")).toHaveText("影院 B1");
  await expect(venue).toContainText("BCC Cinema 1");
  await expect(venue).toContainText("Busan Cinema Center");
  // 卡面不再显示地址行(只留影院名 + 地图入口),地址仅在入口 title 里
  await expect(venue).not.toContainText("120, Suyeonggangbyeon-daero");
  const map = venue.getByRole("link", { name: /在 Google 地图打开/ });
  await expect(map).toHaveAttribute(
    "href",
    /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/,
  );
  await expect(map).toHaveAttribute("target", "_blank");
  // 影院名不再在时间行重复出现(交给影院块)
  await expect(card.locator(".screening-meta").first()).not.toContainText("BCC Cinema 1");
});

test("the Google Maps entry hugs the place name instead of being pushed to the row end", async ({
  page,
}) => {
  await seed(page, { "biff.picks.v2": picks(["008"]) });
  await ready(page, "/agenda");
  await agendaCards(page);
  const head = page.locator('[data-screening="008"] .screening-venue-head');
  await expect(head).toHaveCount(1);
  // 回归(PLAN-20260913192048):入口原本带 `margin-left: auto`,被顶到行右端,
  // 与左侧地名之间隔出上百像素空白。断言它紧跟在前一个兄弟(地名 span)之后 ——
  // 只剩 flex 的 8px 列间距,且二者落在同一行。
  const metrics = await head.evaluate((node) => {
    const link = node.querySelector<HTMLElement>("a.venue-map-link")!;
    const place = link.previousElementSibling as HTMLElement;
    const linkBox = link.getBoundingClientRect();
    const placeBox = place.getBoundingClientRect();
    return {
      gap: linkBox.left - placeBox.right,
      sameLine: Math.abs(linkBox.top - placeBox.top) < 4,
    };
  });
  expect(metrics.sameLine).toBe(true);
  expect(metrics.gap).toBeLessThanOrEqual(16);
});

test("行程卡片不再挂「定位」，整日定位只留在日期行", async ({
  page,
}) => {
  await seed(page, { "biff.picks.v2": picks(["008", "033"]) });
  await ready(page, "/agenda");
  await agendaCards(page);
  const day = page.locator(".agenda-day").first();
  // 2026-09-21(`PLAN-20260921223658` 修订 1):行程页默认就是日程表,单场「定位」跳去排片表
  // 已无意义 —— 跨页定位改从「我的选片」的场次卡进(见 parity-schedule / edge-cases)。
  await expect(
    day
      .locator('[data-screening="008"]')
      .getByRole("button", { name: "定位场次 008", exact: true }),
  ).toHaveCount(0);
  // 整日定位仍在,可见文案保持不变(与「定位场次」区分开)
  await expect(
    day.getByRole("button", { name: "定位当日 2026-10-07", exact: true }),
  ).toHaveText("定位当日");
});

test("the agenda film name carries a douban jump link, and film cards no longer do", async ({
  page,
}) => {
  // 2026-09-13 用户要求:豆瓣入口从影片卡操作行**搬**到「我的行程」的片名后面,
  // 并做成一眼能看出是外跳的指引(PLAN-20260913184357)。
  await page.route("**/douban.json", (route) =>
    route.fulfill({
      json: {
        mappings: {
          "001": {
            subject_id: 1,
            title_cn: "彼此的日夜",
            douban_url: "https://movie.douban.com/subject/1/",
          },
        },
      },
    }),
  );
  await seed(page, { "biff.picks.v2": picks(["001"]) });
  await ready(page, "/agenda");
  await agendaCards(page);
  const card = page.locator('[data-screening="001"]');
  const link = card.locator(".title-row .douban-jump");
  await expect(link).toHaveText("豆瓣 ↗");
  await expect(link).toHaveAttribute(
    "href",
    "https://movie.douban.com/subject/1/",
  );
  await expect(link).toHaveAttribute("target", "_blank");
  // 入口是片名的**下一个兄弟** —— 在片名之后,且标题文本里不含「豆瓣」
  // (塞进 <h3> 会把标题 accessible name 污染成「片名 豆瓣 ↗」,这里锁住不回归)
  await expect(card.locator(".title-row > h3")).toContainText("彼此的日夜");
  await expect(card.locator(".title-row > h3")).not.toContainText("豆瓣");
  await expect(card.locator(".title-row > h3 + .douban-jump")).toHaveCount(1);
  // 影片卡的操作行里不再有豆瓣外链(它挪到了片名行,见 parity-library 的用例)
  await ready(page, "/library?q=彼此的日夜");
  await expect(page.locator('[data-film-key="cat:f001"] .film-actions a')).toHaveCount(0);
});
