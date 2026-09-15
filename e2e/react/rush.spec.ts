// 「抢票」页 + 分享文案的顺位 / 开票批次选项(2026-09-15,PLAN-20260915234414)。
// 断言全部走 DOM 计数 / 文本(DOM token),不看截图。
// 覆盖:① 导航顺序(抢票夹在「我的行程」与「建议」之间);② 行程场次按开票批次分组;
//      ③ 空行程的空态;④ 导出弹层两个勾选框 → 文案出现批次节头 / 顺位 / 备选行。
//
// ⚠ 用真实排期数据里的**真实重叠对**:070(10/8 20:00–22:25 @bt 露天,第 1 批)
//   与 126(10/8 18:00–20:05 @l3,第 2 批)—— 同一天、时间重叠(20:00–20:05),构成一个冲突组。
//   批次判据见 apps/web/src/batch.ts;露天场必须落第 1 批是本需求的核心回归点。

import { test, expect } from "@playwright/test";
import { keyOf, paintedTexts, ready, seed, trackPaintedTexts } from "./helpers";

/** 已选场次 → `biff.picks.v2`(每场一个 key,与行程页口径一致) */
const picks = (...codes: string[]) =>
  JSON.stringify(
    codes.map((code) => ({ key: keyOf(code), picks: [{ code }], note: "" })),
  );

const plan = (...codes: string[]) =>
  JSON.stringify([{ id: "plan-1", name: "方案 1", codes, createdAt: 1 }]);

test("导航里「抢票」排在「我的行程」与「建议」之间", async ({ page }) => {
  await seed(page, { "biff.picks.v2": "[]" });
  await ready(page, "/rush");
  const labels = (
    await page.getByRole("navigation", { name: "主要导航" }).getByRole("link").allTextContents()
  ).map((text) => text.trim());
  expect(labels.indexOf("抢票")).toBeGreaterThan(labels.indexOf("我的行程"));
  expect(labels.indexOf("抢票")).toBeLessThan(labels.indexOf("建议"));
  await expect(page.getByRole("heading", { name: "抢票", exact: true })).toBeVisible();
});

test("行程场次按开票批次分成两批,露天场落第 1 批", async ({ page }) => {
  await seed(page, { "biff.picks.v2": picks("070", "126", "801") });
  await ready(page, "/rush");
  const first = page.locator('[data-ticket-batch="1"]');
  const second = page.locator('[data-ticket-batch="2"]');
  // 第 1 批:070(露天 Open Cinema)+ 801(Actors' House);第 2 批:126(一般放映)
  // ⚠ 批次卡里还有场次卡的 h3(片名),故按名字取批次标题,不能用裸 getByRole("heading")
  await expect(first.getByRole("heading", { name: /第 1 批/ })).toContainText("第 1 批");
  await expect(first).toContainText("Open Cinema"); // 官网品类原文,不翻译
  await expect(first.locator("[data-screening]")).toHaveCount(2);
  await expect(first.locator('[data-screening="070"]')).toBeVisible();
  await expect(first.locator('[data-screening="801"]')).toBeVisible();
  await expect(second.locator("[data-screening]")).toHaveCount(1);
  await expect(second.locator('[data-screening="126"]')).toBeVisible();
  await expect(page.locator(".summary-strip")).toContainText("3 场待抢");
});

test("行程为空时给空态,不渲染批次卡", async ({ page }) => {
  await seed(page, { "biff.picks.v2": "[]" });
  await ready(page, "/rush");
  await expect(page.getByRole("heading", { name: "还没有安排场次", exact: true })).toBeVisible();
  await expect(page.locator("[data-ticket-batch]")).toHaveCount(0);
});

test("分享文案可勾选「带上顺位」与「带上开票批次」", async ({ page }) => {
  await seed(page, {
    "biff.picks.v2": picks("070", "126"),
    "biff.savedplans.v1": plan("070", "126"),
  });
  await ready(page, "/rush");
  await page.getByRole("button", { name: "导出与分享", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导出与分享" });
  await dialog.getByRole("button", { name: "分享文案", exact: true }).click();
  const text = dialog.getByRole("textbox", { name: "行程分享文案", exact: true });

  // 默认(两个都不勾):CODE 前置 + 三行缩进块,没有主选 / 备选 / 批次字样
  await expect(text).toContainText("070  20:00");
  await expect(text).not.toContainText("主选");
  await expect(text).not.toContainText("备选");
  await expect(text).not.toContainText("批");

  // ⚠ S2 复选的可点区是外层 <label>(input 被视觉层盖住,裸点 checkbox 会被拦指针)——
  //   按 label 文本取,与 review/workflows 里点筛选复选的既有写法一致
  await dialog.locator("label", { hasText: "带上顺位" }).click();
  await dialog.locator("label", { hasText: "带上开票批次" }).click();
  await expect(dialog.getByRole("checkbox", { name: /带上顺位/ })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: /带上开票批次/ })).toBeChecked();

  await expect(text).toContainText("【第 1 批");
  await expect(text).toContainText("【第 2 批");
  // 第 1 顺位印「主选」,同组备选另起一块(前缀 ↳ + CODE)
  await expect(text).toContainText("主选");
  await expect(text).toContainText("↳ 126");
  await expect(text).toContainText("070  20:00–22:25");
});

test("分享图片同样受「带上顺位」「带上开票批次」控制", async ({ page }) => {
  await trackPaintedTexts(page); // 海报是 canvas 手绘:断言只能读画上去的文字
  await seed(page, {
    "biff.picks.v2": picks("070", "126"),
    "biff.savedplans.v1": plan("070", "126"),
  });
  await ready(page, "/rush");
  await page.getByRole("button", { name: "导出与分享", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导出与分享" });
  const generate = dialog.getByRole("button", { name: "生成分享图片", exact: true });
  const canvas = dialog.getByLabel("行程分享图片", { exact: true });

  await generate.click();
  await expect(canvas).toBeVisible();
  const plain = await paintedTexts(page);
  // 默认(两个都不勾):图上没有顺位字、没有备选行、没有批次节头
  expect(plain).not.toContain("主选");
  expect(plain).not.toContain("备选");
  expect(plain).not.toContain("第 1 批");
  const plainHeight = await canvas.evaluate((el) => (el as HTMLCanvasElement).height);

  // ⚠ S2 复选的可点区是外层 <label>(见上一条用例的说明)
  await dialog.locator("label", { hasText: "带上顺位" }).click();
  await dialog.locator("label", { hasText: "带上开票批次" }).click();
  // 改选项会作废已出的图(否则弹层里留着按旧选项画好的图,看着「没生效」)
  await expect(canvas).toHaveCount(0);

  await generate.click();
  await expect(canvas).toBeVisible();
  const ranked = await paintedTexts(page);
  // 126 是组内顺位 1 → 主选;070 顺位 2 → 备选②,其备选行指向 126(措辞与分享文案同源)
  expect(ranked).toContain("主选");
  expect(ranked).toContain("备选②");
  expect(ranked).toContain("↳");
  expect(ranked).toContain("第 1 批");
  expect(ranked).toContain("第 2 批");
  // 备选行 + 批次节头都会让图变长(canvas 按模型算高,不涨就是没画进去)
  expect(await canvas.evaluate((el) => (el as HTMLCanvasElement).height)).toBeGreaterThan(
    plainHeight,
  );
});
