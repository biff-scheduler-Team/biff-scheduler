import { test, expect, type Locator, type Page } from "@playwright/test";
import { keyOf, legacyData, paintedTexts, ready, seed, trackPaintedTexts } from "./helpers";

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
  await ready(page, "/redblack?sort=red");

  // 早先版本会在这里自动铺一份示例 —— 那正是用户报「为什么有一堆默认贴纸」的原因
  await expect(page.locator(".rb-hint")).toBeVisible();
  await expect(page.locator(".rb-dot")).toHaveCount(0);
  await expect(page.locator(".rb-card").first()).toBeVisible();
  // 讨论区入口**恒显**，0 票的片也有（2026-09-29）：它取代了原来那个「一枚都没有时不给入口」的
  // 「看全部」——「还没人评过」本身就是信息，而且第一句评语要有个入口。
  await expect(page.locator(".rb-card").first().getByRole("button", { name: /讨论区/ })).toHaveCount(1);
  // 没有人贴过 → 单部评分显示「—」,而不是 0 分(0 分会被读成「大家都觉得烂」)
  // ⚠ 2026-09-30 起评分是**海报右上角的角标**(用户要求「能收起就收起」),
  //   所以它只写数字、类名从 `.rb-chip--score` 换成了 `.rb-poster-score`。
  await expect(page.locator(".rb-card").first().locator(".rb-poster-score")).toHaveText("—");
});


test("榜单铺出去重后的影片,同一部只出现一次,且能按场次 code 搜到", async ({ page }) => {
  await stubEmpty(page);
  await ready(page, "/redblack?sort=red");

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

// 合集场次拆成成员片(2026-10-14,PLAN-20261014112444)。
// 用户原话:「我在红黑榜搜索 062 …出现的是 'Asian Short Film Competition 1',
//   我希望出现的是和影片库一样是『她说』」—— `062` 是「Asian Short Film Competition 1」
//   这个短片竞赛合集场次的编号(一张票连看 5 部),那 5 部此前在榜上既搜不到也贴不了票。
test("搜合集场次编号 062 → 出现的是 5 部成员片(含《她说》),不再是一张合集卡", async ({ page }) => {
  await stubEmpty(page);
  await ready(page, "/redblack?sort=red");

  await page.getByRole("searchbox").fill("062");
  // ⚠ 搜索词是 200ms 合并提交的(见上一条用例)—— 先断**数量**,否则「还没过滤时就通过」会假绿:
  //   成员片本来就在整份榜单里,`toBeVisible()` 在过滤前也成立。
  await expect(page.locator(".rb-card")).toHaveCount(5);
  const sheSaid = page.locator('.rb-card[data-film-key="cat:f228"]');
  await expect(sheSaid).toBeVisible();
  await expect(sheSaid.locator(".rb-title")).toHaveText("她说");
  // 合集卡本身已不在榜上(它被拆成了那 5 张)
  await expect(
    page.locator('.rb-card[data-film-key="sched:asian short film competition 1"]'),
  ).toHaveCount(0);
});

// 午夜联映块也拆开(2026-10-15,PLAN-20261015155041)。
// 用户原话:「jim queen 在 midnight passion 里有场次,但是可以单独打分,这种打分也要拆下」——
// `269` =`Midnight Passion 3` 的块编号,3 部成员(Jim Queen / Welcome to Dolly′s House /
// Angel′s Egg)自己就有场次、本来就在榜上;块卡只是一张**重复计票**的卡。
test("搜午夜联映块编号 269 → 出现的是 3 部成员片(含 Jim Queen),不再是一张块卡", async ({ page }) => {
  await stubEmpty(page);
  await ready(page, "/redblack?sort=red");

  await page.getByRole("searchbox").fill("269");
  // ⚠ 与 062 那条同一个坑:成员片本来就在整份榜单里,先断数量再断可见性(否则「还没过滤」也通过)
  await expect(page.locator(".rb-card")).toHaveCount(3);
  await expect(page.locator('.rb-card[data-film-key="cat:f211"]')).toBeVisible();
  // 块卡本身已不在榜上(它被拆成了那 3 张)
  await expect(page.locator('.rb-card[data-film-key="sched:midnight passion 3"]')).toHaveCount(0);
});

// hero 上那行「全站」数字是**整份榜单**的口径,不该被搜索词牵动
// (用户 2026-10-12 报:「输入编号搜索后 总览上面的这个数字会变化」)。
// 根因:`totals` 的全站红 / 黑原来是从 `filmCounts` 累加的,而 `filmCounts` 只覆盖当前
//   **搜索命中**的那几部 —— 一搜,「424 枚贴纸 红 289 · 黑 135」就跟着缩水。
// 判据取「搜索前后逐字相同」,而不是某个固定数:搜索只该缩减栅格,总览一个字都不许变。
test("按场次编号搜索时,hero 的全站总览数字不变", async ({ page }) => {
  const a = keyOf("008");
  const b = keyOf("033");
  await stubVotes(page, { [a]: { red: 3, black: 2 }, [b]: { red: 1, black: 4 } });
  await ready(page, "/redblack?sort=red");

  const global = page.locator(".rb-global");
  const num = global.locator(".rb-global-num");
  // ⚠ `.rb-global-split` 是 `.rb-global` 的**兄弟**(同挂在 `.rb-stat-card` 下),不是后代
  const split = page.locator(".rb-global-split");
  // 3 + 2 + 1 + 4 = 10,红 4 / 黑 6
  await expect(num).toHaveText("10");
  await expect(split).toHaveText("红 4 · 黑 6");

  const total = await page.locator(".rb-card").count();
  await page.getByRole("searchbox").fill("008");
  // ⚠ 搜索词是 200ms 合并提交的(见上一条用例)—— 必须等过滤**真的生效**再断言,
  //   否则这条会「在还没过滤时就通过」而永远绿。
  await expect.poll(() => page.locator(".rb-card").count()).toBeLessThan(total);

  await expect(num).toHaveText("10");
  await expect(split).toHaveText("红 4 · 黑 6");
});


test("点卡片上的「红」：画布上立刻出现一枚，并上报给服务端", async ({ page }) => {
  const pings: Array<{ ops?: unknown }> = [];
  await page.route("**/api/stats/film-votes**", async (route) => {
    if (route.request().method() === "POST") {
      pings.push(route.request().postDataJSON() as { ops?: unknown });
      return route.fulfill({ json: { ok: true, count: 1, votes: {}, skins: {} } });
    }
    return route.fulfill({ json: { edition: "biff-2026", votes: {} } });
  });
  await ready(page, "/redblack?sort=red");

  const key = keyOf("008");
  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  // 空榜阶段不该有任何上报 —— 否则「新设备本地为空」会被服务端理解成「我把票撤光了」
  expect(pings).toHaveLength(0);

  await card.getByRole("button", { name: /贴红贴纸/ }).click();

  // 自己贴的那一枚:立刻可见(不等服务端)
  await expect(card.locator(".rb-dot--red")).toHaveCount(1);
  await expect(card.locator(".rb-canvas-hint")).toHaveCount(0);

  // 上报是**增量 op**（2026-10-05，PLAN-20261005182415 §C）：载荷里是「改动了什么」，
  // 第一次调度（本机还没有任何 base）会把整面墙作为 `set` 发上去。
  // ⚠ `comment` / `skin` 两个字段都必须**在** `set` op 里：服务端把它当成「这部片现在是这个状态」
  //   整条覆盖 —— 省掉字段等于告诉它「这部片没有评语 / 没带款」，那不是用户的意思（他刚改的是颜色）。
  await expect.poll(() => pings.at(-1)?.ops ?? null, { timeout: 8000 }).toHaveLength(1);
  const sent = (pings.at(-1)?.ops ?? []) as Array<Record<string, unknown>>;
  expect(sent[0]).toMatchObject({ op: "set", key, vote: "red", comment: null });
  // ⚠ **不能写死是哪一款**:刚贴下那枚的款由 id 推导(而 id 带随机后缀),
  //   这里只断言「字段在,且是契约层白名单里的一款」—— 写死会变成一条看运气的断言。
  expect("skin" in sent[0]).toBe(true);
  // ⚠ 这份名单**镜像契约层** `@biff/contracts/sticker` 的 `STICKER_SKIN_KEYS`
  //   (E2E 里没有 workspace 包的 paths,引不进来,只能抄)。换款时必须跟着改 ——
  //   2026-09-30 换款时就漏了这条(以及 `anotherSkin` 里那份),CI 一跑就红,
  //   那条漏的已改成从 DOM 读;这条留着是因为这里**不开轮盘**,没有别的东西可对齐。
  expect(String(sent[0].skin)).toMatch(/^(stub|scrap|sprocket)$/);
});

test("服务端的全体票数渲染成卡片上的红黑数字与只读小点", async ({ page }) => {
  const key = keyOf("008");
  await page.route("**/api/stats/film-votes**", (route) =>
    route.fulfill({
      json: { edition: "biff-2026", votes: { [key]: { red: 3, black: 2 } } },
    }),
  );
  await ready(page, "/redblack?sort=red");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  // ⚠ 2026-09-30:红黑合成**一颗**(「红 166 · 黑 73」) —— 判据从两颗各自比对
  //   换成「这一颗的逐字文本」;0 的那一侧不出现,所以两端都非 0 时格式是「红 N · 黑 N」。
  await expect(card.locator(".rb-chip--tally")).toHaveText("红 3 · 黑 2");
  // 评分是**每部各自的**(加权红占比,2026-10-12 起):全站只有这一部有票 → C = 3/5 = 0.6,
  // 于是 (3 + 5×0.6) / (5 + 5) = 6.0;
  // 顶部那个「全站评分」已经不需要了(用户 2026-09-16)
  await expect(card.locator(".rb-poster-score")).toHaveText("6.0");
  await expect(page.locator(".rb-score")).toHaveCount(0);
  // 别人的 5 枚画在画布上。⚠ 2026-09-22 起只读贴纸由 canvas 绘制(PLAN-20260922145815),
  //   数不出 DOM 点,改成读画布上的**机读契约**:`data-rb-crowd*` = 真的画出来的红黑构成
  const canvas = await paintedCanvas(card);
  await expect(canvas).toHaveAttribute("data-rb-crowd", "5");
  await expect(canvas).toHaveAttribute("data-rb-crowd-red", "3");
  await expect(canvas).toHaveAttribute("data-rb-crowd-black", "2");
});

test("默认就是红榜:红票多的在前;切黑榜后按黑票反过来", async ({ page }) => {
  const good = keyOf("008");
  const bad = keyOf("001");
  // good = 40 红 2 黑、bad = 1 红 3 黑：红榜按红票（40 > 1）good 在前，
  // 黑榜按黑票（3 > 2）bad 在前
  await page.route("**/api/stats/film-votes**", (route) =>
    route.fulfill({
      json: {
        edition: "biff-2026",
        votes: { [good]: { red: 40, black: 2 }, [bad]: { red: 1, black: 3 } },
      },
    }),
  );
  await ready(page, "/redblack?sort=red");

  // ⚠ 2026-10-12 起只留两榜，默认档从「总数」变成**红榜** —— 首屏不用点任何按钮
  await expect(page.locator(".rb-card").first()).toHaveAttribute("data-film-key", good);

  // 切「黑榜」：改按**黑票**降序，黑票多的那部排前面
  // ⚠ 2026-10-14（PLAN-20261014150805 修订 1）：档位改由「榜单」页外壳的 tab 托管，
  //   页面自己那个 `.rb-seg` 分段控件已不再渲染 —— 入口从它改成外壳的 tab。
  await page.locator('[data-board-tab="black"]').click();
  await expect(page.locator(".rb-card").first()).toHaveAttribute("data-film-key", bad);
});

// 画布上「别人的贴纸」怎么画(2026-09-22,PLAN-20260922142903 → PLAN-20260922145815):
// ① 每卡 16 枚的上限已取消 —— 票数几枚就画几枚,「+N」角标随之不存在;
// ② 少数派颜色不能被抹掉(卡片写着「红 1」而画布上一个红点都没有)。
test("票数几枚就画几枚:100 枚全部画出来,没有「+N」角标", async ({ page }) => {
  const key = keyOf("008");
  await stubVotes(page, { [key]: { red: 60, black: 40 } });
  await ready(page, "/redblack?sort=red");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await expect(card.locator(".rb-chip--tally")).toHaveText("红 60 · 黑 40");
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
  await ready(page, "/redblack?sort=red");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  // ⚠ 期望值必须**两侧都写**(2026-09-30,CI 实测红):红黑合并成一颗之后,两侧都非 0 就都出现 ——
  //   只写「红 1」是合并前「红黑各一颗」时代的残留(那时这一条只断言红那颗)。
  await expect(card.locator(".rb-chip--tally")).toHaveText("红 1 · 黑 100");
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
  await ready(page, "/redblack?sort=red");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  const painted = await paintedCanvas(card);
  await expect(painted).toHaveAttribute("data-rb-crowd", "5");

  // 滚到页面底部:这张卡离开「视口 + 预取边距」→ 画布连机读属性都不再挂(= 一枚没画)
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(card.locator(".rb-canvas[data-rb-crowd]")).toHaveCount(0);
  // backing store 也要真的释放:一张卡约 1MB(含 dpr 放大),299 张全留就是几百 MB 显存
  await expect(card.locator("canvas.rb-ink")).toHaveJSProperty("width", 0);

  // 回到这张卡:补齐(贴纸是绝对定位,补画不引起版面跳动,所以这里只需断言属性回来)
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator(".rb-canvas[data-rb-crowd]")).toHaveAttribute("data-rb-crowd", "5");
  await expect(card.locator("canvas.rb-ink")).not.toHaveJSProperty("width", 0);
});

// 「按视口省渲染」只管**别人的**那一层 canvas:我贴的那一枚是**真实元素**,
// 屏幕外也必须留在 DOM 里 —— 它要是跟着群点一起被省掉,用户滚回来才看见它,会读成「我的贴纸丢了」。
// ⚠ 2026-10-14（PLAN-20261014190000 修订 3 起）它**只读**了、不再能拖
//   （那份「可拖」在用户「取消贴贴纸所有行为」的口径下删掉了）—— 这条守的还是那个「始终」,
//   只是从「始终抓得到」变成「始终看得见」。
test("屏幕外的卡片仍留着我贴的那一枚:自己的贴纸始终抓得到", async ({ page }) => {
  const key = keyOf("008");
  await stubVotes(page, { [key]: { red: 3, black: 2 } });
  await ready(page, "/redblack?sort=red");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /贴红贴纸/ }).click();
  const mine = card.locator(".rb-dot");
  await expect(mine).toHaveCount(1);

  // 滚到页面底部:这张卡离开「视口 + 预取边距」→ 别人的点连 backing store 都释放了
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(card.locator("canvas.rb-ink")).toHaveJSProperty("width", 0);
  // 我那一枚没被省掉:它还在 DOM 里(所以滚回来时是「本来就在」而不是「补画出来」)
  await expect(mine).toHaveCount(1);
  await card.scrollIntoViewIfNeeded();
  await expect(mine).toHaveCount(1);
  // 而且它压在最上层、点得到自己 —— 它是**一块真实的画**（不是画在 canvas 上的群点）
  // (群点在 `.rb-ink` 上,那层 `pointer-events: none`,不会把它盖住)
  // ⚠ 用 `expect.poll` 而不是量一次就断:提示条(S2 `ToastQueue`)的进出场走 View Transitions,
  //   过渡那几帧整页被一层快照盖住 —— `elementFromPoint()` 会返回 `<html>` 而不是贴纸本身。
  //   那是**暂时**的,与「我的那一枚有没有被压住」不是一回事(`mine` 是真实元素、`.rb-ink`
  //   又是 `pointer-events: none`,这条断言守的是后者)。2026-09-28 CI 上就红在这里。
  const hitSelf = () =>
    mine.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit === node || node.contains(hit);
    });
  await expect.poll(hitSelf).toBe(true);
});

