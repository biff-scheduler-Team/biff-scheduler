// 分享（「导出与分享」弹层）文案 / 图片的端到端验收 + 主导航顺序快照。
//
// 2026-09-22 由原 `rush.spec.ts` 迁出（`PLAN-20260922102751`）：
//   · 「抢票」页整体下线 → 三条抢票页用例（导航位置 / 批次分组 / 空态）删除；
//   · 分享里的「顺位」「开票批次」两个扩展一并去掉 → 两条分享用例的基准页从 `/rush` 换成 `/agenda`，
//     并把断言**翻转**成「不再出现顺位 / 备选 / 批次节头」——这正是本轮改动的回归点。
//
// 断言全部走 DOM 计数 / 文本（DOM token）与画布文字钩子，不看截图。
//
// 2026-09-22 补：「更多」菜单的**单行**断言。S2 的 `MenuItem` 只把**字符串** children 包成
//   `slot="label"` 的文本组件（落进菜单 grid 的 `label` 区）；一旦传元素（原先是
//   `<span data-track="export">`），它会掉进第一列那段 `.5625rem` 的留白里 ——
//   实测「导出与分享」被压成 12px 宽 × 105px 高，逐字一行。这条断言钉住那个回归。
//
// ⚠ 用真实排期数据里的**真实重叠对**：070(10/8 20:00–22:25 @bt 露天) 与 126(10/8 18:00–20:05 @l3)
//   同一天、时间重叠，构成一个冲突组；`biff.ranks.v1` 给它排顺位 —— 顺位本身仍存在
//   （行程页冲突组在用），只是**不再进分享内容**。

import { test, expect } from "@playwright/test";
import { headerAction, keyOf, paintedTexts, ready, seed, trackPaintedTexts } from "./helpers";

/** 已选场次 → `biff.picks.v2`（每场一个 key，与行程页口径一致） */
const picks = (...codes: string[]) =>
  JSON.stringify(
    codes.map((code) => ({ key: keyOf(code), picks: [{ code }], note: "" })),
  );

const plan = (...codes: string[]) =>
  JSON.stringify([{ id: "plan-1", name: "方案 1", codes, createdAt: 1 }]);

test("主导航是 2026-09-22 指定的新顺序，且「抢票」已下线", async ({ page }) => {
  await ready(page, "/schedule");
  const labels = (
    await page.getByRole("navigation", { name: "主要导航" }).getByRole("link").allTextContents()
  ).map((text) => text.trim());
  expect(labels).toEqual([
    "排片表",
    "影片库",
    "我的选片",
    "我的行程",
    "红黑榜",
    "吃喝",
    "数据分析",
    "建议",
  ]);

  // 「抢票」页整体下线：直接访问落到兜底页（不是白屏、不是报错）
  await ready(page, "/rush");
  await expect(page.getByRole("heading", { name: "找不到这个页面" })).toBeVisible();
});

test("「更多」菜单每一项都是单行文字（元素 children 会被 S2 塞进留白列逐字折行）", async ({
  page,
}) => {
  await ready(page, "/schedule");
  await page.getByRole("button", { name: "更多", exact: true }).click();

  const heights: number[] = [];
  for (const name of ["导出与分享", "说明", "设置"]) {
    const item = page.getByRole("menuitem", { name, exact: true });
    await expect(item).toBeVisible();
    const box = await item.boundingBox();
    // 单行菜单项在两种视口下都远低于 60px;折行那版实测 111px(span 只有 12px 宽)
    expect(box!.height).toBeLessThan(60);
    heights.push(box!.height);
  }
  // 三项是同一档菜单项:高度必须一致 —— 有个别项折行时这里会先炸,读起来比单个阈值清楚
  expect(new Set(heights.map((h) => Math.round(h))).size).toBe(1);
});

