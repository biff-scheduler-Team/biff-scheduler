import { test, expect, type Locator, type Page } from "@playwright/test";
import { keyOf, paintedTexts, ready, trackPaintedTexts } from "./helpers";

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
  // 一枚贴纸都没有时不给「看全部」入口 —— 点开只会是一块空画布
  await expect(page.getByRole("button", { name: /放大查看/ })).toHaveCount(0);
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
  // backing store 也要真的释放:一张卡约 1MB(含 dpr 放大),299 张全留就是几百 MB 显存
  await expect(card.locator("canvas.rb-ink")).toHaveJSProperty("width", 0);

  // 回到这张卡:补齐(贴纸是绝对定位,补画不引起版面跳动,所以这里只需断言属性回来)
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator(".rb-canvas[data-rb-crowd]")).toHaveAttribute("data-rb-crowd", "5");
  await expect(card.locator("canvas.rb-ink")).not.toHaveJSProperty("width", 0);
});

test("「别人的贴纸」与我贴的那枚同尺寸,别人那枚仍不可拖", async ({ page }) => {
  const key = keyOf("008");
  await stubVotes(page, { [key]: { red: 3, black: 2 } });
  await ready(page, "/redblack");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /^标记《/ }).click();
  await card.getByRole("button", { name: /贴红贴纸/ }).click();

  const mine = card.locator(".rb-dot");
  await expect(mine).toHaveCount(1);
  await expect(mine.first()).toHaveCSS("width", "26px");
  await expect(mine.first()).toHaveCSS("cursor", "grab");

  // 别人的贴纸整层是 canvas(2026-09-22,PLAN-20260922145815):
  // ⚠ 必须 `pointer-events: none` —— 拖拽落点靠 `elementFromPoint().closest("[data-rb-canvas]")`,
  //   画布挡住就拖不进这张卡,而「能不能拖」正是群点与我贴的那一枚**唯一**的区别。
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

// 「放大看全部」弹层(2026-09-22,PLAN-20260922145815)。
// 卡片那块画布只有一百多像素高,票一多就叠成一片 —— 弹层给一块大画布。
// a11y 全部走 S2 `Dialog`(role=dialog / focus trap / Esc),焦点归还由卡片那个按钮自己做,
// 这两条都是 §5 的硬约束,必须有机读断言守着。
test("放大看全部:弹层给大画布、画全部贴纸,Esc 关闭并把焦点还回按钮", async ({ page }) => {
  const key = keyOf("008");
  await stubVotes(page, { [key]: { red: 3, black: 2 } });
  await ready(page, "/redblack");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /^标记《/ }).click();
  await card.getByRole("button", { name: /贴红贴纸/ }).click();

  const opener = card.getByRole("button", { name: /放大查看/ });
  await opener.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("全部贴纸");
  // ⚠ 「全部」不是「别人的 + 我的」相加后的重复计数:服务端那份**已含我**,
  //   所以弹层里的数字应当与卡片上的红黑数字**逐字一致**(3 红 2 黑 → 共 5 枚)
  await expect(dialog).toContainText("共 5 枚（红 3 · 黑 2）");

  const cardBox = await card.locator("canvas.rb-ink").boundingBox();
  const stage = dialog.locator(".rb-zoom-stage canvas.rb-ink");
  await expect(stage).toHaveCount(1);
  const stageBox = await stage.boundingBox();
  // 「放大」要真的更大 —— 贴纸是相对坐标,画布一大原来叠着的点就散开了
  expect(stageBox!.height).toBeGreaterThan(cardBox!.height);
  // 大画布同样要按 dpr 放大 backing store,否则高分屏上一样糊
  const backing = await stage.evaluate((node: HTMLCanvasElement) => ({
    width: node.width,
    expected: Math.round(node.getBoundingClientRect().width * window.devicePixelRatio),
  }));
  expect(backing.width).toBe(backing.expected);

  // Esc 关闭 + 焦点归还原按钮
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(opener).toBeFocused();
});

