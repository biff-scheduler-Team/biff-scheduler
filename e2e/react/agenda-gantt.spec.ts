import { test, expect } from "@playwright/test";
import { catalog, keyOf, ready, seed, storage } from "./helpers";

// 「我的行程 → 日程表」视图(2026-09-21,PLAN-20260921223658)。
// 与排片表共用同一个甘特组件,但画布只有我的场次、X 轴只有我有影片的影厅。
// ⚠ 排片表那一列在 `/agenda` 路由上是**渲染出来但 hidden** 的(见 `app/App.tsx` 的
//   `.schedule-column`),所以这里的断言一律先用 CSS 作用域收到 `region 我的行程` 里 ——
//   直接用 `page.locator(".vertical-venue")` 会同时命中隐藏的排片表。

const mine = ["008", "033"];

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

function venueCodes(codes: string[]) {
  return [...new Set(codes.map((code) => catalog.byCode.get(code)!.venue_id))]
    .map((id) => catalog.venueById.get(id)!.code)
    .sort();
}

test("日程表默认只画我的场次，X 轴只留我有影片的影厅", async ({ page }) => {
  await seed(page, { "biff.picks.v2": picks(mine) });
  await ready(page, "/agenda");
  const agenda = page.getByRole("region", { name: "我的行程", exact: true });

  // 日期条只列「我有行程的日期」(排片表那条列全届日期)
  await expect(agenda.locator(".date-strip.calendar-strip > button")).toHaveCount(1);
  // 画布上只有我的两场 —— 当天 10-07 一共有 68 场
  await expect(agenda.locator("[data-grid-slot]")).toHaveCount(2);
  await expect(agenda.locator('[data-grid-code="008"]')).toBeVisible();
  await expect(agenda.locator('[data-grid-code="033"]')).toBeVisible();
  const other = catalog.schedule.screenings.find(
    (s) => s.date === "2026-10-07" && !mine.includes(s.code),
  )!;
  await expect(agenda.locator(`[data-grid-slot="${other.code}"]`)).toHaveCount(0);

  // X 轴只有我有影片的影厅(10-07 当天有 21 个厅在放片,这里只该剩 2 个)
  const codes = (await agenda.locator(".vertical-venue .venue-code").allTextContents()).map(
    (text) => text.trim(),
  );
  expect(codes.sort()).toEqual(venueCodes(mine));
});

test("日程表的整点刻度只是刻度，不再是可点的时段筛选", async ({ page }) => {
  await seed(page, { "biff.picks.v2": picks(mine) });
  await ready(page, "/agenda");
  const agenda = page.getByRole("region", { name: "我的行程", exact: true });

  // 这一页没有整点筛选:做成按钮就是个点了没反应的死控件,还会往 /agenda 的 URL 写 hour
  await expect(agenda.locator(".ruler-track button")).toHaveCount(0);
  await expect(agenda.locator(".ruler-tick").first()).toBeVisible();
  // 排片表那套「排片筛选 / 已选图例」同理不出现在行程画布上
  expect(await agenda.locator(".schedule-legend").innerText()).not.toContain("已选");
  await expect(page.getByRole("button", { name: "排片筛选", exact: true })).toHaveCount(0);
});

test("时间重叠在我的两场之间画成连线，并给格子冲突配色", async ({ page }) => {
  await seed(page, { "biff.picks.v2": picks(mine) });
  await ready(page, "/agenda");
  const agenda = page.getByRole("region", { name: "我的行程", exact: true });

  // 008(08:40–11:20)与 033(09:00–10:53)重叠 → 跨两个影厅列一条连线
  await expect(agenda.locator(".conflict-links line")).toHaveCount(1);
  await expect(agenda.locator('[data-grid-slot="008"]')).toHaveClass(/conflict/);
  await expect(agenda.locator('[data-grid-slot="033"]')).toHaveClass(/conflict/);
  // 连线**不再**跟着一张顺位卡(2026-09-22,`PLAN-20260922123138`):用户口径是
  // 「我的行程不需要显示冲突组顺位这个组件」。连线本身保留 —— 它只是「这两场重叠」的视觉证据。
  // ⚠ 抢票顺位没有被砍掉,改它请切卡片视图(那里按日就地展开顺位卡,见 `parity-agenda`)。
  await expect(agenda.locator(".rank-group")).toHaveCount(0);
});

