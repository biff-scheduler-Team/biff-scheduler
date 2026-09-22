import { test, expect, type Locator, type Page } from "@playwright/test";
import { keyOf, ready } from "./helpers";

// 电影红黑榜(2026-09-16,PLAN-20260916102339)。
//
// 三条链路各自独立,测试里分别挡:
//   ① **空榜**:首次进入不该有任何贴纸 —— 早先的「示例铺底」已删(用户:「正式环境不应该是空的」);
//   ② **读**:`GET /api/stats/film-votes` → 卡片上的红黑数字 + 画布上的只读小点;
//   ③ **写**:贴纸变化 → 1200ms 防抖后 `POST /api/stats/film-votes-ping`(整份替换)。
// 页面必须**接口没上线也能用**,所以第一个用例专门验证「聚合为空时贴纸照常」。

/** 读接口返回一份空聚合(等价于「接口刚上线 / 还没人贴」) */
async function stubEmpty(page: Page) {
  await page.route("**/api/stats/film-votes**", (route) =>
    route.fulfill({ json: { edition: "biff-2026", votes: {} } }),
  );
}

/** 读接口返回**指定票数** —— 用来验证画布怎么画别人的票(比例 / 溢出) */
async function stubVotes(page: Page, votes: Record<string, { red: number; black: number }>) {
  await page.route("**/api/stats/film-votes**", (route) =>
    route.fulfill({ json: { edition: "biff-2026", votes } }),
  );
}

/** 某张卡上**已经画出来**的画布。
 *  ⚠ 必须**先滚进视野**:屏幕外的卡一枚贴纸都不画(PLAN-20260922145815),
 *    此时 `data-rb-crowd*` 属性整个缺席,直接 `toHaveAttribute` 会「元素找不到」。
 *    桌面 1512×982 上第 7 张卡恰好在预取范围内,手机上同一张就已经在范围外了 —— 不能靠视口尺寸碰运气。 */
async function paintedCanvas(card: Locator): Promise<Locator> {
  await card.scrollIntoViewIfNeeded();
  return card.locator(".rb-canvas[data-rb-crowd]");
}

test("首次进入是空榜:一枚贴纸都没有,只留一句怎么开始", async ({ page }) => {
  await stubEmpty(page);
  await ready(page, "/redblack");

  // 早先版本会在这里自动铺一份示例 —— 那正是用户报「为什么有一堆默认贴纸」的原因
  await expect(page.locator(".rb-hint")).toBeVisible();
  await expect(page.locator(".rb-dot")).toHaveCount(0);
  await expect(page.locator(".rb-card").first()).toBeVisible();
  // 没有人贴过 → 单部评分显示「—」,而不是 0 分(0 分会被读成「大家都觉得烂」)
  await expect(page.locator(".rb-card").first().locator(".rb-chip--score")).toHaveText("评分 —");
});

test("榜单铺出去重后的影片,同一部只出现一次,且能按场次 code 搜到", async ({ page }) => {
  await stubEmpty(page);
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
  // ⚠ 搜索词是**延迟 200ms 合并提交**的(`QuerySearchField`,`PLAN-20260917112233`)。
  //   `target` 卡在过滤前本来就在列表里 —— 先断 `toBeVisible` 会立刻通过、等不到过滤生效,
  //   所以这里必须用会重试的 `expect.poll` 等数量真的降下来。
  await expect.poll(() => cards.count()).toBeLessThan(total);
  await expect(page.locator(`.rb-card[data-film-key="${target}"]`)).toBeVisible();
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
  await ready(page, "/redblack");

  const key = keyOf("008");
  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  // 空榜阶段不该有任何上报 —— 否则「新设备本地为空」会被服务端理解成「我把票撤光了」
  expect(pings).toHaveLength(0);

  await card.getByRole("button", { name: /^标记《/ }).click();
  await card.getByRole("button", { name: /贴红贴纸/ }).click();

  // 自己贴的那一枚:立刻可见(不等服务端)
  await expect(card.locator(".rb-dot--red")).toHaveCount(1);
  await expect(card.locator(".rb-canvas-hint")).toHaveCount(0);

  // 上报是整份替换,载荷里就是「我贴出来的那几枚」
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
  await ready(page, "/redblack");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await expect(card.locator(".rb-chip--red")).toHaveText("红 3");
  await expect(card.locator(".rb-chip--black")).toHaveText("黑 2");
  // 评分是**每部各自的**:3 红 2 黑 → 3/5 × 10 = 6.0;
  // 顶部那个「全站评分」已经不需要了(用户 2026-09-16)
  await expect(card.locator(".rb-chip--score")).toHaveText("评分 6.0");
  await expect(page.locator(".rb-score")).toHaveCount(0);
  // 别人的 5 枚画在画布上。⚠ 2026-09-22 起只读贴纸由 canvas 绘制(PLAN-20260922145815),
  //   数不出 DOM 点,改成读画布上的**机读契约**:`data-rb-crowd*` = 真的画出来的红黑构成
  const canvas = await paintedCanvas(card);
  await expect(canvas).toHaveAttribute("data-rb-crowd", "5");
  await expect(canvas).toHaveAttribute("data-rb-crowd-red", "3");
  await expect(canvas).toHaveAttribute("data-rb-crowd-black", "2");
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
  await ready(page, "/redblack");

  // 默认档是「总数」,红票多的本来就该在前;点「红榜」后判据换成红票数,顺序不该变
  await page.getByRole("button", { name: "红榜", exact: true }).click();
  await expect(page.locator(".rb-card").first()).toHaveAttribute("data-film-key", top);
  await expect(page.locator(`.rb-card[data-film-key="${low}"]`)).toBeVisible();
});

