// 「吃喝」页(2026-09-16,`PLAN-20260916232230` 修订 1)。
// 断言全部走 DOM 计数 / 文本 / 属性,不看截图。
// 覆盖:① 导航位置(吃喝在最后,与选片主线无关);② 清单渲染 + 三条地图链接的模板;
//      ③ 搜索与分区筛选;④ 用户自己添加的店落本地键并出现在列表;
//      ⑤ 地图数据源没配密钥时(503)**静默降级** —— Naver 那条仍是搜索链接,页面不报错。
//
// ⚠ 所有用例都把 `/api/eats/lookup` 钉成 503:测试环境没有 Worker,
//   不钉的话 40 家店会各自打一次真实请求,既慢又不确定。

import { test, expect, type Page } from "@playwright/test";
import { ready, storage } from "./helpers";

/** 地图数据源未配置 —— 这是本轮的默认状态,也是降级路径的回归点。 */
const lookupOff = (page: Page) =>
  page.route("**/api/eats/lookup**", (route) => route.fulfill({ status: 503, json: { error: "LOOKUP_DISABLED" } }));

test("「吃喝」排在主导航最后 —— 它与选片 / 观影 / 复盘那条主线无关", async ({ page }) => {
  await lookupOff(page);
  await ready(page, "/eats");
  const labels = (
    await page.getByRole("navigation", { name: "主要导航" }).getByRole("link").allTextContents()
  ).map((text) => text.trim());
  expect(labels[labels.length - 1]).toBe("吃喝");
  expect(labels.indexOf("吃喝")).toBeGreaterThan(labels.indexOf("红黑榜"));
  await expect(page.getByRole("heading", { name: "吃喝", exact: true })).toBeVisible();
});