test("日期条切单日，卡片 / 日程表两档可来回切且互不残留", async ({ page }) => {
  await seed(page, { "biff.picks.v2": picks(["001", ...mine]) });
  await ready(page, "/agenda");
  const agenda = page.getByRole("region", { name: "我的行程", exact: true });

  await expect(agenda.locator(".date-strip.calendar-strip > button")).toHaveCount(2);
  // 默认落行程里最早的一天:10-06 只有 001 一场(唯一场次 → 只有一个影厅列)
  await expect(agenda.locator("[data-grid-slot]")).toHaveCount(1);
  await expect(agenda.locator(".vertical-venue")).toHaveCount(1);
  await agenda
    .getByRole("button", { name: "选择日期 2026-10-07", exact: true })
    .click();
  await expect(agenda.locator("[data-grid-slot]")).toHaveCount(2);
  await expect(agenda.locator(".vertical-venue")).toHaveCount(2);

  // 卡片视图:按天列表回来,画布整块卸载
  await agenda.getByRole("button", { name: "卡片", exact: true }).click();
  await expect(agenda.locator(".agenda-day")).toHaveCount(2);
  await expect(agenda.locator("[data-grid-slot]")).toHaveCount(0);
  await expect(agenda.locator('[data-screening="008"]')).toBeVisible();
  await agenda.getByRole("button", { name: "日程表", exact: true }).click();
  await expect(agenda.locator(".agenda-day")).toHaveCount(0);
  await expect(agenda.locator(".vertical-venue")).toHaveCount(2);

  // 画布铺满(2026-09-22,`PLAN-20260922123138`):右侧栏(冲突组顺位 + 场次详情)整块下线后,
  // 这一列不再被第二列分走宽度 —— 画布左右各只剩 `.agenda-gantt` 自己的内距(宽屏 20 / 窄屏 14)。
  // ⚠ 量的必须是 `.vertical-schedule`(画布含左侧时间刻度列),不是 `.gantt-scroll`:
  //   后者在 `.schedule-grid` 里排在时间列**右边**,量它会凭空多出一个刻度列的宽度。
  await expect(agenda.locator(".agenda-columns")).toHaveCount(0);
  await expect(agenda.locator(".agenda-side")).toHaveCount(0);
  // ⚠ `region 我的行程` 本身就是 `.agenda-page`(`aria-label` 挂在那上面),故页框直接量它
  const pageBox = (await agenda.boundingBox())!;
  const canvasBox = (await agenda.locator(".vertical-schedule").boundingBox())!;
  expect(canvasBox.x - pageBox.x).toBeLessThanOrEqual(21);
  expect(
    pageBox.x + pageBox.width - (canvasBox.x + canvasBox.width),
  ).toBeLessThanOrEqual(21);

  // 「仅看实际行程」联动:一场都没标「已抢到」时画布与日期条一起空掉,并给出说明
  await agenda.getByRole("button", { name: /仅看实际行程/ }).click();
  await expect(agenda.locator("[data-grid-slot]")).toHaveCount(0);
  await expect(agenda.locator(".date-strip.calendar-strip")).toHaveCount(0);
  await expect(agenda.locator(".agenda-gantt-empty")).toBeVisible();
});

