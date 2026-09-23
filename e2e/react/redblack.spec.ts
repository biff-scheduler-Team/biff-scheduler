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

// 空榜那句引导**不能**随「标记看过 / 取消标记」出现消失(2026-09-23 用户:
// 「标记看过 未看过 这个按钮 即使我没有进行贴贴纸动作 好像会触发重新渲染 整个贴纸页面好像闪了一下」)。
// 它挂在栅格**上方**,一收一放会把整页内容顶上去 53px(实测:38px 提示条 + 15px 间距)——
// 用户点一下标记,看到的是「整页闪了一下」。根因是条件里混进了 `totals.marked`(本地「我看过」),
// 而文案说的「榜」指的是全站票数,两回事。
// ⚠ 判据用**文档坐标**(`rect.top + scrollY`)而不是视口坐标:Playwright 为了点击可能会滚页面,
//   那样量的是滚动不是布局位移 —— 这次差一点又被它骗过去。
test("点「标记看过」不会把整页顶上去", async ({ page }) => {
  await stubEmpty(page);
  await ready(page, "/redblack");

  const key = keyOf("008");
  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  const gridTopDoc = () =>
    page.evaluate(() =>
      Math.round(
        (document.querySelector(".rb-grid") as HTMLElement).getBoundingClientRect().top + scrollY,
      ),
    );

  const before = await gridTopDoc();
  await card.getByRole("button", { name: /^标记《/ }).click();
  await expect(card).toHaveAttribute("data-rb-marked", "true");
  expect(await gridTopDoc()).toBe(before);
  // 引导条还在(它只随「全站有没有贴纸」变,与本地的「我看过」无关)
  await expect(page.locator(".rb-hint")).toBeVisible();

  // 再点回去也一样,不许弹回来
  await card.getByRole("button", { name: /取消标记/ }).click();
  await expect(card).not.toHaveAttribute("data-rb-marked", "true");
  expect(await gridTopDoc()).toBe(before);
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

// 「按视口省渲染」只管**别人的**那一层 canvas:我贴的那一枚是**可拖的真实元素**,
// 屏幕外也必须留在 DOM 里 —— 它要是跟着群点一起被省掉,用户滚回来才看见它,会读成「我的贴纸丢了」。
// 用户 2026-09-23:「能否实现自己贴的贴纸始终能被自己拖动?」—— 这条就是那个「始终」的判据。
test("屏幕外的卡片仍留着我贴的那一枚:自己的贴纸始终抓得到", async ({ page }) => {
  const key = keyOf("008");
  await stubVotes(page, { [key]: { red: 3, black: 2 } });
  await ready(page, "/redblack");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /^标记《/ }).click();
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
  // 而且它压在最上层、点得到自己 —— 这就是「能不能拖」本身
  // (群点在 `.rb-ink` 上,那层 `pointer-events: none`,不会把它盖住)
  const hitSelf = await mine.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit === node || node.contains(hit);
  });
  expect(hitSelf).toBe(true);
});

