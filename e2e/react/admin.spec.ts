// 「管理后台」页端到端验收（2026-09-23，PLAN-20260923142546，批 2）。
//
// 断言全走 DOM 计数 / 属性 / 文本，不看截图。
//
// ⚠ E2E 的 webServer 只起 `vite preview`（**没有 API**），所以这一页每个接口都得拦。
//   「拦什么」本身就是被测内容的一部分：`/api/admin/whoami` 的三种响应，正是门禁三态的判据。
//
// 覆盖点：① 门禁三态（未登录 / 非管理员 / 问不到）互不混淆；
//        ② 它是**暗门**（主导航里没有入口）但路径打得开，且走整页布局；
//        ③ 四个视图的标签与顺序固定、`?tab=` 可直达可分享；
//        ④ ★ 趋势图的 `data-points` **等于天数** —— 缺的天被补成 0，图不缩水；
//        ⑤ 内容视图真的打**公开**接口（/api/discussions 与 /api/feedback）；
//        ⑥ 全页不出现 NaN / Infinity / undefined。

import { test, expect, type Page } from "@playwright/test";
import { ready } from "./helpers";

const EDITION = "biff-2026";
/** 服务端日界「今天」（固定值：断言里要用它推 fromDay，不能跟着真实时间漂）。 */
const TODAY = "2026-09-23";

/** `TODAY` 往前数 `count - 1` 天 —— 与页面/服务端的 `fromDay` 口径一致。 */
function dayBefore(count: number): string {
  const at =
    Date.UTC(Number(TODAY.slice(0, 4)), Number(TODAY.slice(5, 7)) - 1, Number(TODAY.slice(8, 10))) -
    (count - 1) * 86_400_000;
  return new Date(at).toISOString().slice(0, 10);
}

const DISCUSSIONS = {
  posts: [
    {
      id: "d1",
      code: "004",
      subject: "user_01M2EVF3GTTJ6JC9NTM8NXYNHY",
      displayName: "gaaiyeoi",
      category: "gift",
      body: "嗨",
      createdAt: 1789527388822,
      updatedAt: 1789527388822,
      reactionCounts: { "👍": 1 },
      myReactions: [],
    },
  ],
  nextCursor: null,
};

const FEEDBACK = {
  posts: [
    {
      id: "f1",
      subject: "user_01M2B43ZJJJG6YJFHVKJ78XVSR",
      displayName: "citron",
      body: "很伟大的一个网站  谢谢开发老师",
      createdAt: 1789622637097,
      updatedAt: 1789622637097,
      reactionCounts: {},
      myReactions: [],
    },
  ],
  nextCursor: null,
};

/** 管理员的四份数据。**趋势刻意只喂 1 天** —— 页面若照原样画，点数就会是 1（见覆盖点 ④）。
 *  `emptyLedger`：模拟「日账本一行都没有」（部署当天就是这状态）—— 用来验「空态不画空图」。 */
