import { test, expect, type Page } from "@playwright/test";
import { catalog, keyOf, ready, seed, storage } from "./helpers";

// 「添加转票场次」这一条链路的 E2E(2026-09-14 起,`PLAN-20260914164050`;2026-09-30 改版,`PLAN-20260930213528`)。
//
// ⚠ 本文件原先覆盖「同场人数 / 票务三态 / 仅看实际行程 / 转票补入」四件事,前三件**随卡片视图
//    一起下线**(它们的控件只长在行程的场次卡上)。现在只剩下**转票补入**,而且形态变了:
//    「编号为主、搜索兜底、支持一次加多枚」,且**不再写任何票务状态**。
// ⚠ 举报 / 管理员后台 / 讨论区的用例分别于 2026-09-14 与 2026-09-22 随各自功能下线。

/** 行程:001 单独一场;其余场次留给「转票补入」当目标。 */
const picks = JSON.stringify([{ key: keyOf("001"), picks: [{ code: "001" }], note: "" }]);

const targets = catalog.schedule.screenings.filter((s) => s.code !== "001");
const first = targets[0];
const second = targets[1];

/** 读回行程里的全部场次 code */
async function plannedCodes(page: import("@playwright/test").Page): Promise<string[]> {
  const rows = JSON.parse((await storage(page))["biff.picks.v2"]) as {
    picks: { code: string }[];
  }[];
  return rows.flatMap((entry) => entry.picks.map((pick) => pick.code));
}

test("转票补入:输入场次编号 → 一步记入行程,且不再写任何票务状态", async ({ page }) => {
  await seed(page, { "biff.picks.v2": picks });
  await ready(page, "/agenda");
  await page.getByRole("button", { name: "添加转票场次", exact: true }).click();
  await page.getByLabel("场次编号或片名", { exact: true }).fill(first.code);

  // 纯编号且命中 → 顶部直接给按钮(候选列表刻意不铺:同一场不该出现两个入口)
  const batch = page.locator(".transfer-batch");
  await expect(batch).toContainText(first.code);
  await expect(page.locator(".transfer-row")).toHaveCount(0);
  await batch.getByRole("button", { name: "排进行程", exact: true }).click();
  await page.getByRole("button", { name: "完成", exact: true }).click();

  expect((await plannedCodes(page)).sort()).toEqual([first.code, "001"].sort());
  // ⚠ 回归:票务三态(`biff.tickets.v1`)已整体下线 —— 这个入口不许再写它
  //   (改版前它写的是 `{state:"got", via:"transfer"}`)。
  expect((await storage(page))["biff.tickets.v1"]).toBeUndefined();
});

test("转票补入:多枚编号(逗号 / 空格分隔)一次全部加入", async ({ page }) => {
  await seed(page, { "biff.picks.v2": picks });
  await ready(page, "/agenda");
  await page.getByRole("button", { name: "添加转票场次", exact: true }).click();
  await page
    .getByLabel("场次编号或片名", { exact: true })
    .fill(`${first.code}, ${second.code}`);

  await page.getByRole("button", { name: "排进这 2 场", exact: true }).click();
  const codes = await plannedCodes(page);
  expect(codes).toContain(first.code);
  expect(codes).toContain(second.code);
});

test("转票补入:编号没命中时给提示,片名仍走候选列表", async ({ page }) => {
  await seed(page, { "biff.picks.v2": picks });
  await ready(page, "/agenda");
  await page.getByRole("button", { name: "添加转票场次", exact: true }).click();
  const field = page.getByLabel("场次编号或片名", { exact: true });

  // ① 不存在的编号 → 明确提示,且不铺候选列表
  await field.fill("9999");
  await expect(page.locator(".transfer-dialog")).toContainText("没找到编号 9999");
  await expect(page.locator(".transfer-row")).toHaveCount(0);

  // ② 片名 → 模糊检索兜底:命中那一场可逐行排进行程
  await field.fill(first.title_en);
  const row = page.locator(`.transfer-row[data-transfer-code="${first.code}"]`).first();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "排进行程" }).click();
  expect(await plannedCodes(page)).toContain(first.code);
});

/** 只打桩 `screening-counts`(同场人数的整站一次拉取);接口没部署时前端静默降级为空表。 */
async function mockCounts(page: Page, attendance: Record<string, number>) {
  await page.route("**/api/stats/screening-counts**", (route) =>
    route.fulfill({ json: { edition: "biff-2026", attendance } }),
  );
}

// 「同场 N 人」原先长在行程的**场次卡**上,卡片视图下线后一度没有展示面;
// 用户 2026-09-30 明确要求「日程表还是可以加上同场 N 人」→ 搬进日程表格子(`.gantt-slot`)。
// ⚠ 这一条钉的是「宿主换了、口径没换」:同一个 `screening-counts` 缓存,0 计数整块不渲染。
test("同场 N 人:日程表格子上只在有计数的场次出现,0 计数整块不渲染", async ({ page }) => {
  await mockCounts(page, { "008": 3 });
  await seed(page, {
    // 008 与 033 同在 2026-10-07 —— 日程表是**单日**视图,不在同一天的场次不会同屏
    "biff.picks.v2": JSON.stringify(
      ["008", "033"].map((code) => ({ key: keyOf(code), picks: [{ code }], note: "" })),
    ),
  });
  await ready(page, "/agenda");
  const agenda = page.getByRole("region", { name: "我的行程", exact: true });
  // ⚠ 选择器收在 `[data-grid-slot]` 上而不是 `[data-grid-code]`:后者是格子内那枚 `.gantt-film`
  //   按钮上的属性,而「同场 N 人」与它**平级**(挂在格子容器上,见 `ScheduleGantt.tsx`)。
  await expect(agenda.locator('[data-grid-slot="008"] .same-count')).toHaveText(/同场\s*3\s*人/);
  await expect(agenda.locator('[data-grid-slot="008"] .same-count')).toHaveAttribute(
    "data-same-count",
    "3",
  );
  // 033 计数是 0 → 整块不渲染(不留空位)
  await expect(agenda.locator('[data-grid-slot="033"] .same-count')).toHaveCount(0);
});

/** 讨论区整体下线的守门人(2026-09-22,`PLAN-20260922101227`)。
 *
 *  ⚠ 这条**不是**在测「兜底页怎么渲染」,而是把「讨论区不再可达」这个决定钉住 ——
 *    日后有人「顺手把页面 / 导航项加回来」时,这里会先红。 */
test("讨论区已下线:导航里没有入口,直接访问 /discussions 落到兜底页", async ({ page }) => {
  await ready(page, "/schedule");
  const nav = page.getByRole("navigation", { name: "主要导航" });
  await expect(nav.getByRole("link", { name: "讨论区", exact: true })).toHaveCount(0);

  await ready(page, "/discussions");
  await expect(page.getByRole("heading", { name: "找不到这个页面" })).toBeVisible();
});