test("「别人的贴纸」与我贴的那枚同尺寸,只差常驻纸白边与能不能拖", async ({ page }) => {
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

  // **常驻纸白边**(2026-09-23):我贴的那一枚独有,群点那边(canvas / sprite)不许有这一层 ——
  // 票数一多,同色同尺寸的点里根本认不出自己那枚,「自己贴的贴纸始终能被自己拖动」就先卡在“找不到”。
  // ⚠ 只断言那一层 `1.5px` 的实心圈(整个 `box-shadow` 字符串各浏览器序列化不同,比不得);
  //   `1.5px` 在这条规则里只出现这一次,所以这个松匹配等于精确匹配。
  await expect(mine.first()).toHaveCSS("box-shadow", /1\.5px/);

  // 别人的贴纸整层是 canvas(2026-09-22,PLAN-20260922145815):
  // ⚠ 必须 `pointer-events: none` —— 拖拽落点靠 `elementFromPoint().closest("[data-rb-canvas]")`,
  //   画布挡住就拖不进这张卡,而「能不能拖」是群点与我贴的那一枚**两处**区别之一(另一处是纸白边)。
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

// 弹层里也要认得出自己那枚(2026-09-23,PLAN-20260923104622)。改之前这里把 `all` 交给画布:
// 我那一枚被画成 `crowdStickers(filmKey, all)` 的**最后一枚** —— 那是由 id 推导出来的点,
// 既不是它在卡片上的真实落点,也没有卡片上那圈常驻纸白边;而 lede 还写着「位置与卡片上一致」。
test("放大弹层里也认得出自己那枚:同位置、同白边", async ({ page }) => {
  const key = keyOf("008");
  await stubVotes(page, { [key]: { red: 3, black: 2 } });
  await ready(page, "/redblack");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /^标记《/ }).click();
  await card.getByRole("button", { name: /贴红贴纸/ }).click();
  const cardDot = card.locator(".rb-canvas .rb-dot");
  await expect(cardDot).toHaveCount(1);

  await card.getByRole("button", { name: /放大查看/ }).click();
  const stage = page.getByRole("dialog").locator(".rb-zoom-stage");
  await expect(stage).toBeVisible();

  // ① 弹层里那一枚就是卡片上那一枚:独立的 DOM 元素(不是画布上的群点),白边还在
  const zoomDot = stage.locator(".rb-dot");
  await expect(zoomDot).toHaveCount(1);
  await expect(zoomDot).toHaveCSS("box-shadow", /1\.5px/);
  // 只读:光标不能还是 `grab` —— 弹层里拖不动,留着那是在承诺一个不存在的交互
  await expect(zoomDot).toHaveCSS("cursor", "default");

  // ② 相对位置一致(两边都是 `posX / posY` 的百分比,所以量**归一化**后的坐标 —— 画布尺寸不同)
  const rel = async (dot: Locator, box: Locator) => {
    const d = (await dot.boundingBox())!;
    const b = (await box.boundingBox())!;
    return {
      x: (d.x + d.width / 2 - b.x) / b.width,
      y: (d.y + d.height / 2 - b.y) / b.height,
    };
  };
  const onCard = await rel(cardDot, card.locator(".rb-canvas"));
  const inZoom = await rel(zoomDot, stage);
  expect(Math.abs(onCard.x - inZoom.x)).toBeLessThan(0.02);
  expect(Math.abs(onCard.y - inZoom.y)).toBeLessThan(0.02);
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

// 张贴区**按片独立**(2026-09-23 用户:「从 A 电影张贴区的贴纸 移到 B 电影的 会直接被贴上
// 我认为应该贴纸张贴区应该是电影之间独立的」)。旧口径 `moveSticker` 收一个 `toKey`:
// 拖到别片的画布上松手,这一票就被**直接改记到别片头上** —— 不报错、不提示,只有盯着两张卡才看得出来。
test("跨片拖拽:别片的张贴区一枚都不会多", async ({ page }) => {
  await stubEmpty(page);
  await ready(page, "/redblack");

  // ⚠ 用**相邻的两张卡**而不是挑两个 key:拖拽走真实指针坐标,两张卡必须同时在视口里
  //   (挑 key 的话它们可能隔着几十张卡,`page.mouse` 的事件送不到另一张身上,测试会假绿)。
  const a = page.locator(".rb-card").nth(0);
  const b = page.locator(".rb-card").nth(1);
  await a.getByRole("button", { name: /^标记《/ }).click();
  await b.getByRole("button", { name: /^标记《/ }).click();
  await a.getByRole("button", { name: /贴红贴纸/ }).click();

  const mine = a.locator(".rb-dot");
  await expect(mine).toHaveCount(1);
  // ⚠ 贴纸是随机落点,不居中时它可能落在视口上方 —— 那样 `page.mouse` 的事件根本送不到它身上
  await a.evaluate((node) => node.scrollIntoView({ block: "center" }));
  const from = (await mine.boundingBox())!;
  const aBox = (await a.locator(".rb-canvas").boundingBox())!;
  const bBox = (await b.locator(".rb-canvas").boundingBox())!;
  const vh = page.viewportSize()!.height;
  const center = (box: { x: number; y: number; width: number; height: number }) => ({
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  });
  const here = center(from);
  const aMid = center(aBox);
  const bMid = center(bBox);
  for (const point of [here, aMid, bMid]) {
    expect(point.y).toBeGreaterThan(0);
    expect(point.y).toBeLessThan(vh);
  }

  await page.mouse.move(here.x, here.y);
  await page.mouse.down();
  // 先在本片画布上走一段:这张卡**是**合法落点 → 它亮着
  await page.mouse.move(aMid.x, aMid.y, { steps: 4 });
  await expect(a).toHaveAttribute("data-rb-hover", "");

  // 再拖到《B》的画布正中:张贴区按片独立 → 《B》不该被点亮成落点(亮灯 = 承诺一个不会兑现的落点)
  await page.mouse.move(bMid.x, bMid.y, { steps: 8 });
  await expect(b).not.toHaveAttribute("data-rb-hover", "");
  await expect(a).not.toHaveAttribute("data-rb-hover", "");
  await page.mouse.up();

  // 松手:《B》一枚都不会多(旧口径下这一枚会直接落在《B》的画布上)
  await expect(b.locator(".rb-dot")).toHaveCount(0);
  await expect(b.locator(".rb-canvas-hint")).toHaveCount(1);
  // 页面上贴纸总数不会变多:《A》那枚要么留在原位、要么收回暂存区,两者都不是「贴到《B》」
  expect(await page.locator(".rb-dot").count()).toBeLessThanOrEqual(1);
});

/** 造一个**原生** PointerEvent 的初始化参数(两处 helper 共用)。
 *  ⚠ 默认 `touch` + 「按下即 `buttons: 1`」—— 双指那条用例要的就是两根手指。
 *  只有「窗口外松手」那条要显式给 `mouse` + `buttons: 0`:那是**鼠标独有**的失效形态。 */
function pointerInit(
  type: "pointerdown" | "pointermove" | "pointerup",
  pointerId: number,
  point: { x: number; y: number },
  opts: { pointerType?: string; buttons?: number } = {},
) {
  return {
    type,
    pointerId,
    x: point.x,
    y: point.y,
    pointerType: opts.pointerType ?? "touch",
    buttons: opts.buttons ?? (type === "pointerup" ? 0 : 1),
  };
}

/** 往**元素**上派发一个指针事件(按下 / 移动)。
 *  ⚠ 为什么要绕开 Playwright 的输入 API:`page.mouse` 与 `page.touchscreen` 都是**单指**,
 *    而「一次松手结算两次落点」必须**两指同时按住**才复现 —— 只能自己造带不同 `pointerId` 的事件。
 *    事件 `bubbles` 到 root 上,React 的 `onPointerDown` 照常收得到。 */
async function dispatchPointer(
  target: Locator,
  type: "pointerdown" | "pointermove",
  pointerId: number,
  point: { x: number; y: number },
  opts: { pointerType?: string; buttons?: number } = {},
) {
  await target.evaluate(
    (node, init) => {
      node.dispatchEvent(
        new PointerEvent(init.type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: init.pointerId,
          pointerType: init.pointerType,
          isPrimary: init.pointerId === 1,
          button: 0,
          buttons: init.buttons,
          clientX: init.x,
          clientY: init.y,
        }),
      );
    },
    pointerInit(type, pointerId, point, opts),
  );
}

/** 抬起 / 取消：直接派发到 `window`(拖拽监听器就挂在它上面)。
 *  ⚠ 刻意**不**落在具体元素上:回归时《B》那枚会被旧代码误判成「拖出画布」而原地收回,
 *    定位它会一直等到超时 —— 那样失败信息是「元素等不到」而不是「次数不对」,读不出根因。 */
async function dispatchPointerUp(page: Page, pointerId: number, point: { x: number; y: number }) {
  await page.evaluate((init) => {
    window.dispatchEvent(
      new PointerEvent(init.type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: init.pointerId,
        pointerType: "touch",
        isPrimary: init.pointerId === 1,
        button: 0,
        buttons: init.buttons,
        clientX: init.x,
        clientY: init.y,
      }),
    );
  }, pointerInit("pointerup", pointerId, point));
}

