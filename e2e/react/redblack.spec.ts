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

/** 尽力等页面上的提示条(S2 `ToastQueue`)退场,再做**需要命中**的动作。
 *
 *  为什么(2026-09-28 从 CI 上抓到的假红):提示条挂在视口**底部**、`role=alertdialog`,
 *  而且**接得住指针** —— 手机上它正好盖住卡片下半截(暂存区那两颗「红 / 黑」就在那儿),
 *  `hover()` / `mouse.down()` 都会先落在它身上;它进出场又走 **View Transitions**,
 *  过渡那几帧整页被一层快照盖住,命中测试会返回 `<html>`
 *  (Playwright 原话:`<html> intercepts pointer events`),`document.elementFromPoint()`
 *  也会拿到 `<html>` 而不是贴纸自己。
 *
 *  ⚠ **必须有界**:指针正好压在提示条上时它会 `pauseAll()` 自己的计时器(`react-stately`
 *    的 `pauseAll` / `resumeAll`),于是永远不走 —— 实测把「窗口外松手」那条卡到 10s 超时。
 *    等不到就照常往下走:后面那些 `hover()` / 断言自己会重试,卡死在这里反而更糟。
 *  ⚠ 只等、**不要**在这里挪指针(试过 `mouse.move(2, 2)`:它会把后面量到的坐标全废掉,
 *    「跨片拖拽」「拖出张贴区」随即以「指针不在画布内」失败)。 */
/** `boundingBox()` 的坐标 → **页面坐标**(`elementFromPoint` 吃的那一套)。
 *
 *  ⚠ 移动端模拟下这两套**不是同一个空间**:实测 Pixel 7 + `mobile-chromium`,把卡片滚进视口之后
 *    `window.visualViewport.offsetTop` 是 **98**(不是 0),而
 *    `getBoundingClientRect()` = `boundingBox()` + 这个偏移 —— 于是拿 `boundingBox()` 的坐标去问
 *    `elementFromPoint()` 会落到**元素上方 98px** 的地方(实测拿到 `.rb-card-info` / `.rb-talk`,
 *    也就是画布上方那一块,而且**稳定复现**,不是「还没落定」)。桌面端两个偏移恒为 0,
 *    所以这条只在手机上现形。
 *  ⚠ **指针那一侧不需要换算**:`page.mouse.move()` 用的是与 `boundingBox()` 同一套坐标,
 *    实测把鼠标挪到它的中心,`:hover` 命中的正是那个元素。 */
async function toPagePoint(page: Page, point: { x: number; y: number }) {
  const offset = await page.evaluate(() => ({
    x: window.visualViewport?.offsetLeft ?? 0,
    y: window.visualViewport?.offsetTop ?? 0,
  }));
  return { x: point.x + offset.x, y: point.y + offset.y };
}

async function quiet(page: Page) {
  await expect(page.locator("[role=alertdialog]"))
    .toHaveCount(0, { timeout: 6000 })
    .catch(() => undefined);
}

/** 长按多久弹出换款轮盘(ms) —— **鼠标与触屏同一个值**(2026-10-05)。
 *  ⚠ 它必须与实现里的 `PRESS_MS` 一致:不一致的症状是「环还没开就断言」而超时,
 *    而不是一条说得出所以然的红。 */
const PRESS_MS = 500;

/** **鼠标长按**开环 —— 2026-10-05 起它是鼠标**唯一**的开环手势(悬停那条入口已删)。
 *
 *  ⚠ 为什么不再用 `dot.hover()`:悬停现在什么都不做了 —— 「划过不弹」正是本轮要守的判据。
 *  ⚠ 起手前先把指针移到贴纸正中再按下:`mouse.down()` 落在的是指针**上一次停留**的位置,
 *    那多半不是这枚贴纸(拖拽那几条用例踩过同一个坑,见它们那段说明)。
 *  ⚠ 按住期间**一次都不挪**:越过 `slop`(鼠标 8px)长按就作废、转成拖拽。
 *  ⚠ 松手之后环**仍然开着**(鼠标靠 `pointerleave` 关,不是靠抬手),调用方接着点节点即可。 */
async function pressOpenWheel(page: Page, dot: Locator): Promise<void> {
  // ⚠ 起手用 `hover()` 而不是「先量 `boundingBox()` 再 `mouse.move()`」:后者拿的是
  //   **过期坐标** —— 榜单上那些 `loading="lazy"` 的海报随时会把版面顶一下,量完之后版面一动,
  //   按下去就落在别处(实测 3 worker 并行时 2/6 假红:贴纸**一次 `pointerdown` 都没收到**,
  //   环自然永远不出来)。`hover()` 会等元素稳定、并在按下的那一刻现算中心 ——
  //   与拖拽那几条用例同一手法。
  await dot.hover();
  await page.mouse.down();
  // ⚠ 按住**直到环真的出现**,不能写死等待时长:`PRESS_MS` 那条 `setTimeout` 在主线程忙时
  //   会被推迟,「固定等 650ms」可能在计时器到点**之前**就 `mouse.up()` ——
  //   而抬手会把计时器清掉,环永远不出来(实测 4/6 假红)。
  await expect(page.locator(".rb-wheel")).toHaveCount(1);
  // ⚠ 开环之后再松手不影响它:鼠标那条关环走的是 `pointerleave`,不是抬手。
  await page.mouse.up();
}