// 画布上「别人的贴纸」怎么画(2026-09-22,PLAN-20260922142903 → PLAN-20260922145815):
// ① 每卡 16 枚的上限已取消 —— 票数几枚就画几枚,「+N」角标随之不存在;
// ② 少数派颜色不能被抹掉(卡片写着「红 1」而画布上一个红点都没有)。
test("票数几枚就画几枚:100 枚全部画出来,没有「+N」角标", async ({ page }) => {
  const key = keyOf("008");
  await stubVotes(page, { [key]: { red: 60, black: 40 } });
  await ready(page, "/redblack");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await expect(card.locator(".rb-chip--red")).toHaveText("红 60");
  await expect(card.locator(".rb-chip--black")).toHaveText("黑 40");
  const canvas = await paintedCanvas(card);
  await expect(canvas).toHaveAttribute("data-rb-crowd", "100");
  await expect(canvas).toHaveAttribute("data-rb-crowd-red", "60");
  await expect(canvas).toHaveAttribute("data-rb-crowd-black", "40");
  // 上限与角标都已下线
  await expect(card.locator(".rb-overflow")).toHaveCount(0);
});

test("少数派颜色不会被抹掉:1 红 / 100 黑 也画得出那枚红", async ({ page }) => {
  const key = keyOf("008");
  await stubVotes(page, { [key]: { red: 1, black: 100 } });
  await ready(page, "/redblack");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await expect(card.locator(".rb-chip--red")).toHaveText("红 1");
  // 画布真的画了 101 枚、其中 1 枚红 —— 曾经的「按比例取整」会把这枚红抹掉
  const canvas = await paintedCanvas(card);
  await expect(canvas).toHaveAttribute("data-rb-crowd", "101");
  await expect(canvas).toHaveAttribute("data-rb-crowd-red", "1");
  await expect(canvas).toHaveAttribute("data-rb-crowd-black", "100");
});

// 渲染预算的单位是「同时画几张卡」而不是「每卡画几枚」(PLAN-20260922145815):
// 299 张卡里只有 4~6 张在视口附近,屏幕外的卡一枚都不该画 —— 这条是性能修复的**回归判据**,
// 它退化的表现只是「页面变卡」,没有任何报错,只能靠断言守住。
test("屏幕外的卡片一枚贴纸都不画,滚回视野再补齐", async ({ page }) => {
  const key = keyOf("008");
  await stubVotes(page, { [key]: { red: 3, black: 2 } });
  await ready(page, "/redblack");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  const painted = await paintedCanvas(card);
  await expect(painted).toHaveAttribute("data-rb-crowd", "5");

  // 滚到页面底部:这张卡离开「视口 + 预取边距」→ 画布连机读属性都不再挂(= 一枚没画)
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(card.locator(".rb-canvas[data-rb-crowd]")).toHaveCount(0);

  // 回到这张卡:补齐(贴纸是绝对定位,补画不引起版面跳动,所以这里只需断言属性回来)
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator(".rb-canvas[data-rb-crowd]")).toHaveAttribute("data-rb-crowd", "5");
});

