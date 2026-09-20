// 「数据分析」页端到端验收（2026-09-20 精简版：只剩两组 + ECharts；同日由「抢票分析」更名，PLAN-20260920193032）。
// 断言全部走 DOM 计数 / 属性 / 文本，不看截图。
//
// ⚠ E2E 的 webServer 只起 `vite preview`（**没有 API**），所以三份聚合计数一律是空表 ——
//   本 spec 覆盖「全空数据下页面仍然成立」这条路径（也正是最容易出 NaN / 除零的那条）。
//   非零数据的计算由 `apps/web/tests/rush-*.test.ts` 的单测覆盖。
//
// 覆盖点：① 导航顺序；② 两组都在且是**只有两组**（用户明确「只留下」这两组）；
//        ③ 群体面板的三个筛选真的会收窄清单；④ 画像空行程整组不渲染、有行程按场次数出现；
//        ⑤ 影片分析数的是片目数；⑥ 全页不出现 NaN / Infinity。

import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { buildFilms } from "../../apps/web/src/app/model";
import { catalog, keyOf, ready, seed } from "./helpers";
import type { ScheduleFile } from "../../apps/web/src/types";

const schedule = JSON.parse(
  readFileSync("apps/web/public/schedule.json", "utf8"),
) as ScheduleFile;

/** 喂一份确定的数据（本 spec 的 webServer 没有 API，不拦就全是空表）。 */
async function seedCounts(page: Page) {
  const codes = schedule.screenings.slice(0, 12).map((s) => s.code);
  await page.route("**/api/stats/want-counts*", (route) =>
    route.fulfill({
      json: {
        counts: Object.fromEntries(codes.slice(0, 6).map((code, index) => [keyOf(code), 30 - index * 4])),
      },
    }),
  );
  await page.route("**/api/stats/film-votes*", (route) =>
    route.fulfill({
      json: {
        votes: Object.fromEntries(
          codes.slice(0, 4).map((code, index) => [keyOf(code), { red: 8 - index, black: index + 1 }]),
        ),
      },
    }),
  );
  await page.route("**/api/stats/screening-counts*", (route) =>
    route.fulfill({
      json: {
        attendance: Object.fromEntries(codes.map((code, index) => [code, 40 - index * 3])),
        discussions: { [codes[0]]: 7, [codes[1]]: 2 },
      },
    }),
  );
  return codes;
}

test("导航里「数据分析」紧接「抢票」之后，且与页面标题同名", async ({ page }) => {
  await ready(page, "/rush-analysis");
  const labels = (
    await page.getByRole("navigation", { name: "主要导航" }).getByRole("link").allTextContents()
  ).map((text) => text.trim());
  expect(labels.indexOf("数据分析")).toBe(labels.indexOf("抢票") + 1);
  await expect(page.getByRole("heading", { name: "数据分析", exact: true })).toBeVisible();
  // ⚠ 导航名与页面标题是**两处各写一遍**的字面量（App.tsx / RushAnalysisPage.tsx）。
  //   这里断言它们逐字相同 —— 以后只改一处（2026-09-20 就是「抢票分析 → 数据分析」这种改名）
  //   会在这里立刻红，而不是等到用户看见导航和标题不一致。
  expect(await page.locator(".ra-page h1").first().textContent()).toBe("数据分析");
});

test("这一页只有两组：群体行为与口碑、我的观影画像 + 影片分析", async ({ page }) => {
  await ready(page, "/rush-analysis");
  const sections = await page
    .locator(".ra-block")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
  // ⚠ 用户 2026-09-20 明确「只留下」这两组 —— 这条断言就是那个决定的守门人。
  //   「我的观影画像」是第二组的主体，但它**空行程时不渲染**，故这里用「子集 + 必含」，
  //   而不是写死数组（否则断言会依赖「恰好没有行程」这个前提）。
  const allowed = ["群体行为与口碑", "我的观影画像", "影片分析"];
  expect(sections.filter((label) => !allowed.includes(label ?? ""))).toEqual([]);
  expect(sections).toContain("群体行为与口碑");
  expect(sections).toContain("影片分析");
});