test("「导出与分享」从菜单打开时仍记一次 click=export（锚点改显式上报后不能丢）", async ({
  page,
}) => {
  const events: Array<{ kind: string; target: string }> = [];
  // 埋点是防抖批量发(1.2s),且接口在预览环境不存在 —— 拦下来既避免 404 噪声,也直接读上报内容
  await page.route("**/api/stats/telemetry-ping", async (route) => {
    const body = route.request().postDataJSON() as {
      events?: Array<{ kind: string; target: string }>;
    };
    events.push(...(body.events ?? []));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: '{"counts":{}}',
    });
  });
  await ready(page, "/schedule");
  await headerAction(page, "导出与分享");
  await expect(page.getByRole("dialog", { name: "导出与分享" })).toBeVisible();

  // ⚠ 不能只等「第一条 ping 到」:页面浏览那条会先发出(攒批是同一个 1.2s 防抖窗口),
  //   于是 poll 在 click 还没攒够一波时就通过了 —— 必须等到 click=export 本身出现。
  await expect
    .poll(
      () => events.some((event) => event.kind === "click" && event.target === "export"),
      { timeout: 8_000 },
    )
    .toBe(true);
});

test("分享文案按「当前行程」导出，且不含顺位 / 备选 / 开票批次", async ({ page }) => {
  await seed(page, {
    "biff.picks.v2": picks("070", "126"),
    "biff.ranks.v1": JSON.stringify({ "126": 1, "070": 2 }),
    // ⚠ `biff.savedplans.v1` 是**废键**(「已保存方案」2026-09-22 整体下线,`PLAN-20260922105228`)。
    //   这里仍塞一个**与行程无关**的 code:它必须彻底失效 —— 既不能进导出范围,也不能进分享文案。
    "biff.savedplans.v1": plan("033"),
  });
  await ready(page, "/agenda");

  await headerAction(page, "导出与分享");
  const dialog = page.getByRole("dialog", { name: "导出与分享" });
  // 导出范围只剩「当前行程」一项,故下拉已换成一行静态说明(单选项下拉是死控件)
  await expect(dialog.getByText(/导出范围：当前行程/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: /导出范围/ })).toHaveCount(0);
  // 两个勾选框已随功能下线 —— 弹层里不该再有任何复选开关
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);

  await dialog.getByRole("button", { name: "分享文案", exact: true }).click();
  const text = dialog.getByRole("textbox", { name: "行程分享文案", exact: true });
  await expect(text).toContainText("126  18:00");
  await expect(text).not.toContainText("033");

  const shared = await text.evaluate((el) => (el as HTMLTextAreaElement).value);
  for (const needle of ["主选", "备选", "↳", "批"]) {
    expect(shared).not.toContain(needle);
  }
  // 「当前行程」取的是「每组第一顺位 + 共同场次」⇒ 冲突组里只有 126；
  // 070 原先是以**备选块**的样子跟着进文案的，备选下线后它就该整条消失。
  expect(shared).not.toContain("070");
});

test("分享图片同样不含顺位 / 备选 / 批次节头，但内容照画", async ({ page }) => {
  await trackPaintedTexts(page); // 海报是 canvas 手绘：断言只能读画上去的文字
  await seed(page, {
    "biff.picks.v2": picks("070", "126"),
    "biff.ranks.v1": JSON.stringify({ "126": 1, "070": 2 }),
    "biff.savedplans.v1": plan("070", "126"),
  });
  await ready(page, "/agenda");
  await headerAction(page, "导出与分享");
  const dialog = page.getByRole("dialog", { name: "导出与分享" });
  await dialog.getByRole("button", { name: "生成分享图片", exact: true }).click();
  const canvas = dialog.getByLabel("行程分享图片", { exact: true });
  await expect(canvas).toBeVisible();

  const painted = await paintedTexts(page);
  for (const needle of ["主选", "备选", "↳", "第 1 批", "第 2 批"]) {
    expect(painted).not.toContain(needle);
  }
  // 阴性对照：图**确实**画了内容 —— 否则上面那几条「不含」可能只是因为图是空的
  expect(painted).toContain("126");
  // 070 是 126 同冲突组的备选：备选行随顺位一起下线，它不该再出现在图上
  expect(painted).not.toContain("070");
});