test("首次进入是空榜:一枚贴纸都没有,只留一句怎么开始", async ({ page }) => {
  await stubEmpty(page);
  await ready(page, "/redblack");

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

// 空榜那句引导**不能**随「标记看过 / 取消标记」出现消失(2026-09-23 用户:
// 「标记看过 未看过 这个按钮 即使我没有进行贴贴纸动作 好像会触发重新渲染 整个贴纸页面好像闪了一下」)。
// 它挂在栅格**上方**,一收一放会把整页内容顶上去 53px(实测:38px 提示条 + 15px 间距)——
// 用户点一下标记,看到的是「整页闪了一下」。根因是条件里混进了 `totals.marked`(本地「我看过」),
// 而文案说的「榜」指的是全站票数,两回事。
// ⚠ 判据是「**页眉底边 → 栅格顶边**」这段间距,不是栅格的绝对文档坐标(2026-09-28 改):
//   预览页会异步换上 S2 的 WebFont,而页眉里那组小字(现在是 `.rb-badge`,2026-09-29 改版前叫 `.rb-mine`)
//   走的是 `line-height: normal` —— 换上的那一刻它的行盒高会变一次(CI 实测 **+2px**)。
//   量绝对坐标时,「标记前」量到的是换字体
//   之前的版面、「标记后」量到的是换完之后的,差的 2px 会被读成「标记把整页顶上去了」
//   (2026-09-28 CI 上桌面与手机同时以 433 → 435 红掉,查了一轮才发现与标记无关)。
//   页眉自己高矮一次与这条用例无关:要守的是**页眉与栅格之间那一段**(空榜引导条就长在那儿)——
//   它一出现 / 一消失,下面的内容就被顶上 / 放下 53px,那才是用户看到的「闪了一下」。
//   ⚠ 顺带免疫滚动:两个 rect 一起滚,相减之后与 `scrollY` 无关(旧写法要自己补 `scrollY`,
//   而 Playwright 为了点击会滚页面 —— 这次不再有那个坑)。
test("点「标记看过」不会把整页顶上去", async ({ page }) => {
  await stubEmpty(page);
  await ready(page, "/redblack");

  const key = keyOf("008");
  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  const aboveGrid = () =>
    page.evaluate(() => {
      const hero = document.querySelector(".rb-hero") as HTMLElement;
      const grid = document.querySelector(".rb-grid") as HTMLElement;
      return Math.round(
        grid.getBoundingClientRect().top - hero.getBoundingClientRect().bottom,
      );
    });

  // ⚠ 2026-09-30 重排守卫:两个**状态角标**都挂在海报上,讨论区入口挂在**卡片右上角**,
  //   三者都不在信息列那排胶囊里。移回去就会把那一行撑断 —— 而那一行的宽**决定信息列要多宽,
  //   信息列的宽又决定画布有多宽**(用户三次提这块太乱 / 要求「贴贴纸的区域大一点」,
  //   所以钉住它,而不是靠注释提醒)。
  await expect(card.locator(".rb-poster-box .rb-poster-score")).toHaveCount(1);
  await expect(card.locator(".rb-poster-box .rb-mark")).toHaveCount(1);
  await expect(card.locator(".rb-chips .rb-poster-score")).toHaveCount(0);
  await expect(card.locator(".rb-chips .rb-mark")).toHaveCount(0);
  await expect(card.locator(".rb-chips .rb-talk")).toHaveCount(0);
  // 位置本身也量一下:入口必须在卡片的**右上区**(两种断点都成立,量的是相对卡片的比例,
  // 所以单列布局那条也一起守住了)
  const place = await card.evaluate((node) => {
    const talk = node.querySelector<HTMLElement>(".rb-talk");
    if (!talk) return null;
    const cardBox = node.getBoundingClientRect();
    const box = talk.getBoundingClientRect();
    return {
      rightHalf: box.left > cardBox.left + cardBox.width / 2,
      topQuarter: box.top < cardBox.top + cardBox.height / 4,
      inside: cardBox.left <= box.left && box.right <= cardBox.right,
    };
  });
  expect(place).not.toBeNull();
  expect(place?.rightHalf).toBe(true);
  expect(place?.topQuarter).toBe(true);
  expect(place?.inside).toBe(true);

  // ⚠ 量基线**之前**先等 WebFont 换完(2026-09-30,CI 三个浏览器齐红,`176 → 178`):
  //   页眉与栅格**之间**那段工具栏里有小字走 `line-height: normal`,换字体的那一刻行盒高会变
  //   (**实测 +2px**)—— 量「两者之间的距离」并不能免疫它,因为那 2px 正好长在这两者之间。
  await page.evaluate(() => document.fonts.ready.then(() => true));
  const before = await aboveGrid();
  await card.getByRole("button", { name: /^标记《/ }).click();
  await expect(card).toHaveAttribute("data-rb-marked", "true");
  // ⚠ 再用 `poll` 收掉剩下的抖动(字体可能是**后到**的懒加载字面)。
  //   真正的回归是**持续**的 —— 引导条一收一放 = 53px,它不会因为重试就消失,照样红。
  await expect.poll(aboveGrid, { timeout: 5000 }).toBe(before);
  // 引导条还在(它只随「全站有没有贴纸」变,与本地的「我看过」无关)
  await expect(page.locator(".rb-hint")).toBeVisible();

  // 再点回去也一样,不许弹回来
  await card.getByRole("button", { name: /取消标记/ }).click();
  await expect(card).not.toHaveAttribute("data-rb-marked", "true");
  expect(await aboveGrid()).toBe(before);
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

// 未标记「看过」时红 / 黑按钮是**真 `disabled`**(2026-09-29,PLAN-20260929172651 §4)。
// 用户要的是「查看 → 标记看过 → 选红黑」这条**单向流**:过去按钮只是 CSS 置灰、点了仍进得去,
// 弹一句「先标记看过」——那是个「看着能点、点了被拒」的假出口。
// ⚠ 判据必须是 `toBeDisabled()`(真 `disabled` 属性),**不是** `data-rb-spent` / `aria-disabled`:
//   后两者说的是「已经贴过这一色」,与「有没有标记看过」是两件事(已标记但已贴时按钮**仍要能点**,
//   那是「点另一色原地换色」的出口,2026-09-28 加的,不许被这轮改掉)。
test("没标记「看过」时红 / 黑按钮是禁态,标记之后才放开", async ({ page }) => {
  await stubEmpty(page);
  await ready(page, "/redblack");

  const card = page.locator(`.rb-card[data-film-key="${keyOf("008")}"]`);
  const red = card.getByRole("button", { name: /贴红贴纸/ });
  const black = card.getByRole("button", { name: /贴黑贴纸/ });

  await expect(red).toBeDisabled();
  await expect(black).toBeDisabled();
  // 「为什么点不动」只能挂在**容器**上:`disabled` 的按钮在浏览器里不弹 `title`
  await expect(card.locator(".rb-tray")).toHaveAttribute("title", /标记看过/);

  // 点「标记看过」→ 两枚立刻放开,那句 hover 解释也跟着撤掉
  await card.getByRole("button", { name: /^标记《/ }).click();
  await expect(red).toBeEnabled();
  await expect(black).toBeEnabled();
  await expect(card.locator(".rb-tray")).not.toHaveAttribute("title");

  // 取消标记 → 收回禁态(单向流是可逆的,只是每次都要先把「看过」补回来)
  await card.getByRole("button", { name: /取消标记/ }).click();
  await expect(red).toBeDisabled();
  await expect(black).toBeDisabled();
});

// 未标记「看过」时,伸手去点 / 拖那两枚被锁住的贴纸 → 把「标记看过」指出来
// (2026-10-07,PLAN-20261007225916)。按钮本身仍是**真 `disabled`**(上一条用例守着),
// 手势落在**拦截层** `.rb-tray-lock` 上;它要给出两样东西:
//   ① 一句提示(落在 `role=alertdialog` 的提示条里);② 那枚角标拿到 `rb-mark--nudge`(脉冲一下指路)。
test("没标记「看过」时想点贴纸:提示「标记看过」并点亮那枚角标", async ({ page }) => {
  await stubEmpty(page);
  await ready(page, "/redblack");

  const card = page.locator(`.rb-card[data-film-key="${keyOf("008")}"]`);
  const lock = card.locator(".rb-tray-lock");
  await expect(lock).toHaveCount(1);
  await expect(card.locator(".rb-mark")).not.toHaveClass(/rb-mark--nudge/);

  // 真机手势是**按下**那一刻被接住的(「想拖」也一样)—— `click()` 会先派发 pointerdown
  await lock.click();
  await expect(page.locator("[role=alertdialog]")).toContainText(/标记「看过」/);
  await expect(card.locator(".rb-mark--nudge")).toHaveCount(1);

  // 键盘那条:未标记时那两枚 `disabled` 不可聚焦,而拦截层可;
  // `Enter` 派发的 `click` 带 `detail = 0`,走 `onLockedClick`(防与上面那次弹两遍)
  await quiet(page);
  await lock.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[role=alertdialog]")).toContainText(/标记「看过」/);

  // 标记「看过」→ 拦截层撤掉,入口开放(它只**解释**,不替用户做决定)
  await quiet(page);
  await card.getByRole("button", { name: /^标记《/ }).click();
  await expect(card.locator(".rb-tray-lock")).toHaveCount(0);
  await expect(card.getByRole("button", { name: /贴红贴纸/ })).toBeEnabled();
});

test("标记「看过」→ 贴一枚红:画布上立刻出现,并上报给服务端", async ({ page }) => {
  const pings: Array<{ ops?: unknown }> = [];
  await page.route("**/api/stats/film-votes**", async (route) => {
    if (route.request().method() === "POST") {
      pings.push(route.request().postDataJSON() as { ops?: unknown });
      return route.fulfill({ json: { ok: true, count: 1, votes: {}, skins: {} } });
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
  await ready(page, "/redblack");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  // ⚠ 2026-09-30:红黑合成**一颗**(「红 166 · 黑 73」) —— 判据从两颗各自比对
  //   换成「这一颗的逐字文本」;0 的那一侧不出现,所以两端都非 0 时格式是「红 N · 黑 N」。
  await expect(card.locator(".rb-chip--tally")).toHaveText("红 3 · 黑 2");
  // 评分是**每部各自的**:3 红 2 黑 → 3/5 × 10 = 6.0;
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
  await ready(page, "/redblack");

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

test("「别人的贴纸」与我贴的那枚同尺寸,只差常驻纸白边与能不能拖", async ({ page }) => {
  const key = keyOf("008");
  await stubVotes(page, { [key]: { red: 3, black: 2 } });
  await ready(page, "/redblack");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /^标记《/ }).click();
  await card.getByRole("button", { name: /贴红贴纸/ }).click();

  const mine = card.locator(".rb-dot");
  await expect(mine).toHaveCount(1);
  // 尺寸口径同源两处:CSS 的 `.rb-dot` 与 canvas sprite 的 `sticker-sprite.ts::STICKER_SIZE`
  // (26 → 20 → 32 → 20 → 24,用户五轮改过;单测守着 sprite 那一侧,这里守 DOM 这一侧)
  await expect(mine.first()).toHaveCSS("width", "24px");
  await expect(mine.first()).toHaveCSS("cursor", "grab");

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
  await ready(page, "/redblack");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /^标记《/ }).click();
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

// 我贴的那一枚的交互(2026-09-22 建 · 2026-09-30 改口径):
//  ① **双击收回** —— 原先是单击。用户 2026-09-30 要求改成双击:单击太容易误触
//     (尤其「拖完松手」浏览器补发的那一次 click,得靠 `movedRef` 之类的旁证去挡)。
//     于是单击必须有个**真**含义,不能变成「点了没反应」—— 它现在是**什么都不做**:
//     换款另有**长按 / 键盘聚焦**两条入口(第一版曾让单击开环,用户看过之后否掉了)。
//     ⚠ 触屏上「轻点」还会顺带聚焦,而 WebKit 把点按也算 `:focus-visible` —— 实现在
//       `RedBlackPage.tsx::pointerTouch` 里把触屏来的聚焦挡掉了,否则这条在 iPhone 上必红。
//  ② **拖一下不能顺手收走** —— `pointerup` 之后浏览器还会补一次 `click`,
//     不做区分的话「微调位置」会变成「撤销」。
test("双击自己贴的那一枚才收回;单击什么都不做", async ({ page }) => {
  const pings: Array<{ ops?: unknown }> = [];
  await page.route("**/api/stats/film-votes**", async (route) => {
    if (route.request().method() === "POST") {
      pings.push(route.request().postDataJSON() as { ops?: unknown });
      return route.fulfill({ json: { ok: true, count: 0, votes: {}, skins: {} } });
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

  // ① 单击:**什么都不做**(用户 2026-09-30 口径)。这枚贴纸本质是一根拖拽手柄,
  //   「换款」另有**长按 / 键盘聚焦**两条入口,不必再借用单击。
  //   ⚠ 所以这里要断言**两件事都没发生**:既不收回、也不弹环 ——
  //   只断言「没收回」的话,把单击接回「开环」也照样绿。
  await mine.click();
  await expect(mine).toHaveCount(1);
  await expect(page.locator(".rb-wheel")).toHaveCount(0);

  // ② 双击:**立即**收回(不再有「等一等看会不会来第二下」那套延迟,那一套随「单击开环」一起删了)
  await mine.dblclick();

  // 收回到暂存区:画布空了、提示回来了、按钮重新亮起、环也随贴纸一起消失
  await expect(card.locator(".rb-dot")).toHaveCount(0);
  await expect(card.locator(".rb-canvas-hint")).toHaveCount(1);
  await expect(page.locator(".rb-wheel")).toHaveCount(0);
  await expect(trayRed).not.toHaveAttribute("data-rb-spent");
  // 上报是**增量 op**：收回之后发的是那条 `remove`（而不是「整份空表」——整份替换会把
  // 别的设备的票一起删掉，那正是 §C 要修的东西）
  await expect
    .poll(() => pings.at(-1)?.ops ?? null, { timeout: 8000 })
    .toEqual([{ op: "remove", key }]);
});

// 用户 2026-09-23:「收回贴纸之后 贴纸仍残留 然后过一段时间才刷新」。
// 本地先确定、请求后同步 —— 收回那一拍画布与数字就该少一枚,而不是等 1200ms 防抖 + 重拉。
// ⚠ 断言必须在**防抖窗口内**成立才算数:所以把「收回后的那次上报」扣住不返回。
//   一旦放它过去,重拉回来的真值也会把画布修对 —— 这条用例就变成假绿(spec 里原本那几条
//   正是这么放过去的:它们造的都是「服务端票数为空」的场景,压根没有「服务端还含我」那一拍)。
test("收回自己那一枚:画布与数字**当场**少一枚,不等上报", async ({ page }) => {
  const key = keyOf("008");
  let reads = 0;
  let pings = 0;
  await page.route("**/api/stats/film-votes**", async (route) => {
    if (route.request().method() === "POST") {
      pings += 1;
      // 只有贴完的那一次放行(让它落地成服务端的一份票);收回那一次永远扣住
      if (pings === 1) return route.fulfill({ json: { ok: true, count: 1 } });
      return;
    }
    reads += 1;
    // 载入那次是空榜;上报落地之后服务端就有我这一票(1 红)
    return route.fulfill({
      json: { edition: "biff-2026", votes: reads === 1 ? {} : { [key]: { red: 1, black: 0 } } },
    });
  });
  await ready(page, "/redblack");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /^标记《/ }).click();
  await card.getByRole("button", { name: /贴红贴纸/ }).click();

  // 先等「服务端已含我」这个前提成立(上报落地后会自动重拉一次)
  await expect.poll(() => reads).toBeGreaterThan(1);
  const canvas = await paintedCanvas(card);
  await expect(canvas).toHaveAttribute("data-rb-crowd", "0");
  // ⚠ 收回是**双击**(2026-09-30 起,原为单击;单击现在是打开换款环)
  await card.locator(".rb-dot").dblclick();

  // ① 我那一枚当场消失
  await expect(card.locator(".rb-dot")).toHaveCount(0);
  // ② 画布上**没有**把它补成「别人的票」——这一条才是那个 bug 的判据(改前会变成 1)
  await expect(canvas).toHaveAttribute("data-rb-crowd", "0");
  // ③ 数字也跟着回去(改前要等重拉)
  await expect(card.locator(".rb-chip--tally")).toHaveCount(0);
  // ④ 上面三条都是**本地**生效的:期间没有任何新的读请求(收回那次上报还被扣着,没触发重拉)
  expect(reads).toBe(2);
});

test("拖一下微调位置不算点击:贴纸不会被顺手收走,也不会弹出换款环", async ({ page }) => {
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
  // ⚠ 2026-09-30 追加:拖完松手补发的那一次 click **更不该弹出换款环** ——
  //   单击在这枚贴纸上**什么都不做**(用户口径),环只由**长按 / 键盘聚焦**打开。
  //   所以此刻轮盘一枚都不该有,无论 `pressMoved` 是什么。
  await expect(page.locator(".rb-wheel")).toHaveCount(0);
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
  // ⚠ 贴纸是随机落点,不居中时它可能落在视口上方 —— 那样 `page.mouse` 的事件根本送不到它身上。
  // ⚠ 但这里**不能**用 `block: "center"`(2026-09-29 窄屏改上下布局之后才暴露):
  //   单列把卡片撑高了一倍,把《A》居中会让《B》的画布整个掉到 `vh` 之下 ——
  //   下面那几行视口断言当场以 `Expected: < 839 / Received: 920` 报出来。
  //   这条用例要的是「两张卡的关键区域**同时在**视口里」,所以对齐到**顶部**:
  //   《A》顶边贴住视口顶,页眉 / 工具条被滚出去正好让位。
  //   ⚠ 只对齐顶部还不够:`mobile-webkit` 的视口只有 664px,单列卡片一屏仍放不下两张 ——
  //     所以《B》的落点也一并改成了「画布上缘内一点」(见下面的 `bSpot`)。
  await a.evaluate((node) => node.scrollIntoView({ block: "start" }));
  // ⚠ 2026-09-29 追加:把「《B》的落点也在视口里」从**假设**改成**显式保证**。
  //   上面那两个历史修正都是在「碰巧还放得下」的边界上打补丁,而卡片高度一动
  //   (这次是 `contain-intrinsic-size` 按实测值校正)整条前提就悄悄失效 ——
  //   失败信息是 `Expected: < 664 / Received: 677`,看起来像判据坏了,其实是**前提没了**。
  //   所以先量、再按需要补滚一段,让 B 的上缘稳稳进视口。
  const viewport = page.viewportSize()!.height;
  const bTop = (await b.locator(".rb-canvas").boundingBox())!.y;
  const shift = Math.round(bTop + 8 - (viewport - 8));
  if (shift > 0) await page.evaluate((dy) => window.scrollBy(0, dy), shift);
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
  // ⚠ 《B》的落点取**画布上缘内一点**,不是画布中心(2026-09-29,窄屏改上下布局之后才暴露):
  //   单列把卡片撑高,就算《A》顶边对齐,`webkit` 那个更矮的视口(vh=664)也放不下
  //   《B》的画布中心(实测 692)。而这条用例要的只是「落点**在《B》的画布上**」——
  //   上缘内 8px 同样是合法落点(判据是画布矩形包含),却稳稳落在视口里。
  const bSpot = { x: bBox.x + bBox.width / 2, y: bBox.y + 8 };
  for (const point of [here, aMid, bSpot]) {
    expect(point.y).toBeGreaterThan(0);
    expect(point.y).toBeLessThan(vh);
  }

  await page.mouse.move(here.x, here.y);
  await page.mouse.down();
  // 先在本片画布上走一段:这张卡**是**合法落点 → 它亮着
  await page.mouse.move(aMid.x, aMid.y, { steps: 4 });
  await expect(a).toHaveAttribute("data-rb-hover", "");

  // 再拖到《B》的画布上:张贴区按片独立 → 《B》不该被点亮成落点(亮灯 = 承诺一个不会兑现的落点)
  await page.mouse.move(bSpot.x, bSpot.y, { steps: 8 });
  await expect(b).not.toHaveAttribute("data-rb-hover", "");
  await expect(a).not.toHaveAttribute("data-rb-hover", "");
  await page.mouse.up();

  // 松手:《B》一枚都不会多(旧口径下这一枚会直接落在《B》的画布上)
  await expect(b.locator(".rb-dot")).toHaveCount(0);
  await expect(b.locator(".rb-canvas-hint")).toHaveCount(1);
  // 页面上贴纸总数不会变多:《A》那枚要么留在原位、要么收回暂存区,两者都不是「贴到《B》」
  expect(await page.locator(".rb-dot").count()).toBeLessThanOrEqual(1);
});

// 拖出张贴区要有**明显提示**(2026-09-23 用户:「贴纸拖出可张贴区域 进入被收回区域 需要明显提示」,
// PLAN-20260923110401)。出界 = 松手会把它**收回暂存区**,这件事必须在松手**之前**看得出来:
//   ① 浮标换装(`rb-ghost--out`:半透明 + 去饱和) ② 浮标下面「松开 · 收回暂存区」
//   ③ 源片暂存区点亮(亮的是**真的落点**:它要回到这儿)。
// 同时「卡片亮着灯、松手却收回」的假承诺必须消失 —— 高亮与出界判据收敛到同一处(`ownCanvasAt`)。
test("拖出张贴区:先给「会被收回」的提示,拖回来立刻消失,松手确实收回", async ({ page }) => {
  const key = keyOf("008");
  await stubEmpty(page);
  await ready(page, "/redblack");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /^标记《/ }).click();
  await card.getByRole("button", { name: /贴红贴纸/ }).click();
  const mine = card.locator(".rb-dot");
  await expect(mine).toHaveCount(1);

  // 三个点都要在视口里:`elementFromPoint` 与指针坐标都按视口算(实测过假绿)。
  // ⚠ 起手**不再用 `hover()`**(2026-09-29,窄屏改上下布局之后才暴露):`hover()` 会按需滚动,
  //   而单列卡片一滚就是几百像素 —— 量好的坐标当场作废:起手那次 `mouse.move` 被判成「出界」
  //   (`.rb-ghost` 一上来就带 `rb-ghost--out`),或者画布整块被推到视口之外
  //   (实测 `canvas y=766 h=150`,而 `vh=839`)。改成把整张卡**钉进视口**再按坐标起手。
  // ⚠ 必须**收敛式**滚:`content-visibility: auto` 会在滚动中用真实高替换屏外卡的估算高,
  //   一次滚不收敛(spec:821 那条用例踩过同一个坑),所以最多试 6 轮。
  //   贴纸就在卡片里,整卡可见 ⇒ 贴纸必然可命中 —— `hover()` 原本想保证的正是这件事。
  // ⚠ 先等提示条退场:它挂在视口底部、`role=alertdialog`,而且**接得住指针**(见文件头 `quiet` 的说明),
  //   手机上它正好盖住卡片下半截 —— 那正是画布与暂存区的地盘。
  await quiet(page);
  const vh = page.viewportSize()!.height;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const box = (await card.boundingBox())!;
    if (box.y >= 0 && box.y + box.height <= vh) break;
    await card.evaluate((node) => node.scrollIntoView({ block: "start" }));
  }
  const canvas = (await card.locator(".rb-canvas").boundingBox())!;
  const dot = (await mine.boundingBox())!;
  const info = (await card.locator(".rb-card-info").boundingBox())!;
  // ⚠ 断言带上**是哪个盒子、值是多少**:这条断言在窄屏上翻过车(2026-09-29 单列布局),
  //   而原来只说「Expected: < 839 / Received: 884」—— 三个盒子里是哪个出界、出到哪儿,全靠猜。
  const boxes: Array<[string, { x: number; y: number; width: number; height: number }]> = [
    ["canvas", canvas],
    ["dot", dot],
    ["info", info],
  ];
  for (const [name, box] of boxes) {
    const detail = `${name}=${JSON.stringify(box)} vh=${vh}`;
    expect(box.y, `${name} 跑到视口上方:${detail}`).toBeGreaterThan(0);
    expect(box.y + box.height, `${name} 底部出了视口:${detail}`).toBeLessThan(vh);
  }
  const inCanvas = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };
  // 出界点取**信息列的上缘**:不是画布、也不是任何按钮 —— 松手就是收回。
  // ⚠ 判据是「不在画布矩形里」,与方向无关;只是窄屏改成上下布局之后,这一列跑到了画布**上方**
  //   (原来叫「卡片左侧信息列」),所以这里改的是描述,不是行为。
  const outside = { x: info.x + info.width / 2, y: info.y + 16 };

  const ghost = page.locator(".rb-ghost");
  const hint = page.locator(".rb-drag-hint");
  const tray = card.locator(".rb-tray");

  // ⚠ 起手:先把指针**挪到贴纸正中**再按下。
  //   借 `hover()` 不行(它会滚动,见上面那段说明);只按不挪也不行
  //   (`mouse.down` 会落在指针上一次停留的地方 —— 那多半不是这枚贴纸)。
  let dotMid = { x: dot.x + dot.width / 2, y: dot.y + dot.height / 2 };
  await page.mouse.move(dotMid.x, dotMid.y);
  // ⚠ 起手**前**必须确认这一下真的落在贴纸上,而且要**重试到落定**(2026-09-29 实测定位):
  //   这条用例在 `mobile-webkit` 上偶发「`.rb-ghost` 数 0」(`--repeat-each=8` 红 2~4 次),
  //   根因不是坐标过期 —— 把命中结果当场量出来,拿到的是
  //   `<html class="wf-loading … chyGla_toast-remove">`:**S2 的提示条进出场走 View Transitions,
  //   过渡那几帧整页被一层快照盖住**(文件头 `quiet()` 的说明里记着同一个坑,spec:237 也踩过)。
  //   起手落在那层快照上,`pointerdown` 到不了贴纸,`.rb-ghost` 自然不出现。
  //   过渡是**暂时**的 ⇒ 用 `expect.poll` 重试(与 spec:237 那条修法一致),而不是加固定等待。
  // ⚠ 另一条独立的成因(2026-09-29,这条用例在 `mobile-chromium` 上**每次**都红):
  //   上面那次 `boundingBox()` 量出来的坐标**不是** `elementFromPoint()` 那一套(移动端模拟下
  //   差一个 `visualViewport.offsetTop`,实测 98)—— 于是命中测试稳定落在画布**上方**那一块
  //   (拿到 `.rb-card-info` / `.rb-talk`),而指针其实是落在贴纸上的(见 `toPagePoint` 的说明)。
  //   所以这里:① 把「量位置 + 挪指针」放进 poll 里重试(版面万一还在落定也不怕);
  //   ② 命中测试把坐标**换算到页面空间**再问。
  await expect
    .poll(
      async () => {
        const box = (await mine.boundingBox())!;
        dotMid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await page.mouse.move(dotMid.x, dotMid.y);
        return page.evaluate(
          ({ x, y }) => {
            const el = document.elementFromPoint(x, y) as HTMLElement | null;
            return el ? `${el.tagName}.${el.className}` : "null";
          },
          await toPagePoint(page, dotMid),
        );
      },
      { timeout: 10_000, message: `起手点一直没落在贴纸上:dotMid=${JSON.stringify(dotMid)}` },
    )
    .toContain("rb-dot");
  await page.mouse.down();

  // ① 起手仍在本片画布内:浮标正常、卡片亮着、暂存区不亮、没有说话。
  // ⚠ 这一段的目标点**不能取画布中心**(2026-09-29 踩的第三个几何坑):起手位移必须明确超过
  //   `DRAG_SLOP_TOUCH`(触屏 10px),否则手势被判成「点一下」,`.rb-ghost` 压根不会出现 ——
  //   报出来的是「`ghost` 数 0」这种看不出根因的错(实测 `--repeat-each=6` 红 2 次)。
  //   而落点分布改成「中间密」之后,贴纸落在画布中心附近的概率明显变高,两个点几乎重合。
  //   改成往**离贴纸最远的那个角**走:位移至少是画布尺寸的一半,且内缩 24px 仍在张贴区内
  //   (所以「卡片照常亮灯」这条断言不受影响)。
  const far = {
    x: dotMid.x < canvas.x + canvas.width / 2 ? canvas.x + canvas.width - 24 : canvas.x + 24,
    y: dotMid.y < canvas.y + canvas.height / 2 ? canvas.y + canvas.height - 24 : canvas.y + 24,
  };
  await page.mouse.move(far.x, far.y, { steps: 4 });
  await expect(ghost).toHaveCount(1);
  await expect(ghost).not.toHaveClass(/rb-ghost--out/);
  await expect(hint).toBeHidden();
  await expect(card).toHaveAttribute("data-rb-hover", "");
  await expect(tray).not.toHaveAttribute("data-rb-target", "");

  // ② 拖到卡片左侧信息列(在卡片上、却**不在画布上**)→ 三处提示同时出现,
  //    ⚠ 卡片灯必须同时灭掉:亮着它就是在承诺一个不会兑现的落点
  await page.mouse.move(outside.x, outside.y, { steps: 6 });
  await expect(ghost).toHaveClass(/rb-ghost--out/);
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText("松开 · 收回暂存区");
  await expect(tray).toHaveAttribute("data-rb-target", "");
  await expect(card).not.toHaveAttribute("data-rb-hover", "");

  // ③ 拖回画布:四处一起恢复 —— 提示是**随位置变化的状态**,不是一次性弹窗
  await page.mouse.move(inCanvas.x, inCanvas.y, { steps: 6 });
  await expect(ghost).not.toHaveClass(/rb-ghost--out/);
  await expect(hint).toBeHidden();
  await expect(tray).not.toHaveAttribute("data-rb-target", "");
  await expect(card).toHaveAttribute("data-rb-hover", "");

  // ④ 再拖出去松手:那枚确实被收回(提示承诺过的结果),而且不留残灯、不留浮标
  await page.mouse.move(outside.x, outside.y, { steps: 6 });
  await expect(hint).toHaveText("松开 · 收回暂存区");
  await page.mouse.up();
  await expect(mine).toHaveCount(0);
  await expect(ghost).toHaveCount(0);
  await expect(tray).not.toHaveAttribute("data-rb-target", "");
  await expect(card.locator(".rb-canvas-hint")).toHaveCount(1);
});

// 从**暂存区**拖出来的那枚是另一条路(2026-09-23,PLAN-20260923110401):松手「什么也不做」,
// 所以文案必须说「取消」而不是「收回」,暂存区也**不许**亮灯 —— 它本来就在那儿,
// 亮灯等于说「它会回到这儿」(见页面 `setOut` 的说明)。
test("从暂存区拖出并移出画布:提示是「松开 · 取消」,暂存区不亮", async ({ page }) => {
  const key = keyOf("008");
  await stubEmpty(page);
  await ready(page, "/redblack");

  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /^标记《/ }).click();
  // ⚠ 先等这次重渲染落地(按钮文案从「标记看过」变「看过 ✓」会让左侧信息列改高矮),
  //   否则后面量到的位置是过期的
  await expect(card).toHaveAttribute("data-rb-marked", "true");
  // ⚠ 滚到视口**中间**而不是 `scrollIntoViewIfNeeded`:后者只把卡片滚到「刚好露出来」,
  //   暂存区那两颗就落在视口底缘 —— 正好是提示条的地盘,`hover()` 会一直重试到超时
  //   (2026-09-28 CI 上 mobile-webkit 就是这么红的:`<html ... toast-remove> intercepts pointer events`)。
  await card.evaluate((node) => node.scrollIntoView({ block: "center" }));

  // ⚠ 起手用 `hover()`:让 Playwright 在**按下的那一刻**现算按钮中心(理由同上)
  await quiet(page);
  await card.locator(".rb-src--red").hover();
  // ⚠ `info` 在 `hover()` **之后**量:`hover()` 有需要时会滚一下,先量的坐标会过期
  const info = (await card.locator(".rb-card-info").boundingBox())!;
  await page.mouse.down();
  await page.mouse.move(info.x + info.width / 2, info.y + 16, { steps: 6 });

  await expect(page.locator(".rb-drag-hint")).toHaveText("松开 · 取消");
  await expect(card.locator(".rb-tray")).not.toHaveAttribute("data-rb-target", "");

  // 松手:它只是回到暂存区原位,画布上一枚都不会多
  await page.mouse.up();
  await expect(card.locator(".rb-dot")).toHaveCount(0);
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
  // ⚠ 两枚贴纸用**键盘**贴,不用 `click()`(2026-09-28):`click()` 会起一次真实鼠标手势,而
  //   mobile-webkit 上那一次**有时没被收尾** —— 随后合成的单指手势会有约一半概率被
  //   `beginDrag` 第一行的单手势守卫直接挡掉(实测:同一个手势 `ghost` 数 0 / 1 随机,
  //   失败值恒等于「贴纸到落点」的距离,即「一枚都没挪」)。这条用例从头到尾用的都是
  //   **合成**指针事件,前置步骤就不该在页面上留下手势。
  //   键盘 `Enter` 触发的 click `detail === 0` → 走 `placeByTap` 的键盘分支(页面本来就支持)。
  await a.getByRole("button", { name: /贴红贴纸/ }).focus();
  await page.keyboard.press("Enter");
  await b.getByRole("button", { name: /贴黑贴纸/ }).focus();
  await page.keyboard.press("Enter");
  const dotA = a.locator(".rb-dot");
  const dotB = b.locator(".rb-dot");
  await expect(dotA).toHaveCount(1);
  await expect(dotB).toHaveCount(1);

  // 两张卡上的**贴纸**都要在视口里:落点判定与指针坐标都按视口算(实测过假绿)。
  // ⚠ 只把《A》那张卡滚动到视口中间是**不够**的(2026-09-28):手机上一张卡近 300px 高,
  //   两张卡放不下,第二枚贴纸很可能落在视口**之下** —— CI 上正是以「692 > 664」红的。
  //   改成按「两枚贴纸实际占的那段窗口」来滚:把它们整体挪到上边留 8px。
  //   ⚠ 那段窗口本身放不下时直接断言失败 —— 那种情况没有合法位置,不该让后面的断言遮成假绿。
  await a.evaluate((node) => node.scrollIntoView({ block: "center" }));
  const vh = page.viewportSize()!.height;
  /** 把两枚贴纸一起挪进视口(上边留 8px)。
   *  ⚠ 不能只滚一次:榜单每张卡都挂着 `content-visibility: auto` + 估算高度(206px),滚动中
   *    屏外卡片的**估算高**会被换成真实高,文档里上面的内容跟着变高变矮 —— 「滚到某个绝对位置」
   *    于是要一两轮才收敛(实测一次滚完仍可能差 100px 以上,贴纸直接落在视口外)。
   *    所以量一次、挪一次,最多几轮;始终进不去就由下面的断言明确失败(那样也没有合法窗口)。 */
  const fitBoth = async () => {
    for (let i = 0; i < 6; i += 1) {
      const top = (await dotA.boundingBox())!.y;
      const bb = (await dotB.boundingBox())!;
      if (top > 4 && bb.y + bb.height < vh - 4) return;
      await page.evaluate((dy) => window.scrollBy(0, dy), top - 8);
    }
  };
  await fitBoth();
  const aBox = (await dotA.boundingBox())!;
  const bBox = (await dotB.boundingBox())!;
  expect(bBox.y + bBox.height - aBox.y).toBeLessThan(vh - 16);
  for (const box of [aBox, bBox]) {
    expect(box.y).toBeGreaterThan(0);
    expect(box.y + box.height).toBeLessThan(vh);
  }
  const centerOf = (box: { x: number; y: number; width: number; height: number }) => ({
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  });
  const aFrom = centerOf(aBox);
  const bAt = centerOf(bBox);

  // 第一指按住《A》那枚 → 第二指按住《B》那枚(同一时刻的两个指针)
  // ⚠ 起手前先补一个 `pointerId = 1` 的 `pointerup`(2026-09-28):这条用例从头到尾用的是
  //   **合成**指针,而它前一拍是**真实鼠标**交互(`click()` / `keyboard`)—— Playwright 的鼠标
  //   `pointerId` 在 Chromium 与 WebKit 上都是 **1**(实测),所以上一步那次手势万一没被收尾,
  //   它占着的 `gestureRef` 会把这里的第一指直接挡掉(实测:同一个手势 `ghost` 数 0 / 1 随机,
  //   失败值恒等于「贴纸到落点」的距离 = 一枚都没挪)。补的这一发在**没有**残留时是空操作;
  //   有残留时 `moved` 仍是 false(真实鼠标只是把指针移过去再按,没越过拖动阈值)→ 只收尾、不结算。
  await dispatchPointerUp(page, 1, { x: 0, y: 0 });
  await dispatchPointer(dotA, "pointerdown", 1, aFrom);
  await dispatchPointer(dotB, "pointerdown", 2, bAt);
  // ⚠ 落点由一个**画布内的相对位置**推出来,而不是「贴纸中心 + 固定像素」,也不再固定用
  //   「画布正中」(2026-09-28):
  //   ① 固定偏移会在贴纸靠近右下角时把松手点推出画布 → 判成出界 → 那枚被收回
  //      (2026-09-23,PLAN-20260923104622 已经踩过一次);
  //   ② 「画布正中」是**彩票**:贴纸落点走 `Math.random`,它本来就在正中附近时,从起手到落点
  //      这段位移连触屏 10px 的拖动阈值都过不去(`moved` 不置位 → 手势不算拖 → 一枚都不结算),
  //      失败值恰好等于「贴纸到画布中心」那点距离 —— CI 上两次假红都是这个形状。
  //   ③ 所以目标点**按贴纸现在的位置反着挑**:它偏左就落 0.85,偏右就落 0.15,位移恒 ≥ 0.3 个画布。
  const aRect = (await a.locator(".rb-canvas").boundingBox())!;
  const aRel = { x: (aFrom.x - aRect.x) / aRect.width, y: (aFrom.y - aRect.y) / aRect.height };
  const target = { x: aRel.x < 0.5 ? 0.85 : 0.15, y: aRel.y < 0.5 ? 0.85 : 0.15 };
  const aDrop = { x: aRect.x + aRect.width * target.x, y: aRect.y + aRect.height * target.y };
  // 第一指拖动(越过触屏 10px 阈值),第二指不动
  await dispatchPointer(dotA, "pointermove", 1, aDrop);
  // 抬起第一指 —— 旧实现这一刻两套 `onUp` 都会收到它,第二套还会拿**这个坐标**去结算《B》
  // (实测症状:坐标落在《A》的画布上 → 对《B》而言是「拖出画布」→ 那枚被**当场误收回**,连弹一条 toast)
  await dispatchPointerUp(page, 1, aDrop);
  await dispatchPointerUp(page, 2, bAt);

  // 发起的那一枚**确实被挪到了松手那一点**(否则就是「手势压根没跑」,测试会假绿)。
  // ⚠ 判据回到**画布内的相对位置**:贴纸存的就是相对坐标,从「量画布」到「派发 pointerup」
  //   之间画布被浮动层推几个像素也不影响它;拿视口坐标相减则会把那点位移原样记成误差
  //   (实测 2~48px 不等,「落点对不对」就成了看运气)。
  const aAfter = centerOf((await dotA.boundingBox())!);
  const afterRect = (await a.locator(".rb-canvas").boundingBox())!;
  const afterRel = {
    x: (aAfter.x - afterRect.x) / afterRect.width,
    y: (aAfter.y - afterRect.y) / afterRect.height,
  };
  expect(Math.abs(afterRel.x - target.x)).toBeLessThan(0.03);
  expect(Math.abs(afterRel.y - target.y)).toBeLessThan(0.03);
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
  // ⚠ 这一步只是为了把版面摆正:上面两条 `dispatchPointer` 是**直接派发到元素上**的
  //   (本来就不吃视口),但③那一步要拿《B》画布的真实 rect 算落点,摆正之后更稳。
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
  // ⚠ 起手用 `hover()` 而不是「先量按钮坐标再 `mouse.move`」(2026-09-28):
  //   手机上一张卡就有近 300px 高,`scrollIntoView({block:"center"})` 到的是**上一张卡**的
  //   中心,《B》的暂存区那颗还在视口之下 —— `mouse.down()` 落在视口外面,手势压根没起
  //   (CI 上 mobile-chromium 与 mobile-webkit 都红在这里:`《B》一枚都贴不上`)。
  //   `hover()` 会自己把按钮滚进视野,再按下去才真的落在它身上;顺带先等提示条退场(见 `quiet`)。
  await b.evaluate((node) => node.scrollIntoView({ block: "center" }));
  await quiet(page);
  await b.locator(".rb-src--red").hover();
  await page.mouse.down();
  // ⚠ 落点在 `hover()` **之后**量:它可能刚滚过页面(而落点判据是画布 rect 的矩形包含,
  //   只要求这个点落在《B》那块画布里,不要求它在视口的哪个位置)
  const bCanvas = (await b.locator(".rb-canvas").boundingBox())!;
  await page.mouse.move(bCanvas.x + bCanvas.width / 2, bCanvas.y + bCanvas.height / 2, {
    steps: 6,
  });
  await page.mouse.up();
  const placedB = b.locator(".rb-dot");
  await expect(placedB).toHaveCount(1);
  // 落在松手那一点(证明走的是完整手势,而不是「本来就有一枚」)。
  // ⚠ 判据用**画布内的相对位置**,不是视口坐标:这一枚落下去会让卡片多出一个「红 N」票数胶囊
  //   (`counts.red > 0 && …`),那一行折行顺手把卡片(连同画布)撑高 30px ——
  //   拿布局变化前的视口坐标去比会差 15px(实测),而贴纸是相对坐标,它一直在那块画布的正中
  //   (`posY = 0.5`)。
  //   （2026-09-29 修订:原来这里的成因是「多出一个『看全部』按钮」,那个入口已被讨论区取代、
  //     而且讨论区入口是**恒显**的 —— 撑高卡片的换成了票数胶囊，判据本身一个字没变。）
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
  await ready(page, "/redblack");

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
  await ready(page, "/redblack");

  const key = keyOf("008");
  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /^标记《/ }).click();
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
  await ready(page, "/redblack");

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
  await card.getByRole("button", { name: /^标记《/ }).click();
  await card.getByRole("button", { name: /贴红贴纸/ }).click();
  await expect(card.locator(".rb-dot--red")).toHaveCount(1);
});