test("「别人的贴纸」与我贴的那枚同尺寸,别人那枚仍不可拖", async ({ page }) => {
  const key = keyOf("008");
  await stubVotes(page, { [key]: { red: 3, black: 2 } });
  await ready(page, "/redblack");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /^标记《/ }).click();
  await card.getByRole("button", { name: /贴红贴纸/ }).click();

  const mine = card.locator(".rb-dot:not(.rb-dot--crowd)");
  const crowd = card.locator(".rb-dot--crowd").first();
  await expect(mine).toHaveCount(1);
  // 用户 2026-09-22:「完全拉平,只靠能不能拖区分」—— 尺寸与实心度都必须一致。
  // ⚠ 不能拿 `boundingBox()` 比:贴纸带 ±15° 歪斜,包围盒随各自角度变(实测 26.98 vs 26.58),
  //   比**布局尺寸**才说明问题。
  await expect(crowd).toHaveCSS("width", "26px");
  await expect(crowd).toHaveCSS("height", "26px");
  await expect(crowd).toHaveCSS("opacity", "1");
  await expect(mine.first()).toHaveCSS("width", "26px");
  // 拉平之后,**唯一**的差异就是这个:别人的拖不动
  await expect(crowd).toHaveCSS("pointer-events", "none");
  await expect(mine.first()).toHaveCSS("cursor", "grab");
});

test("「只看我贴过」:只列我贴过的片,参数进 URL,再点一次恢复全量", async ({ page }) => {
  await stubEmpty(page);
  await ready(page, "/redblack");

  const key = keyOf("008");
  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /^标记《/ }).click();
  await card.getByRole("button", { name: /贴红贴纸/ }).click();

  const all = await page.locator(".rb-card").count();
  await page.getByRole("button", { name: "只看我贴过" }).click();
  await expect(page.locator(".rb-card")).toHaveCount(1);
  await expect(page.locator(`.rb-card[data-film-key="${key}"]`)).toBeVisible();
  // 筛选是**独立参数**,不挤进 `sort`(排序档位此时仍是默认「总数」)
  expect(new URL(page.url()).searchParams.get("only")).toBe("mine");
  expect(new URL(page.url()).searchParams.get("sort")).toBeNull();

  await page.getByRole("button", { name: "只看我贴过" }).click();
  await expect.poll(() => page.locator(".rb-card").count()).toBe(all);
  expect(new URL(page.url()).searchParams.get("only")).toBeNull();
});

// 「有新贴纸 · 重新排序」只在**数量变化**时才提示(2026-09-22,PLAN-20260922142903)。
// 触发场景:贴一枚 → 上报成功 → 前端重拉票数。重拉拿到的是**新对象**,
// 若拿对象引用当判据,数字一模一样提示也会白亮一次 —— 用户看到的就是「莫名提示」。
test("重拉同一份票数不算「有新贴纸」:数量没变就不提示重排", async ({ page }) => {
  const key = keyOf("008");
  let reads = 0;
  // 读接口**固定**返回同一份票数(不随上报变化)—— 模拟「服务端还没算上我这票」
  await page.route("**/api/stats/film-votes**", async (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({ json: { ok: true, count: 1 } });
    }
    reads += 1;
    return route.fulfill({ json: { edition: "biff-2026", votes: { [key]: { red: 3, black: 2 } } } });
  });
  await ready(page, "/redblack");

  const resort = page.locator(".rb-resort");
  // 首次载入时榜单顺序还是默认序 —— 这时提示一次是**对的**,点掉它。
  // ⚠ 属性值是 `"true"` 而不是空串:React 对 `data-*` 上的布尔值走 `setAttribute(String(v))`
  //   (`data-rb-stale={orderStale || undefined}`),空串那版断言从来没成立过 —— 写断言要写**实际值**。
  await expect(resort).toHaveAttribute("data-rb-stale", "true");
  await resort.click();
  await expect(resort).not.toHaveAttribute("data-rb-stale");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /^标记《/ }).click();
  await card.getByRole("button", { name: /贴红贴纸/ }).click();
  // ⚠ 必须排掉 `.rb-dot--crowd`:这一部服务端也返回了 3 枚红,`.rb-dot--red` 会把它们一起数进来
  await expect(card.locator(".rb-dot--red:not(.rb-dot--crowd)")).toHaveCount(1);

  // 等 ping 之后那次**重拉**真的发生(上报有 1200ms 防抖)
  await expect.poll(() => reads, { timeout: 8000 }).toBeGreaterThan(1);
  // 给 setVotes → 重渲染留一拍:修复前这里会亮起「有新贴纸」(votes 换了新对象)
  await page.waitForTimeout(500);
  await expect(resort).not.toHaveAttribute("data-rb-stale");
});
