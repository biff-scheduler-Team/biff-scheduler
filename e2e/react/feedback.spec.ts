import { test, expect } from "@playwright/test";
import { ready } from "./helpers";

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

/** 匿名帖的署名（2026-10-05 起免登录写，服务端固定这一串 —— 见 `feedback.ts`）。 */
const ANON_DISPLAY_NAME = "匿名观众";
const ANON_SUBJECT = "anon:8f2c…";

type Post = {
  id: string;
  subject: string;
  displayName: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  reactionCounts: Record<string, number>;
  myReactions: string[];
};

/** 反馈板的读写替身（两条用例共用一套形状，只在 `author` 上分叉）。 */
async function mockFeedbackApi(
  page: import("@playwright/test").Page,
  author: { subject: string; displayName: string },
  posts: Post[],
) {
  await page.route("**/api/feedback**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    if (method === "GET" && url.pathname === "/api/feedback") {
      await route.fulfill({ json: { posts, nextCursor: null } });
      return;
    }
    if (method === "POST" && url.pathname === "/api/feedback") {
      const body = req.postDataJSON().body as string;
      const post: Post = {
        id: `post_${posts.length + 1}`,
        subject: author.subject,
        displayName: author.displayName,
        body,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        reactionCounts: {},
        myReactions: [],
      };
      posts.unshift(post);
      await route.fulfill({ status: 201, json: post });
      return;
    }
    const react = url.pathname.match(/^\/api\/feedback\/([^/]+)\/reactions$/);
    if (method === "POST" && react) {
      const postId = decodeURIComponent(react[1]);
      const emoji = req.postDataJSON().emoji as string;
      const post = posts.find((p) => p.id === postId);
      if (!post) {
        await route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
        return;
      }
      const mine = new Set(post.myReactions);
      if (mine.has(emoji)) {
        mine.delete(emoji);
        post.reactionCounts[emoji] = Math.max(0, (post.reactionCounts[emoji] ?? 1) - 1);
        if (post.reactionCounts[emoji] === 0) delete post.reactionCounts[emoji];
      } else {
        mine.add(emoji);
        post.reactionCounts[emoji] = (post.reactionCounts[emoji] ?? 0) + 1;
      }
      post.myReactions = [...mine];
      await route.fulfill({
        json: {
          active: mine.has(emoji),
          reactionCounts: post.reactionCounts,
          myReactions: post.myReactions,
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
  });
}

test("guest can read, post and react without logging in", async ({ page }) => {
  const posts: Post[] = [
    {
      id: "post_1",
      subject: "user_00000000000000000000000002",
      displayName: "先到",
      body: "希望能按影厅筛选",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      reactionCounts: { "👍": 2 },
      myReactions: [],
    },
  ];
  await page.route("**/api/account/me", (route) =>
    route.fulfill({ status: 401, json: { error: "UNAUTHENTICATED" } }),
  );
  // ⚠ 客人写路径**不再回 401** —— 那正是本次要修的行为（改前 `POST` 被 `requireIdentity` 挡下）
  await mockFeedbackApi(page, { subject: ANON_SUBJECT, displayName: ANON_DISPLAY_NAME }, posts);

  await ready(page, "/feedback");
  await expect(page.getByRole("heading", { name: "建议反馈", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "建议", exact: true })).toHaveClass(/active/);
  await expect(page.locator(".feedback-card")).toHaveCount(1);
  await expect(page.locator(".feedback-card")).toContainText("希望能按影厅筛选");
  await expect(page.locator('.feedback-chip[data-emoji="👍"]')).toContainText("2");

  // 未登录也直接是「发布」，不再有「登录后发布」这道前置
  await expect(page.getByRole("button", { name: "登录后发布", exact: true })).toHaveCount(0);
  await page.getByLabel("写一条建议", { exact: true }).fill("加个夜间模式开关");
  await page.getByRole("button", { name: "发布", exact: true }).click();

  const first = page.locator(".feedback-card").first();
  await expect(page.locator(".feedback-card")).toHaveCount(2);
  await expect(first).toContainText("加个夜间模式开关");
  await expect(first).toContainText(ANON_DISPLAY_NAME);

  // 反应也不再弹登录
  const chip = first.locator('.feedback-chip[data-emoji="💡"]');
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(chip).toContainText("1");

  // 全程没有账号弹层插进来
  await expect(page.getByRole("dialog", { name: "IFFDAY 账号", exact: true })).toHaveCount(0);
});

test("logged-in user can post and toggle emoji reactions", async ({ page }) => {
  const posts: Post[] = [];
  await page.route("**/api/account/me", (route) => route.fulfill({ json: account }));
  await page.route("**/api/account/sync/biff-2026", async (route) => {
    if (route.request().method() === "PUT") await route.fulfill({ json: { revision: 1 } });
    else
      await route.fulfill({
        json: { subject: id, revision: 0, records: {}, updatedAt: 0, importedAt: null },
      });
  });
  await mockFeedbackApi(page, { subject: id, displayName: account.profile.displayName }, posts);

  await ready(page, "/feedback");
  await expect(page.locator("#account-btn")).toHaveText("观众");
  await page.getByLabel("写一条建议", { exact: true }).fill("加个夜间模式开关");
  await page.getByRole("button", { name: "发布", exact: true }).click();
  await expect(page.locator(".feedback-card")).toHaveCount(1);
  await expect(page.locator(".feedback-card")).toContainText("加个夜间模式开关");
  await expect(page.locator(".feedback-card")).toContainText("观众");

  const chip = page.locator('.feedback-chip[data-emoji="💡"]');
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(chip).toContainText("1");
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "false");
});