// 这条用例守的东西 2026-09-29 变了**:长按现在**确实**会弹东西出来 —— 换款轮盘。
// 但它的另一半一个字没变,也仍然必须成立:**轮盘不在贴纸里、也不在卡片里**。
// 所以判据从「聚焦什么都不弹」改成「弹了,但弹在别处」:
//   · 贴纸后代恒为 5 个(逐个点名,多塞一个节点都会红);
//   · 卡片里不许出现轮盘 / 评语 / 弹层;
//   · 轮盘挂在 `document.body` 上(唯一的挂法,理由见 `StickerSkinWheel.tsx`:画布与卡片都会裁它)。
test("长按会弹出换款轮盘,但它不在贴纸里、也不在卡片里", async ({ page }) => {
  await stubEmpty(page);
  await stubComments(page, {
    items: [{ filmKey: keyOf("008"), vote: "red", comment: "好看", displayName: null }],
  });
  await ready(page, "/redblack");

  const key = keyOf("008");
  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /^标记《/ }).click();
  await card.getByRole("button", { name: /贴红贴纸/ }).click();
  const dot = card.locator(".rb-dot");
  await expect(dot).toHaveCount(1);

  // 贴纸里只有**画它自己的那 5 个节点** —— 评语与轮盘都不在它里面(「不要放在贴纸上,不然很乱」)。
  await expect(dot.locator(".rb-dot__face")).toHaveCount(1);
  await expect(dot.locator(".rb-dot__face .rb-dot__edge path")).toHaveCount(1);
  await expect(dot.locator(".rb-dot__face .rb-dot__icon path")).toHaveCount(1);
  await expect(dot.locator("*")).toHaveCount(5);

  // ⚠ **划过不弹**(2026-10-05 的回归判据):悬停那条入口已删 —— 鼠标也得长按。
  //   先挪一次指针再断言,否则「哪天有人把悬停开环加回来」这条也照样绿。
  //   ⚠ 而且必须**等过**旧那条的 `HOVER_MS`(160ms)再断:悬停开环是**延时**的,
  //     `toHaveCount(0)` 在它弹出来之前就会满足 —— 那样这条守卫等于什么都没守。
  await dot.hover();
  await page.waitForTimeout(400);
  await expect(page.locator(".rb-wheel")).toHaveCount(0);

  await pressOpenWheel(page, dot);
  const wheel = page.locator(".rb-wheel");
  await expect(wheel).toHaveCount(1);

  // 弹了,但三处都不许有它 —— 这几条才是这条用例真正守的东西
  await expect(dot.locator("*")).toHaveCount(5);
  await expect(dot.locator(".rb-wheel")).toHaveCount(0);
  await expect(card.locator(".rb-wheel")).toHaveCount(0);
  // 卡片里也不许冒出讨论区弹层 / 任何浮层（它要点开才挂）
  await expect(card.locator("[role=tooltip], [role=dialog]")).toHaveCount(0);
  // ⚠ 「评语模块在页面上」那条断言随「大家说」一起删了（2026-09-29）：页面级模块不再存在，
  //   评语现在只在**卡片级讨论区弹层**里出现，而它要点开才有。
  //   入口本身是**恒显**的（0 票的片也能讨论），所以它在、而弹层不在。
  await expect(card.getByRole("button", { name: /讨论区/ })).toHaveCount(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

/* ---------------- 换款轮盘(2026-09-29,PLAN-20260929195500;手势收敛 2026-10-05) ----------------
 * 测什么:能不能打开(**长按** —— 鼠标与触屏同一套;键盘聚焦是等价入口)、预览会不会
 * **只是预览**、点选会不会真的落定并上报、关得掉关不掉、以及**既有的「双击贴纸 = 收回」
 * 有没有被踩坏**。
 * ⚠ 2026-09-30 起「收回」的触发是**双击**(单击改成打开环了) —— 下面几处判据跟着改了,
 *   但守的东西一个字没变:环不能把落在贴纸上的那几下点击吞掉。
 * ⚠ 2026-10-05 起鼠标**不再靠悬停开环**(那条入口已删,见 `PLAN-20261005194221`):
 *   原来的 `dot.hover()` 全部换成 `pressOpenWheel()`(鼠标长按 500ms);
 *   触屏那条由「★ 触屏长按换款」用手动派发的 `pointerType: "touch"` 事件覆盖。 */

/** 贴一枚红贴纸,并等 `data-rb-fresh` 摘掉。
 *  ⚠ 2026-10-05 起它**不再**是「能不能弹环」的闸门 —— 那道闸门随悬停入口一起删了
 *    (长按本来就是用户主动按下去的,没有「误弹」可言)。这里保留这一次等待,是为了让
 *    「这一枚已经落定」有个确定的判据,免得后面的断言跑在落地动效中间。 */
async function placeRedAndSettle(page: Page): Promise<{ card: Locator; dot: Locator }> {
  const key = keyOf("008");
  const card = page.locator(`.rb-card[data-film-key="${key}"]`);
  await card.getByRole("button", { name: /^标记《/ }).click();
  await card.getByRole("button", { name: /贴红贴纸/ }).click();
  const dot = card.locator(".rb-dot");
  await expect(dot).toHaveCount(1);
  await expect(dot).not.toHaveAttribute("data-rb-fresh");
  return { card, dot };
}

/** 轮盘里**当前这一款之外**的另一款(避免「预览与现状同款 → 看不出变化」的假绿)。
 *  ⚠ 当前款从容器上的 `data-rb-wheel` 读 —— 那是组件与测试之间唯一的机读契约;
 *    写死某一款的话,新贴那枚的款由带随机后缀的 id 推导,这条用例就会变成看运气。 */
async function anotherSkin(wheel: Locator): Promise<string> {
  const current = await wheel.getAttribute("data-rb-wheel");
  // ⚠ **不再手抄一份名单**:2026-09-30 换款(`torn` / `reel` → `clap` / `palm`)时这里抄的那份
  //   没跟着改,于是这条用例去点一个已经不存在的节点、红在「元素找不到」上 ——
  //   而它想守的其实是「换一款给用户看」,与具体是哪几款无关
  //   (2026-10-05 缩到三款时也是因为它从 DOM 读,才没有第三次踩同一个坑)。
  //   现在名单从**轮盘自己渲染出来的节点**读:契约层换款,这条自动跟上。
  const keys = await wheel
    .locator("[data-rb-wheel-node]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-rb-wheel-node") ?? ""));
  const other = keys.find((skin) => skin !== current);
  expect(other).toBeTruthy();
  return other as string;
}