async function stubAdmin(page: Page, options: { emptyLedger?: boolean } = {}) {
  await page.route("**/api/admin/whoami", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/admin/overview*", (route) =>
    route.fulfill({
      json: {
        edition: EDITION,
        today: TODAY,
        earliestDay: TODAY,
        metrics: [
          { metric: "vote", rows: 2, contributors: 2, targets: 2, total: 2, today: 2 },
        ],
        audit: { edition: EDITION, scanned: { vote: 2 }, drifts: [], ok: true },
        accounts: { sessions: 1, documents: 2, documentBytes: 2048, imported: 1 },
        content: { discussions: 1, feedback: 1 },
      },
    }),
  );
  await page.route("**/api/admin/rows*", (route) =>
    route.fulfill({
      json: {
        metric: "vote",
        rows: [
          {
            target: "cat:f001",
            sub: null,
            contributor: "anon:abcdefghijklmnopqrstuvwxyz012345",
            anonymous: true,
            weight: 0.75,
            hits: 1,
            updatedAt: 1789527388822,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  // ⚠ fromDay 跟着请求里的 days 走：切 7 天时若仍回 30 天的起点，补零后点数就还是 30，
  //   而「点数 = 天数」这条断言会**误红**（那是假报警，不是真 bug）。
  await page.route("**/api/admin/trends*", (route) => {
    const days = Number(new URL(route.request().url()).searchParams.get("days") ?? "30");
    return route.fulfill({
      json: {
        edition: EDITION,
        metric: "vote",
        metrics: ["vote:red", "vote:black"],
        fromDay: dayBefore(days),
        days,
        earliestDay: options.emptyLedger ? null : TODAY,
        points: options.emptyLedger ? [] : [{ day: TODAY, weight: 2, hits: 0 }],
      },
    });
  });
  await page.route("**/api/discussions*", (route) => route.fulfill({ json: DISCUSSIONS }));
  await page.route("**/api/feedback*", (route) => route.fulfill({ json: FEEDBACK }));
}

/* ---------------- 门禁三态 ---------------- */

test("未登录：给登录入口，且不与「你没权限」混为一谈", async ({ page }) => {
  await page.route("**/api/admin/whoami", (route) =>
    route.fulfill({ status: 401, json: { error: "UNAUTHENTICATED" } }),
  );
  await ready(page, "/admin");
  await expect(page.getByRole("heading", { name: "需要登录" })).toBeVisible();
  // ★ 三态必须互斥：401 的答案不是「你不是管理员」
  await expect(page.getByRole("heading", { name: "当前账号不是管理员" })).toHaveCount(0);
  // ⚠ 必须收窄到这一屏：顶栏那个账号按钮的 aria-label 也叫「登录 IFFDAY」，
  //   不收窄就是 strict mode 撞车（实测踩到）
  const panel = page.locator("section.admin-panel").filter({ hasText: "需要登录" });
  await expect(panel.getByRole("button", { name: "登录 IFFDAY" })).toBeVisible();
});

test("已登录但不是管理员：说清是名单问题，并给切换账号（不提示去登录）", async ({ page }) => {
  await page.route("**/api/admin/whoami", (route) =>
    route.fulfill({ status: 403, json: { error: "FORBIDDEN" } }),
  );
  await ready(page, "/admin");
  await expect(page.getByRole("heading", { name: "当前账号不是管理员" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "需要登录" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "切换账号" })).toBeVisible();
});

test("★ 服务端出错（500）：说「暂时问不到」，绝不伪装成「你不是管理员」", async ({ page }) => {
  await page.route("**/api/admin/whoami", (route) =>
    route.fulfill({ status: 500, json: { error: "INTERNAL" } }),
  );
  await ready(page, "/admin");
  await expect(page.getByRole("heading", { name: "暂时问不到服务端" })).toBeVisible();
  // 这一条就是防「服务端挂了，页面让人去切换账号」那种把人带偏的提示
  await expect(page.getByRole("heading", { name: "当前账号不是管理员" })).toHaveCount(0);
  await expect(page.getByText(/这与「没有权限」是两件事/)).toBeVisible();
});

/* ---------------- 暗门与整页布局 ---------------- */

test("暗门：主导航里没有入口，路径能直开，且走整页布局", async ({ page }) => {
  await stubAdmin(page);
  await ready(page, "/admin");
  await expect(page.getByRole("heading", { name: "管理后台" })).toBeVisible();
  // 不在主导航里（不对外宣传这个页面）
  await expect(
    page.getByRole("navigation", { name: "主要导航" }).getByText("管理后台"),
  ).toHaveCount(0);
  // ⚠ 这一条钉的是 `App.tsx` 的 fullPage 正则：漏加 `admin` 会让整页被塞进浮动面板布局，
  //   而「逻辑对不对」的断言全都照旧通过 —— 只有布局属性拦得住（PLAN 里点名的那一处）
  await expect(page.locator("#workspace")).toHaveClass(/full-page-workspace/);
});

/* ---------------- 四个视图 ---------------- */

test("四个视图：标签与顺序固定，且 ?tab= 可直达（URL 可收藏可分享）", async ({ page }) => {
  await stubAdmin(page);
  await ready(page, "/admin");
  const tabs = page.getByRole("navigation", { name: "管理端视图" }).getByRole("button");
  // ⚠ 必须先等标签出来再读文本：`allTextContents()` **不会**自动等待，
  //   而 `ready()` 只等主导航（权限探测还在飞）—— 高并发下会读到空数组（实测 mobile-webkit 踩到）
  await expect(tabs).toHaveCount(4);
  expect((await tabs.allTextContents()).map((text) => text.trim())).toEqual([
    "概览",
    "明细",
    "趋势",
    "内容",
  ]);
  // 概览默认在：数据总览 + 体检结论
  await expect(page.getByRole("heading", { name: `数据总览（${EDITION}）` })).toBeVisible();
  await expect(page.getByRole("heading", { name: "数据体检（聚合对账）" })).toBeVisible();

  await tabs.filter({ hasText: "明细" }).click();
  await expect(page).toHaveURL(/tab=rows/);
  await expect(page.getByRole("heading", { name: "贡献行明细" })).toBeVisible();

  // 直接打开带参数的 URL 与点标签等价（收藏 / 分享 / 后退都靠它）
  await ready(page, "/admin?tab=content");
  await expect(page.getByRole("heading", { name: "内容（场次讨论）" })).toBeVisible();
});

test("★ 趋势：图上点数**等于天数**（缺的天补成 0，图不缩水），切天数会重取", async ({ page }) => {
  await stubAdmin(page);
  await ready(page, "/admin?tab=trends");
  const figure = page.locator('[data-chart="admin-trend"]');
  // 数据里只有 1 天有值，但默认窗口是 30 天 —— 图必须画满 30 个点：
  // 只画有值的那几天，会让「中间空着」看起来像「那几天不存在」（PLAN 里点名的坑）
  await expect(figure).toHaveAttribute("data-points", "30");
  await expect(page.getByRole("heading", { name: "按天趋势" })).toBeVisible();

  await page.getByRole("button", { name: "近 7 天" }).click();
  await expect(figure).toHaveAttribute("data-points", "7");

  // 口径收在右上角 ⓘ 里（默认不展开），点开能看到「日账本」「缺的天按 0 画」
  const note = figure.locator(".ra-note-body");
  await expect(note).toBeHidden();
  await figure.locator(".ra-note-btn").click();
  await expect(note).toContainText("日账本");
  await expect(note).toContainText("缺的天在图上是 0");
});

test("明细：模块可切，行里的身份与权重都摆出来了", async ({ page }) => {
  await stubAdmin(page);
  await ready(page, "/admin?tab=rows");
  await expect(page.getByRole("heading", { name: "贡献行明细" })).toBeVisible();
  const table = page.locator(".admin-table");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  // 匿名行要能一眼看出是匿名的（这就是排查「死贴纸」时要的判据）
  await expect(table.locator("tbody")).toContainText("cat:f001");
  await expect(table.locator("tbody")).toContainText("0.75");
  await expect(table.locator("tbody")).toContainText("匿名");
  // 服务端没给游标 → 上一页 / 下一页都不可用（不是「点了没反应」）
  await expect(page.getByRole("button", { name: "下一页" })).toBeDisabled();
});

test("★ 内容视图：复用**公开**接口（请求真的打到 /api/discussions 与 /api/feedback）", async ({
  page,
}) => {
  const paths: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) paths.push(url.pathname);
  });
  await stubAdmin(page);
  await ready(page, "/admin?tab=content");

  const table = page.locator(".admin-table");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.locator("tbody")).toContainText("gaaiyeoi");
  // 分类显示契约里的中文标签，不是裸 key（`gift` → 无料交换）
  await expect(table.locator("tbody")).toContainText("无料交换");
  await expect(table.locator("tbody")).toContainText("👍 1");
  // ★ 走的就是公开那条路 —— 管理端没有第二条「更全」的实现
  expect(paths).toContain("/api/discussions");
  // 管理端接口在这条视图里**一次都不该被调用**（否则就是在造第二份口径）
  expect(paths.some((path) => path.startsWith("/api/admin/") && path !== "/api/admin/whoami")).toBe(
    false,
  );

  await page.getByRole("button", { name: "反馈留言" }).click();
  await expect(page.getByRole("heading", { name: "内容（反馈留言）" })).toBeVisible();
  await expect(table.locator("tbody")).toContainText("citron");
  // 反应为空时给破折号，不留空单元格
  await expect(table.locator("tbody")).toContainText("—");
  expect(paths).toContain("/api/feedback");
  // 反馈没有「场次 / 分类」列（那是讨论才有的维度）
  await expect(table.locator("thead")).not.toContainText("场次");
});

/* ---------------- 图表（参考数据分析模块） ---------------- */

test("概览：规模图与内容构成都在，数字与下面那张表同口径", async ({ page }) => {
  await stubAdmin(page);
  await ready(page, "/admin");
  // stub 里只有一个模块 → 一根条；图与表说的是同一件事（参与人数那一列）
  await expect(page.locator('[data-chart="admin-metric-users"]')).toHaveAttribute("data-points", "1");
  await expect(page.locator(".admin-table").first().locator("tbody")).toContainText("红黑榜");
  // 内容构成：讨论 1 + 反馈 1 = 两片
  await expect(page.locator('[data-chart="admin-content-mix"]')).toHaveAttribute("data-points", "2");
});

test("内容：分类环 + 作者榜都在；切到反馈时分类环消失（不是空环）", async ({ page }) => {
  await stubAdmin(page);
  await ready(page, "/admin?tab=content");
  await expect(page.locator('[data-chart="admin-content-categories"]')).toHaveAttribute("data-points", "1");
  await expect(page.locator('[data-chart="admin-content-authors"]')).toHaveAttribute("data-points", "1");
  // ★ 口径要写在图上：两张图只统计**已加载**的那几条 —— 把「已加载」当「全量」是会出错的
  const authors = page.locator('[data-chart="admin-content-authors"]');
  await authors.locator(".ra-note-btn").click();
  await expect(authors.locator(".ra-note-body")).toContainText("只统计已加载的 1 条");

  await page.getByRole("button", { name: "反馈留言" }).click();
  await expect(page.locator('[data-chart="admin-content-categories"]')).toHaveCount(0);
  await expect(page.locator('[data-chart="admin-content-authors"]')).toHaveAttribute("data-points", "1");
});

test("趋势：日账本一行都没有时**不画空图**，只给一句话（空态口径）", async ({ page }) => {
  await stubAdmin(page, { emptyLedger: true });
  await ready(page, "/admin?tab=trends");
  await expect(page.locator(".ra-chart-empty")).toContainText("日账本还没有数据");
  // 空图比一句话更糟：全是 0 的柱子看着像图坏了
  await expect(page.locator('[data-chart="admin-trend"]')).toHaveCount(0);
});

test("★ 图表外壳样式真的加载了（缺了它，图的 ⓘ 会失效而逻辑断言照旧全过）", async ({ page }) => {
  await stubAdmin(page);
  await ready(page, "/admin?tab=trends");
  const figure = page.locator('[data-chart="admin-trend"]');
  await expect(figure).toBeVisible();
  // ⚠ 这几条就是 2026-09-23 那个真 bug 的守门人：`.ra-chart*` / `.ra-note*` 原先只写在
  //   `pages/rush-analysis.css` 里，管理后台没引它 —— 图能画出来、ⓘ 也能点开（`<details>` 的
  //   原生行为），**所有逻辑断言都过**，只有计算样式看得出画布锚点与浮层定位全丢了。
  const styles = await figure.evaluate((el) => {
    const canvas = el.querySelector(".ra-chart-canvas");
    const note = el.querySelector(".ra-note");
    const btn = el.querySelector(".ra-note-btn");
    return {
      canvasPosition: canvas ? getComputedStyle(canvas).position : "missing",
      notePosition: note ? getComputedStyle(note).position : "missing",
      btnRadius: btn ? getComputedStyle(btn).borderRadius : "missing",
    };
  });
  expect(styles.canvasPosition).toBe("relative");
  expect(styles.notePosition).toBe("absolute");
  expect(styles.btnRadius).toBe("50%");

  // `.ra-grid` 同理：没加载时多张图会一张压一张地竖排（图在，但版面是坏的）
  await ready(page, "/admin?tab=content");
  await expect(page.locator(".ra-grid").first()).toHaveCSS("display", "grid");
});

/* ---------------- 兜底 ---------------- */

test("四个视图轮流打开，全页不出现 NaN / Infinity / undefined", async ({ page }) => {
  await stubAdmin(page);
  for (const tab of ["", "?tab=rows", "?tab=trends", "?tab=content"]) {
    await ready(page, `/admin${tab}`);
    const text = await page.evaluate(() => document.body.innerText);
    expect(text, `tab=${tab || "overview"} 出现了 NaN`).not.toContain("NaN");
    expect(text, `tab=${tab || "overview"} 出现了 Infinity`).not.toContain("Infinity");
    expect(text, `tab=${tab || "overview"} 出现了 undefined`).not.toContain("undefined");
  }
});