test("「别人的贴纸」与我贴的那枚同尺寸,只差常驻纸白边（我贴的那枚已只读）", async ({ page }) => {
  const key = keyOf("008");
  await stubVotes(page, { [key]: { red: 3, black: 2 } });
  await ready(page, "/redblack?sort=red");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /贴红贴纸/ }).click();

  const mine = card.locator(".rb-dot");
  await expect(mine).toHaveCount(1);
  // 尺寸口径同源两处:CSS 的 `.rb-dot` 与 canvas sprite 的 `sticker-sprite.ts::STICKER_SIZE`
  // (26 → 20 → 32 → 20 → 24,用户五轮改过;单测守着 sprite 那一侧,这里守 DOM 这一侧)
  await expect(mine.first()).toHaveCSS("width", "24px");
  // ⚠ 2026-10-14（PLAN-20261014190000 修订 3）：`cursor` 从 `grab` 改成 `inherit` ——
  //   它不再是一根拖拽手柄了，留着抓手等于**承诺一个不存在的手势**（用户会按住试图拖）。
  //   这条断言于是**反过来**守这件事：任何一天有人把 `grab` 加回来，它就红。
  await expect(mine.first()).not.toHaveCSS("cursor", "grab");

  // 贴纸本体(2026-09-29):外形**不是** `border-radius`,而是内联 `--rb-shape` 交给 `clip-path`;
  // 中心微图标与沿轮廓的内描边是两枚 SVG。三者都必须真的渲染出来 —— 少一个不是报错,
  // 而是贴纸悄悄退回「纯色圆点」,只有人眼看得出来。
  await expect(mine.first().locator(".rb-dot__face")).toHaveCount(1);
  await expect(mine.first().locator(".rb-dot__face")).toHaveCSS("clip-path", /path\(/);
  await expect(mine.first().locator(".rb-dot__edge path")).toHaveCount(1);
  await expect(mine.first().locator(".rb-dot__icon path")).toHaveCount(1);
  // 内联变量里的那条路径必须**真的按贴纸尺寸**生成 —— 这是 `clip-path: path()` 的经典坑:
  // 它是**绝对 px**、不像 SVG 的 `viewBox` 那样随元素缩放。生成时用了别的尺寸(比如设计盒的 32)
  // 不会报错,只会把贴纸**静默地**裁掉右下角 —— 只有人眼看得出来。
  // 量法:把那段路径塞进一个临时 SVG 量 `getBBox()`;真按 24 生成 → 包围盒就是 24×24 上下,
  // 用错尺寸则会是 32。
  // ⚠ 2026-09-29 起 `--rb-shape` 写在**本体那一层**(`.rb-dot__face`,它就是被 `clip-path` 裁的那层),
  //   不再挂在 `.rb-dot` 按钮上 —— 形状与图标一起归 `StickerFace` 管。
  const faceNode = mine.first().locator(".rb-dot__face");
  const box = await faceNode.evaluate((node) => {
    const raw = (node as HTMLElement).style.getPropertyValue("--rb-shape");
    const d = /path\("([^"]+)"\)/.exec(raw)?.[1] ?? "";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
    document.body.append(svg);
    const measured = path.getBBox();
    svg.remove();
    return { width: measured.width, height: measured.height, d };
  });
  expect(box.d.length).toBeGreaterThan(10);
  // ⚠ 判据相对**贴纸自己的尺寸**(24px),不要写死一个区间:三款轮廓的包围盒差得很远 ——
  //   票根 / 胶片齿孔接近占满设计盒,而胶片残片是一条**斜置的窄条**(宽 ~77%、高只 ~56%)。
  // 两个上界抓的是同一件事:按**别的尺寸**生成(比如设计盒的 32)时,包围盒会明显超过 24
  //   —— 所以宽的上界是那条真正可靠的判据。
  // 两个下界只抓「退化 / 真被裁掉一角」,所以取得松(高那一侧最窄的款只有 56%)。
  expect(box.width).toBeLessThanOrEqual(24.5);
  expect(box.width).toBeGreaterThan(24 * 0.65);
  expect(box.height).toBeLessThanOrEqual(24.5);
  expect(box.height).toBeGreaterThan(24 * 0.5);

  // **常驻纸白边**(2026-09-23):我贴的那一枚独有,群点那边(canvas / sprite)不许有这一层 ——
  // 票数一多,同色同尺寸的点里根本认不出自己那枚,「想改票时找得到自己贴的那一枚」就先卡在“找不到”。
  // ⚠ 只断言那一层 `1.5px` 的实心圈(整个 `box-shadow` 字符串各浏览器序列化不同,比不得);
  //   `1.5px` 在这条规则里只出现这一次,所以这个松匹配等于精确匹配。
  await expect(mine.first()).toHaveCSS("box-shadow", /1\.5px/);

  // 别人的贴纸整层是 canvas(2026-09-22,PLAN-20260922145815):
  // ⚠ 必须 `pointer-events: none` —— 它与「我贴的那一枚」是**两处**区别之一(另一处是纸白边);
  //   这一层要是可命中,它就压在自己那枚上面,点不着自己(2026-10-14 起贴纸已不可拖,
  //   但「点得到自己」仍是那条只读契约的判据 —— 与上面那条 `cursor` 断言守的是同一件事)。
  const ink = card.locator("canvas.rb-ink");
  await expect(ink).toHaveCSS("pointer-events", "none");
  await expect(ink).toHaveCount(1);
  // 群点不再是 DOM —— 「数 DOM 点」这件事本身已经不存在了
  await expect(card.locator(".rb-dot--crowd")).toHaveCount(0);

  // 高分屏适配:backing store 必须是 CSS 尺寸 × dpr,否则 Retina / 手机上贴纸边缘发糊
  const backing = await ink.evaluate((node: HTMLCanvasElement) => ({
    width: node.width,
    css: node.getBoundingClientRect().width,
    dpr: window.devicePixelRatio,
  }));
  expect(backing.width).toBe(Math.round(backing.css * backing.dpr));

  // DPR 变化(跨屏拖窗 / 浏览器缩放)必须按**新**倍率重新分配 backing store —— 它**不触发** `resize`,
  // 所以 `use-dpr.ts` 除了 matchMedia 还兜了一刀 resize。这里把 dpr 换一个值 + 触发 resize 来验:
  // 漏了这条的症状是「换个屏幕贴纸就糊」,不报错、不崩,只能靠断言守。
  const next = backing.dpr >= 2 ? 1 : 2;
  await page.evaluate((value) => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => value });
    window.dispatchEvent(new Event("resize"));
  }, next);
  await expect.poll(() => ink.evaluate((node: HTMLCanvasElement) => node.width)).toBe(
    Math.round(backing.css * next),
  );
});

// 卡片级「讨论区」弹层(2026-09-29,PLAN-20260929195500)。
// 它取代了两样东西:「放大看全部」大画布弹层 + 页面底部的「大家说」模块 ——
// 于是评语从「一个与片子无关的长列表」变成**贴着这一部**的讨论区。
// a11y 全部走 S2 `Dialog`(role=dialog / focus trap / Esc),焦点归还由卡片那个按钮自己做,
// 这两条都是 §5 的硬约束,必须有机读断言守着。
test("讨论区:数字与卡片一致、按片读、只列写了评语的人、Esc 关闭并把焦点还回按钮", async ({ page }) => {
  const key = keyOf("008");
  await stubVotes(page, { [key]: { red: 3, black: 2 } });
  const queries: string[] = [];
  await page.route("**/api/stats/film-comments**", (route) => {
    queries.push(route.request().url());
    return route.fulfill({
      json: {
        edition: "biff-2026",
        // 只列**写了评语**的人 —— 这是服务端口径(`isNotNull(comment)`),这里照着喂
        items: [
          { filmKey: key, vote: "red", comment: "拉片细节绝了", displayName: "阿柴" },
          { filmKey: key, vote: "black", comment: "太闷", displayName: null },
        ],
        nextCursor: null,
      },
    });
  });
  await ready(page, "/redblack?sort=red");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /贴红贴纸/ }).click();

  const opener = card.getByRole("button", { name: /讨论区/ });
  await opener.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("讨论区");
  // ⚠ 「红 N · 黑 N」必须与卡片上那两个数字**逐字一致**(同一份修正过的 counts):
  //   服务端那份**已含我**,所以这里不是「别人的 + 我的」相加 —— 加一次就重复了
  await expect(dialog).toContainText("红 3 · 黑 2");
  // ⚠ **按片**读:`filmKey` 没带上时服务端回的是**全场**评语,而弹层照样渲染 ——
  //   看起来完全正常,只是列出来的是别的片。这条断言是唯一能挡住它的东西。
  expect(queries.some((url) => url.includes(`filmKey=${encodeURIComponent(key)}`))).toBe(true);

  // 列表:只列写了评语的人,匿名显示「匿名观众」
  await expect(dialog.locator(".rb-talk-item")).toHaveCount(2);
  await expect(dialog.locator(".rb-talk-item").first()).toContainText("拉片细节绝了");
  await expect(dialog.locator(".rb-talk-item").nth(1)).toContainText("匿名观众");
  // ⚠ 弹层里**一枚贴纸都不画**(大画布已随本轮删除):想看自己那枚,卡片上就是它
  await expect(dialog.locator(".rb-dot")).toHaveCount(0);

  // Esc 关闭 + 焦点归还原按钮
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(opener).toBeFocused();
});


// 刚贴下的那一枚闪描边(PLAN-20260922160432):票多时点按钮贴下去的那一枚会被丢进一片点里,
// 原来没有任何线索指出它在哪;但**必须有界** —— 闪完就与别人的贴纸逐字一致(拉平口径)。
test("刚贴的那一枚会闪描边,闪完与别人的完全一致", async ({ page }) => {
  await stubEmpty(page);
  await ready(page, "/redblack?sort=red");

  const key = keyOf("008");
  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /贴红贴纸/ }).click();

  const mine = card.locator(".rb-dot");
  // ⚠ 属性值是 "true"(React 对 data-* 上的布尔值走 setAttribute(String(v)))
  await expect(mine).toHaveAttribute("data-rb-fresh", "true");
  await expect(mine).toHaveCSS("outline-style", "solid");
  // 有界:2.4s 之后连描边一起去掉 —— 不是常驻标识
  await expect(mine).not.toHaveAttribute("data-rb-fresh");
  await expect(mine).toHaveCSS("outline-style", "none");
});

