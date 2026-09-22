import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { agendaCards, keyOf, ready, seed, storage } from "./helpers";

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

/* 「顺位撞车（逐层）→ 预览修复 / 逐组让路」整条用例随 `RankClashes` 组件删除(2026-09-22,`PLAN-20260922123138`)。
 * 前情:它原叫「first-choice clashes block **saving** …」,靠「保存按钮禁用 / 改选后可用」间接证明撞车被判出来;
 * 保存方案下线(2026-09-22,`PLAN-20260922105228`)后改成直接断言撞车与改选落盘;本轮用户口径
 * 「我的行程**不需要显示**冲突组顺位这个组件」——连提示本身一起下线,断言没有宿主了。
 * ⚠ 顺位机制与 `plans.ts::detectRankClashes` **都没删**:改顺位仍在卡片视图的顺位卡里(见下方拖动用例)。 */

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

/* 「已保存方案的快照校验 / 查看场次弹层」整条用例随方案下线删除(2026-09-22,`PLAN-20260922105228`)。
 * 它覆盖的三件事都没了宿主:①快照的日期区间与「N 场已不在排期」概要(`describeSavedPlan`)、
 * ②「查看场次」弹层(`PlanShowsDialog`,它的信息口径与分享图片同源)、
 * ③「已保存方案」区块本身。行程侧的等价口径仍由下面的按日折叠用例与 `share-export` 覆盖。 */

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
  // ⚠ 必须切到**卡片**视图:顺位卡自 2026-09-22 起只在那边按日就地展开
  //   (`PLAN-20260922123138` 撤掉了日历表画布上的顺位卡 —— 日程表默认视图里没有把手)。
  await agendaCards(page);
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
  // ⚠ 刷新会落回默认的**日程表**视图(视图选择只存在会话内的模块变量里),顺位卡要再切一次卡片视图
  await agendaCards(page);
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

/* 「方案卡片的删除入口钉在方案名右边 + 二次确认」整条用例随方案下线删除
 * (2026-09-22,`PLAN-20260922105228`)—— 卡片、方案名、删除入口与那个确认弹层都不存在了。
 * ⚠ 它上一轮(`PLAN-20260922103307`)刚被写出来,所以这里留档一句:不是漏改,是宿主没了。 */

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