// 「我的行程」信息架构收拾(三轮合并,现在是 `PLAN-20260922123138` 定稿的形态):
//   ① 两行控件并成**一条**工具栏(左:状态与操作,右:视图与缩放);
//   ② 日期条从独立一行**并进**这条工具栏;
//   ③ 概览从独立一行收进页头标题右侧;
//   ④ 画布**单列铺满**(上一轮那块右侧栏连同「冲突组顺位」一起撤掉);
//   ⑤ 「保存当前方案 / 已保存方案」整体下线 → 断言是**反向**的(计数 0),钉住「没有复活」。
test("首屏只有一条工具栏（含日期卡），概览收进页头，画布单列铺满", async ({
  page,
  isMobile,
}) => {
  // 这条钉的是**桌面**版式:视口被顶到 1512,但移动端模拟下的字宽 / 行高与真桌面不同,
  // 首屏预算实测差十几像素(288 vs 274)—— 预算只在桌面这一档有意义。
  test.skip(isMobile, "桌面版式;窄屏的内距与铺满由上面那条用例覆盖");
  // 左右两组要落在同一行才有「左 vs 右」可言,故把视口钉死在桌面宽度
  await page.setViewportSize({ width: 1512, height: 1200 });
  await seed(page, { "biff.picks.v2": picks(mine) });
  await ready(page, "/agenda");
  const agenda = page.getByRole("region", { name: "我的行程", exact: true });

  // ① 全页只有一条工具栏:日期卡、图例、操作、视图、缩放全在里面
  const toolbar = agenda.locator(".agenda-actions");
  await expect(toolbar).toHaveCount(1);
  const strip = toolbar.locator(".date-strip.calendar-strip");
  await expect(strip).toHaveCount(1);
  const legend = toolbar.locator(".schedule-legend");
  await expect(legend).toHaveCount(1);
  await expect(legend).toContainText("时间紧张");
  await expect(legend).toContainText("时间重叠");
  await expect(legend).toContainText("韩国时间 KST");
  // 缩放档位从画布自己的图例行搬进了这条工具栏
  await expect(toolbar.locator(".zoom-controls button")).toHaveCount(3);
  // 画布容器里不再有第二行图例(否则就是「两行控件」又回来了)
  await expect(agenda.locator(".agenda-gantt .schedule-legend")).toHaveCount(0);

  // ② 左组 = 日期卡 + 图例 + 添加转票场次 + 仅看实际行程;右组 = 日程表 / 卡片 + 缩放
  const left = toolbar.locator(".agenda-actions-left");
  const right = toolbar.locator(".agenda-actions-right");
  expect(await left.innerText()).toContain("添加转票场次");
  expect(await left.innerText()).toContain("仅看实际行程");
  expect(await right.innerText()).toContain("日程表");
  expect(await right.innerText()).toContain("卡片");
  const leftBox = (await left.boundingBox())!;
  const rightBox = (await right.boundingBox())!;
  expect(rightBox.x).toBeGreaterThanOrEqual(leftBox.x + leftBox.width);

  // ③ 「方案」整体下线(2026-09-22,`PLAN-20260922105228`):保存按钮与已保存方案区块都不在了
  await expect(agenda.locator(".agenda-save")).toHaveCount(0);
  await expect(
    agenda.getByRole("button", { name: "保存当前方案", exact: true }),
  ).toHaveCount(0);
  await expect(agenda.locator(".saved-plans")).toHaveCount(0);

  // ④ 概览不再独占一行,而是标题右侧的一排 tag;画布起点按**首屏预算**钉住。
  //    预算账(1512 宽实测,2026-09-22):
  //      改前 = 页头 82 + 概览 36 + 日期条 112 + 工具栏 66 = 296(画布起点 y≈295)
  //      改后 = 页头 ~62(副标题收进 h1 同行)+ 一条工具栏 ~60(日期卡压成药丸)= **274**
  //    ⚠ 这条预算**包含**新增的票务通知条(~28)与全站固定两条(站点 header 64 + 主导航 44)——
  //      所以它不是"能压到多小"的记录,而是"别再把离散层级加回来"的守卫:多一行就红。
  //    ⚠ 别再往下抠那 ~25px:剩下的都是标题/工具栏的内边距,抠掉就是拿呼吸感换算高度。
  const overview = agenda.locator(".agenda-overview");
  await expect(overview).toHaveCount(1);
  await expect(overview).toContainText("部电影");
  await expect(overview).toContainText("质量分");
  await expect(agenda.locator(".summary-strip")).toHaveCount(0);
  const headingBox = (await agenda.locator(".panel-heading").boundingBox())!;
  const overviewBox = (await overview.boundingBox())!;
  expect(overviewBox.y).toBeLessThan(headingBox.y + headingBox.height);
  const canvasBox = (await agenda.locator(".gantt-scroll").boundingBox())!;
  expect(canvasBox.y).toBeLessThanOrEqual(280);

  // ⑤ 单列铺满(2026-09-22,`PLAN-20260922123138`):上一轮那两栏与右侧栏
  //    (当天冲突组顺位 + 场次详情)整块下线,「顺位撞车」提示也一并撤掉 ——
  //    它们读的是同一批 `plans.rankClashes` / `plans.groups`。
  await expect(agenda.locator(".agenda-columns")).toHaveCount(0);
  await expect(agenda.locator(".agenda-side")).toHaveCount(0);
  await expect(
    agenda.getByRole("region", { name: "当天冲突组顺位", exact: true }),
  ).toHaveCount(0);
  await expect(
    agenda.getByRole("region", { name: "场次详情", exact: true }),
  ).toHaveCount(0);
  await expect(agenda.locator(".rank-clashes")).toHaveCount(0);
  // ⚠ `region 我的行程` 本身就是 `.agenda-page`,页框直接量它(再写 `.agenda-page` 会找不到后代)
  const pageBox = (await agenda.boundingBox())!;
  const canvasRight = (await agenda.locator(".vertical-schedule").boundingBox())!;
  expect(
    pageBox.x + pageBox.width - (canvasRight.x + canvasRight.width),
  ).toBeLessThanOrEqual(21);

  // ⑥ 卡片视图没有画布:图例 / 缩放 / 日期条一起退场;顺位卡回到按日就地展开
  //    (改抢票顺位现在只剩这一个入口 —— 侧栏与撞车提示都撤了)
  await right.getByRole("button", { name: "卡片", exact: true }).click();
  await expect(agenda.locator(".schedule-legend")).toHaveCount(0);
  await expect(agenda.locator(".zoom-controls")).toHaveCount(0);
  await expect(strip).toHaveCount(0);
  await expect(agenda.locator(".agenda-side")).toHaveCount(0);
  await expect(agenda.locator(".rank-group").first()).toBeVisible();
});

