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

test("讨论区:集合成方格墙、行程里的讨论跳过去定位;发帖门闸与社区提醒只留一条", async ({ page }) => {
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
  await page.route("**/api/discussions**", (route) =>
    route.fulfill({ json: { posts, nextCursor: null } }),
  );
  await page.route("**/api/screenings/*/discussion**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { posts, nextCursor: null } });
      return;
    }
    await route.fulfill({ status: 401, json: { error: "UNAUTHENTICATED" } });
  });
  await seed(page, { "biff.picks.v2": picks });

  await ready(page, "/agenda");

  // 导航里新增「讨论区」模块,且排在「我的行程」「建议」之后
  // ⚠ 末尾的「红黑榜」不属于本 PLAN —— 它由并行需求 `PLAN-20260916102339` 加到导航末尾,
  //   本断言是「导航整体顺序」的快照,故一并列出(2026-09-16)。
  const nav = page.getByRole("navigation", { name: "主要导航" });
  const labels = (await nav.locator("a.nav-item").allTextContents()).map((text) => text.trim());
  expect(labels).toEqual([
    "排片表",
    "影片库",
    "我的选片",
    "我的行程",
    "抢票",
    "建议",
    "讨论区",
    "红黑榜",
  ]);

  const entry = page.locator('.screening-card[data-screening="001"] .card-actions button', {
    hasText: "讨论",
  });
  await expect(entry).toHaveText(/讨论 1/);
  await entry.click();

  // 不再就地弹层:跳到讨论区并**定位**到这场(高亮 + 定位条)
  await expect(page).toHaveURL(/\/discussions\?focus=001$/);
  await expect(page.getByRole("heading", { name: "讨论区", exact: true })).toBeVisible();
  const grid = page.locator(".discussion-grid");
  await expect(grid.locator(".discussion-tile")).toHaveCount(1);
  const tile = grid.locator('.discussion-tile[data-discussion-code="001"]');
  await expect(tile).toHaveClass(/located/);
  await expect(tile.locator(".discussion-tile-body")).toContainText("多带了一张 10/8 的票");
  await expect(tile.locator(".discussion-tile-reactions")).toContainText("👍 2");
  await expect(page.locator(".discussion-locate-bar")).toContainText("共 1 帖");

  // 清除定位:高亮消失,URL 回到 /discussions
  await page.getByRole("button", { name: "清除定位", exact: true }).click();
  await expect(page).toHaveURL(/\/discussions$/);
  await expect(grid.locator(".discussion-tile.located")).toHaveCount(0);

  // 从格子上进该场次的讨论弹层(发帖 / 反应 / 删除仍在这里)
  await tile.locator(".discussion-tile-foot button").click();

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

/** 定位条上的「发帖」入口(2026-09-16,PLAN-20260916102631)。
 *
 *  回归的 bug:行程卡上的「讨论」只做跳转,而方格墙的格子是**已存在的帖子** —— 某场一条帖子都
 *  没有时讨论区里没有任何可点的发帖口,用户被空态文案指回行程,点「讨论」又跳回来,成闭环。 */
test("讨论区:定位到没有帖子的场次也能直接发帖,发完立刻出现在墙上", async ({ page }) => {
  const id = "user_00000000000000000000000001";
  const account = {
    user: { id, email: "viewer@example.com", emailVerified: true },
    profile: {
      userId: id,
      displayName: "观众",
      bio: "",
      website: "",
      avatarUrl: null,
      updatedAt: "2026-09-13T00:00:00Z",
      version: 1,
    },
  };
  const posted: Record<string, unknown>[] = [];
  await page.route("**/api/account/me", (route) => route.fulfill({ json: account }));
  await page.route("**/api/account/sync/biff-2026", async (route) => {
    if (route.request().method() === "PUT") await route.fulfill({ json: { revision: 1 } });
    else
      await route.fulfill({
        json: { subject: id, revision: 0, records: {}, updatedAt: 0, importedAt: null },
      });
  });
  // 001 这场**一条帖子都没有** —— 正是原 bug 里走不通的场景
  await mockCounts(page, { attendance: {}, discussions: {} });
  await page.route("**/api/discussions**", (route) =>
    route.fulfill({ json: { posts: [], nextCursor: null } }),
  );
  await page.route("**/api/screenings/*/discussion**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ json: { posts: [], nextCursor: null } });
      return;
    }
    const body = request.postDataJSON() as { category: string; body: string };
    const post = {
      id: `post_${posted.length + 1}`,
      code: "001",
      subject: id,
      displayName: "观众",
      category: body.category,
      body: body.body,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      reactionCounts: {},
      myReactions: [],
    };
    posted.unshift(post);
    await route.fulfill({ status: 201, json: post });
  });

  await ready(page, "/discussions?focus=001");

  // 定位条给出发帖口,且文案承认这场还没有帖子
  const bar = page.locator(".discussion-locate-bar");
  await expect(bar).toContainText("这场还没有帖子");
  await expect(page.locator(".discussion-tile")).toHaveCount(0);
  await bar.getByRole("button", { name: /发帖/ }).click();

  const dialog = page.getByRole("dialog", { name: "001 场次讨论", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.locator("textarea").fill("多带了一张 10/8 的票，原价转。");
  await dialog.getByRole("button", { name: "发布", exact: true }).click();
  await expect(dialog.locator(".discussion-card")).toContainText("多带了一张 10/8 的票");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();

  // 关掉弹层后,方格墙首位立刻有这条新帖(否则用户会以为没发出去)
  const grid = page.locator(".discussion-grid");
  await expect(grid.locator(".discussion-tile")).toHaveCount(1);
  await expect(grid.locator('.discussion-tile[data-discussion-code="001"]')).toContainText(
    "多带了一张 10/8 的票",
  );
  await expect(page.locator(".discussion-locate-bar")).toContainText("共 1 帖");
});

