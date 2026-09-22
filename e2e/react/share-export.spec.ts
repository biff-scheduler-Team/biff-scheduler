// 分享（「导出与分享」弹层）文案 / 图片的端到端验收 + 主导航顺序快照。
//
// 2026-09-22 由原 `rush.spec.ts` 迁出（`PLAN-20260922102751`）：
//   · 「抢票」页整体下线 → 三条抢票页用例（导航位置 / 批次分组 / 空态）删除；
//   · 分享里的「顺位」「开票批次」两个扩展一并去掉 → 两条分享用例的基准页从 `/rush` 换成 `/agenda`，
//     并把断言**翻转**成「不再出现顺位 / 备选 / 批次节头」——这正是本轮改动的回归点。
//
// 断言全部走 DOM 计数 / 文本（DOM token）与画布文字钩子，不看截图。
//
// ⚠ 用真实排期数据里的**真实重叠对**：070(10/8 20:00–22:25 @bt 露天) 与 126(10/8 18:00–20:05 @l3)
//   同一天、时间重叠，构成一个冲突组；`biff.ranks.v1` 给它排顺位 —— 顺位本身仍存在
//   （行程页冲突组在用），只是**不再进分享内容**。

import { test, expect } from "@playwright/test";
import { keyOf, paintedTexts, ready, seed, trackPaintedTexts } from "./helpers";

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

test("分享文案按「当前行程」导出，且不含顺位 / 备选 / 开票批次", async ({ page }) => {
  await seed(page, {
    "biff.picks.v2": picks("070", "126"),
    "biff.ranks.v1": JSON.stringify({ "126": 1, "070": 2 }),
    // ⚠ 方案里故意放一个**与行程无关**的 code：默认范围必须是「当前行程」（`PLAN-20260916135942`）。
    //   若哪天回归成「默认选最后一个已保存方案」，下面的 126 / 070 会整个从文案里消失。
    "biff.savedplans.v1": plan("033"),
  });
  await ready(page, "/agenda");

  await page.getByRole("button", { name: "导出与分享", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导出与分享" });
  await expect(dialog.getByRole("button", { name: /导出范围/ })).toContainText("当前行程");
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
  await page.getByRole("button", { name: "导出与分享", exact: true }).click();
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