// 我贴的那一枚的两条交互(2026-09-22,PLAN-20260922160432):
//  ① **单击收回** —— 文件头早就写着「单击就取下」,但实现里只挂了 pointerdown,
//     从来没有这个能力;唯一能收回的路径是「拖出画布」这个相当隐蔽的手势。
//  ② **拖一下不能顺手收走** —— `pointerup` 之后浏览器还会补一次 `click`,
//     不做区分的话「微调位置」会变成「撤销」。
test("单击自己贴的那一枚就收回暂存区,按钮重新可贴", async ({ page }) => {
  const pings: Array<{ votes?: unknown }> = [];
  await page.route("**/api/stats/film-votes**", async (route) => {
    if (route.request().method() === "POST") {
      pings.push(route.request().postDataJSON() as { votes?: unknown });
      return route.fulfill({ json: { ok: true, count: 0 } });
    }
    return route.fulfill({ json: { edition: "biff-2026", votes: {} } });
  });
  await ready(page, "/redblack");

  const key = keyOf("008");
  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  const trayRed = card.getByRole("button", { name: /贴红贴纸/ });
  await card.getByRole("button", { name: /^标记《/ }).click();
  await trayRed.click();

  const mine = card.locator(".rb-dot");
  await expect(mine).toHaveCount(1);
  // 贴过了 → 暂存区那两枚淡下去(`data-rb-spent` 是**存在即真**,值是 "true")
  await expect(trayRed).toHaveAttribute("data-rb-spent", "true");

  await mine.click();

  // 收回到暂存区:画布空了、提示回来了、按钮重新亮起
  await expect(card.locator(".rb-dot")).toHaveCount(0);
  await expect(card.locator(".rb-canvas-hint")).toHaveCount(1);
  await expect(trayRed).not.toHaveAttribute("data-rb-spent");
  // 上报是**整份替换**:收回之后服务端那份应当变成空表(否则服务端还替我留着那一票)
  await expect.poll(() => pings.at(-1)?.votes ?? null, { timeout: 8000 }).toEqual([]);
});

test("拖一下微调位置不算单击:贴纸不会被顺手收走", async ({ page }) => {
  await stubEmpty(page);
  await ready(page, "/redblack");

  const key = keyOf("008");
  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /^标记《/ }).click();
  await card.getByRole("button", { name: /贴红贴纸/ }).click();

  const mine = card.locator(".rb-dot");
  await expect(mine).toHaveCount(1);
  // ⚠ 先把这张卡滚到视口**中间**:贴纸是随机落点,不居中时它可能落在视口上方
  //   (实测 y = -41),那样 `page.mouse` 的事件根本送不到它身上 —— 测试会假绿
  await card.evaluate((node) => node.scrollIntoView({ block: "center" }));
  const before = (await mine.boundingBox())!;
  expect(before.y).toBeGreaterThan(0);

  // 只挪 10px(越过鼠标 4px 的拖动阈值),而且**松手点仍落在这枚贴纸自己身上** ——
  // 这样浏览器会在 pointerup 之后补发一次 click,正是要防的那条路径
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 10, before.y + before.height / 2 + 8, {
    steps: 6,
  });
  await page.mouse.up();

  await expect(card.locator(".rb-dot")).toHaveCount(1);
  // 而且是**挪了位置**(说明确实走了拖拽分支),不是原地没动
  const after = (await mine.boundingBox())!;
  expect(Math.abs(after.x - before.x) + Math.abs(after.y - before.y)).toBeGreaterThan(4);
});

// 刚贴下的那一枚闪描边(PLAN-20260922160432):票多时点按钮贴下去的那一枚会被丢进一片点里,
// 原来没有任何线索指出它在哪;但**必须有界** —— 闪完就与别人的贴纸逐字一致(拉平口径)。
test("刚贴的那一枚会闪描边,闪完与别人的完全一致", async ({ page }) => {
  await stubEmpty(page);
  await ready(page, "/redblack");

  const key = keyOf("008");
  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /^标记《/ }).click();
  await card.getByRole("button", { name: /贴红贴纸/ }).click();

  const mine = card.locator(".rb-dot");
  // ⚠ 属性值是 "true"(React 对 data-* 上的布尔值走 setAttribute(String(v)))
  await expect(mine).toHaveAttribute("data-rb-fresh", "true");
  await expect(mine).toHaveCSS("outline-style", "solid");
  // 有界:2.4s 之后连描边一起去掉 —— 不是常驻标识
  await expect(mine).not.toHaveAttribute("data-rb-fresh");
  await expect(mine).toHaveCSS("outline-style", "none");
});