test("清单来自 eats.json,每张卡三个地图入口且模板正确", async ({ page }) => {
  await lookupOff(page);
  await ready(page, "/eats");
  const card = page.locator('[data-eat-id="halmae-gukbab"]');
  await expect(card).toBeVisible();
  // 中文名当主名、韩文名当副名 —— 到了现场给店家看韩文名
  await expect(card.locator(".eat-name")).toHaveText("60年传统奶奶汤饭");
  await expect(card.locator(".eat-sub")).toHaveText("60년전통할매국밥");
  await expect(card).toContainText("猪肉汤饭");
  await expect(card).toContainText("人均 ¥35");
  await expect(card).toContainText("부산 동구 중앙대로533번길 4");

  // 三家地图入口 + 表里人工整理的那条(这家是小红书食记)
  const links = card.locator(".eat-links a");
  await expect(links).toHaveCount(4);
  await expect(links.nth(3)).toHaveText(/小红书 ↗/);
  await expect(links.nth(3)).toHaveAttribute("href", /^https:\/\/www\.xiaohongshu\.com\//);
  await expect(links.nth(0)).toHaveAttribute("href", /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
  await expect(links.nth(1)).toHaveAttribute("href", /^https:\/\/map\.naver\.com\/p\/search\//);
  await expect(links.nth(2)).toHaveAttribute("href", /^https:\/\/map\.kakao\.com\/link\/search\//);
  // 检索串优先韩文名(中文名在韩国地图上搜不到),且三个目标共用同一个 query
  const naver = decodeURIComponent((await links.nth(1).getAttribute("href")) ?? "");
  expect(naver).toContain("60년전통할매국밥");
  expect(naver).not.toContain("60年传统奶奶汤饭");
  // 外链一律新窗口打开
  await expect(links.nth(0)).toHaveAttribute("rel", /noopener/);

  // 汇总数与实际渲染的卡片数一致(不写死 40,表格改了这条也不会红)
  await expect(page.locator(".count")).toHaveText(`${await page.locator(".eat-card").count()} 家`);

  // 没有人工链接的店就只有三个地图入口 —— 别给所有卡都渲染一个空链接
  const plain = page.locator('[data-eat-id="cu"]');
  await expect(plain.locator(".eat-links a")).toHaveCount(3);
  await expect(page.locator(".eat-curated")).toHaveCount(5);
});

// 回归 `PLAN-20260917002528`:同名 key `q` 在影片库 / 红黑榜 / 吃喝三页各有一份语义,
// 主导航原先把整条 search 原样搬过去 —— 用户在影片库搜「Midnight Passion」,切到吃喝时
// 搜索框里躺着那句话,列表被同一根 needle 过滤成「没有匹配的店」。
test("影片库的搜索词不会跟着导航进吃喝(搜索词不跨页)", async ({ page }) => {
  await lookupOff(page);
  await ready(page, "/library");
  await page.getByRole("searchbox", { name: "搜索影片" }).fill("Midnight Passion");
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("Midnight Passion");

  await page.getByRole("navigation", { name: "主要导航" }).getByRole("link", { name: "吃喝", exact: true }).click();
  await expect(page.getByRole("heading", { name: "吃喝", exact: true })).toBeVisible();

  await expect(page.getByRole("searchbox", { name: "搜索店铺" })).toHaveValue("");
  expect(new URL(page.url()).searchParams.has("q")).toBe(false);
  // 阴性对照:清单是全量,不是「因为过滤成空所以才没搜索词」
  await expect(page.locator(".eat-card")).not.toHaveCount(0);
});

// 阳性对照:排片表的浏览上下文(`date` / `hour`)是**刻意**跨页保留的 ——
// 修搜索词串台时不能顺手把它一起丢掉。
test("排片表的日期跨页保留:切到吃喝再切回来仍是同一天", async ({ page }) => {
  await lookupOff(page);
  await ready(page, "/schedule?date=2026-10-07");
  const nav = page.getByRole("navigation", { name: "主要导航" });
  await nav.getByRole("link", { name: "吃喝", exact: true }).click();
  expect(new URL(page.url()).searchParams.get("date")).toBe("2026-10-07");
  await nav.getByRole("link", { name: "排片表", exact: true }).click();
  await expect(page.getByRole("button", { name: "选择日期 2026-10-07" })).toHaveAttribute("aria-pressed", "true");
});

test("搜索与分区筛选", async ({ page }) => {
  await lookupOff(page);
  await ready(page, "/eats");
  // 先等清单真的渲染出来再取基线 —— 否则会在 eats.json 还没到位时数到 0
  await expect(page.locator('[data-eat-id="halmae-gukbab"]')).toBeVisible();
  const total = await page.locator(".eat-card").count();

  await page.getByRole("searchbox", { name: "搜索店铺" }).fill("雪绿茶");
  await expect(page.locator(".eat-card")).toHaveCount(1);
  await expect(page.locator(".eat-card")).toContainText("오설록");

  // 清掉关键词,只留分区筛选
  await page.getByRole("searchbox", { name: "搜索店铺" }).fill("");
  await expect(page.locator(".eat-card")).toHaveCount(total);
  // Spectrum 的 Picker 触发按钮的可访问名含当前值(「分区 全部分区」)→ 用正则而非 exact
  await page.getByRole("button", { name: /分区/ }).click();
  await page.getByRole("option", { name: "东区", exact: true }).click();
  const shuffled = page.locator(".eat-card");
  const east = await shuffled.count();
  expect(east).toBeGreaterThan(0);
  expect(east).toBeLessThan(total);
  await expect(page.locator('[data-eat-id="halmae-gukbab"]')).toBeVisible();
  await expect(page.locator(".eat-chip").first()).toHaveText("东区");

  // 搜不到时给明确空态,不是白屏
  await page.getByRole("searchbox", { name: "搜索店铺" }).fill("이런가게는없다");
  await expect(page.locator(".eat-card")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "没有匹配的店" })).toBeVisible();
});

test("添加心仪的店:落 biff.eats.v1 并出现在列表最前", async ({ page }) => {
  await lookupOff(page);
  await ready(page, "/eats");
  await page.getByRole("button", { name: "添加心仪的店" }).click();
  const dialog = page.getByRole("dialog", { name: "添加心仪的店" });
  await expect(dialog).toBeVisible();
  // 店名没填时不能让「添加」可用 —— 否则会往列表里塞一个空卡片
  const submit = dialog.getByRole("button", { name: "添加", exact: true });
  await expect(submit).toBeDisabled();
  await dialog.getByRole("textbox", { name: "店名" }).fill("五福猪肉汤饭");
  await dialog.getByRole("textbox", { name: /地址/ }).fill("부산 해운대구 해운대로143번길 17");
  await dialog.getByRole("textbox", { name: /备注/ }).fill("影迷推荐");
  await submit.click();
  await expect(dialog).toBeHidden();

  const mine = page.locator(".eat-card").first();
  await expect(mine).toHaveClass(/eat-mine/);
  await expect(mine).toContainText("五福猪肉汤饭");
  await expect(mine).toContainText("我添加的");
  await expect(mine).toContainText("影迷推荐");

  // 刷盘:未登录时**只存本地**(不写任何共享位置)
  const saved = await storage(page);
  const list = JSON.parse(saved["biff.eats.v1"]) as { name: string; id: string }[];
  expect(list).toHaveLength(1);
  expect(list[0].name).toBe("五福猪肉汤饭");
  expect(list[0].id.startsWith("user:")).toBe(true);

  // 删除回到表里的店
  await mine.getByRole("button", { name: "删除这家" }).click();
  await expect(page.locator(".eat-card")).not.toHaveCount(0);
  await expect(page.locator(".eat-card").first()).not.toHaveClass(/eat-mine/);
  const after = JSON.parse((await storage(page))["biff.eats.v1"]) as unknown[];
  expect(after).toHaveLength(0);
});

test("地图数据源已配置时,Naver 入口换成精确店铺页", async ({ page }) => {
  await page.route("**/api/eats/lookup**", (route) =>
    route.fulfill({
      json: {
        hit: {
          provider: "naver",
          name: "60년전통할매국밥",
          category: "음식점>한식",
          address: "부산 동구 초량동",
          roadAddress: "부산 동구 중앙대로533번길 4",
          phone: "051-000-0000",
          lat: 35.13,
          lng: 129.04,
          url: "https://map.naver.com/p/entry/place/12345",
        },
      },
    }),
  );
  await ready(page, "/eats");
  const card = page.locator('[data-eat-id="halmae-gukbab"]');
  const naver = card.locator(".eat-links a").nth(1);
  await expect(naver).toHaveAttribute("href", "https://map.naver.com/p/entry/place/12345");
  await expect(naver).toHaveText(/Naver 地图（精确）/);
  await expect(card.locator(".eat-phone")).toContainText("051-000-0000");
  // Google / Kakao 不受影响,仍是搜索链接
  await expect(card.locator(".eat-links a").nth(0)).toHaveAttribute("href", /google\.com\/maps\/search/);
  await expect(card.locator(".eat-links a").nth(2)).toHaveAttribute("href", /map\.kakao\.com\/link\/search/);
});
