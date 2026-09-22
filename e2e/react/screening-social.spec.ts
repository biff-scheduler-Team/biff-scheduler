import { test, expect, type Page } from "@playwright/test";
import { agendaCards, catalog, keyOf, ready, seed, storage } from "./helpers";

// 同场观影 & 场次讨论(2026-09-14,PLAN-20260914164050)。
// API 一律用 page.route 打桩(feedback.spec.ts 同一手法),不打真实后端。
// ⚠ 举报 / 管理员后台的用例已于 2026-09-14 随功能整体移除(见该 PLAN 修订 2)。
// ⚠ 讨论区(方格墙 / 定位条 / 页头常驻发帖口)的三个用例已于 2026-09-22 随功能下线删除
//   (`PLAN-20260922101227`,用户「去掉讨论区入口 相关组件也去掉」)——
//   本 spec 现在只覆盖「同场人数 / 票务三态 / 仅看实际行程 / 转票补入」这条链路。

/** 行程:001 单独一场 + 008/033/037 构成一个冲突组(与 helpers 的 ranks 种子一致)。 */
const picks = JSON.stringify([
  { key: keyOf("001"), picks: [{ code: "001" }], note: "" },
  ...["008", "033", "037"].map((code) => ({
    key: keyOf(code),
    picks: [{ code }],
    note: "",
  })),
]);

/** 从真实排期里挑一场没被种进行程的场次,当作「转票补入」的目标。 */
const transferTarget = catalog.schedule.screenings.find(
  (s) => !["001", "008", "033", "037"].includes(s.code),
)!;

/** 只打桩 `attendance` —— 接口仍会回 `discussions`,但前端自 2026-09-22 起不再消费它。 */
async function mockCounts(page: Page, attendance: Record<string, number>) {
  await page.route("**/api/stats/screening-counts**", (route) =>
    route.fulfill({ json: { edition: "biff-2026", attendance } }),
  );
  // 上报是「纯副作用」,打桩成 200 免得回落到预览服务器
  await page.route("**/api/stats/screening-attendance-ping**", (route) =>
    route.fulfill({ json: { ok: true, weight: 0.75, count: 0 } }),
  );
}

async function guest(page: Page) {
  await page.route("**/api/account/me", (route) =>
    route.fulfill({ status: 401, json: { error: "UNAUTHENTICATED" } }),
  );
}

test("票务三态 / 同场人数 / 仅看实际行程 / 转票补入", async ({ page }) => {
  await guest(page);
  await mockCounts(page, { "001": 3 });
  await seed(page, { "biff.picks.v2": picks });

  await ready(page, "/agenda");
  // 场次卡只在「卡片」视图(2026-09-21 起「我的行程」默认是日程表,见 PLAN-20260921223658)
  await agendaCards(page);
  await expect(page.locator(".screening-card")).toHaveCount(4);
  // 008/033/037 时间重叠 → 行程里出现冲突组顺位卡
  await expect(page.locator(".rank-group")).toHaveCount(1);

  // 「同场 N 人」只在该场有计数时出现(008 是 0 → 整块不渲染)
  const card001 = page.locator('.screening-card[data-screening="001"]');
  await expect(card001.locator(".same-count")).toHaveText(/同场\s*3\s*人/);
  await expect(page.locator('.screening-card[data-screening="008"] .same-count')).toHaveCount(0);

  // 行程场次卡上不再有任何讨论入口(2026-09-21 摘入口 / 2026-09-22 功能整体下线)
  await expect(
    page.locator('.screening-card[data-screening="001"] .card-actions button', {
      hasText: "讨论",
    }),
  ).toHaveCount(0);

  // 标记「已抢到」→ 落进 biff.tickets.v1
  await card001.locator('.ticket-chip[data-ticket-state="got"]').click();
  await expect(card001.locator('.ticket-chip[data-ticket-state="got"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect((await storage(page))["biff.tickets.v1"]).toContain('"001":{"state":"got"}');

  // 「仅看实际行程」:只剩已抢到的那一场,且不再摆顺位卡
  await page.locator('button:has-text("仅看实际行程")').click();
  await expect(page.locator(".screening-card")).toHaveCount(1);
  await expect(page.locator('.screening-card[data-screening="001"]')).toBeVisible();
  await expect(page.locator(".rank-group")).toHaveCount(0);
  // 「顺位撞车」提示(`.rank-clashes`)已于 2026-09-22 整块下线(`PLAN-20260922123138`)——
  // 这条**留着当反向守卫**:撞车提示不该再回到这一页。
  await expect(page.locator(".rank-clashes")).toHaveCount(0);

  // 退出筛选,走「添加转票场次」
  await page.locator('button:has-text("仅看实际行程")').click();
  await page.getByRole("button", { name: "添加转票场次", exact: true }).click();
  await page.getByLabel("场次编号或片名", { exact: true }).fill(transferTarget.code);
  const row = page.locator(`.transfer-row[data-transfer-code="${transferTarget.code}"]`);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /加入并标记转票|标记为转票/ }).click();

  const stored = JSON.parse((await storage(page))["biff.tickets.v1"]) as Record<
    string,
    { state: string; via?: string }
  >;
  expect(stored[transferTarget.code]).toEqual({ state: "got", via: "transfer" });

  // 卡片上出现只读的「转票」徽章
  await page.locator('button:has-text("完成")').click();
  const targetCard = page.locator(`.screening-card[data-screening="${transferTarget.code}"]`);
  await expect(targetCard.locator(".ticket-transfer")).toHaveText("转票");
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