test("群体面板：两个搜索框都会收窄清单", async ({ page }) => {
  const codes = await seedCounts(page);
  await ready(page, "/rush-analysis");

  const section = page.locator('section[aria-label="群体行为与口碑"]');
  const rows = section.locator("tbody tr");
  // ⚠ 三份计数是**异步**拉的：直接读属性会在全量并发下拿到空态（total=0，本轮实测踩到）。
  //   先用带重试的断言等它到位，再读数字。
  await expect(section).toHaveAttribute("data-crowd-films", /^[1-9]/);
  const total = Number(await section.getAttribute("data-crowd-films"));
  expect(total).toBeGreaterThan(1);
  // 明细表只列 **TOP 10**（用户 2026-09-20 明确要求），故行数是 min(10, 符合筛选的影片数)
  const LIST_ROWS = 10;
  await expect(rows).toHaveCount(Math.min(LIST_ROWS, total));

  // ① 电影搜索框：输入清单第一行的片名 → 收窄到那部片（2026-09-20 起「电影 / 场次」是搜索框，
  //   不再是下拉；片名按子串匹配，故这里断言「收窄 + 第一行仍是它」而不写死行数）
  const title = ((await rows.first().locator("td").first().textContent()) ?? "").trim();
  expect(title.length).toBeGreaterThan(0);
  await section.locator("input[data-filter='film']").fill(title);
  await expect(rows.first()).toContainText(title);
  expect(Number(await section.getAttribute("data-crowd-films"))).toBeLessThan(total);

  // ② 搜不到 → 整组清空（并给空态提示）
  await section.locator("input[data-filter='film']").fill("绝对不存在的片名");
  await expect(rows).toHaveCount(0);

  // 清掉筛选后回来（表仍只列 TOP 10）
  await section.locator("input[data-filter='film']").fill("");
  await expect(rows).toHaveCount(Math.min(LIST_ROWS, total));

  // ③ 场次搜索框：输入场次号 → 清单收窄到含该场次的影片，并出现「本场同场 N 人」一行
  //   （这一行只在**唯一命中一场**时出现 —— 也就是「选中语义由搜索框承担」的那条规则）
  await section.locator("input[data-filter='screening']").fill(codes[0]);
  await expect(section).toContainText("本场同场");
  expect(Number(await section.getAttribute("data-crowd-films"))).toBeLessThan(total);
});

test("影片明细可切到「按场次看」：出现影厅列，且首行就是人最多的那一场", async ({ page }) => {
  await seedCounts(page);
  await ready(page, "/rush-analysis");
  const section = page.locator('section[aria-label="群体行为与口碑"]');
  // 计数是异步拉的，先等它到位
  await expect(section).toHaveAttribute("data-crowd-films", /^[1-9]/);
  const table = section.locator("table.ra-table");
  // 默认是影片视角：没有「影厅」这一列（页面与改动前一致）
  await expect(table).toHaveAttribute("data-crowd-mode", "film");
  await expect(table.locator("thead")).not.toContainText("影厅");

  await section.locator("input[data-toggle='by-show']").check();
  await expect(table).toHaveAttribute("data-crowd-mode", "show");
  await expect(table.locator("thead")).toContainText("影厅");

  // 勾上后按**单场人数降序** —— 第一行就是「人最多的那一场」
  const nums = (await table.locator("tbody tr td:last-child").allTextContents()).map(Number);
  expect(nums.length).toBeGreaterThan(0);
  expect(nums.length).toBeLessThanOrEqual(10);
  expect(nums).toEqual([...nums].sort((a, b) => b - a));
  // 每行都能说出「哪一场、什么时候、在哪个厅、多少人」
  await expect(table.locator("tbody tr").first().locator("td")).toHaveCount(5);
});