// ⚠ 下面这几个「鼠标那条」的用例都**只在桌面项目上跑**:它们用 `page.mouse` 走鼠标那条路。
//   触屏那条由「★ 触屏长按换款」用手动派发的 `pointerType: "touch"` 事件覆盖 ——
//   两者现在走**同一段代码**(见 `PRESS_MS` 的说明),不必在移动项目上重复跑一遍。
//   ⚠ Playwright 的 `hover()` 还会**顺手把元素滚进视口**,而轮盘按设计「滚动即关」
//   (锚点是视口坐标),于是它在命中测试之前就被自己关掉了(实测报「被 .rb-card-info 挡住」,
//   而用 `elementFromPoint` 量下来轮盘节点其实稳稳在最上层 —— 那是**假象**,不是真遮挡)。
//   `pressOpenWheel()` 里那次 `scrollIntoViewIfNeeded()` 发生在**开环之前**,不受这条影响。
test("换款轮盘:长按弹出、悬停节点只是预览、点选才落定并随票上报", async ({ page, isMobile }) => {
  test.skip(isMobile, "这一条走 `page.mouse`；触屏那条在「★ 触屏长按换款」里用手动派发的事件覆盖");
  const pings: Array<{ ops: Array<Record<string, unknown>> }> = [];
  await page.route("**/api/stats/film-votes**", async (route) => {
    if (route.request().method() === "POST") {
      pings.push(route.request().postDataJSON() as { ops: Array<Record<string, unknown>> });
      return route.fulfill({ json: { ok: true, count: 1, votes: {}, skins: {} } });
    }
    return route.fulfill({ json: { edition: "biff-2026", votes: {} } });
  });
  await stubComments(page, { items: [] });
  await ready(page, "/redblack");

  const { dot } = await placeRedAndSettle(page);
  // ⚠ 先等提示条退场:它挂在视口**底部**、`role=alertdialog`、而且**接得住指针** ——
  //   下面那次 `target.hover()` 会先落在它身上(Playwright 原话:`intercepts pointer events`),
  //   然后为了躲它去滚动页面,而轮盘「滚动即关」:节点当场被卸载,报的是「element was detached」。
  //   ⚠ 2026-10-05 之前这条不会踩上,只是因为开环之后**立刻**就 hover 了节点;
  //     长按要多花 500ms,正好挪进那条提示条的退场窗口里(实测抓到 `…_toast-remove`)。
  await quiet(page);
  const face = dot.locator(".rb-dot__face");
  /** 这一枚现在长什么样 —— 读的就是 `clip-path` 吃的那条路径(`--rb-shape`) */
  const shape = (): Promise<string> =>
    face.evaluate((node) => (node as HTMLElement).style.getPropertyValue("--rb-shape"));
  const before = await shape();

  await pressOpenWheel(page, dot);
  const wheel = page.locator(".rb-wheel");
  await expect(wheel).toHaveCount(1);
  // 三款一款不少,且**当前那款被明确标出**(`aria-checked` 是视觉与无障碍共用的判据)
  await expect(wheel.locator(".rb-wheel__node")).toHaveCount(3);
  await expect(wheel.locator('[role=radio][aria-checked=true]')).toHaveCount(1);
  // 白底盘(2026-09-30,用户要求「选择的盘白底的,能更清晰看到」)。
  // ⚠ 断言的是**它真的画出来了**,不是「有这个元素」—— `background` 那串径向渐变少一层
  //   就会退化成实心圆(正好盖住用户要预览的那枚贴纸),而那不会有任何报错。
  const plate = wheel.locator(".rb-wheel__plate");
  await expect(plate).toHaveCount(1);
  await expect(plate).toHaveCSS("background-image", /radial-gradient/);
  // 中心要**掏空**:透明到白之间那条硬停色标必须真的在。
  // ⚠ 不能只断言关键字 `transparent`(2026-09-30,CI 实测红):**计算值里它被归一成 `rgba(0, 0, 0, 0)`**,
  //   三个引擎都是如此 —— 那句断言必红。两种形态都接,要守的仍然是「中心那一段是全透明的」这件事。
  await expect(plate).toHaveCSS("background-image", /transparent|rgba\(0,\s*0,\s*0,\s*0\)/);
  // 底盘不吃指针(它只是背景),否则指针从贴纸走向节点会被它挡住
  await expect(plate).toHaveCSS("pointer-events", "none");

  const other = await anotherSkin(wheel);
  const target = wheel.locator(`[data-rb-wheel-node="${other}"]`);
  // 名称胶囊(2026-09-30,用户要求「悬停出现贴纸名称」):默认看不见,悬停那颗才露出来。
  // ⚠ 两个断言缺一不可 —— 只断言「悬停后可见」的话,把名字改成常显也照样绿(那就成了几个名字糊一圈)。
  // ⚠ 但**不能**拿 `.first()` 硬碰「opacity 0」:开环的手势把光标留在了贴纸正中,
  //   而轮盘中心未必正好落在光标底下(锚点只在开环那一刻量一次,期间版面可能被
  //   `loading="lazy"` 的海报顶过;`clampAnchor` 也会夹它)—— 于是某一颗可能恰好在
  //   光标底下、名字已经亮着。判据写成「亮着的**最多一颗**」:常显 ⇒ 3 颗全亮 ⇒ 照样红。
  const litNames = await wheel
    .locator(".rb-wheel__name")
    .evaluateAll((nodes) => nodes.filter((node) => getComputedStyle(node).opacity === "1").length);
  expect(litNames).toBeLessThanOrEqual(1);
  // ⚠ 基线要取**现在**这一刻:贴下那一枚本身已经上报过一次(1200ms 防抖),
  //   写 `toHaveLength(0)` 会红在与预览无关的地方。
  const pinged = pings.length;
  await target.hover();
  // 悬停的这一颗露出名字,而且**只有它**
  await expect(target.locator(".rb-wheel__name")).toHaveCSS("opacity", "1");
  await expect(wheel.locator(".rb-wheel__name")).toHaveCount(3);
  await expect(wheel.locator(".rb-wheel__name").filter({ hasText: /^$/ })).toHaveCount(0);
  // 预览:贴纸**本体**跟着换款了
  await expect.poll(shape).not.toBe(before);
  // ⚠ 但预览**不写盘、不上报** —— 在环上转一圈不该多出任何一次上报
  expect(pings).toHaveLength(pinged);

  await target.click();
  await expect(wheel).toHaveCount(0);
  await expect.poll(shape).not.toBe(before);
  // 落定之后才跟着票一起上报(服务端按款聚合,展板上的群点才画得出大家选了什么)
  await expect
    .poll(() => (pings.at(-1)?.ops?.[0] as { skin?: string } | undefined)?.skin, { timeout: 8000 })
    .toBe(other);
});

