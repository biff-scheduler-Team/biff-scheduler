import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { catalog, keyOf, ready, seed, storage } from "./helpers";

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
  await saved.locator("summary").click();
  await expect(saved.locator("details p")).toHaveText(
    "18:00 · 001\n08:40 · 008\n99999",
  );
  await expect(saved).not.toContainText("已不在当前行程");
});

test("folded days retain daily prices, overlap counts, and their legacy time span", async ({
  page,
}) => {
  await seed(page, { "biff.picks.v2": picks(["008", "033"]) });
  await ready(page, "/agenda");
  await page
    .getByRole("button", { name: "收起行程 2026-10-07", exact: true })
    .click();
  const day = page.locator(".agenda-day");
  await expect(day).toContainText("当日 ₩20,000");
  await expect(day).toContainText("1 处时间重叠");
  await expect(day).toContainText("08:40–10:53");
  await page.reload();
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
    "65 岁以上（1961 年前出生）/ 残障 / 退伍军人，需证件核验",
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

test("agenda cards carry the venue code, place details and a Google Maps entry", async ({
  page,
}) => {
  await seed(page, { "biff.picks.v2": picks(["008", "033"]) });
  await ready(page, "/agenda");
  const card = page.locator('[data-screening="008"]');
  const venue = card.locator(".screening-venue");
  await expect(venue).toHaveCount(1);
  // 「影院」前缀用于和卡片顶部的场次代码徽章(001)区分
  await expect(venue.locator(".venue-code")).toHaveText("影院 B1");
  await expect(venue).toContainText("BCC Cinema 1");
  await expect(venue).toContainText("Busan Cinema Center");
  await expect(venue).toContainText("120, Suyeonggangbyeon-daero, Haeundae-gu, Busan");
  const map = venue.getByRole("link", { name: /在 Google 地图打开/ });
  await expect(map).toHaveAttribute(
    "href",
    /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/,
  );
  await expect(map).toHaveAttribute("target", "_blank");
  // 影院名不再在时间行重复出现(交给影院块)
  await expect(card.locator(".screening-meta").first()).not.toContainText("BCC Cinema 1");
});

test("the day-level locate says 定位当日 while the card-level one stays 定位", async ({
  page,
}) => {
  await seed(page, { "biff.picks.v2": picks(["008", "033"]) });
  await ready(page, "/agenda");
  const day = page.locator(".agenda-day").first();
  // 两者功能不同(整日 vs 单场),可见文案必须能区分,否则用户无从判断按哪个
  await expect(
    day.getByRole("button", { name: "定位当日 2026-10-07", exact: true }),
  ).toHaveText("定位当日");
  await expect(
    day
      .locator('[data-screening="008"]')
      .getByRole("button", { name: "定位场次 008", exact: true }),
  ).toHaveText("定位");
});