test("群体面板：喂入计数后两张图都画得出来", async ({ page }) => {
  await seedCounts(page);
  await ready(page, "/rush-analysis");
  await expect(page.locator('[data-chart="crowd-want"]')).toHaveAttribute("data-points", /^[1-9]/);
  await expect(page.locator('[data-chart="crowd-votes"]')).toHaveAttribute("data-points", /^[1-9]/);
  // ECharts 真的画了东西（SVG 渲染器 → 容器里必须有 path）
  expect(await page.locator('[data-chart="crowd-want"] svg path').count()).toBeGreaterThan(0);
});

test("我的观影画像：没有行程时整组不渲染，有行程时按我的场次数出现", async ({ page }) => {
  await ready(page, "/rush-analysis");
  await expect(page.locator("[data-my-shows]")).toHaveCount(0);

  await seed(page, {
    "biff.picks.v2": JSON.stringify(
      ["001", "008", "022"].map((code) => ({ key: keyOf(code), picks: [{ code }], note: "" })),
    ),
  });
  await ready(page, "/rush-analysis");
  await expect(page.locator("[data-my-shows]")).toHaveAttribute("data-my-shows", "3");
  await expect(page.locator('[data-chart="portrait-country"]')).toBeVisible();
  await expect(page.locator('[data-chart="portrait-unit"]')).toBeVisible();
  // 票面总额写明不含折扣（否则会被当成实付预算）
  await expect(page.getByText(/不含折扣/).first()).toBeVisible();
});

test("影片分析：数的是本届片目，五张图都在", async ({ page }) => {
  await ready(page, "/rush-analysis");
  // ⚠ 基准必须与页面**同源**：页面用的是 `buildFilms(cat, mappings)`（除了排期里的片，
  //   还会补上「只在合集块里出现」与「目录里有但本届没排期」的条目），
  //   它比「排期里去重的 filmNodeKey 数」多——实测 299 vs 327，拿后者当基准是错的。
  const expectedFilms = buildFilms(catalog, new Map()).length;
  await expect(page.locator("[data-facet-films]")).toHaveAttribute(
    "data-facet-films",
    String(expectedFilms),
  );
  for (const chart of ["facet-country", "facet-unit", "facet-rating", "facet-year", "facet-duration"]) {
    const figure = page.locator(`[data-chart="${chart}"]`);
    await expect(figure).toBeVisible();
    expect(Number(await figure.getAttribute("data-points"))).toBeGreaterThan(0);
  }
  // 「类型暂缺」必须写出来（产物里没有 genre 这一列）——
  // 2026-09-20 起它收在图的右上角 ⓘ 里（PLAN-20260920193412），故先点开再断言
  const unitNote = page.locator('[data-chart-note="facet-unit"]');
  await expect(unitNote.locator(".ra-note-body")).toBeHidden();
  await unitNote.locator(".ra-note-btn").click();
  await expect(unitNote.locator(".ra-note-body")).toContainText("类型");
});

test("图的说明默认收在右上角的 ⓘ 里，点开才显示", async ({ page }) => {
  await ready(page, "/rush-analysis");
  const figure = page.locator('[data-chart="facet-rating"]');
  const note = figure.locator(".ra-note-body");
  // 默认不占版面 —— 这正是用户 2026-09-20 提的那件事
  await expect(note).toBeHidden();
  await figure.locator(".ra-note-btn").click();
  await expect(note).toBeVisible();
  // 用户举例的那一句话必须还在，只是换了位置
  await expect(note).toContainText("不是 0 分");
});

test("全页不出现 NaN / Infinity / undefined", async ({ page }) => {
  await seedCounts(page);
  await ready(page, "/rush-analysis");
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toContain("NaN");
  expect(text).not.toContain("Infinity");
  expect(text).not.toContain("undefined");
});