// 单手势守卫(2026-09-23 review,PLAN-20260923103830)。监听器改成在 `pointerdown` 里**同步**挂到
// `window` 之后,旧实现那层「`useEffect` cleanup 先摘掉上一套监听」的保护没有了:两指各按住一张卡的
// 贴纸时,两套 `onUp` 都会收到**同一个** `pointerup`,各自用当前坐标调一次 `finishRef` ——
// 一次松手把**两张卡**都结算了(第二套用的还是第一根手指的坐标)。
// ⚠ 现有用例抓不到它:它们全都只按一根手指。
test("两指同时按住两张卡的贴纸:一次松手只结算发起的那一枚", async ({ page }) => {
  await stubEmpty(page);
  await ready(page, "/redblack");

  const a = page.locator(".rb-card").nth(0);
  const b = page.locator(".rb-card").nth(1);
  await a.getByRole("button", { name: /^标记《/ }).click();
  await b.getByRole("button", { name: /^标记《/ }).click();
  await a.getByRole("button", { name: /贴红贴纸/ }).click();
  await b.getByRole("button", { name: /贴黑贴纸/ }).click();
  const dotA = a.locator(".rb-dot");
  const dotB = b.locator(".rb-dot");
  await expect(dotA).toHaveCount(1);
  await expect(dotB).toHaveCount(1);

  // 两张卡都要在视口里:`elementFromPoint` 与指针坐标都按视口算(实测过假绿)
  await a.evaluate((node) => node.scrollIntoView({ block: "center" }));
  const vh = page.viewportSize()!.height;
  for (const dot of [dotA, dotB]) {
    const box = (await dot.boundingBox())!;
    expect(box.y).toBeGreaterThan(0);
    expect(box.y + box.height).toBeLessThan(vh);
  }
  const aBox = (await dotA.boundingBox())!;
  const bBox = (await dotB.boundingBox())!;
  const centerOf = (box: { x: number; y: number; width: number; height: number }) => ({
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  });
  const aFrom = centerOf(aBox);
  const bAt = centerOf(bBox);

  // 第一指按住《A》那枚 → 第二指按住《B》那枚(同一时刻的两个指针)
  await dispatchPointer(dotA, "pointerdown", 1, aFrom);
  await dispatchPointer(dotB, "pointerdown", 2, bAt);
  // ⚠ 落点取《A》画布的**几何中心**,不是「贴纸中心 + 固定像素」(2026-09-23,PLAN-20260923104622):
  //   贴纸落点是 `Math.random` 的,靠近画布右下角时那个偏移会把松手点推出画布 → 判成出界 →
  //   那枚被收回 → 断言以「确实动了」失败(偶发**假红**)。按画布矩形推出来的点才是确定性的。
  const aDrop = centerOf((await a.locator(".rb-canvas").boundingBox())!);
  // 第一指拖动(越过触屏 10px 阈值),第二指不动
  await dispatchPointer(dotA, "pointermove", 1, aDrop);
  // 抬起第一指 —— 旧实现这一刻两套 `onUp` 都会收到它,第二套还会拿**这个坐标**去结算《B》
  // (实测症状:坐标落在《A》的画布上 → 对《B》而言是「拖出画布」→ 那枚被**当场误收回**,连弹一条 toast)
  await dispatchPointerUp(page, 1, aDrop);
  await dispatchPointerUp(page, 2, bAt);

  // 发起的那一枚**确实被挪到了松手那一点**(否则就是「手势压根没跑」,测试会假绿)
  const aAfter = centerOf((await dotA.boundingBox())!);
  expect(Math.abs(aAfter.x - aDrop.x)).toBeLessThan(2);
  expect(Math.abs(aAfter.y - aDrop.y)).toBeLessThan(2);
  // 《B》那枚**一枚不多、一位不移**
  await expect(dotB).toHaveCount(1);
  const bAfter = (await dotB.boundingBox())!;
  expect(Math.abs(bAfter.x - bBox.x) + Math.abs(bAfter.y - bBox.y)).toBeLessThan(1);
  expect(await page.locator(".rb-dot").count()).toBe(2);
});