/** 页头常驻的「发帖」入口(2026-09-16,PLAN-20260916154255)。
 *
 *  还原的缺口:无 `focus` 的 `/discussions` 上原本**没有**任何发帖口 —— 格子要求那一场已有帖子,
 *  定位条要求 URL 带 `focus`;用户手上只知道场次编号时,只能先绕去行程页点卡片。 */
test("讨论区:不进任何场次弹层,按场次编号挑一场直接发帖", async ({ page }) => {
  const id = "user_00000000000000000000000001";
  const account = {
    user: { id, email: "viewer@example.com", emailVerified: true },
    profile: {
      userId: id,
      displayName: "观众",
      bio: "",
      website: "",
      avatarUrl: null,
      updatedAt: "2026-09-13T00:00:00Z",
      version: 1,
    },
  };
  // 目标场次从真实排期里挑(与转票补入同一手法),避免把断言绑死在某个编号上
  const target = catalog.schedule.screenings.find((s) => s.code !== "001")!;
  await page.route("**/api/account/me", (route) => route.fulfill({ json: account }));
  await page.route("**/api/account/sync/biff-2026", async (route) => {
    if (route.request().method() === "PUT") await route.fulfill({ json: { revision: 1 } });
    else
      await route.fulfill({
        json: { subject: id, revision: 0, records: {}, updatedAt: 0, importedAt: null },
      });
  });
  await mockCounts(page, { attendance: {}, discussions: {} });
  await page.route("**/api/discussions**", (route) =>
    route.fulfill({ json: { posts: [], nextCursor: null } }),
  );
  await page.route("**/api/screenings/*/discussion**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ json: { posts: [], nextCursor: null } });
      return;
    }
    const body = request.postDataJSON() as { category: string; body: string };
    await route.fulfill({
      status: 201,
      json: {
        id: "post_1",
        code: target.code,
        subject: id,
        displayName: "观众",
        category: body.category,
        body: body.body,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        reactionCounts: {},
        myReactions: [],
      },
    });
  });

  // 没有 focus:定位条不在场,发帖口仍然要在
  await ready(page, "/discussions");
  await expect(page.locator(".discussion-locate-bar")).toHaveCount(0);

  await page.getByRole("button", { name: "发帖：按场次编号或片名选一场", exact: true }).click();
  const picker = page.locator(".discussion-picker");
  await expect(picker).toBeVisible();
  const search = picker.getByLabel("场次编号或片名", { exact: true });

  // 没命中时给出可照做的提示(与「添加转票场次」同一文案口径)
  await search.fill("zzz-no-such-screening");
  await expect(picker).toContainText("没找到这一场");

  await search.fill(target.code);
  const row = picker.locator(`.discussion-picker-row[data-compose-code="${target.code}"]`);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /发帖/ }).click();

  // 选择区收起,打开的是既有的场次讨论弹层(分类 / 登录门闸 / 社区提醒全在)
  await expect(picker).toHaveCount(0);
  const dialog = page.getByRole("dialog", { name: `${target.code} 场次讨论`, exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".discussion-notice")).toBeVisible();
  await expect(dialog.locator(".discussion-category")).toHaveCount(4);

  await dialog.locator("textarea").fill("散场后想找人聊两句。");
  await dialog.getByRole("button", { name: "发布", exact: true }).click();
  await expect(dialog.locator(".discussion-card")).toContainText("散场后想找人聊两句");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();

  // 关掉弹层后新帖已在方格墙首位
  const grid = page.locator(".discussion-grid");
  await expect(grid.locator(".discussion-tile")).toHaveCount(1);
  await expect(
    grid.locator(`.discussion-tile[data-discussion-code="${target.code}"]`),
  ).toContainText("散场后想找人聊两句");
});
