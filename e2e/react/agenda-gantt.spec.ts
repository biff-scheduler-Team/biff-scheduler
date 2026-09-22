import { test, expect } from "@playwright/test";
import { catalog, keyOf, ready, seed } from "./helpers";

// 「我的行程 → 日程表」视图(2026-09-21,PLAN-20260921223658)。
// 与排片表共用同一个甘特组件,但画布只有我的场次、X 轴只有我有影片的影厅。
// ⚠ 排片表那一列在 `/agenda` 路由上是**渲染出来但 hidden** 的(见 `app/App.tsx` 的
//   `.schedule-column`),所以这里的断言一律先用 CSS 作用域收到 `region 我的行程` 里 ——
//   直接用 `page.locator(".vertical-venue")` 会同时命中隐藏的排片表。

const mine = ["008", "033"];

function picks(codes: string[]) {
  const entries = new Map<
    string,
    { key: string; picks: { code: string }[]; note: string }
  >();
  for (const code of codes) {
    const key = keyOf(code);
    const entry = entries.get(key) ?? { key, picks: [], note: "" };
    entry.picks.push({ code });
    entries.set(key, entry);
  }
  return JSON.stringify([...entries.values()]);
}

function venueCodes(codes: string[]) {
  return [...new Set(codes.map((code) => catalog.byCode.get(code)!.venue_id))]
    .map((id) => catalog.venueById.get(id)!.code)
    .sort();
}

test("日程表默认只画我的场次，X 轴只留我有影片的影厅", async ({ page }) => {
  await seed(page, { "biff.picks.v2": picks(mine) });
  await ready(page, "/agenda");
  const agenda = page.getByRole("region", { name: "我的行程", exact: true });

  // 日期条只列「我有行程的日期」(排片表那条列全届日期)
  await expect(agenda.locator(".date-strip.calendar-strip > button")).toHaveCount(1);
  // 画布上只有我的两场 —— 当天 10-07 一共有 68 场
  await expect(agenda.locator("[data-grid-slot]")).toHaveCount(2);
  await expect(agenda.locator('[data-grid-code="008"]')).toBeVisible();
  await expect(agenda.locator('[data-grid-code="033"]')).toBeVisible();
  const other = catalog.schedule.screenings.find(
    (s) => s.date === "2026-10-07" && !mine.includes(s.code),
  )!;
  await expect(agenda.locator(`[data-grid-slot="${other.code}"]`)).toHaveCount(0);

  // X 轴只有我有影片的影厅(10-07 当天有 21 个厅在放片,这里只该剩 2 个)
  const codes = (await agenda.locator(".vertical-venue .venue-code").allTextContents()).map(
    (text) => text.trim(),
  );
  expect(codes.sort()).toEqual(venueCodes(mine));
});

test("日程表的整点刻度只是刻度，不再是可点的时段筛选", async ({ page }) => {
  await seed(page, { "biff.picks.v2": picks(mine) });
  await ready(page, "/agenda");
  const agenda = page.getByRole("region", { name: "我的行程", exact: true });

  // 这一页没有整点筛选:做成按钮就是个点了没反应的死控件,还会往 /agenda 的 URL 写 hour
  await expect(agenda.locator(".ruler-track button")).toHaveCount(0);
  await expect(agenda.locator(".ruler-tick").first()).toBeVisible();
  // 排片表那套「排片筛选 / 已选图例」同理不出现在行程画布上
  expect(await agenda.locator(".schedule-legend").innerText()).not.toContain("已选");
  await expect(page.getByRole("button", { name: "排片筛选", exact: true })).toHaveCount(0);
});

test("时间重叠在我的两场之间画成连线，并给格子冲突配色", async ({ page }) => {
  await seed(page, { "biff.picks.v2": picks(mine) });
  await ready(page, "/agenda");
  const agenda = page.getByRole("region", { name: "我的行程", exact: true });

  // 008(08:40–11:20)与 033(09:00–10:53)重叠 → 跨两个影厅列一条连线
  await expect(agenda.locator(".conflict-links line")).toHaveCount(1);
  await expect(agenda.locator('[data-grid-slot="008"]')).toHaveClass(/conflict/);
  await expect(agenda.locator('[data-grid-slot="033"]')).toHaveClass(/conflict/);
  // 冲突组的抢票顺位仍留在这条连线的画布下方(顺位只在这里拖动设置)
  await expect(
    agenda.getByRole("region", { name: /冲突组 008 033/ }),
  ).toHaveCount(1);
});

