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

test("guest can read feedback list and is gated on post/react", async ({ page }) => {
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
  await page.route("**/api/feedback**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { posts, nextCursor: null } });
      return;
    }
    await route.fulfill({ status: 401, json: { error: "UNAUTHENTICATED" } });
  });

  await ready(page, "/feedback");
  await expect(page.getByRole("heading", { name: "建议反馈", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "建议", exact: true })).toHaveClass(/active/);
  await expect(page.locator(".feedback-card")).toHaveCount(1);
  await expect(page.locator(".feedback-card")).toContainText("希望能按影厅筛选");
  await expect(page.locator('.feedback-chip[data-emoji="👍"]')).toContainText("2");

  await page.getByRole("button", { name: "登录后发布", exact: true }).click();
  const accountDialog = page.getByRole("dialog", { name: "IFFDAY 账号", exact: true });
  await expect(accountDialog).toBeVisible();
  // 收进弹层再点:全页查询会撞上别的弹层 / S2 菜单浮层里同样叫「关闭」的隐藏按钮
  await accountDialog.getByRole("button", { name: "关闭", exact: true }).click();

  await page.locator('.feedback-chip[data-emoji="❤️"]').click();
  await expect(page.getByRole("dialog", { name: "IFFDAY 账号", exact: true })).toBeVisible();
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
        subject: id,
        displayName: account.profile.displayName,
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