test("换款轮盘:Esc 关得掉;而「双击贴纸 = 收回」这条既有契约没被踩坏", async ({ page, isMobile }) => {
  test.skip(isMobile, "这一条走 `page.mouse`；触屏那条在「★ 触屏长按换款」里用手动派发的事件覆盖");
  await stubEmpty(page);
  await stubComments(page, { items: [] });
  await ready(page, "/redblack");

  const { dot } = await placeRedAndSettle(page);
  await pressOpenWheel(page, dot);
  const wheel = page.locator(".rb-wheel");
  await expect(wheel).toHaveCount(1);

  await page.keyboard.press("Escape");
  await expect(wheel).toHaveCount(0);

  // ⚠ 这条是**回归守卫**:环开着的时候双击那枚贴纸,两次点击都得落到「收回」上 ——
  //   若环把这两次点击吞掉,收回就没了。
  //   ⚠ 2026-10-05 之前环是**悬停**弹出来的,而 `dblclick()` 先 hover 再点,所以环「必然开着」;
  //     现在鼠标也得**长按**才开,所以这里显式开一次,情境反而更干净。
  await pressOpenWheel(page, dot);
  await expect(wheel).toHaveCount(1);
  await dot.dblclick();
  await expect(dot).toHaveCount(0);
  await expect(wheel).toHaveCount(0);
});