// 默认档「按红贴纸数（多在前）」在**首屏**就得是真的(2026-09-22,PLAN-20260922161710;
// 2026-10-12 起默认档由「总数」换成红榜;2026-10-14 起判据由评分改成**票数**)。
// 改版前:排序发生在票数到达之前 → 每部并列 0 → 退化成影片库目录序,而 chip 上写着排序口径。
// 这条守的是「票数一落定就自动补排一次」。
test("默认档「按红贴纸数」在首屏就是真的:票数落定后自动排一次", async ({ page }) => {
  const top = keyOf("008");
  await stubVotes(page, { [top]: { red: 40, black: 0 } });
  await ready(page, "/redblack?sort=red");

  await expect(page.locator(".rb-card").first()).toHaveAttribute("data-film-key", top);
  // 顺序已经是按最新票数排的 → 不留下提示
  await expect(page.locator(".rb-resort")).not.toHaveAttribute("data-rb-stale");
});

// 补排**只在用户还没动过手**时发生:在读的人不该被整页重排顶走。
// 这条是那个门槛的回归判据 —— 去掉门槛它就会红(顺序会被改成票最多的那一部打头)。
test("票数落下之前用户已经在滚 → 不补排,顺序照旧并亮起「有新贴纸」", async ({ page }) => {
  const top = keyOf("008");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 把读接口**扣住**不返回,模拟慢网:票数落下之前先让用户滚一下
  await page.route("**/api/stats/film-votes**", async (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({ json: { ok: true, count: 0 } });
    }
    await gate;
    return route.fulfill({ json: { edition: "biff-2026", votes: { [top]: { red: 40, black: 0 } } } });
  });
  await ready(page, "/redblack?sort=red");

  const first = await page.locator(".rb-card").first().getAttribute("data-film-key");
  // ⚠ 用 `window.scrollBy` 而不是 `mouse.wheel`:**WebKit 不支持 `mouse.wheel`**
  //   (仓库里 `vertical-schedule.spec.ts` 也为这条差异分过支)。两者都会派发 `scroll` 事件,
  //   而门槛判的就是这个事件。
  await page.evaluate(() => window.scrollBy(0, 400));
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);

  release();

  // 票数到了,但用户已经动过手 → 顺序不动,提示亮着交给他自己点
  await expect(page.locator(".rb-resort")).toHaveAttribute("data-rb-stale", "true");
  expect(await page.locator(".rb-card").first().getAttribute("data-film-key")).toBe(first);
});

// 生成分享图(2026-09-22;2026-10-12 起两榜):两榜各 TOP10 + **我贴过的全部** + 底部署名。
// 出图是 canvas 手绘、没有 DOM 可断言,所以读**画出来的字**
// (`helpers.ts::trackPaintedTexts` 给 `fillText` 打了补丁)。
test("生成分享图:两榜各 TOP10、我贴过的全部、底部署名", async ({ page }) => {
  await trackPaintedTexts(page);
  const top = keyOf("008");
  const low = keyOf("003");
  // 一部只有红票、一部只有黑票 → 红榜 / 黑榜各自只剩一条,便于断言「该榜按该色排」
  await stubVotes(page, { [top]: { red: 40, black: 0 }, [low]: { red: 0, black: 30 } });
  await ready(page, "/redblack?sort=red");

  const card = page.locator(`.rb-card[data-film-key="${top}"]`);
  const topTitle = (await card.locator(".rb-title").textContent())!.trim();
  await card.getByRole("button", { name: /贴红贴纸/ }).click();

  const opener = page.getByRole("button", { name: "生成分享图" });
  await opener.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".rb-share-preview")).toBeVisible();
  // 出图是异步的(画完才 toBlob),这里等按钮出来即代表图已生成
  await expect(dialog.getByRole("button", { name: "下载 PNG 图片" })).toBeVisible();

  // 每行左侧带影片海报缩略图(2026-10-08)。画布手绘没有 DOM 可断,所以读锚点属性 ——
  // 目录里多数影片有海报,这张图里必须**真的**带了图(而不是整张图都在画占位块)。
  await expect(dialog.locator(".rb-share-preview")).toHaveAttribute(
    "data-poster-count",
    /^[1-9]\d*$/,
  );

  const painted = await paintedTexts(page);
  // 头部 + 两榜标签 + 我的那一节 + 署名:逐项都要画出来
  // ⚠ 「黑榜」三个字在图上那个大标题「红黑榜」里就有,它恒为真 —— 真正管用的是口径说明那两条
  for (const needle of [
    "BIFF 2026 · 观影红黑榜",
    "红黑榜",
    "红榜",
    "按红贴纸数（多在前）",
    "黑榜",
    "按黑贴纸数（多在前）",
    "我贴过的 1 部",
    "biff.lcandy.co",
    "by @gaaiyeoi 和 by @lcandy2",
  ]) {
    expect(painted).toContain(needle);
  }
  // 每行印**评分**(2026-10-12):票数相同时它就是名次的依据,只印红黑数看不出「为什么这部排在前面」。
  // top = 40 红 0 黑、low = 0 红 30 黑 → C = 40/70 = 0.571 → top = (40 + 2.86)/45 ≈ 9.5 分
  expect(painted).toContain("9.5 分");
  // 我贴过的片名要真的画上去(而不是只有节标题)
  expect(painted).toContain(topTitle);
  // 署名**头部与底部各一处**(2026-09-22 用户:「gaaiyeoi 和lcandy 的在头部也加一下就行」)——
  // 长图常被截一半转发,底部那行会跟着丢掉。出现 2 次 → split 出 3 段
  expect(painted.split("by @gaaiyeoi 和 by @lcandy2")).toHaveLength(3);
  // 没票的片不该进榜:这一部服务端一枚票都没有
  const silent = keyOf("011");
  const silentTitle = (await page
    .locator(`.rb-card[data-film-key="${silent}"] .rb-title`)
    .textContent())!.trim();
  expect(painted).not.toContain(silentTitle);

  // Esc 关闭 + 焦点归还给打开它的那个按钮(§5 硬约束)
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(opener).toBeFocused();
});

// 分享哪些节由用户勾选(2026-09-22):榜单是「全站看法」,不是每个人都愿意两榜全发出去。
test("生成分享图:可以只分享部分榜单,一节都不勾时下载停用", async ({ page }) => {
  await trackPaintedTexts(page);
  const top = keyOf("008");
  await stubVotes(page, { [top]: { red: 40, black: 0 }, [keyOf("003")]: { red: 0, black: 30 } });
  await ready(page, "/redblack?sort=red");

  // 先贴一枚:否则「我贴过的」那一项没有内容、是被置灰的
  const card = page.locator(`.rb-card[data-film-key="${top}"]`);
  await card.getByRole("button", { name: /贴红贴纸/ }).click();

  await page.getByRole("button", { name: "生成分享图" }).click();
  const dialog = page.getByRole("dialog");
  const download = dialog.getByRole("button", { name: "下载 PNG 图片" });
  await expect(download).toBeVisible();
  // 「长图内容」那**一组**正好三项：红榜 / 黑榜 / 我贴过的。
  // ⚠ 必须限定在这一组里数：弹层里还有两个**范围**开关（画标题栏 / 画署名，
  //   2026-10-14 加，见 `PLAN-20261014162246`）—— 拿整个弹层的 checkbox 数写死 3，
  //   加任何一个开关都会让这条红（这正是它当时红掉的原因）。
  const contents = dialog.getByRole("group", { name: "长图内容" });
  await expect(contents.getByRole("checkbox")).toHaveCount(3);

  // 对照组:默认全选,第一张图里两榜都在
  // ⚠ 断言用的是各节的**口径说明**(「按黑贴纸数（多在前）」这种)而不是节名 —— 图里那个大标题
  //   「**红黑榜**」本身就含「黑榜」三个字,拿节名去判「有没有」会永远为真
  const first = await paintedTexts(page);
  expect(first).toContain("按黑贴纸数（多在前）");

  // 尺寸提示(2026-09-22 用户:「提示一下选择不同的分享模块后图片分别的大小是多少」):
  // 勾一节图就矮一截,所以每换一次选择都读一次这个数字,断言它**真的跟着变**
  const sizeOf = async () => {
    const text = await dialog.locator(".rb-share-size").innerText();
    const matched = text.match(/(\d+)\s*×\s*(\d+)\s*px/);
    return { width: Number(matched![1]), height: Number(matched![2]) };
  };
  const full = await sizeOf();
  // ⚠ 只断宽度落在 [1080, 2160] 之间:倍数由 `posterScale` 按**面积**反算,自 2026-10-08 起是
  //   连续值而不是「2 或 1」二选一(这份 stub 只有 2 部有票 → 图短 → 仍是 2×),
  //   别把某个具体倍数写死
  expect(full.width).toBeGreaterThanOrEqual(1080);
  expect(full.width).toBeLessThanOrEqual(2160);

  // ⚠ RAC 的复选框:真正的 `<input>` 是**视觉隐藏**的,直接 `uncheck()` 会被上层样式 div
  //   挡掉(`intercepts pointer events`)—— 按用户的做法点**标签文字**(与 `schedule-toolbar` 同手法),
  //   状态照旧断言在 `checkbox` 角色上。
  const check = (name: string | RegExp) =>
    dialog.getByRole("checkbox", { name, exact: typeof name === "string" });
  const toggle = async (label: string | RegExp) => {
    await dialog.getByText(label, { exact: typeof label === "string" }).click();
    await expect(check(label)).not.toBeChecked();
  };

  // 勾掉「黑榜」→ 重画。⚠ `paintedTexts` 跨多次出图**累加**:要判断「这一张图上有什么」,
  //   得前后各读一次、只比新增的那一段,否则永远能看到上一张的残留
  await toggle("黑榜");
  await expect
    .poll(async () => (await paintedTexts(page)).slice(first.length).includes("按红贴纸数（多在前）"))
    .toBe(true);
  expect((await sizeOf()).height).toBeLessThan(full.height); // 少一节 → 图矮一截
  const second = (await paintedTexts(page)).slice(first.length);
  expect(second).not.toContain("按黑贴纸数（多在前）");
  expect(second).toContain("按红贴纸数（多在前）");

  // 再勾掉「我贴过的」→ 那一节消失,红榜还在
  await toggle(/^我贴过的/);
  const offset = first.length + second.length;
  await expect
    .poll(async () => (await paintedTexts(page)).slice(offset).includes("按红贴纸数（多在前）"))
    .toBe(true);
  const withoutMine = await sizeOf();
  expect(withoutMine.height).toBeLessThan(full.height); // 「我贴过的」那一节也占高度
  const third = (await paintedTexts(page)).slice(offset);
  expect(third).not.toContain("左侧圆点是我贴的那一色"); // 「我贴过的」的说明不再画
  expect(third).toContain("按红贴纸数（多在前）");

  // 一节都不勾 → 图里只剩头部与署名(空态文案说的是「还没选」,不是「榜上没贴纸」),
  // 下载 / 复制停用,免得把一张空图发出去
  await toggle("红榜");
  await expect
    .poll(async () => (await paintedTexts(page)).includes("还没选要分享的内容"))
    .toBe(true);
  await expect(download).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "复制图片" })).toBeDisabled();
});

test("「只看我贴过」:只列我贴过的片,参数进 URL,再点一次恢复全量", async ({ page }) => {
  await stubEmpty(page);
  await ready(page, "/redblack?sort=red");

  const key = keyOf("008");
  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /贴红贴纸/ }).click();

  const all = await page.locator(".rb-card").count();
  await page.getByRole("button", { name: "只看我贴过" }).click();
  await expect(page.locator(".rb-card")).toHaveCount(1);
  await expect(page.locator(`.rb-card[data-film-key="${key}"]`)).toBeVisible();
  // 筛选是**独立参数**,不挤进 `sort`(排序档位此时仍是「红榜」)
  expect(new URL(page.url()).searchParams.get("only")).toBe("mine");
  // ⚠ 2026-10-14（PLAN-20261014150805 修订 1）：档位现在**显式**写在 URL 上
  //   （外壳 `BoardPage` 会把隐含档位固化成 `?sort=`,否则清掉 `q` 时档位会翻转）。
  expect(new URL(page.url()).searchParams.get("sort")).toBe("red");

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
  await ready(page, "/redblack?sort=red");

  const resort = page.locator(".rb-resort");
  // 首屏**不该**留下「有新贴纸」的提示:票数落定后会自动按票数补排一次(2026-09-22,PLAN-20260922161710)。
  // 改版前首屏那次排序发生在票数到达之前(全部并列 0 → 退化成目录序),所以才需要这条提示让人手动补排。
  // ⚠ 属性值是 `"true"` 而不是空串:React 对 `data-*` 上的布尔值走 `setAttribute(String(v))`
  //   (`data-rb-stale={orderStale || undefined}`)。
  await expect(resort).not.toHaveAttribute("data-rb-stale");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /贴红贴纸/ }).click();
  // 群点已在 canvas 上,所以 `.rb-dot--red` 只可能是我贴的那一枚
  await expect(card.locator(".rb-dot--red")).toHaveCount(1);

  // 等 ping 之后那次**重拉**真的发生(上报有 1200ms 防抖)
  await expect.poll(() => reads, { timeout: 8000 }).toBeGreaterThan(1);
  // 给 setVotes → 重渲染留一拍:修复前这里会亮起「有新贴纸」(votes 换了新对象)
  await page.waitForTimeout(500);
  await expect(resort).not.toHaveAttribute("data-rb-stale");
});