// 行程画布上点掉一场要走二次确认(2026-09-22,`PLAN-20260922123138`)。
// 回归的是改动前的口径:行程画布只画我的场次,每一格都是「已选」,点一下 = 移出行程 ——
// 原先静默生效、没有撤销,票务标记也会跟着被 prune 掉。
// ⚠ 排片表那档不受影响(它的点击是「加入 / 移出」双向的日常动作),那条边界单列在下面。
test("日程表上点掉一场先出站内确认：取消不动、确认才移出", async ({ page }) => {
  await seed(page, { "biff.picks.v2": picks(mine) });
  await ready(page, "/agenda");
  const agenda = page.getByRole("region", { name: "我的行程", exact: true });
  const cell = agenda.locator('[data-grid-code="008"]');
  await expect(cell).toHaveAttribute("aria-pressed", "true");
  expect((await storage(page))["biff.picks.v2"]).toContain("008");

  // ① 点一下**不**立刻移出,先出站内弹层(弹层里说清后果:这一场 + 票务标记)
  await cell.click();
  const dialog = page.getByRole("dialog", { name: /把《.*》移出行程？/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("008");
  await expect(dialog).toContainText("票务标记");
  await expect(cell).toHaveAttribute("aria-pressed", "true");
  expect((await storage(page))["biff.picks.v2"]).toContain("008");

  // ② 取消 = 什么也没发生
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(cell).toHaveAttribute("aria-pressed", "true");

  // ③ 确认才真的移出:画布只画我的场次 → 这一格消失,另一场还在
  await cell.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "移出行程", exact: true })
    .click();
  await expect(agenda.locator('[data-grid-code="008"]')).toHaveCount(0);
  await expect(agenda.locator('[data-grid-code="033"]')).toBeVisible();
  expect((await storage(page))["biff.picks.v2"]).not.toContain("008");
});

// 同一条边界——排片表那档**不拦**(2026-09-22,`PLAN-20260922123138`)。
// 为什么值得钉:两档共用同一个画布组件与同一个 `toggle` 出口,给行程档加确认时
// 最省事的写法是拦在共享出口上,那会让排片表「点格子加入 / 移出」每天都多问一句。
test("排片表点格子仍是即时的加入 / 移出，不弹确认", async ({ page }) => {
  await ready(page, "/schedule?date=2026-10-07");
  const cell = page.locator('.schedule-column [data-grid-code="008"]');
  await expect(cell).toHaveAttribute("aria-pressed", "false");

  await cell.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(cell).toHaveAttribute("aria-pressed", "true");

  await cell.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(cell).toHaveAttribute("aria-pressed", "false");
});