// 丢了 `pointerup` 的兜底(2026-09-23 review 第二轮,PLAN-20260923104622)。鼠标在**浏览器窗口外**
// 松手时,抬手那一刻可能根本没送到页面上 —— `end()` 永不执行、`gestureRef` 一直占着,于是此后
// **每一次**拖拽都在 `beginDrag` 第一行被挡掉、ghost 还粘在鼠标上,只有换页才能恢复
// (旧实现监听挂 `useEffect([drag])` 上,下一次 `pointerdown` 会顶掉旧监听而自愈;同步挂之后没这层)。
test("窗口外松手丢了 pointerup:手势不卡死,贴纸也原样留着", async ({ page }) => {
  await stubEmpty(page);
  await ready(page, "/redblack");

  const a = page.locator(".rb-card").nth(0);
  const b = page.locator(".rb-card").nth(1);
  await a.getByRole("button", { name: /^标记《/ }).click();
  await b.getByRole("button", { name: /^标记《/ }).click();
  await a.getByRole("button", { name: /贴红贴纸/ }).click();
  const mine = a.locator(".rb-dot");
  await expect(mine).toHaveCount(1);
  // 两张卡都要在视口里:落点命中测试(`elementFromPoint`)与指针坐标都按视口算
  await a.evaluate((node) => node.scrollIntoView({ block: "center" }));

  const before = (await mine.boundingBox())!;
  const at = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
  const aCanvas = (await a.locator(".rb-canvas").boundingBox())!;

  // 按下(起手势)→ 一个 `buttons: 0` 的 move:真实场景里后者就是鼠标**重新进入窗口**时的第一帧,
  // 而松手那一刻的坐标从来没送达过页面
  await dispatchPointer(mine, "pointerdown", 1, at, { pointerType: "mouse" });
  await dispatchPointer(
    a.locator(".rb-canvas"),
    "pointermove",
    1,
    { x: aCanvas.x + 6, y: aCanvas.y + 6 },
    { pointerType: "mouse", buttons: 0 },
  );

  // ① 手势已经收尾 —— 未修前 ghost 会一直挂在页面上(跟着鼠标跑),直到换页
  await expect(page.locator(".rb-ghost")).toHaveCount(0);
  // ② 只收尾、不结算:那个坐标**不是**松手点,不能拿它挪走 / 收回贴纸
  await expect(mine).toHaveCount(1);
  const still = (await mine.boundingBox())!;
  expect(Math.abs(still.x - before.x) + Math.abs(still.y - before.y)).toBeLessThan(1);

  // ③ 让出来的手势要**真的能再用**:把《B》暂存区那枚拖到《B》自己的画布上,它必须落下去
  //    (未修前 `beginDrag` 会被那个卡住的手势一直挡掉:《B》一枚都贴不上,而《A》那枚
  //     还会被那套陈旧的监听拿**这次**的坐标结算一次)
  const src = (await b.locator(".rb-src--red").boundingBox())!;
  const bCanvas = (await b.locator(".rb-canvas").boundingBox())!;
  const from = { x: src.x + src.width / 2, y: src.y + src.height / 2 };
  const to = { x: bCanvas.x + bCanvas.width / 2, y: bCanvas.y + bCanvas.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  const placedB = b.locator(".rb-dot");
  await expect(placedB).toHaveCount(1);
  // 落在松手那一点(证明走的是完整手势,而不是「本来就有一枚」)。
  // ⚠ 判据用**画布内的相对位置**,不是视口坐标:这一枚落下去会让卡片多出一个「看全部」按钮,
  //   那一行折行顺手把卡片(连同画布)撑高 30px —— 拿布局变化前的视口坐标去比会差 15px(实测),
  //   而贴纸是相对坐标,它一直在那块画布的正中(`posY = 0.5`)。
  const bNow = (await b.locator(".rb-canvas").boundingBox())!;
  const put = (await placedB.boundingBox())!;
  const relNow = {
    x: (put.x + put.width / 2 - bNow.x) / bNow.width,
    y: (put.y + put.height / 2 - bNow.y) / bNow.height,
  };
  expect(Math.abs(relNow.x - 0.5)).toBeLessThan(0.02);
  expect(Math.abs(relNow.y - 0.5)).toBeLessThan(0.02);
});

// 键盘收回(2026-09-23 review,PLAN-20260923103830)。`movedRef` 只在**下一次 `pointerdown`** 复位,
// 而键盘 `Enter` 触发的 `click` 根本不经过 pointerdown —— 于是「刚拖过一次」会把后来的回车收回
// **静默吞掉**(按钮有反应、贴纸不动)。修法:`MouseEvent.detail === 0` 的 click(键盘 / `element.click()`)
// 不问 `movedRef`。
test("拖过一次之后,键盘回车照样能把贴纸收回来", async ({ page }) => {
  await stubEmpty(page);
  await ready(page, "/redblack");

  const key = keyOf("008");
  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /^标记《/ }).click();
  await card.getByRole("button", { name: /贴红贴纸/ }).click();

  const mine = card.locator(".rb-dot");
  await expect(mine).toHaveCount(1);
  await card.evaluate((node) => node.scrollIntoView({ block: "center" }));
  const box = (await mine.boundingBox())!;
  expect(box.y).toBeGreaterThan(0);

  // 先真的拖一次 → `movedRef` 置位(这正是键盘路径的干扰源)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 10, { steps: 6 });
  await page.mouse.up();
  await expect(card.locator(".rb-dot")).toHaveCount(1);

  // 它是个 `<button>`,聚焦后按回车就该收回
  await mine.focus();
  await page.keyboard.press("Enter");
  await expect(card.locator(".rb-dot")).toHaveCount(0);
  await expect(card.locator(".rb-canvas-hint")).toHaveCount(1);
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

// 分享哪些节由用户勾选(2026-09-22):榜单是「全站看法」,不是每个人都愿意三榜全发出去。
test("生成分享图:可以只分享部分榜单,一节都不勾时下载停用", async ({ page }) => {
  await trackPaintedTexts(page);
  const top = keyOf("008");
  await stubVotes(page, { [top]: { red: 40, black: 0 }, [keyOf("003")]: { red: 0, black: 30 } });
  await ready(page, "/redblack");

  // 先贴一枚:否则「我贴过的」那一项没有内容、是被置灰的
  const card = page.locator(`.rb-card[data-film-key="${top}"]`);
  await card.getByRole("button", { name: /^标记《/ }).click();
  await card.getByRole("button", { name: /贴红贴纸/ }).click();

  await page.getByRole("button", { name: "生成分享图" }).click();
  const dialog = page.getByRole("dialog");
  const download = dialog.getByRole("button", { name: "下载 PNG 图片" });
  await expect(download).toBeVisible();
  await expect(dialog.getByRole("checkbox")).toHaveCount(4); // 三榜 + 我贴过的

  // 对照组:默认全选,第一张图里三榜都在
  // ⚠ 断言用的是各节的**口径说明**(「按黑贴纸数」这种)而不是节名 —— 图里那个大标题
  //   「**红黑榜**」本身就含「黑榜」三个字,拿节名去判「有没有」会永远为真
  const first = await paintedTexts(page);
  expect(first).toContain("按黑贴纸数");

  // 尺寸提示(2026-09-22 用户:「提示一下选择不同的分享模块后图片分别的大小是多少」):
  // 勾一节图就矮一截,所以每换一次选择都读一次这个数字,断言它**真的跟着变**
  const sizeOf = async () => {
    const text = await dialog.locator(".rb-share-size").innerText();
    const matched = text.match(/(\d+)\s*×\s*(\d+)\s*px/);
    return { width: Number(matched![1]), height: Number(matched![2]) };
  };
  const full = await sizeOf();
  // ⚠ 只断宽度是 1080 / 2160 两种之一:倍数由 `posterScale` 按画布**面积**决定
  //   (这份 stub 只有 2 部有票 → 图短 → 走 2×),别把某个具体倍数写死
  expect([1080, 2160]).toContain(full.width);

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
    .poll(async () => (await paintedTexts(page)).slice(first.length).includes("按红贴纸数"))
    .toBe(true);
  expect((await sizeOf()).height).toBeLessThan(full.height); // 少一节 → 图矮一截
  const second = (await paintedTexts(page)).slice(first.length);
  expect(second).not.toContain("按黑贴纸数");
  expect(second).toContain("按红 + 黑贴纸数"); // 总数榜照旧
  expect(second).toContain("按红贴纸数");

  // 再勾掉「我贴过的」→ 那一节消失,两榜还在
  await toggle(/^我贴过的/);
  const offset = first.length + second.length;
  await expect
    .poll(async () => (await paintedTexts(page)).slice(offset).includes("按红贴纸数"))
    .toBe(true);
  const withoutMine = await sizeOf();
  expect(withoutMine.height).toBeLessThan(full.height); // 「我贴过的」那一节也占高度
  const third = (await paintedTexts(page)).slice(offset);
  expect(third).not.toContain("左侧圆点是我贴的那一色"); // 「我贴过的」的说明不再画
  expect(third).toContain("按红 + 黑贴纸数");

  // 一节都不勾 → 图里只剩头部与署名(空态文案说的是「还没选」,不是「榜上没贴纸」),
  // 下载 / 复制停用,免得把一张空图发出去
  await toggle("总数榜");
  await toggle("红榜");
  await expect
    .poll(async () => (await paintedTexts(page)).includes("还没选要分享的内容"))
    .toBe(true);
  await expect(download).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "复制图片" })).toBeDisabled();
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