test("日期条切单日，卡片 / 日程表两档可来回切且互不残留", async ({ page }) => {
  await seed(page, { "biff.picks.v2": picks(["001", ...mine]) });
  await ready(page, "/agenda");
  const agenda = page.getByRole("region", { name: "我的行程", exact: true });

  await expect(agenda.locator(".date-strip.calendar-strip > button")).toHaveCount(2);
  // 默认落行程里最早的一天:10-06 只有 001 一场(唯一场次 → 只有一个影厅列)
  await expect(agenda.locator("[data-grid-slot]")).toHaveCount(1);
  await expect(agenda.locator(".vertical-venue")).toHaveCount(1);
  await agenda
    .getByRole("button", { name: "选择日期 2026-10-07", exact: true })
    .click();
  await expect(agenda.locator("[data-grid-slot]")).toHaveCount(2);
  await expect(agenda.locator(".vertical-venue")).toHaveCount(2);

  // 卡片视图:按天列表回来,画布整块卸载
  await agenda.getByRole("button", { name: "卡片", exact: true }).click();
  await expect(agenda.locator(".agenda-day")).toHaveCount(2);
  await expect(agenda.locator("[data-grid-slot]")).toHaveCount(0);
  await expect(agenda.locator('[data-screening="008"]')).toBeVisible();
  await agenda.getByRole("button", { name: "日程表", exact: true }).click();
  await expect(agenda.locator(".agenda-day")).toHaveCount(0);
  await expect(agenda.locator(".vertical-venue")).toHaveCount(2);

  // 「仅看实际行程」联动:一场都没标「已抢到」时画布与日期条一起空掉,并给出说明
  await agenda.getByRole("button", { name: /仅看实际行程/ }).click();
  await expect(agenda.locator("[data-grid-slot]")).toHaveCount(0);
  await expect(agenda.locator(".date-strip.calendar-strip")).toHaveCount(0);
  await expect(agenda.locator(".agenda-gantt-empty")).toBeVisible();
});

// 「我的行程」信息架构收拾(2026-09-22,`PLAN-20260922103307`)。
// 回归的是改动前的两处结构问题:① 工具栏与画布图例**分成两行**、功能混杂;
// ② 「保存当前方案」悬在日程表与「已保存方案」之间的空白里(不在首屏工具栏)。
test("顶部工具栏只有一条：左状态操作、右视图与保存，日期条夹在概览条与它之间", async ({
  page,
}) => {
  // 左右两组要落在同一行才有「左 vs 右」可言,故把视口钉死在桌面宽度
  await page.setViewportSize({ width: 1512, height: 1200 });
  await seed(page, { "biff.picks.v2": picks(mine) });
  await ready(page, "/agenda");
  const agenda = page.getByRole("region", { name: "我的行程", exact: true });

  // ① 全页只有一条工具栏:图例、操作、视图、缩放全在里面
  const toolbar = agenda.locator(".agenda-actions");
  await expect(toolbar).toHaveCount(1);
  const legend = toolbar.locator(".schedule-legend");
  await expect(legend).toHaveCount(1);
  await expect(legend).toContainText("时间紧张");
  await expect(legend).toContainText("时间重叠");
  await expect(legend).toContainText("韩国时间 KST");
  // 缩放档位从画布自己的图例行搬进了这条工具栏
  await expect(toolbar.locator(".zoom-controls button")).toHaveCount(3);
  // 画布容器里不再有第二行图例(否则就是「两行控件」又回来了)
  await expect(agenda.locator(".agenda-gantt .schedule-legend")).toHaveCount(0);

  // ② 左组 = 图例 + 添加转票场次 + 仅看实际行程;右组 = 日程表 / 卡片 + 缩放 + 保存当前方案
  const left = toolbar.locator(".agenda-actions-left");
  const right = toolbar.locator(".agenda-actions-right");
  expect(await left.innerText()).toContain("添加转票场次");
  expect(await left.innerText()).toContain("仅看实际行程");
  expect(await right.innerText()).toContain("日程表");
  expect(await right.innerText()).toContain("卡片");
  expect(await right.innerText()).toContain("保存当前方案");
  const leftBox = (await left.boundingBox())!;
  const rightBox = (await right.boundingBox())!;
  expect(rightBox.x).toBeGreaterThanOrEqual(leftBox.x + leftBox.width);

  // ③ 保存当前方案在工具栏里,不再是日程表与「已保存方案」之间那块孤立按钮
  await expect(agenda.locator(".agenda-save")).toHaveCount(0);
  await expect(
    right.getByRole("button", { name: "保存当前方案", exact: true }),
  ).toHaveCount(1);

  // ④ 层次:概览条 → 日期导航 → 工具栏
  const strip = agenda.locator(".date-strip.calendar-strip");
  await expect(strip).toHaveCount(1);
  const summaryBox = (await agenda.locator(".summary-strip").boundingBox())!;
  const stripBox = (await strip.boundingBox())!;
  const toolbarBox = (await toolbar.boundingBox())!;
  expect(summaryBox.y + summaryBox.height).toBeLessThanOrEqual(stripBox.y);
  expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(toolbarBox.y);

  // ⑤ 卡片视图没有画布:图例 / 缩放 / 日期条一起退场,但保存按钮留下
  await right.getByRole("button", { name: "卡片", exact: true }).click();
  await expect(agenda.locator(".schedule-legend")).toHaveCount(0);
  await expect(agenda.locator(".zoom-controls")).toHaveCount(0);
  await expect(strip).toHaveCount(0);
  await expect(
    agenda.locator(".agenda-actions-right").getByRole("button", {
      name: "保存当前方案",
      exact: true,
    }),
  ).toHaveCount(1);
});