test("换款轮盘:键盘也能走完(聚焦弹出、方向键转、回车落定)", async ({ page, isMobile }) => {
  // ⚠ 移动端的 WebKit **不做 Tab 焦点遍历**(实测按 Tab 焦点不动),所以「键盘走到这一枚」
  //   这件事在那些项目里根本无法发生 —— 那是浏览器的行为差异,不是本页的缺陷。
  test.skip(isMobile, "移动端浏览器不做 Tab 焦点遍历");
  await stubEmpty(page);
  await stubComments(page, { items: [] });
  await ready(page, "/redblack");

  const { dot } = await placeRedAndSettle(page);
  // ⚠ 不能直接 `dot.focus()`:程序化聚焦**不匹配 `:focus-visible`**,而环正是靠这个判据
  //   区分「键盘 Tab 过来」与「鼠标点了一下」的(后者要留给「收回」)。
  //   所以先键盘移出、再键盘移回来 —— 这才是真的「键盘走到这一枚」。
  await dot.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");

  const wheel = page.locator(".rb-wheel");
  await expect(wheel).toHaveCount(1);
  // 键盘打开时焦点被收进环里(指针长按打开的环则**不能**抢焦点)
  await expect(wheel.locator("[role=radio]:focus")).toHaveCount(1);

  const before = await wheel.getAttribute("data-rb-wheel");
  await page.keyboard.press("ArrowRight");
  await expect(wheel.locator("[role=radio]:focus")).not.toHaveAttribute(
    "data-rb-wheel-node",
    before as string,
  );
  // 方向键只**转移焦点**(顺带预览),不落定 —— 环还开着
  await expect(wheel).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(wheel).toHaveCount(0);
  // 落定之后焦点回到那一枚贴纸上(否则键盘用户会被丢在文档开头)
  await expect(dot).toBeFocused();
});