/* ---------------- 「大家说」评语模块(2026-09-29,PLAN-20260929181900) ----------------
 * 四件事各自钉一条:
 *   ① 读:列表能出、匿名显示「匿名观众」、片名由 `filmKey` 反查目录、游标翻页;
 *   ② 写:ping 载荷里**真的带了 `comment` 字段**(漏了 = 评语永远写不进去,且服务端不报错);
 *   ③ 降级:接口 500 时模块走空态,红黑榜照常可用;
 *   ④ 形态:贴纸上**没有任何浮层**(用户口径:「不要放在贴纸上,不然很乱」)。
 * ⚠ 评语区是**页面级**的(在 `.rb-grid` 之外、`.rb-page` 之内),不在任何一张卡里。 */

/** 评语读接口返回一页(等价于「接口已上线 + 已经有评语」) */
async function stubComments(
  page: Page,
  body: { items: unknown[]; nextCursor?: string | null },
) {
  await page.route("**/api/stats/film-comments**", (route) =>
    route.fulfill({
      json: { edition: "biff-2026", items: body.items, nextCursor: body.nextCursor ?? null },
    }),
  );
}

// 讨论区里也能翻页（观感与措辞沿用被它取代的那个模块：翻页走游标、服务端说没有了按钮就消失）。
test("讨论区:按游标翻页,翻完按钮消失", async ({ page }) => {
  await stubEmpty(page);
  const key = keyOf("008");
  // 第一页给 nextCursor,第二页给最后一条 —— 「加载更多」是**唯一**的翻页方式
  let first = true;
  const cursors: string[] = [];
  const filmKeys: Array<string | null> = [];
  await page.route("**/api/stats/film-comments**", (route) => {
    const url = new URL(route.request().url());
    cursors.push(url.searchParams.get("cursor") ?? "");
    filmKeys.push(url.searchParams.get("filmKey"));
    if (first) {
      first = false;
      return route.fulfill({
        json: {
          edition: "biff-2026",
          items: [
            { filmKey: key, vote: "red", comment: "拉片细节绝了", displayName: null },
            { filmKey: key, vote: "black", comment: "节奏太慢", displayName: "阿柴" },
          ],
          nextCursor: "C1",
        },
      });
    }
    return route.fulfill({
      json: {
        edition: "biff-2026",
        items: [{ filmKey: key, vote: "black", comment: "音效炸裂", displayName: "小满" }],
        nextCursor: null,
      },
    });
  });
  await ready(page, "/redblack?sort=red");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /讨论区/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".rb-talk-item")).toHaveCount(2);
  // 匿名(displayName 为 null)→「匿名观众」,而不是一行空白
  await expect(dialog.locator(".rb-talk-item").first()).toContainText("匿名观众");
  await expect(dialog.locator(".rb-talk-item").nth(1)).toContainText("阿柴");

  await dialog.getByRole("button", { name: "加载更多" }).click();
  await expect(dialog.locator(".rb-talk-item")).toHaveCount(3);
  expect(cursors.at(-1)).toBe("C1");
  // ⚠ **两页都要按片读**：翻页时把 `filmKey` 丢掉，第二页就会混进全场的评语
  expect(filmKeys.every((filmKey) => filmKey === key)).toBe(true);
  // 服务端说没有下一页了(nextCursor 为 null)→ 按钮整颗消失
  await expect(dialog.getByRole("button", { name: "加载更多" })).toHaveCount(0);
});

test("在讨论区里写一条评语:ping 载荷里真的带了 comment 字段", async ({ page }) => {
  await stubEmpty(page);
  await stubComments(page, { items: [] });
  const pings: Array<{ ops: Array<Record<string, unknown>> }> = [];
  // ⚠ 注册在 `stubEmpty` **之后**:Playwright 后注册的路由优先,而
  //   `**/api/stats/film-votes**` 也匹配 `…-ping` —— 顺序反了这里就收不到载荷
  await page.route("**/api/stats/film-votes-ping", async (route) => {
    pings.push(JSON.parse(route.request().postData() ?? "{}") as { ops: Array<Record<string, unknown>> });
    await route.fulfill({ json: { ok: true, count: 1, votes: {}, skins: {} } });
  });
  await ready(page, "/redblack?sort=red");

  const key = keyOf("008");
  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /贴红贴纸/ }).click();

  await card.getByRole("button", { name: /讨论区/ }).click();
  const dialog = page.getByRole("dialog");
  // ⚠ 表单里**没有「给哪一部写」这个下拉框**了 —— 弹层本来就只属于这一部
  //   （那个下拉框是页面级模块的产物，随它一起删掉了）
  await dialog.getByLabel(/写一句/).fill("拉片细节绝了");
  await dialog.getByRole("button", { name: "保存评语" }).click();

  // 1200ms 防抖之后才发出去。
  // ⚠ 判据必须是**载荷里有没有那句评语**,不能只等「有没有 ping」(2026-09-30,CI 实测红):
  //   贴下那一枚贴纸**自己就会发一条**(同样走 1200ms 防抖),它比「保存评语」那条先到 ——
  //   只等计数就会读到上一条,而那条的 `comment` 是 `null`。CI 上负载高,这里必红、本地通常不红。
  await expect
    .poll(
      () => {
        const mineNow = pings.at(-1)?.ops.find((op) => op.key === key);
        return mineNow?.comment ?? null;
      },
      { timeout: 8000 },
    )
    .toBe("拉片细节绝了");
  const ops = pings.at(-1)!.ops;
  const mine = ops.find((op) => op.key === key);
  expect(mine?.comment).toBe("拉片细节绝了");
  // ⚠ 每一条 `set` op 都必须带字段：省掉 `comment` 等于告诉服务端「这部片现在没有评语」——
  //   而 op 的语义是「整条覆盖」，不是「只改我提到的那几列」。（`remove` op 自然没有这个字段。）
  for (const op of ops) {
    if (op.op !== "set") continue;
    expect("comment" in op).toBe(true);
    expect("skin" in op).toBe(true);
  }
});