// 默认档「按总数从高到低」在**首屏**就得是真的(2026-09-22,PLAN-20260922161710)。
// 改版前:排序发生在票数到达之前 → 每部并列 0 → 退化成影片库目录序,而 chip 上写着「按总数」。
// 这条守的是「票数一落定就自动补排一次」。
test("默认档「按总数」在首屏就是真的:票数落定后自动排一次", async ({ page }) => {
  const top = keyOf("008");
  await stubVotes(page, { [top]: { red: 40, black: 0 } });
  await ready(page, "/redblack");

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
  await ready(page, "/redblack");

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

// 生成分享图(2026-09-22):三榜各 TOP10 + **我贴过的全部** + 底部署名。
// 出图是 canvas 手绘、没有 DOM 可断言,所以读**画出来的字**
// (`helpers.ts::trackPaintedTexts` 给 `fillText` 打了补丁)。
test("生成分享图:三榜各 TOP10、我贴过的全部、底部署名", async ({ page }) => {
  await trackPaintedTexts(page);
  const top = keyOf("008");
  const low = keyOf("003");
  // 一部只有红票、一部只有黑票 → 红榜 / 黑榜各自只剩一条,便于断言「该榜按该色排」
  await stubVotes(page, { [top]: { red: 40, black: 0 }, [low]: { red: 0, black: 30 } });
  await ready(page, "/redblack");

  const card = page.locator(`.rb-card[data-film-key="${top}"]`);
  const topTitle = (await card.locator(".rb-title").textContent())!.trim();
  await card.getByRole("button", { name: /^标记《/ }).click();
  await card.getByRole("button", { name: /贴红贴纸/ }).click();

  const opener = page.getByRole("button", { name: "生成分享图" });
  await opener.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".rb-share-preview")).toBeVisible();
  // 出图是异步的(画完才 toBlob),这里等按钮出来即代表图已生成
  await expect(dialog.getByRole("button", { name: "下载 PNG 图片" })).toBeVisible();

  const painted = await paintedTexts(page);
  // 头部 + 三榜标签 + 我的那一节 + 署名:逐项都要画出来
  for (const needle of [
    "BIFF 2026 · 观影红黑榜",
    "红黑榜",
    "总数榜",
    "按红 + 黑贴纸数",
    "红榜",
    "按红贴纸数",
    "黑榜",
    "按黑贴纸数",
    "我贴过的 1 部",
    "biff.lcandy.co",
    "by @gaaiyeoi 和 by @lcandy2",
  ]) {
    expect(painted).toContain(needle);
  }
  // 我贴过的片名要真的画上去(而不是只有节标题)
  expect(painted).toContain(topTitle);
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
  // 首屏**不该**留下「有新贴纸」的提示:票数落定后会自动按总数补排一次(2026-09-22,PLAN-20260922161710)。
  // 改版前首屏那次排序发生在票数到达之前(全部并列 0 → 退化成目录序),所以才需要这条提示让人手动补排。
  // ⚠ 属性值是 `"true"` 而不是空串:React 对 `data-*` 上的布尔值走 `setAttribute(String(v))`
  //   (`data-rb-stale={orderStale || undefined}`)。
  await expect(resort).not.toHaveAttribute("data-rb-stale");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /^标记《/ }).click();
  await card.getByRole("button", { name: /贴红贴纸/ }).click();
  // 群点已在 canvas 上,所以 `.rb-dot--red` 只可能是我贴的那一枚
  await expect(card.locator(".rb-dot--red")).toHaveCount(1);

  // 等 ping 之后那次**重拉**真的发生(上报有 1200ms 防抖)
  await expect.poll(() => reads, { timeout: 8000 }).toBeGreaterThan(1);
  // 给 setVotes → 重渲染留一拍:修复前这里会亮起「有新贴纸」(votes 换了新对象)
  await page.waitForTimeout(500);
  await expect(resort).not.toHaveAttribute("data-rb-stale");
});