test("换款轮盘:滚一下就关掉(锚点是视口坐标,不跟着滚)", async ({ page, isMobile }) => {
  test.skip(isMobile, "这一条走 `page.mouse`；触屏那条在「★ 触屏长按换款」里用手动派发的事件覆盖");
  await stubEmpty(page);
  await stubComments(page, { items: [] });
  await ready(page, "/redblack");

  const { dot } = await placeRedAndSettle(page);
  await pressOpenWheel(page, dot);
  const wheel = page.locator(".rb-wheel");
  await expect(wheel).toHaveCount(1);

  // ⚠ 用 `window.scrollBy` 而不是 `mouse.wheel`:WebKit 不支持 `mouse.wheel`(仓库既有结论)
  await page.evaluate(() => window.scrollBy(0, 240));
  await expect(wheel).toHaveCount(0);
  // 关掉之后**不动 board**:这枚贴纸还在(滚动不该顺手把东西改掉)
  await expect(dot).toHaveCount(1);
});

// 触屏那条 —— ⚠ Playwright **没有 long-press API**,所以这里手动派发带
// `pointerType: "touch"` 的 pointer 事件。它们与真机触屏的差别只在 `touch-action`
// 与浏览器的滚动去抖,而本用例走的那几条分支**只看 `pointerType`** —— 三个项目都能跑。
test("★ 触屏长按换款:带一点点抖动也照样弹出轮盘,松手不关、点环外才关", async ({ page }) => {
  // ⚠ 用户 2026-10-05 报的是触屏这条路**根本走不通**(见 `PLAN-20261005183113`):
  //   ① 长按判定没有位移阈值 —— 按住半秒期间的一点点抖动就把它作废;
  //   ② 就算环出来了,一松手(`pointerleave`)就会被那条**鼠标**的关环逻辑收掉。
  //   两条都只看 `pointerType`,与真机触屏 / `touch-action` 无关 —— 所以这里
  //   **手动派发带 `pointerType: "touch"` 的 pointer 事件**,三个项目(含 desktop)都能跑这条判据。
  await stubEmpty(page);
  await stubComments(page, { items: [] });
  await ready(page, "/redblack");

  const { card, dot } = await placeRedAndSettle(page);
  const box = (await dot.boundingBox())!;
  const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const touch = (type: string, dx = 0, dy = 0) =>
    dot.dispatchEvent(type, {
      pointerType: "touch",
      pointerId: 7,
      isPrimary: true,
      clientX: origin.x + dx,
      clientY: origin.y + dy,
    });
  const wheel = page.locator(".rb-wheel");

  // ---- ① 小抖动不该作废长按(回归判据:改前 `onPointerMove` 是无条件作废的) ----
  await touch("pointerdown");
  // 蓄力进度环:按下去的**那一刻**就看得见 —— 它同时是「能长按」唯一看得见的提示
  await expect(dot).toHaveAttribute("data-rb-pressing", "true");
  // ⚠ 光有 `data-rb-pressing` 只说明**状态**对了,证明不了**画面**对:环是 `::after` 画的,
  //   `background` / `mask` 少写一层、或角度没注册成可动画的自定义属性,属性照样在、
  //   而屏幕上什么都没有。所以这里直接读伪元素的计算样式(用户 2026-10-05 要的就是这一圈)。
  const pressRing = (): Promise<{ background: string; mask: string; turn: number }> =>
    dot.evaluate((node) => {
      const style = getComputedStyle(node, "::after");
      return {
        background: style.getPropertyValue("background-image"),
        mask: style.getPropertyValue("mask-image") || style.getPropertyValue("-webkit-mask-image"),
        // 注册过的自定义属性给出的是**当前动画进度**;取不到就退化成 0
        turn: Number.parseFloat(style.getPropertyValue("--rb-press-turn")) || 0,
      };
    });
  const ring = await pressRing();
  expect(ring.background).toContain("conic-gradient");
  expect(ring.mask).toContain("radial-gradient");
  // 进度**真的在跑**(而不是一圈静态底轨):注册过的 `@property` 加动画才会给出**非零角度**。
  // ⚠ 用 `poll` 从 0 等它涨起来,别采样两次比大小 —— 环在 `PRESS_MS` 之后会被摘掉
  //   (轮盘开出来了),再采样读到的是空值 0,那条判据会假红(实测)。
  await expect.poll(async () => (await pressRing()).turn).toBeGreaterThan(0);
  // 5px < `DRAG_SLOP_TOUCH`(10px):这一步在改前会把长按计时器直接清掉,环永远不出来
  await touch("pointermove", 5, 5);
  // ⚠ 这里**不再**断言「此刻还没有环」—— 那是个对时序敏感的判据:`toHaveAttribute` 自己的轮询
  //   就耗时不定,并发跑时可能已经越过 `PRESS_MS`(实测:全 spec 并发下偶发假红,单条 3/3 全绿)。
  //   要守的那件事下面一条已经说清了:**那一抖没有把环作废**(改前它永远不成立)。
  await expect(wheel).toHaveCount(1, { timeout: 3000 });

  // ---- ② 松手不该关掉它(触屏没有 hover,「指针离开」在那里只等于抬手) ----
  await touch("pointerup");
  await expect(dot).not.toHaveAttribute("data-rb-pressing");
  // ⚠ 等过 `WHEEL_GRACE_MS`(260ms):改前环会在这条宽限走完时消失,用户根本来不及点节点
  await page.waitForTimeout(400);
  await expect(wheel).toHaveCount(1);

  // ---- ③ 点环外 → 关(触屏没有 Escape,这是那条唯一通用的退路) ----
  await page.locator(".rb-sort-hint").click();
  await expect(wheel).toHaveCount(0);

  // ---- ④ 环开着时的**移动** / 抬手 / 补发的 `pointerleave` 都不该把环收掉 ----
  // ⚠ 用户 2026-10-05:「长按后 一松手圆盘就消失了 应该选了皮肤才消失」,随后又明确
  //   「不选皮肤就圆环就不会消失」—— 所以环的出口只有「选皮肤 / 点环外 / 滚动 / Esc」;
  //   位移(真机抬手实测能到 14px)与抬手补发的事件都不算。
  await touch("pointerdown");
  await expect(wheel).toHaveCount(1, { timeout: 3000 });
  await touch("pointermove", 14, 0);
  await page.waitForTimeout(200);
  await expect(wheel).toHaveCount(1);
  // ⚠ 判据取**手势类型**而不是这一个事件的 `pointerType`(见 `onPointerLeave` 的说明)——
  //   这里故意把它报成 `mouse`:改前会走鼠标那条关环逻辑,260ms 后环就没了。
  //   ⚠ 派发的是 `pointerout`(冒泡)而不是 `pointerleave`(不冒泡):React 的
  //     `onPointerLeave` 就是在根节点上听 `pointerout` 合成出来的。
  await dot.dispatchEvent("pointerout", {
    pointerType: "mouse",
    pointerId: 7,
    isPrimary: true,
    relatedTarget: null,
    clientX: origin.x + 14,
    clientY: origin.y,
  });
  await page.waitForTimeout(400); // > `WHEEL_GRACE_MS`
  await expect(wheel).toHaveCount(1);
  // ⚠ 松手点取**当下量到的画布中心**,不要用缓存的 `origin`:上面第 ③ 步那次
  //   `locator(".rb-sort-hint").click()` 会让页面滚动,`origin` 从此过期 ——
  //   而过期的落点会被判成「出界 → 收回」,把这一枚**真的收走**(实测:贴纸当场没了,
  //   下一条断言报的是「元素已不在」)。落点这个坑仓库里另一条用例也是这么绕的。
  const canvasRect = (await card.locator(".rb-canvas").boundingBox())!;
  const drop = { x: canvasRect.x + canvasRect.width / 2, y: canvasRect.y + canvasRect.height / 2 };
  await touch("pointerup", drop.x - origin.x, drop.y - origin.y);
  // 收尾:把环关掉,免得这条判据的中间状态影响下一条
  await page.keyboard.press("Escape");
  await expect(wheel).toHaveCount(0);

  // ---- ⑤ 挪过阈值就是「拖」,不该再弹环 ----
  await touch("pointerdown");
  await touch("pointermove", -60, 0);
  await page.waitForTimeout(PRESS_MS + 200); // > `PRESS_MS`
  await expect(wheel).toHaveCount(0);
  await touch("pointerup", drop.x - origin.x, drop.y - origin.y);
});

