// 「抢票分析」页端到端验收（2026-09-20,PLAN-20260920161837）。
// 断言全部走 DOM 计数 / 属性 / 文本，不看截图。
//
// ⚠ E2E 的 webServer 只起 `vite preview`（**没有 API**），所以四份聚合计数一律是空表 ——
//   本 spec 覆盖的是「全空数据下页面仍然成立」这条路径（也正是最容易出 NaN / 除零的那条）。
//   非零需求 / 抢到率的计算由 `apps/web/tests/rush-analysis.test.ts` 的单测覆盖。
//
// 覆盖点：① 导航顺序；② 难度榜行数 = 真实场次数；③ 已收录容量的厅印真实数字、
//        未收录的厅印「未收录」而**不是**数字；④ 搜索能定位到具体场次；
//        ⑤ 结果面无样本时给「还没有人标记」而不是编一个 0%；⑥ 全页不出现 NaN / Infinity。

import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { ready } from "./helpers";
import type { ScheduleFile, VenuesFile } from "../../apps/web/src/types";

const schedule = JSON.parse(
  readFileSync("apps/web/public/schedule.json", "utf8"),
) as ScheduleFile;
const venues = (
  JSON.parse(readFileSync("apps/web/public/venues.json", "utf8")) as VenuesFile
).venues;

/** 找一个真实归属于某厅的场次编号（不硬编码具体 code，换版后仍然成立） */
const codeAt = (venueId: string) =>
  schedule.screenings.find((s) => s.venue_id === venueId)!.code;

const boardRow = (page: Page, code: string) =>
  page.locator(`.ra-row[data-code="${code}"]`);

test("导航里「抢票分析」紧接「抢票」之后", async ({ page }) => {
  await ready(page, "/rush-analysis");
  const labels = (
    await page.getByRole("navigation", { name: "主要导航" }).getByRole("link").allTextContents()
  ).map((text) => text.trim());
  expect(labels.indexOf("抢票分析")).toBe(labels.indexOf("抢票") + 1);
  await expect(page.getByRole("heading", { name: "抢票分析", exact: true })).toBeVisible();
});

test("难度榜列出全部场次，行数 = 排期场次数", async ({ page }) => {
  await ready(page, "/rush-analysis");
  const total = schedule.screenings.length;
  await expect(page.locator(".ra-row[data-code]")).toHaveCount(total);
  await expect(page.locator(".count[data-board-total]")).toHaveAttribute(
    "data-board-total",
    String(total),
  );
});

test("已收录座位数的厅印真实数字，未收录的厅印「未收录」而不是数字", async ({ page }) => {
  await ready(page, "/rush-analysis");

  // b1（电影殿堂中剧场）= 413 席，来自 tools/build_venue_capacity.py 的人工查证表
  const known = boardRow(page, codeAt("b1"));
  await expect(known).toHaveAttribute("data-capacity", "413");
  await expect(known).toContainText("容量 413");
  await expect(known).toHaveAttribute("data-level", /extreme|high|medium|low/);

  // 未收录容量的厅（多数 CGV / LOTTE 厅都还没查到）必须降级，且逐字出现「未收录」
  const unknown = boardRow(page, codeAt("c1"));
  await expect(unknown).toHaveAttribute("data-capacity", "");
  await expect(unknown).toContainText("未收录");
  await expect(unknown).toHaveAttribute("data-level", "unknown");

  // 露天场（bt）容量收录了，且口径说明写明座位可变 —— 不与固定小厅直接横比倍率
  const outdoor = codeAt("bt");
  await expect(boardRow(page, outdoor)).toHaveAttribute("data-capacity", "4000");
  expect(venues.find((v) => v.id === "bt")?.capacityNote).toContain("露天");
});

test("搜索场次编号只留下匹配的那一行", async ({ page }) => {
  const code = "070";
  await ready(page, `/rush-analysis?q=${code}`);
  await expect(page.locator(".ra-row[data-code]")).toHaveCount(1);
  await expect(page.locator(".ra-row[data-code]").first()).toHaveAttribute("data-code", code);
  await expect(page.locator(".ra-list[data-shown]")).toHaveAttribute("data-shown", "1");
});

test("空数据下逐块降级：结果面给「还没有人标记」而不是 0%，需求面给空态", async ({ page }) => {
  await ready(page, "/rush-analysis");

  // 结果面：接口 404 → 没有样本 → 不给率值（`data-samples` 整块不出现）
  await expect(page.locator("[data-samples]")).toHaveCount(0);
  await expect(page.getByText("还没有人标记抢票结果")).toBeVisible();

  // 需求面：没有人把场次排进行程 → 集中度 / 时间分布都给空态文案
  await expect(page.getByText("还没有任何场次被排进行程")).toHaveCount(2);

  // 难度榜仍然照常渲染（需求为 0 也是事实，不是缺数据）
  await expect(page.locator(".ra-row[data-demand]").first()).toHaveAttribute("data-demand", "0");
});

test("全页不出现 NaN / Infinity / undefined", async ({ page }) => {
  await ready(page, "/rush-analysis");
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toContain("NaN");
  expect(text).not.toContain("Infinity");
  expect(text).not.toContain("undefined");
  expect(text).not.toContain("—%");
});
