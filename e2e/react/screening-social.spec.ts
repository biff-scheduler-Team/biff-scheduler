import { test, expect, type Page } from "@playwright/test";
import { catalog, keyOf, ready, seed, storage } from "./helpers";

// 同场观影 & 场次讨论(2026-09-14,PLAN-20260914164050)。
// API 一律用 page.route 打桩(feedback.spec.ts 同一手法),不打真实后端。
// ⚠ 举报 / 管理员后台的用例已于 2026-09-14 随功能整体移除(见该 PLAN 修订 2)。

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

async function mockCounts(
  page: Page,
  counts: { attendance: Record<string, number>; discussions: Record<string, number> },
) {
  await page.route("**/api/stats/screening-counts**", (route) =>
    route.fulfill({ json: { edition: "biff-2026", ...counts } }),
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
  await mockCounts(page, {
    attendance: { "001": 3 },
    discussions: { "001": 2 },
  });
  await seed(page, { "biff.picks.v2": picks });

  await ready(page, "/agenda");
  await expect(page.locator(".screening-card")).toHaveCount(4);
  // 008/033/037 时间重叠 → 行程里出现冲突组顺位卡
  await expect(page.locator(".rank-group")).toHaveCount(1);

  // 「同场 N 人」只在该场有计数时出现(008 是 0 → 整块不渲染)
  const card001 = page.locator('.screening-card[data-screening="001"]');
  await expect(card001.locator(".same-count")).toHaveText(/同场\s*3\s*人/);
  await expect(page.locator('.screening-card[data-screening="008"] .same-count')).toHaveCount(0);

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

test("场次讨论:未登录可读、发帖被门闸挡住、社区提醒只留一条且只出现一次", async ({ page }) => {
  await guest(page);
  await mockCounts(page, { attendance: { "001": 1 }, discussions: { "001": 1 } });

  const posts = [
    {
      id: "post_1",
      code: "001",
      subject: "user_00000000000000000000000002",
      displayName: "先到",
      category: "gift",
      body: "多带了一张 10/8 的票，原价转。",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      reactionCounts: { "👍": 2 },
      myReactions: [],
    },
  ];
  await page.route("**/api/screenings/*/discussion**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { posts, nextCursor: null } });
      return;
    }
    await route.fulfill({ status: 401, json: { error: "UNAUTHENTICATED" } });
  });
  await seed(page, { "biff.picks.v2": picks });

  await ready(page, "/agenda");
  const entry = page.locator('.screening-card[data-screening="001"] .card-actions button', {
    hasText: "讨论",
  });
  await expect(entry).toHaveText(/讨论 1/);
  await entry.click();

  const dialog = page.getByRole("dialog", { name: "001 场次讨论", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".discussion-card")).toHaveCount(1);
  await expect(dialog.locator(".discussion-card")).toContainText("多带了一张 10/8 的票");
  await expect(dialog.locator(".discussion-card .discussion-tag")).toHaveText("无料交换");
  await expect(dialog.locator('.discussion-card .feedback-chip[data-emoji="👍"]')).toContainText("2");
  // 「点踩」是唯一负反馈手段(举报/后台已移除):chip 必须在,计数为 0 时不显示数字
  const downvote = dialog.locator('.discussion-card .feedback-chip[data-emoji="👎"]');
  await expect(downvote).toBeVisible();
  await expect(downvote.locator(".feedback-chip-count")).toHaveCount(0);

  // 首次打开:社区提醒(含范围与免责)在;点「知道了」后写本地标记
  await expect(dialog.locator(".discussion-notice")).toBeVisible();
  await expect(dialog.locator(".discussion-notice-list")).toContainText("聊电影");
  await expect(dialog.locator(".discussion-notice-list")).toContainText("信息发布平台");
  await expect(dialog.locator(".discussion-notice-list")).toContainText("👎");
  // 语气 = 建议而非规定(2026-09-14 修订 3):个人信息只劝阻,不写成「请不要发布」
  await expect(dialog.locator(".discussion-notice-list")).not.toContainText("请不要发布");
  // 回归(2026-09-14 修订 3):弹层里**只留这一条可关闭的提醒** —— 原先那条常驻的「发布前请阅读」已删除
  await expect(dialog.locator(".discussion-privacy")).toHaveCount(0);
  await dialog.getByRole("button", { name: "知道了", exact: true }).click();
  await expect(dialog.locator(".discussion-notice")).toHaveCount(0);
  await expect(dialog.locator(".discussion-privacy")).toHaveCount(0);
  expect((await storage(page))["biff.discussionprivacy.v1"]).toBe("1");

  // 未登录:发布被挡到登录面板
  await dialog.getByRole("button", { name: "登录后发布", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "IFFDAY 账号", exact: true })).toBeVisible();
});