test("★ 触屏:环弹出后照样拖得动贴纸,而环**不会**因此消失(「不选皮肤就不消失」)", async ({ page }) => {
  // ⚠ 口径变更(2026-10-05,用户第三次反馈):「不选皮肤就圆环就不会消失」——
  //   这条**撤销**了上一版按第二次反馈(「当时想拖动贴纸 就马上会触发换肤」)做的「拖动优先」
  //   (环开着时位移一越过 `slop` 就让位)。两种口径互斥,以用户**最后一次**的为准:
  //   环一旦开出来就留着,直到「选了皮肤 / 点环外 / 滚动 / Esc」;而拖动**照常生效**
  //   (`beginDrag` 的监听挂在 `window` 上,与环没有关系)。
  await stubEmpty(page);
  await stubComments(page, { items: [] });
  await ready(page, "/redblack");

  const { card, dot } = await placeRedAndSettle(page);
  const box = (await dot.boundingBox())!;
  const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const touch = (type: string, at: { x: number; y: number }) =>
    dot.dispatchEvent(type, {
      pointerType: "touch",
      pointerId: 9,
      isPrimary: true,
      clientX: at.x,
      clientY: at.y,
    });
  const wheel = page.locator(".rb-wheel");

  // ① 按住不动 → 环照常弹出来(那条路不能被这次改坏)
  await touch("pointerdown", origin);
  await expect(wheel).toHaveCount(1, { timeout: 3000 });

  // ② 环开着时继续移动(越过 `DRAG_SLOP_TOUCH` = 10px)→ **环不动**
  //    ⚠ 改前这里断的是 `toHaveCount(0)`(让位);现在反过来 —— 这正是本条要守的新口径。
  await touch("pointermove", { x: origin.x + 30, y: origin.y });
  await expect(wheel).toHaveCount(1);

  // ③ 而这一拖**照样生效**:贴纸落到松手那一点(环既不为难拖拽,也不替用户做决定)
  const rect = (await card.locator(".rb-canvas").boundingBox())!;
  const rel = { x: (origin.x - rect.x) / rect.width, y: (origin.y - rect.y) / rect.height };
  const target = { x: rel.x < 0.5 ? 0.8 : 0.2, y: rel.y < 0.5 ? 0.8 : 0.2 };
  const drop = { x: rect.x + rect.width * target.x, y: rect.y + rect.height * target.y };
  await touch("pointermove", drop);
  await touch("pointerup", drop);
  // 松手也不该收起它 —— 只有「选皮肤 / 点环外 / 滚动 / Esc」才是出口
  await expect(wheel).toHaveCount(1);

  const after = (await dot.boundingBox())!;
  const settled = (await card.locator(".rb-canvas").boundingBox())!;
  const afterRel = {
    x: (after.x + after.width / 2 - settled.x) / settled.width,
    y: (after.y + after.height / 2 - settled.y) / settled.height,
  };
  expect(Math.abs(afterRel.x - target.x)).toBeLessThan(0.05);
  expect(Math.abs(afterRel.y - target.y)).toBeLessThan(0.05);

  // ④ 出口仍然是有效的:点环外 → 关(触屏没有 Escape,这是那条通用退路)
  await page.locator(".rb-sort-hint").click();
  await expect(wheel).toHaveCount(0);
});

