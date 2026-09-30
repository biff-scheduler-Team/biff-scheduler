import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { ready, seed } from "./helpers";

/* ★ 本文件原先 11 条用例,2026-09-30 只剩 2 条(`PLAN-20260930213528`)。
 *
 * 「我的行程」删掉卡片视图后,下列用例的**宿主整体消失**(它们断言的元素只长在卡片视图上):
 *   · 「a following screening has no misleading gap…」—— `.agenda-day` + `.gap-label`(间隔提示);
 *   · 「folded days retain daily prices…」—— 按日折叠(`biff.agendafold.v1`);
 *   · 「pointer dragging changes ranks…」—— 顺位卡拖拽(`biff.ranks.v1`);
 *   · 「agenda cards carry the venue code…」/「the Google Maps entry hugs…」—— 场次卡的影院块;
 *   · 「行程卡片不再挂「定位」…」/「the agenda film name carries a douban jump link…」—— 场次卡;
 *   · 更早的「顺位撞车 / 保存方案 / 方案卡片删除」等条已在 2026-09-22 随各自功能下线。
 * 日程表那一条(`agenda-gantt.spec.ts`)才是现在这一页的守门人。
 *
 * ⚠ 场次卡(`ScreeningCard`)本身**没有删** —— 影片库仍在用它(不传行程页那几个开关)。 */

test("ticket details retain translated guidance and a fixed 30-minute ticket alarm", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-09-12T00:00:00Z") });
  await seed(page, { "biff.settings.v1": JSON.stringify({ alarmMin: 90 }) });
  await ready(page, "/agenda");
  const ticketButton = page.getByRole("button", { name: /距第 1 批开票/ });
  await expect(ticketButton.getByRole("timer")).toBeVisible();
  await ticketButton.click();
  const dialog = page.getByRole("dialog", { name: "购票信息", exact: true });
  await expect(dialog).toContainText("北京时间 9/17 13:00");
  await expect(dialog).toContainText("韩国时间 9/17 14:00");
  await expect(dialog).toContainText(
    "65 岁以上（1961 年及以前出生）/ 残障 / 退伍军人，需证件核验",
  );
  await expect(dialog).toContainText("推荐用 Chrome 浏览器购票");
  await expect(dialog).toContainText("每场限购 2 张");
  await expect(dialog).toContainText("观众入场");
  await expect(dialog).toContainText("BCC 周边无指定车位");
  const download = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "导出开票提醒", exact: true })
    .click();
  const file = await download;
  const text = await readFile((await file.path())!, "utf8");
  expect(text).toContain("TRIGGER:-PT30M");
  expect(text).not.toContain("TRIGGER:-PT90M");
});

test("after the final batch the ticket banner says tickets are on sale", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-09-22T00:00:00Z") });
  await ready(page, "/agenda");
  await expect(
    page.getByRole("button", { name: /BIFF 2026 售票中/ }),
  ).toBeVisible();
});
