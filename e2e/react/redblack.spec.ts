import { test, expect } from "@playwright/test";
import { keyOf, ready, seed } from "./helpers";

// 电影红黑榜(2026-09-16,PLAN-20260916102339)。
//
// 两条链路各自独立,测试里分别挡:
//   ① **读**:`GET /api/stats/film-votes` → 卡片上的红黑数字 + 画布上的只读小点;
//   ② **写**:贴纸变化 → 1200ms 防抖后 `POST /api/stats/film-votes-ping`(整份替换)。
// 页面必须**接口没上线也能用**,所以第三个用例专门验证「聚合为空时贴纸照常」。

/** 关掉示例铺底:示例会让「我贴了几枚」的断言变成玄学(内容随排期变) */
const noDemo = { "biff.redblack.seen.v1": "off" };

/** 读接口返回一份空聚合(等价于「接口刚上线,还没人贴」) */
async function stubEmpty(page: import("@playwright/test").Page) {
  await page.route("**/api/stats/film-votes**", (route) =>
    route.fulfill({ json: { edition: "biff-2026", votes: {} } }),
  );
}

test("榜单铺出去重后的影片,同一部只出现一次,且能按场次 code 搜到", async ({ page }) => {
  await stubEmpty(page);
  await seed(page, noDemo);
  await ready(page, "/redblack");

  const cards = page.locator(".rb-card");
  await expect(cards.first()).toBeVisible();
  const keys = await cards.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-film-key")),
  );
  expect(keys.length).toBeGreaterThan(1);
  // 判同来源与影片库一致(filmNodeKey + buildFilms),所以这里不该出现重复的 key
  expect(new Set(keys).size).toBe(keys.length);

  const target = keyOf("008");
  const total = keys.length;
  await page.getByRole("searchbox").fill("008");
  await expect(page.locator(`.rb-card[data-film-key="${target}"]`)).toBeVisible();
  expect(await cards.count()).toBeLessThan(total);
});

test("标记「看过」→ 贴一枚红:画布上立刻出现,并上报给服务端", async ({ page }) => {
  const pings: Array<{ votes?: unknown }> = [];
  await page.route("**/api/stats/film-votes**", async (route) => {
    if (route.request().method() === "POST") {
      pings.push(route.request().postDataJSON() as { votes?: unknown });
      return route.fulfill({ json: { ok: true, count: 1 } });
    }
    return route.fulfill({ json: { edition: "biff-2026", votes: {} } });
  });
  await seed(page, noDemo);
  await ready(page, "/redblack");

  const key = keyOf("008");
  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /^标记《/ }).click();
  await card.getByRole("button", { name: /贴红贴纸/ }).click();

  // 自己贴的那一枚:立刻可见(不等服务端)
  await expect(card.locator(".rb-dot--red")).toHaveCount(1);
  await expect(card.locator(".rb-canvas-hint")).toHaveCount(0);

  // 上报是整份替换,载荷里就是「我贴出来的那几枚」。
  // ⚠ 载入时也会上报一次(那时榜是空的),所以要 poll **最后一次**载荷的内容,
  //   而不是「有没有发生过上报」—— 后者在空榜那次就已经满足了。
  await expect
    .poll(() => pings.at(-1)?.votes ?? null, { timeout: 8000 })
    .toEqual([{ key, vote: "red" }]);
});

test("服务端的全体票数渲染成卡片上的红黑数字与只读小点", async ({ page }) => {
  const key = keyOf("008");
  await page.route("**/api/stats/film-votes**", (route) =>
    route.fulfill({
      json: { edition: "biff-2026", votes: { [key]: { red: 3, black: 2 } } },
    }),
  );
  await seed(page, noDemo);
  await ready(page, "/redblack");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await expect(card.locator(".rb-chip--red")).toHaveText("红 3");
  await expect(card.locator(".rb-chip--black")).toHaveText("黑 2");
  // 别人的 5 枚画在画布上,且**不可拖**(不挂 pointerdown → 不是可抓取的手型)
  await expect(card.locator(".rb-dot--crowd")).toHaveCount(5);
});

test("切「红榜」:按红票数降序,票多的排前面", async ({ page }) => {
  const top = keyOf("008");
  const low = keyOf("001");
  await page.route("**/api/stats/film-votes**", (route) =>
    route.fulfill({
      json: {
        edition: "biff-2026",
        votes: { [top]: { red: 5, black: 0 }, [low]: { red: 1, black: 0 } },
      },
    }),
  );
  await seed(page, noDemo);
  await ready(page, "/redblack");

  // 默认档是「总数」,红票多的本来就该在前;点「红榜」后判据换成红票数,顺序不该变
  await page.getByRole("button", { name: "红榜", exact: true }).click();
  await expect(page.locator(".rb-card").first()).toHaveAttribute("data-film-key", top);
  await expect(page.locator(`.rb-card[data-film-key="${low}"]`)).toBeVisible();
});