test("评语接口 500:讨论区走空态,红黑榜照常可用(静默降级)", async ({ page }) => {
  await stubEmpty(page);
  await page.route("**/api/stats/film-comments**", (route) =>
    route.fulfill({ status: 500, json: { error: "BOOM" } }),
  );
  await ready(page, "/redblack?sort=red");

  const key = keyOf("008");
  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  // ⚠ 接口挂了也要能打开 —— 讨论区只是附加内容，绝不把整页拖挂
  await card.getByRole("button", { name: /讨论区/ }).click();
  const dialog = page.getByRole("dialog");
  // 空态要**说清为什么空**,不是留一块空白
  await expect(dialog.locator(".rb-talk-empty")).toBeVisible();
  await expect(dialog.locator(".rb-talk-list")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // 贴上贴纸这条主链路一个字节都不受影响
  await card.getByRole("button", { name: /贴红贴纸/ }).click();
  await expect(card.locator(".rb-dot--red")).toHaveCount(1);
});

/* ---------------- 讨论区**总览**(2026-10-07,PLAN-20261007231522) ----------------
 * 卡片上那枚「讨论区」只回答「这一部」;总览回答「**全站**」—— 两者共用同一个读接口,
 * 差别只在**带不带 `filmKey`**。三条断言各自钉一件事:
 *   ① 跨片读(不带 `filmKey`)—— 带了就退回「只问这一部」,而列表照样渲染得「看起来正常」;
 *   ② 每行自己说清**是哪一部**(片名角标)—— 这是本弹层存在的理由;
 *   ③ 点一行 → 关弹层 + 定位到那张卡(滚进视口 + 闪描边)。 */

test("讨论区总览:跨片列出评语(每行带片名角标),点一行跳到那部卡片", async ({ page }) => {
  await stubEmpty(page);
  const keyA = keyOf("001");
  const keyB = keyOf("008");
  const queries: string[] = [];
  await page.route("**/api/stats/film-comments**", (route) => {
    queries.push(route.request().url());
    return route.fulfill({
      json: {
        edition: "biff-2026",
        items: [
          { filmKey: keyA, vote: "red", comment: "第一部真好", displayName: "阿柴" },
          { filmKey: keyB, vote: "black", comment: "第二部太闷", displayName: null },
          // 反查不到片名(旧届残留 / 目录里没有的 key)→ 只能读、不能跳
          { filmKey: "cat:__missing__", vote: "red", comment: "查不到片名", displayName: "路人" },
        ],
        nextCursor: null,
      },
    });
  });
  await ready(page, "/redblack?sort=red");

  await page.getByRole("button", { name: "打开讨论区总览" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("讨论区总览");
  // ⚠ **跨片**读:`filmKey` 一旦带上,这里列的就只是那一部了 —— 而界面看起来完全一样
  expect(queries.some((url) => !new URL(url).searchParams.has("filmKey"))).toBe(true);

  // 每行**自己**说清是哪一部(片名角标);红 / 黑来源角标也照旧
  const rows = dialog.locator(".rb-board-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).locator(".rb-board-film")).toContainText(/^《.+》$/);
  await expect(rows.nth(0).locator(".rb-talk-vote")).toHaveText("红");
  await expect(rows.nth(1).locator(".rb-talk-vote")).toHaveText("黑");
  // 两行的片名角标必须**不同**(否则「显示是哪个电影的」等于没做)
  const filmA = await rows.nth(0).locator(".rb-board-film").textContent();
  const filmB = await rows.nth(1).locator(".rb-board-film").textContent();
  expect(filmA).not.toBe(filmB);
  // 反查不到的行:退化成「未知影片」,且**不是**按钮(点了会滚到一张不存在的卡上)
  await expect(rows.nth(2).locator(".rb-board-film")).toHaveText("《未知影片》");
  await expect(dialog.getByRole("button", { name: /查不到片名/ })).toHaveCount(0);
  // ⚠ 能跳的行,可访问名必须是**这行内容本身**(评语 + 片名 + 昵称)——
  //   给它挂 `aria-label` 会把内容整个换掉,读屏就再也念不到评语了(动作改走 `title`)。
  await expect(dialog.getByRole("button", { name: /第一部真好/ })).toHaveCount(1);

  // 点第一行 → 关弹层 + 那张卡被定位到
  await rows.nth(0).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const target = page.locator(`.rb-card[data-film-key="${keyA}"]`);
  await expect(target).toBeInViewport();
  // ⚠ 描边是**瞬时**的(3 次闪烁后就撤掉),所以只能 poll —— 直接 `toHaveClass` 会看运气
  await expect
    .poll(() => target.evaluate((node) => node.classList.contains("rb-card-located")))
    .toBe(true);
});

test("讨论区总览:目标被搜索框挡住时,自动清掉过滤再定位", async ({ page }) => {
  await stubEmpty(page);
  const key = keyOf("008");
  await stubComments(page, {
    items: [{ filmKey: key, vote: "red", comment: "被藏起来的评语", displayName: null }],
  });
  // 先让搜索把所有卡都过滤掉 —— 此时那片根本没渲染,直接查 DOM 一定找不到
  await ready(page, `/redblack?q=${encodeURIComponent("绝无此片")}`);
  await expect(page.locator(".rb-card")).toHaveCount(0);

  await page.getByRole("button", { name: "打开讨论区总览" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator(".rb-board-row").first().click();

  // 过滤被清掉 → 卡片回来了,并且被定位到
  const target = page.locator(`.rb-card[data-film-key="${key}"]`);
  await expect(target).toHaveCount(1);
  await expect
    .poll(() => target.evaluate((node) => node.classList.contains("rb-card-located")))
    .toBe(true);
});


/* ---------------- 「榜单」页的页内 tab（2026-10-14，PLAN-20261014150805 修订 1 / 2） ----------------
 * 红黑榜从「一整页」变成「榜单页的一个 tab」：外壳 `BoardPage` 用 `?sort=` 承载
 * 「热门榜 / 红榜 / 黑榜」三档（`RedBlackPage` 本来就读这个参数，所以老书签不受影响）。
 * 这里钉两条口径：
 *   ① 没有 `sort` 且没有 `q` → 默认落在**热门榜**（从导航进来的第一眼）；
 *   ② 切到红榜后贴纸墙出现、热门榜消失（两块视图互斥，不是叠在一起）。 */

test("榜单页：默认落在热门榜；切到红榜后贴纸墙出现、热门榜消失", async ({ page }) => {
  await stubEmpty(page);
  await stubComments(page, { items: [] });
  await page.route("**/api/stats/want-counts**", (route) => route.fulfill({ json: { counts: {} } }));
  await ready(page, "/redblack");

  // ① 默认 = 热门榜（外壳的 tab 是唯一的档位入口）
  await expect(page.locator('[data-board-tab="hot"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".hb-panel")).toHaveCount(1);
  await expect(page.locator(".rb-page")).toHaveCount(0);
  // ⚠ 2026-10-14 起热门榜是「本届**全部影片**按想看降序」（`hot-board.ts`，用户：「全部默认
  //   就是全部影片的想看人数就行」）——**没有想看数据也照样出榜**（每部想看 0，榜首 = 目录序第一部），
  //   所以这里**不该**是空态；空态只在目录里真的没有影片时才出现。想看合计如实印 0，不编数。
  await expect(page.locator(".hb-lead")).toHaveCount(1);
  await expect(page.locator(".hb-grid")).toHaveCount(1);
  await expect(page.locator(".hb-panel .empty-state")).toHaveCount(0);
  await expect(page.locator(".hb-count")).toHaveAttribute("data-hot-want", "0");

  // ② 切红榜：贴纸墙出现，热门榜卸载
  await page.locator('[data-board-tab="red"]').click();
  await expect(page.locator('[data-board-tab="red"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".hb-panel")).toHaveCount(0);
  await expect(page.locator(".rb-page")).toHaveCount(1);
  // ⚠ 档位改由外壳托管 → 页面自己那个分段控件不再渲染：
  //   同一屏里不能有两个「红榜 / 黑榜」入口（它们是同一件事）。
  await expect(page.locator(".rb-seg")).toHaveCount(0);
});

test("榜单页：想看数据到达后榜单**真的渲染出来**（回归 · 不是停在空表）", async ({ page }) => {
  // ⚠ 这条是回归测试，复现的是 2026-10-14 本地验收时抓到的一个真 bug：
  //   订阅回调当时写成了空函数（`() => undefined`），于是 `loadWantCounts()` 到了数据
  //   **也不会触发重渲染** —— 接口明明有数据，页面却永远停在第一帧的空表上
  //   （`rows = 0` / hero 显示 `0 部上榜`）。
  //   ⚠ 光断言「空表走空态」是**抓不到**它的：那种写法在有数据时同样会红/同样会绿。
  //   必须在有数据的前提下断言**行数与顺序**。
  await stubEmpty(page);
  await stubComments(page, { items: [] });
  await page.route("**/api/stats/want-counts**", (route) =>
    route.fulfill({ json: { counts: { "cat:f001": 120, "cat:f002": 30 } } }),
  );
  await ready(page, "/redblack");

  // 按想看降序：120 的这部是**榜首**（#01 主视觉），30 的那部进海报墙
  const lead = page.locator(".hb-lead");
  await expect(lead).toHaveAttribute("data-hot-row", "cat:f001");
  await expect(lead.locator(".hb-lead-want")).toContainText("120");
  const cards = page.locator(".hb-card");
  await expect(cards.first()).toHaveAttribute("data-hot-row", "cat:f002");
  await expect(cards.first().locator(".hb-cap-want")).toContainText("30");
  // ⚠ 海报墙 = **本届全部影片减去榜首那一部**（2026-10-14 起不按「有没有信号」筛）——
  //   所以行数跟着目录规模走，而不是「只有 1 部有想看所以只剩 1 张」
  const films = Number(await page.locator(".hb-count").getAttribute("data-hot-films"));
  expect(films).toBeGreaterThan(2);
  await expect(cards).toHaveCount(Math.min(films - 1, 24));
  // 一票没有的片排在最后（想看 0），但**仍然在榜** —— 页面不该退回空态
  await expect(page.locator(".hb-panel .empty-state")).toHaveCount(0);
});

test("榜单页：单元筛选是下拉，且键已归一、「头部说 N 部」与列表行数同源", async ({ page }) => {
  // ⚠ 这条守的是 2026-10-14 **打开浏览器才发现**的两个真 bug：
  //   ① 单元下拉里出现 4 个一模一样的「…年度亚洲电影人奖 · 杨紫琼专题」（按**原串**分组）；
  //   ② 同一单元两套数（头部说 N 部、列表少几行）。
  //   两者都只在「有数据」的前提下才现形 —— 拿空数据是抓不到的。
  // ⚠ 2026-10-14 用户：「热门影片的单元还是没有通过下拉筛选」—— 所以这里**先断言形态**：
  //   选项必须挂在一个 `role=listbox` 里（点按钮才出现），而不是页面上常驻的一排按钮。
  await stubEmpty(page);
  await stubComments(page, { items: [] });
  const keys = [
    ...new Set(Array.from({ length: 60 }, (_, i) => keyOf(String(i + 1).padStart(3, "0")))),
  ];
  await page.route("**/api/stats/want-counts**", (route) =>
    route.fulfill({
      json: { counts: Object.fromEntries(keys.map((key, i) => [key, 300 - i])) },
    }),
  );
  await ready(page, "/redblack");
  await expect.poll(() => page.locator(".hb-card").count()).toBeGreaterThan(20);

  // ① 下拉：点开刊头那支「单元」，选项在 listbox 里；选项文案 = 「单元名，N 部」
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.getByRole("button", { name: /单元/ }).click();
  await expect(page.getByRole("listbox")).toBeVisible();
  const labels = (await page.getByRole("option").allInnerTexts()).map((t) => t.trim());
  expect(labels[0]).toBe("全部单元");
  const names = labels.slice(1).map((t) => t.replace(/[，,]\s*\d+\s*部$/, "").trim());
  // 选项不重名 —— 同义写法已归一到同一个键
  expect(names.length).toBeGreaterThan(5);
  expect(new Set(names).size).toBe(names.length);

  // ② 头的计数与版面同源：选中某个**真实单元**（第 1 项恒是「全部单元」）后，
  //    「N 部影片」必须等于 榜首（1 部）+ 海报墙（首屏最多 GRID_STEP = 24 张）
  await page.getByRole("option").nth(1).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  const filmsOf = async () => Number((await page.locator(".hb-count").getAttribute("data-hot-films")) ?? -1);
  await expect.poll(filmsOf).toBeGreaterThan(0);
  const films = await filmsOf();
  await expect(page.locator(".hb-card")).toHaveCount(Math.min(films - 1, 24));
  await expect(page.locator(".hb-lead")).toHaveCount(1);
});

test("榜单页：从日程表格子带 `q` 跳进来时仍落在红榜（不是热门榜）", async ({ page }) => {
  await stubEmpty(page);
  await stubComments(page, { items: [] });
  await ready(page, "/redblack?q=008");
  // ⚠ 这是「去评分」那条链路的兜底（`agenda-gantt.spec.ts` 只断言了 URL，这里补断言视图）：
  //   从那一跳进来的人是要**贴贴纸**的，给热门榜等于把他挡在门外。
  await expect(page.locator('[data-board-tab="red"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".rb-page")).toHaveCount(1);
});

/* ★ 分享图的「范围」开关（2026-10-14，PLAN-20261014150805 修订 2）
 *
 * 用户原话：「分享的时候可以选择需要哪个单元的就行」「只要出 PNG，我自己上传」。
 * 出图是 canvas 手绘、没有 DOM 可断言，所以读**画出来的字**（`helpers.ts::trackPaintedTexts`
 * 给 `fillText` 打了补丁）+ 弹层里那句尺寸提示。
 * ⚠ `paintedTexts` 跨多次出图**累加**：判断「这一张图上有什么」必须前后各读一次、只比新增的那段。
 */

/** 读弹层里那句「这张图：W × H px」—— 换选项图高会变，所以每次都要现读一次。 */
async function shareSize(dialog: Locator): Promise<{ width: number; height: number }> {
  const text = await dialog.locator(".hb-share-size, .rb-share-size").innerText();
  const matched = text.match(/(\d+)\s*×\s*(\d+)\s*px/);
  return { width: Number(matched![1]), height: Number(matched![2]) };
}

/** 在下拉里挑一个**真实存在**的单元（不写死名字：单元清单来自 `films.json`，写死会随片单变）。
 *  返回它的展示名 —— 断言要用它。 */
async function pickFirstUnit(page: Page, dialog: Locator): Promise<string> {
  await dialog.getByRole("button", { name: /单元/ }).click();
  // ⚠ **必须限定在「单元」那个 listbox 里**：同一张弹层里还有别的下拉（「取前几名」/「每榜条数」），
  //   选完一次之后它的 listbox **仍然留在 DOM 上** —— 不限定就会 strict mode 撞两个
  //   （2026-10-14 实测：先选了 TOP3、再挑单元，`getByRole("listbox")` 解到 2 个，直接红）。
  const listbox = page.getByRole("listbox", { name: "单元" });
  await expect(listbox).toBeVisible();
  // ⚠ 第 0 项恒是「全部单元」，所以要第 1 项
  const option = listbox.getByRole("option").nth(1);
  const label = ((await option.textContent()) ?? "").trim();
  await option.click();
  // 选项文案是「单元名，N 部」—— 去掉尾巴那一截才是单元名
  return label.replace(/[，,]\s*\d+\s*部$/, "").trim();
}

test("热门榜：分享图默认 TOP10、换 TOP3 矮一截；换单元后这张图只讲那个单元", async ({ page }) => {
  await trackPaintedTexts(page);
  await stubEmpty(page);
  await stubComments(page, { items: [] });
  // 给一批真实影片灌想看数据（多给几个场次编号，去重后一定撑得起默认那 10 行）
  const keys = [
    ...new Set(
      Array.from({ length: 20 }, (_, i) => keyOf(String(i + 1).padStart(3, "0"))),
    ),
  ];
  await page.route("**/api/stats/want-counts**", (route) =>
    route.fulfill({
      json: { counts: Object.fromEntries(keys.map((key, i) => [key, 200 - i * 7])) },
    }),
  );
  await ready(page, "/redblack");

  // 前置事实：榜上真的够 10 部（出图默认就取 10 行 —— 「换 TOP3 会矮一截」那条靠它成立）。
  // ⚠ 必须用会重试的 `expect.poll`：想看数据是异步到达的（`want-counts` 拉回来才建榜），
  //   一次性 `count()` 会抢在数据之前读到 0 部（与「榜单真的渲染出来」那条同一条纪律）。
  //   ⚠ 榜首（`.hb-lead`）也是榜上的一部，所以数的是「1 + 海报墙」。
  await expect
    .poll(async () => 1 + (await page.locator(".hb-card").count()))
    .toBeGreaterThanOrEqual(10);

  const opener = page.getByRole("button", { name: "生成分享图" });
  await opener.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // 出图是异步的（画完才 toBlob），等按钮出来即代表图已生成
  await expect(dialog.getByRole("button", { name: "下载 PNG 图片" })).toBeVisible();

  // ★ 档位（2026-10-14 用户：「取前几名 改成 TOP3 TOP10」）：两档、默认 TOP10，
  //   换 TOP3 之后图**矮一截**。
  //   ⚠ 断言「换了真的变矮」而不是某两个具体像素：图高由 `hotPosterHeight` 按行数算
  //     （不补白），写死 1080 × 1710 / 1080 × 765 会在别人改行高时假红，
  //     而「行数决定图高」才是这条口径本身。
  const topPicker = dialog.getByRole("button", { name: /取前几名/ });
  await expect(topPicker).toContainText("TOP10");
  const ten = await shareSize(dialog);
  expect(ten.width).toBeGreaterThanOrEqual(1080);
  // 画布手绘没有 DOM 可断 → 读锚点属性，确认图里真的带了海报（而不是整张在画占位块）。
  // ⚠ 在**默认那 10 行**上读：换成 TOP3 之后只剩 3 行，样本太小（可能三行都没图）。
  await expect(dialog.locator(".hb-share-preview")).toHaveAttribute(
    "data-poster-count",
    /^[1-9]\d*$/,
  );
  await topPicker.click();
  await page
    .getByRole("listbox", { name: "取前几名" })
    .getByRole("option", { name: "TOP3", exact: true })
    .click();
  await expect(topPicker).toContainText("TOP3");
  await expect.poll(async () => (await shareSize(dialog)).height).toBeLessThan(ten.height);

  // 换单元 → 图**当场重画**（不必关掉弹层重开），而且这张图只讲那个单元
  const before = (await paintedTexts(page)).length;
  const unitName = await pickFirstUnit(page, dialog);
  await expect
    .poll(async () => (await paintedTexts(page)).slice(before))
    .toContain(`${unitName} 热门榜`);
  await expect(dialog.getByRole("button", { name: /单元/ })).toContainText(unitName);

  // 关掉署名 → 新画的那一段里不该再有网站那行（⚠ 头部也印 `by @…`，所以判据用网站域名）
  const mark = (await paintedTexts(page)).length;
  await dialog.getByText("画署名", { exact: true }).click();
  await expect
    .poll(async () => {
      const seg = (await paintedTexts(page)).slice(mark);
      return seg.length > 0 && !seg.includes("biff.lcandy.co");
    })
    .toBe(true);

  // Esc 关闭 + 焦点归还给打开它的那个按钮（§5 硬约束）
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("红黑榜分享图：可以只讲一个单元，也可以关头尾", async ({ page }) => {
  await trackPaintedTexts(page);
  // 两榜各铺够 8 行 —— 否则「前 5」这一档改变不了任何东西，那条「图矮一截」的断言会失去意义
  const keys = [
    ...new Set(Array.from({ length: 16 }, (_, i) => keyOf(String(i + 1).padStart(3, "0")))),
  ];
  await stubVotes(
    page,
    Object.fromEntries(
      keys.map((key, i) => [key, i % 2 === 0 ? { red: 30 - i, black: 0 } : { red: 0, black: 30 - i }]),
    ),
  );
  await stubComments(page, { items: [] });
  await ready(page, "/redblack?sort=red");

  const opener = page.getByRole("button", { name: "生成分享图" });
  await opener.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "下载 PNG 图片" })).toBeVisible();

  // ① 每榜条数改成 5 → 图**矮一截**（两榜各少 5 行）
  const full = await shareSize(dialog);
  await dialog.getByRole("button", { name: /每榜条数/ }).click();
  await page.getByRole("option", { name: "前 5", exact: true }).click();
  const five = await shareSize(dialog);
  expect(five.height).toBeLessThan(full.height);

  // ② 选一个单元 → 副标题里点明范围（只印几行却不说哪一单元，读图的人会误读成全站）
  const beforeUnit = (await paintedTexts(page)).length;
  const unitName = await pickFirstUnit(page, dialog);
  await expect
    .poll(async () => (await paintedTexts(page)).slice(beforeUnit))
    .toContain(unitName);

  // ③ 关掉标题栏 → 届次那一行不再画；关掉署名 → 网站那行不再画。
  //   ⚠ 两次点击之间**必须重读 offset**：每一次重画都往累加数组里追加文本，
  //     拿同一个起点去比「最终那一段」会把中间那次画的残留也算进来（永远红）。
  const a = (await paintedTexts(page)).length;
  await dialog.getByText("画标题栏", { exact: true }).click();
  await expect
    .poll(async () => {
      const seg = (await paintedTexts(page)).slice(a);
      return seg.length > 0 && !seg.includes("BIFF 2026 · 观影红黑榜");
    })
    .toBe(true);

  const b = (await paintedTexts(page)).length;
  await dialog.getByText("画署名", { exact: true }).click();
  await expect
    .poll(async () => {
      const seg = (await paintedTexts(page)).slice(b);
      return seg.length > 0 && !seg.includes("biff.lcandy.co");
    })
    .toBe(true);

  // 头尾都关掉了，图仍然出得来（不是 0 高、也不是空白失败），而且比「只关掉头尾之一」更矮
  expect(await dialog.locator(".rb-share-size").innerText()).toMatch(/\d+\s*×\s*\d+\s*px/);
  expect((await shareSize(dialog)).height).toBeLessThan(five.height);
});

/* ★ 「热门影片」编辑式排行榜（2026-10-14，PLAN-20261014162246；同日修订为**单一榜单**）
 *
 * 这一组守的是**版式与交互**，不是排序（排序在 `apps/web/tests/hot-board.test.ts` 里断）。
 * 重点三处：① 只有一份榜 —— 本届全部影片按想看降序；② 榜首是主视觉且点得开详情；
 * ③ hover 是**纯 CSS 的渐进揭示**，不动版面、不吃点击，且在触屏 / 减少动态效果下都不掉信息。
 */

/** 日账本（服务端「某天起的按影片增量」）。
 *  ⚠ 2026-10-14 起它**只喂名次变化（▲▼）**：「正在升温」那一档已撤，日账本不再决定排序。 */
async function stubTrend(page: Page, deltas: Record<string, number>) {
  await page.route("**/api/stats/want-trend**", (route) =>
    route.fulfill({
      json: { fromDay: "2026-10-14", toDay: "2026-10-14", days: 1, deltas },
    }),
  );
}

test("热门影片：只有一份榜单 —— 本届全部影片按想看降序，且没有档位 / 说明文字", async ({ page }) => {
  await stubEmpty(page);
  await stubComments(page, { items: [] });
  await page.route("**/api/stats/want-counts**", (route) =>
    route.fulfill({ json: { counts: { "cat:f001": 120, "cat:f002": 30, "cat:f003": 7 } } }),
  );
  await stubTrend(page, { "cat:f003": 9, "cat:f001": 2 });
  await ready(page, "/redblack");

  // 用户 2026-10-14：「不需要 热门影片 / 正在升温 / 全部影片 还有上面的解释文字」
  await expect(page.locator(".hb-mode")).toHaveCount(0);
  await expect(page.locator(".hb-hint")).toHaveCount(0);
  await expect(page.locator(".hb-lede")).toHaveCount(0);

  // 榜首 = 想看最多的那部（日账本今天给 f003 的增量最大，但它**不参与排序**）
  await expect(page.locator(".hb-lead")).toHaveAttribute("data-hot-row", "cat:f001");

  // 「全部影片」：不管有没有人想看，目录里的片全在（stub 只给了 3 部有想看）
  const films = Number(await page.locator(".hb-count").getAttribute("data-hot-films"));
  expect(films).toBeGreaterThan(3);
  await expect(page.locator(".hb-card")).toHaveCount(Math.min(films - 1, 24));
  // 「显示更多」只在还有剩的时候出现，并报出还剩几部
  await expect(page.locator(".hb-more-btn")).toContainText(`还有 ${films - 1 - 24} 部`);
});

test("热门影片：账本为空时不伪造名次变化（一枚 ▲▼ 都不画）", async ({ page }) => {
  await stubEmpty(page);
  await stubComments(page, { items: [] });
  await page.route("**/api/stats/want-counts**", (route) =>
    route.fulfill({ json: { counts: { "cat:f001": 120, "cat:f002": 30 } } }),
  );
  await stubTrend(page, {});
  await ready(page, "/redblack");

  // 榜单照常有内容；而账本为空 → 每部片昨日累计 == 今日累计 → 名次没动 → 一枚 ▲▼ 都不画
  await expect(page.locator(".hb-lead")).toHaveCount(1);
  await expect(page.locator(".hb-trend")).toHaveCount(0);
});

test("热门影片：榜首是 #01 主视觉，点它打开影片详情（守住 BoardPage 的 Outlet）", async ({ page }) => {
  await stubEmpty(page);
  await stubComments(page, { items: [] });
  await page.route("**/api/stats/want-counts**", (route) =>
    route.fulfill({ json: { counts: { "cat:f001": 120, "cat:f002": 30 } } }),
  );
  await stubTrend(page, {});
  await ready(page, "/redblack");

  const lead = page.locator(".hb-lead");
  await expect(lead.locator(".hb-lead-rank")).toHaveText("#01");
  await expect(lead.locator(".hb-lead-tag")).toContainText("TOP 01");
  await expect(lead.locator(".hb-lead-title")).not.toBeEmpty();
  // 榜首要占据主视觉：海报框比海报墙里任何一张都大
  const leadBox = (await lead.locator(".hb-lead-media").boundingBox())!;
  const cardBox = (await page.locator(".hb-card .hb-frame").first().boundingBox())!;
  expect(leadBox.width).toBeGreaterThan(cardBox.width);
  expect(leadBox.height / leadBox.width).toBeCloseTo(1.5, 1); // 2:3

  // ⚠ 点开详情走的是路由表里已有的 `films/:filmKey` 子路由 —— BoardPage 不渲染 Outlet 的话
  //   这里会「什么都没发生」（点完 URL 变了、弹层不出来），所以这条同时守住那个坑
  await lead.locator(".hb-lead-cta").click();
  await expect(page).toHaveURL(/\/redblack\/films\/cat(%3A|:)f001/);
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("热门影片：hover 是渐进揭示，移出复位、不动版面、不吃点击", async ({ page, isMobile }) => {
  test.skip(isMobile, "hover 是鼠标行为；触屏那条见「手机上说明行常驻」");
  await stubEmpty(page);
  await stubComments(page, { items: [] });
  await page.route("**/api/stats/want-counts**", (route) =>
    route.fulfill({ json: { counts: { "cat:f001": 120, "cat:f002": 30, "cat:f003": 20 } } }),
  );
  await stubTrend(page, {});
  await ready(page, "/redblack");

  const card = page.locator(".hb-card").first();
  const veil = card.locator(".hb-veil");
  const hover = card.locator(".hb-hover");
  const img = card.locator(".hb-frame-img");
  const opacity = (locator: Locator) =>
    locator.evaluate((el) => Number(getComputedStyle(el).opacity));

  // 默认：遮罩透明、海报没有缩放、也不跑任何动画（需求：不添加持续运行动画）
  expect(await opacity(veil)).toBe(0);
  await expect(img).toHaveCSS("transform", "none");

  // ⚠ 量版面之前先把它滚进视口：`hover()` 自己会滚动，滚动之后的坐标当然会变 ——
  //   不先滚，这条会变成「测滚动」而不是「测有没有挤压邻格」
  await card.scrollIntoViewIfNeeded();
  const before = await card.boundingBox();
  await card.locator(".hb-card-btn").hover();

  // hover：遮罩渐显 + 提示淡入 + 海报轻微放大（1.03）
  await expect.poll(() => opacity(veil)).toBeGreaterThan(0.9);
  await expect.poll(() => opacity(hover)).toBeGreaterThan(0.9);
  await expect.poll(async () => img.evaluate((el) => getComputedStyle(el).transform)).toContain("1.03");

  // 放大发生在**海报框内**：邻格没有被挤走（版面零位移），也没有把父级顶出滚动条
  expect(await card.boundingBox()).toEqual(before);

  // 遮罩与提示都不吃点击（点得下去 = 详情打得开）
  await expect(veil).toHaveCSS("pointer-events", "none");
  await expect(hover).toHaveCSS("pointer-events", "none");

  // 移出：平滑复位，不留残余状态
  await page.mouse.move(0, 0);
  await expect.poll(() => opacity(veil)).toBeLessThan(0.05);
  await expect.poll(() => opacity(hover)).toBeLessThan(0.05);
  await expect.poll(async () => img.evaluate((el) => getComputedStyle(el).transform)).toBe("none");
});

test("热门影片：手机上必要信息常驻、不依赖 hover，海报整格可点", async ({ page, isMobile }) => {
  test.skip(!isMobile, "这一条只看移动端");
  await stubEmpty(page);
  await stubComments(page, { items: [] });
  await page.route("**/api/stats/want-counts**", (route) =>
    route.fulfill({ json: { counts: { "cat:f001": 120, "cat:f002": 30 } } }),
  );
  await stubTrend(page, {});
  await ready(page, "/redblack");

  const card = page.locator(".hb-card").first();
  // 排名 / 片名 / 想看人数都在**说明行**里常驻可见
  await expect(card.locator(".hb-cap-rank")).toBeVisible();
  await expect(card.locator(".hb-cap-title")).toBeVisible();
  await expect(card.locator(".hb-cap-want")).toContainText("30");
  // 而 hover 那层在触屏上是关掉的（没有鼠标可用，留着只会多一层遮罩）
  await expect(card.locator(".hb-hover")).toBeHidden();

  // 整格可点：点海报进详情
  await card.locator(".hb-card-btn").click();
  await expect(page).toHaveURL(/\/redblack\/films\//);
});

test("热门影片：减少动态效果时关掉过渡（缩放不做，信息照旧）", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await stubEmpty(page);
  await stubComments(page, { items: [] });
  await page.route("**/api/stats/want-counts**", (route) =>
    route.fulfill({ json: { counts: { "cat:f001": 120, "cat:f002": 30 } } }),
  );
  await stubTrend(page, {});
  await ready(page, "/redblack");

  const card = page.locator(".hb-card").first();
  /** 过渡时长（秒）—— ⚠ 断言「**短到看不出来**」而不是写死 `0s`：
   *  React Spectrum S2 在 reduced-motion 下自己会打一条 `1e-05s`，与我们的
   *  `transition: none` 是同一个意思；写死 `0s` 会把「别人的正确实现」判成红。 */
  const durationOf = (selector: string) =>
    card
      .locator(selector)
      .evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration) || 0);

  expect(await durationOf(".hb-frame-img")).toBeLessThan(0.01);
  expect(await durationOf(".hb-veil")).toBeLessThan(0.01);

  // 揭示照旧发生（关的是动效，不是信息），但不再有缩放
  await card.scrollIntoViewIfNeeded();
  await card.locator(".hb-card-btn").hover();
  await expect.poll(() => card.locator(".hb-veil").evaluate((el) => Number(getComputedStyle(el).opacity))).toBeGreaterThan(0.9);
  await expect(card.locator(".hb-frame-img")).toHaveCSS("transform", "none");
});

/* ⚠ 2026-10-14（`PLAN-20261014190000` 修订 6）：卡片上那两枚「红 / 黑」按钮回来了。
 *
 * 守着四件事，每一件都是用户这次点名的：
 *   ① **不需要先「标记看过」** —— 按钮开局就是可用的（那道闸门在修订 3 已删）；
 *   ② 点一下就投，**贴纸落点是随机的**（写在 inline `left/top` 的百分比上）；
 *   ③ 改票 = 点另一色，**同一枚原地换色**（位置一个字都不动）；
 *   ④ 1200ms 防抖后**真的上报**，且载荷里是最后那一色。
 *
 * ⚠ 那批守着「标记看过 / 暂存区 / 拖拽 / 换款轮盘」的旧用例**已经删掉了**
 *   （2026-10-14，`PLAN-20261014205414` 的 `test` 提交）—— 那些交互是用户明确要求去掉的，
 *   留着用例等于对不存在的东西作出承诺，而它们正是本条之前那 30 条红。 */
test("卡片上的「红 / 黑」按钮直接投票：点一下随机落一枚、改票原地换色、并上报", async ({ page }) => {
  await stubEmpty(page);
  const pings: Array<{ ops: Array<Record<string, unknown>> }> = [];
  // ⚠ 注册在 `stubEmpty` **之后**：Playwright 后注册的路由优先，而
  //   `**/api/stats/film-votes**` 也匹配 `…-ping` —— 顺序反了这里就收不到载荷
  await page.route("**/api/stats/film-votes-ping", async (route) => {
    pings.push(JSON.parse(route.request().postData() ?? "{}") as { ops: Array<Record<string, unknown>> });
    await route.fulfill({ json: { ok: true, count: 1, votes: {}, skins: {} } });
  });
  await ready(page, "/redblack?sort=red");

  const key = keyOf("008");
  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  const red = card.getByRole("button", { name: /贴红贴纸/ });
  const black = card.getByRole("button", { name: /贴黑贴纸/ });

  // ① 没有前置闸门：开局就能点，且两枚都还没被选中
  await expect(red).toBeEnabled();
  await expect(black).toBeEnabled();
  await expect(red).toHaveAttribute("aria-pressed", "false");

  await red.click();

  // 自己贴的那一枚**立刻**可见（不等服务端）；按钮同时进入「这一色已贴出去」的形态
  const mine = card.locator(".rb-dot");
  await expect(mine).toHaveCount(1);
  await expect(card.locator(".rb-dot--red")).toHaveCount(1);
  await expect(red).toHaveAttribute("aria-pressed", "true");
  await expect(red).toHaveAttribute("data-rb-spent", "true");
  await expect(black).toHaveAttribute("aria-pressed", "false");

  // ② 落点是**随机**的：坐标由 `softSpot` 摇出来，写成画布内的百分比
  //   ⚠ 只断言「是一个合法百分比」而不写死数值 —— 写死等于把随机分布钉成常量，第二天就红
  const spot = await mine.evaluate((node) => ({
    left: (node as HTMLElement).style.left,
    top: (node as HTMLElement).style.top,
  }));
  expect(spot.left).toMatch(/^\d+(\.\d+)?%$/);
  expect(spot.top).toMatch(/^\d+(\.\d+)?%$/);

  // ③ 改票 = 点另一色：**同一枚**原地换色（位置一个字都不动，见 `retintSticker`）
  await black.click();
  await expect(card.locator(".rb-dot--black")).toHaveCount(1);
  await expect(card.locator(".rb-dot--red")).toHaveCount(0);
  await expect(mine).toHaveCount(1);
  expect(await mine.evaluate((node) => (node as HTMLElement).style.left)).toBe(spot.left);
  await expect(black).toHaveAttribute("aria-pressed", "true");
  await expect(red).toHaveAttribute("aria-pressed", "false");

  // ④ 1200ms 防抖之后才发出去；最后那一条载荷里，这一部是**黑**（改票后的状态）
  await expect
    .poll(
      () => pings.at(-1)?.ops.find((op) => op.key === key)?.vote ?? null,
      { timeout: 8000 },
    )
    .toBe("black");
});

/* ⚠ 2026-10-14（`PLAN-20261014205414`）：下面是**本次**新增的三条，守着手机端那几条反馈 ——
 * 「不知道左右哪个是喜欢」「需要指引和反悔机制」「把红黑榜链接做成一个二维码」。
 * 它们对着的正是修订 6 之后那一套契约（卡片上的按钮 / 常驻图例 / 撤回条 / 扫码弹层）。 */

/** 打开快速投票卡片所需的本地基线：**行程里有片**（`biff.picks.v2`）。
 *  ⚠ 不种它的话 `deck` 会退到「热门榜 TOP50」兜底支 —— 那条路还要等 `want-counts` 接口，
 *    而本文件里那些 stub 并不提供它（卡片会停在「正在取热门榜的候选…」）。 */
const deckSeed = { "biff.picks.v2": legacyData["biff.picks.v2"] };

test("快速投票：不拖动也能看出左右是什么，且卡片上只剩海报", async ({ page }) => {
  await stubEmpty(page);
  await seed(page, deckSeed);
  await ready(page, "/redblack?sort=red&vote=1");

  await expect(page.locator(".qv-card")).toBeVisible();

  // ① 常驻图例：它**不靠拖动**才出现 —— 用户朋友的问句「不知道左右哪个是喜欢」就是这条的由来。
  //    ⚠ 2026-10-15 措辞改成「黑榜 / 红榜」（用户：「不能叫喜欢/不喜欢 应该叫红黑吧 因为是红黑榜的」）
  const legend = page.locator(".qv-legend");
  await expect(legend).toBeVisible();
  await expect(legend).toContainText("左滑 · 黑榜");
  await expect(legend).toContainText("右滑 · 红榜");

  // ② 三枚按钮把方向与语义一起写出来：箭头给方向，「黑榜 / 红榜」给语义
  await expect(page.getByRole("button", { name: "投黑榜" })).toBeVisible();
  await expect(page.getByRole("button", { name: "投红榜" })).toBeVisible();

  // ③ 卡片上只剩海报（2026-10-14 用户：「海报上的信息太多了 …… 最好只保留纯海报」）。
  //    ⚠ 逐条钉住那六块文字，而不是断言整块 `.qv-caption` 不存在 —— 后者只能证明「容器没了」，
  //      证明不了「没人把其中某一行挪到别处又加回来」。
  const card = page.locator(".qv-card");
  for (const gone of ["qv-caption", "qv-title", "qv-en", "qv-meta", "qv-sub", "qv-counts", "qv-intro"]) {
    await expect(card.locator(`.${gone}`)).toHaveCount(0);
  }
  await expect(card.locator(".qv-poster")).toHaveCount(1);
});

test("快速投票：投完出现「已投红榜 · 撤回」，撤回后那一票被撤掉", async ({ page }) => {
  await stubEmpty(page);
  await seed(page, deckSeed);
  await page.route("**/api/stats/film-votes-ping", (route) =>
    route.fulfill({ json: { ok: true, count: 1, votes: {}, skins: {} } }),
  );
  await ready(page, "/redblack?sort=red&vote=1");

  // ① 空态也把那句话说全：看不见的东西用户不会去用，而撤回恰恰最需要被看见
  await expect(page.locator(".qv-undo-idle")).toHaveText("划错了可以撤回");
  await expect(page.locator(".qv-undo")).toHaveCount(0);

  const card = page.locator(".qv-card");
  const first = await card.getAttribute("data-qv-key");
  await page.getByRole("button", { name: "投红榜" }).click();

  // ② 回执说清「刚才那一下做成了什么」—— 这正是 `Step.after` 存在的理由
  await expect(page.locator(".qv-undo-text")).toHaveText("已投红榜");
  await expect(page.locator(".qv-undo-text")).toHaveAttribute("data-qv-last", "red");

  // ③ 撤回：先恢复数据、再退回上一张（`undo()` 的顺序没改）。
  //    ⚠ 先等**落定动画**走完（`data-qv-index` 从 0 变 1）：那 300ms 里 `committing` 为真，
  //      撤回会被按设计挡掉（动画期间不接受第二次推进）—— 真人不会在这 300ms 里点，
  //      而这里必须按真人的节奏走，否则断言的是「并发竞态」而不是「撤回本身」。
  await expect(card).toHaveAttribute("data-qv-index", "1");
  await page.locator(".qv-undo").click();

  await expect(page.locator(".qv-card")).toHaveAttribute("data-qv-key", first!);
  await expect(page.locator(".qv-undo-idle")).toHaveText("划错了可以撤回");
  // ④ 那一票**真的**从票板上撤掉了 —— 卡片上已经没有票数可看了（2026-10-14「只保留纯海报」），
  //    所以直接读票板本身。⚠ 这是比看数字更硬的判据：数字只是渲染，票板才是那本账。
  const board = await page.evaluate(() => localStorage.getItem("biff.redblack.v2") ?? "");
  expect(board).not.toContain(first!);
});

test("快速投票：矮屏（390 × 667）里卡片不再顶满一屏 —— 海报高度受视口约束", async ({ page }) => {
  // 用户原话「移动端海报太大了」。钉住它的判据不是「卡片多宽」而是**卡片多高**：
  // 海报是 2/3 的竖版，高度 = 宽度 × 1.5，所以矮屏上「一屏放不下那几行」的根因在高度。
  // ⚠ 用 667 高（iPhone SE 那一档）：Pixel 7（915）与 iPhone 13（844）的 `36vh` 恰好大于
  //   `320px` 上限，这条在那两台机器上**测不出差别** —— 必须把视口压到矮屏才守得住。
  await page.setViewportSize({ width: 390, height: 667 });
  await stubEmpty(page);
  await seed(page, deckSeed);
  await ready(page, "/redblack?sort=red&vote=1");

  // 两件事一起量：卡片**自身**的高度受没受约束、以及那几行够不够得着。
  // ⚠ 用 `getBoundingClientRect().bottom ≤ innerHeight` 而不是 `toBeInViewport()`：
  //   后者走 IntersectionObserver，会把**祖先的裁剪**也算进去，这个弹层里报出来是 ratio 0
  //   （元素明明在窗口里）—— 断言的是「用户够不够得着」，那就直接量那个距离。
  // ⚠ 视口高度也取 `innerHeight` 而不是写死的 667：移动端模拟里 `setViewportSize` 之后
  //   真正参与布局的高度与桌面档并不相同（`vh` 也按它算），写死会把差异判成失败。
  const measured = await page.evaluate(() => {
    const rectOf = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    return {
      stage: rectOf(".qv-stage").height,
      // 卡片是 2/3 的竖版：高度 = 宽度 × 1.5，“一屏放不下”的根因在这里而不是宽度
      lowest: Math.max(
        rectOf(".qv-legend").bottom,
        rectOf(".qv-actions").bottom,
        rectOf(".qv-undo-row").bottom,
        rectOf('[aria-label="投红榜"]').bottom,
      ),
      viewport: window.innerHeight,
    };
  });
  expect(measured.stage, JSON.stringify(measured)).toBeLessThanOrEqual(measured.viewport * 0.65);
  expect(measured.lowest, JSON.stringify(measured)).toBeLessThanOrEqual(measured.viewport);
});

test("快速投票：手机上整块内容完整可见 —— 不用滚，且每个控件都点得到", async ({ page }) => {
  // 2026-10-15 用户截图 + 「验证在手机端能完全显示」。判据有三层，缺一不可：
  //  ① 弹层滚动容器 `scrollHeight ≤ clientHeight`（不用滚）；
  //  ② 图例 / 三枚按钮 / 撤回条的矩形都落在视口内；
  //  ③ 这些控件**中心点**真的命中自己（`elementFromPoint`）—— 只看矩形会放过「在视口里但被遮住」。
  // ⚠ 尺寸取「浏览器工具栏吃掉一截之后」的真实可视高度，含最小的 320 × 568（iPhone SE 1 代）。
  const sizes = [
    { width: 430, height: 728 },
    { width: 390, height: 664 },
    { width: 375, height: 553 },
    { width: 360, height: 600 },
    { width: 320, height: 568 },
  ];
  await stubEmpty(page);
  await seed(page, deckSeed);
  for (const size of sizes) {
    await page.setViewportSize(size);
    await ready(page, "/redblack?sort=red&vote=1");
    await expect(page.locator(".qv-card")).toBeVisible();
    const report = await page.evaluate(() => {
      let node: HTMLElement | null = document.querySelector(".qv");
      while (node && node.scrollHeight <= node.clientHeight + 1 && node !== document.body) {
        node = node.parentElement;
      }
      const overflow = node && node !== document.body ? node.scrollHeight - node.clientHeight : 0;
      const hidden: string[] = [];
      const targets: Array<[string, Element | null]> = [
        ["图例", document.querySelector(".qv-legend")],
        ["黑榜", document.querySelector('[aria-label="投黑榜"]')],
        ["跳过", [...document.querySelectorAll(".qv-actions button")][1] ?? null],
        ["红榜", document.querySelector('[aria-label="投红榜"]')],
        ["撤回条", document.querySelector(".qv-undo-row")],
      ];
      for (const [label, el] of targets) {
        if (!el) {
          hidden.push(`${label}:缺失`);
          continue;
        }
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const inView = r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth;
        const hit = document.elementFromPoint(x, y);
        if (!inView || !hit || !(el === hit || el.contains(hit))) hidden.push(label);
      }
      const buttons = [...document.querySelectorAll(".qv-actions button")].map((b) => Math.round(b.getBoundingClientRect().height));
      return { overflow, hidden, buttons };
    });
    const tag = `${size.width}x${size.height} ${JSON.stringify(report)}`;
    expect(report.hidden, tag).toEqual([]);
    expect(report.overflow, tag).toBeLessThanOrEqual(1);
    // 按钮折成两行时高度会翻倍（实测「不喜欢」折成「不喜 / 欢」是 65px）
    for (const height of report.buttons) expect(height, tag).toBeLessThanOrEqual(48);
  }
});

/* ⚠ 2026-10-15（`PLAN-20261015005652`）：候选的**默认来源**从「我的行程」换成了
 * 「全站有过票的影片」（用户：「打开之后默认直接所有有过票的都作为滑动的片单吧这样也不会遗漏
 * 反正划一下也很快」），而用户自己**有行程**时给一枚「换成我的行程」的入口
 * （用户：「如果用户有片单 你可以提示他 切换成自己的行程片单」）。
 * 判据取**计数行**（`第 1 / N 部`）：它直接回答「这一轮的候选是谁」，比盯某一张卡更硬。 */
/* 「跳过的那个提示 应该显示在海报下面 不然往上滑就看不到跳过那两个字了」（用户 2026-10-15）。
 * 原来那两个字压在卡片顶部（`.qv-mark--up`，已删），而卡片整张会往上飞出屏幕 —— 一滑就没了。
 * 现在它由**海报下面那一行常驻图例**承担，往上滑时高亮（`data-qv-skip-live`）。 */
test("快速投票：「跳过」提示在海报下面，往上滑时亮起且不跟卡片飞走", async ({ page }) => {
  await stubVotes(page, { [keyOf("008")]: { red: 1, black: 1 }, [keyOf("033")]: { red: 1 } });
  await ready(page, "/redblack?sort=red&vote=1");
  await expect(page.locator(".qv-card")).toBeVisible();

  // ① 它在**卡片外面、且在海报下方** —— 判据取几何位置，比类名硬
  const stage = (await page.locator(".qv-stage").boundingBox())!;
  const hint = (await page.locator(".qv-legend-skip").boundingBox())!;
  expect(hint.y).toBeGreaterThanOrEqual(stage.y + stage.height);
  // ② 卡片上那枚已经没有了（两处口径不许同时存在）
  await expect(page.locator('.qv-card [data-qv-mark="skip"]')).toHaveCount(0);

  // ③ 往上拖 → 它当场亮起（位移 120px 远过阈值：unit = 卡片较短边，桌面 320 × 0.28 ≈ 90px）
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2 - 120, { steps: 8 });
  const skipHint = page.locator(".qv-legend-skip");
  await expect(skipHint).toHaveAttribute("data-qv-skip-live", "");
  await page.mouse.up();

  // ④ 松手之后卡片飞走，这一行**留在原位**（这正是把提示挪下来的理由），高亮跟着复位
  await expect(skipHint).toBeVisible();
  await expect(skipHint).not.toHaveAttribute("data-qv-skip-live", "");
});

/* 「左滑加入红榜黑榜不明显 / 上滑跳过不明显」（用户 2026-10-15，修订 2）。
 * 原来跟手标记只是描边、跳过提示只是变色 —— 压在海报或默认文字色上都容易被吃掉。
 * 改成实心底色后，这里直接断言 `background-color` 不是 transparent，而不是看截图。
 * ⚠ 「跳过」药丸高亮用的是 `transform: scale()`（视觉放大，不触发重排），所以自身
 *   `getBoundingClientRect` 的宽度本来就会跟着放大 —— 真正要守住的是**不顶动右边「红榜」**，
 *   判据要取右边那枚图例的横向起点（`.qv-legend-right` 的 `x`），而不是药丸自己的宽度。 */
test("快速投票：左滑 / 右滑的跟手标记是实心底色，跳过药丸高亮不顶动右边「红榜」", async ({ page }) => {
  await stubVotes(page, { [keyOf("008")]: { red: 1, black: 1 }, [keyOf("033")]: { red: 1 } });
  await ready(page, "/redblack?sort=red&vote=1");
  await expect(page.locator(".qv-card")).toBeVisible();
  const stage = (await page.locator(".qv-stage").boundingBox())!;

  // ① 跳过药丸未高亮时先确认是透明底（既有常态），同时量一次「红榜」图例的横向起点
  const skipHint = page.locator(".qv-legend-skip");
  const rightLegend = page.locator(".qv-legend-right");
  const bgIdle = await skipHint.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bgIdle).toBe("rgba(0, 0, 0, 0)");
  const rightXIdle = (await rightLegend.boundingBox())!.x;

  // ② 左滑：拖够距离，`.qv-mark--left`（加入黑榜）应该是实心底色，不是透明描边
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width / 2 - 120, stage.y + stage.height / 2, { steps: 8 });
  const leftMark = page.locator('[data-qv-mark="passed"]');
  const leftBg = await leftMark.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(leftBg).not.toBe("rgba(0, 0, 0, 0)");
  await page.mouse.up();

  // ③ 上滑：跳过药丸高亮时同样是实心底色，且右边「红榜」图例的横向起点**几乎不变**（没被顶动）
  await ready(page, "/redblack?sort=red&vote=1");
  await expect(page.locator(".qv-card")).toBeVisible();
  const stage2 = (await page.locator(".qv-stage").boundingBox())!;
  await page.mouse.move(stage2.x + stage2.width / 2, stage2.y + stage2.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage2.x + stage2.width / 2, stage2.y + stage2.height / 2 - 120, { steps: 8 });
  const bgLive = await skipHint.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bgLive).not.toBe("rgba(0, 0, 0, 0)");
  const rightXLive = (await rightLegend.boundingBox())!.x;
  expect(Math.abs(rightXLive - rightXIdle)).toBeLessThanOrEqual(1);
  await page.mouse.up();
});

test("快速投票：默认按「全部有票的影片」划，并可换成我的行程", async ({ page }) => {
  const a = keyOf("008");
  const b = keyOf("033");
  // 榜上有票的只有这 2 部；而 `deckSeed` 的行程里有 5 部（001 / 008 / 033 / 037 / 蓦然回首）
  await stubVotes(page, { [a]: { red: 3, black: 1 }, [b]: { red: 0, black: 2 } });
  await seed(page, deckSeed);
  await ready(page, "/redblack?sort=red&vote=1");

  await expect(page.locator(".qv-card")).toBeVisible();
  // ① 默认来源 = 有票的（2 部），**不是**行程（5 部）
  await expect(page.locator(".qv-counter")).toContainText("第 1 / 2 部");
  await expect(page.locator(".qv-source")).toContainText("换成我的行程");

  // ② 换来源 = 换整轮候选：计数行跟着变（换来源是用户主动点的，重开一轮是应然）
  await page.locator(".qv-source-switch").click();
  await expect(page.locator(".qv-counter")).toContainText("第 1 / 5 部");
  await expect(page.locator(".qv-source")).toContainText("换成全部有票的");

  // ③ 换得回去 —— 只给单向入口的话，用户切过去就回不来了
  await page.locator(".qv-source-switch").click();
  await expect(page.locator(".qv-counter")).toContainText("第 1 / 2 部");
});

/* 划完了还没看到自己看过的那部（冷门片多半两边都没沾上）——
 * 用户 2026-10-15：「你需要提示他 类似于没有找到自己看过的电影吗 尝试通过 CODE 搜索」。
 * ⚠ 那枚按钮**不能只关卡片**：卡片是弹层、搜索框在它后面，所以断言**焦点真的落在搜索框上**。 */
test("快速投票：划完给一条「去搜索」的出口，关掉卡片后焦点落在搜索框", async ({ page }) => {
  await stubVotes(page, { [keyOf("008")]: { red: 2, black: 1 } });
  await ready(page, "/redblack?sort=red&vote=1");

  // 候选只有 1 部 → 投完就是总结页
  await expect(page.locator(".qv-counter")).toContainText("第 1 / 1 部");
  await page.getByRole("button", { name: "投红榜" }).click();

  const missing = page.locator(".qv-missing");
  await expect(missing).toBeVisible();
  await expect(missing).toContainText("没找到你看过的那部");
  await expect(missing).toContainText("场次编号");

  await page.locator(".qv-missing-btn").click();
  // ① 卡片真的关掉了（不是只把焦点挪走）
  await expect(page.getByRole("dialog", { name: "快速投票" })).toHaveCount(0);
  // ② 焦点落在页面上的搜索框 —— 这一步的用途就是「换个入口去找」，不送焦点等于让用户自己找一圈
  await expect(page.getByRole("searchbox")).toBeFocused();
});

/* 「还是把影片信息放到海报上吧 中英文名 导演名称 然后 code 就行」（用户 2026-10-15，
 * `PLAN-20261015005652` 修订 1）—— 对「只保留纯海报」的部分收回，只叠这四样。
 * 场次 008《宛如星辰的你》（title_en: "You, Like a Star"、director: "藤井道人"）来自
 * 真实目录数据（见 PLAN 修订 1 的数据核对），不是桩出来的，所以这里断言**具体文字**。
 *
 * ⚠ 2026-10-15 修订 3（用户：「code 应该需要显示成 004/008 这样 而不是显示成 CODE 004 这样
 *   而且丢了其他场次」）：这一行现在是**全部场次编号**、用 `/` 连，且**不带「CODE 」前缀**。
 *   008 这部片排了四场（真实数据）：按 (date, start_time) 是 008 → 143 → 248 → 681，
 *   所以整行读作 "008/143/248/681" —— 旧的 `toContainText("008")` 在「只印第一场」的实现下
 *   也会通过，钉不住这个 bug，必须写成**整行相等**。 */
test("快速投票：海报上叠着中英文名 / 导演 / 全部场次编号四行", async ({ page }) => {
  await stubVotes(page, { [keyOf("008")]: { red: 2, black: 1 } });
  await ready(page, "/redblack?sort=red&vote=1");

  const info = page.locator(".qv-card .qv-info");
  await expect(info).toBeVisible();
  await expect(info.locator(".qv-info-zh")).toHaveText("宛如星辰的你");
  await expect(info.locator(".qv-info-en")).toHaveText("You, Like a Star");
  await expect(info.locator(".qv-info-director")).toContainText("藤井道人");
  // 整行相等：四场一个都不能丢，且没有「CODE 」前缀
  await expect(info.locator(".qv-info-code")).toHaveText("008/143/248/681");
});

/* 「每次进入红黑榜就是直接默认弹出快速投票」（用户 2026-10-15，`PLAN-20261015005652` 修订 1）——
 * 判据从「有没有行程」换成「有没有从热门榜切进来」。这条钉住三步：
 * 落地在热门榜不弹 → 切到红榜自动弹 → 切回热门榜关掉 → 再切回红榜又弹一次。 */
test("快速投票：从热门榜切到红 / 黑榜会自动弹出卡片，切回热门榜会关掉", async ({ page }) => {
  // ⚠ 必须有**候选**：空候选时卡片渲染的是 `.qv-empty` 那句说明，不是 `.qv-card`
  // （这条要断言的是「自动弹」本身，不该被「候选是空的」那条分支干扰）。
  await stubVotes(page, { [keyOf("008")]: { red: 2, black: 1 } });
  await ready(page, "/redblack");

  // ① 落地在热门榜，不弹
  await expect(page.locator('[data-board-tab="hot"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".qv-card")).toHaveCount(0);

  // ② 切到红榜：自动弹出（不用先点「快速投票」按钮）
  await page.locator('[data-board-tab="red"]').click();
  await expect(page.locator(".qv-card")).toBeVisible();

  // ③ 卡片是模态弹层，挡住了下面的 tab 栏（现实中必须先关掉才能切 tab）——
  //    先 Esc 关掉，再切回热门榜：`vote` 被清掉。
  await page.keyboard.press("Escape");
  await expect(page.locator(".qv-card")).toHaveCount(0);
  await page.locator('[data-board-tab="hot"]').click();
  await expect(page.locator(".qv-card")).toHaveCount(0);

  // ④ 再切回红榜：又弹一次（不是「只有第一次有效」）
  await page.locator('[data-board-tab="red"]').click();
  await expect(page.locator(".qv-card")).toBeVisible();

  // ⑤ 用户在红黑榜里自己关掉卡片后，红 ↔ 黑之间来回切**不会**把它弹回来
  //    （两者都已经在红黑榜里，不算「进入」；见 `BoardPage.tsx::pick` 的注释）
  await page.keyboard.press("Escape");
  await expect(page.locator(".qv-card")).toHaveCount(0);
  await page.locator('[data-board-tab="black"]').click();
  await expect(page.locator(".qv-card")).toHaveCount(0);
});

test("扫码投票：控制栏那枚按钮打开弹层，里面是一枚画好了的二维码", async ({ page }) => {
  await stubEmpty(page);
  await ready(page, "/redblack?sort=red");

  const entry = page.getByRole("button", { name: "打开扫码投票二维码" });
  await entry.click();
  const dialog = page.getByRole("dialog", { name: "扫码投票" });
  await expect(dialog).toBeVisible();

  // 二维码真的画上去了 —— canvas 手绘没有 DOM 可断言，只能读像素：
  // 白底之外必须有**足够多的深色格**（全白 = 没画、全黑 = 画反了，两种都扫不出来）。
  const darkRatio = await dialog.locator("canvas.qr-canvas").evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 128) dark += 1;
    return dark / (data.length / 4);
  });
  expect(darkRatio).toBeGreaterThan(0.1);
  expect(darkRatio).toBeLessThan(0.7);

  // 链接也亮出来了：同一台手机上自扫时靠它兜底；两个参数少一个落点就不对
  await expect(dialog).toContainText("/redblack?sort=red&vote=1");
  await expect(dialog.getByRole("button", { name: "下载 PNG 图片" })).toBeVisible();

  // Esc 关闭 + 焦点归还那枚入口按钮（与分享图同一个手法）
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(entry).toBeFocused();
});
