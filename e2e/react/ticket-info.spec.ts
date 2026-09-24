import { test, expect, type Locator, type Page } from "@playwright/test";
import { keyOf, ready, seed, storage } from "./helpers";

// 票据明细:日程表上的座位表 = 票数(2026-09-24,`PLAN-20260924141442`)。
//
// ⚠ 本 spec 守的**两条不变量**比 UI 本身更重要:
//   ① **票数是座位行数的派生值**,没有独立的数字字段 —— 空行也是「一张票」,归一化不许把它收掉;
//   ② 已撤销的账号 / 密码方案**一个键都不许留**(`iffday.workspace.ticketaccounts.v1` 应当从不存在)。

const V1 = "biff.ticketinfo.v1";
const V2 = "biff.ticketinfo.v2";

/** 行程播种:`biff.picks.v2` 每场一个 key(与行程页口径一致)。 */
const picks = (...codes: string[]) =>
  JSON.stringify(
    codes.map((code) => ({ key: keyOf(code), picks: [{ code }], note: "" })),
  );

const editDialog = (page: Page) =>
  page.getByRole("dialog", { name: /^编辑场次 008 的票务$/, exact: true });

/** 从格子上的票按钮打开编辑弹层(右键那条路径由上面第一条用例单独覆盖)。 */
async function openEditor(page: Page) {
  await page.getByRole("button", { name: "编辑场次 008 的票务", exact: true }).click();
  return editDialog(page);
}

/** 加 n 张(点 n 次「添加一张」)。 */
async function addRows(dialog: Locator, n: number) {
  const add = dialog.getByRole("button", { name: /添加一张/ });
  for (let i = 0; i < n; i++) await add.click();
}

test("加一行座位 = 多一张票:格子标出「2 张」,概览按行数合计,刷新后仍在", async ({
  page,
}) => {
  await seed(page, { "biff.picks.v2": picks("008", "033") });
  await ready(page, "/agenda");
  const slot = page.locator('[data-grid-slot="008"]');
  await expect(slot).toBeVisible();

  // 右键 = 编辑票务(不是「移出行程」:那个走左键 + 确认弹层)
  await slot.locator(".gantt-film").click({ button: "right" });
  const dialog = editDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".ticket-seats-count")).toHaveText("0 张票");

  await addRows(dialog, 2);
  await expect(dialog.locator(".ticket-seats-count")).toHaveText("2 张票");
  await dialog.getByRole("textbox", { name: "第 1 张", exact: true }).fill("F12");
  await dialog.getByRole("button", { name: "保存票务信息", exact: true }).click();

  // 标注回到画布上(徽章带 tooltip,里面是「几张 / 坐哪」)
  const badge = slot.locator(".gantt-ticket-badge");
  await expect(badge).toHaveText("2 张");
  await expect(badge).toHaveAttribute("title", "2 张，座位 第 1 张 F12");

  // 概览:「共 N 张票」按**行数**合计(008 加了两行;033 没标已抢到也没明细 → 不计)
  await expect(page.locator(".agenda-overview")).toContainText("共 2 张票");

  // 落盘形状:第二行是空的,但**必须留着** —— 收掉它票数就变 1 了
  expect(JSON.parse((await storage(page))[V2])).toEqual({ "008": { seats: ["F12", ""] } });

  // 刷新后仍在(不是只活在 React state 里)
  await page.reload();
  await expect(page.locator('[data-grid-slot="008"] .gantt-ticket-badge')).toHaveText("2 张");
});

test("删掉一行,票数跟着减", async ({ page }) => {
  await seed(page, {
    "biff.picks.v2": picks("008"),
    [V2]: JSON.stringify({ "008": { seats: ["F12", "F13", "F14"] } }),
  });
  await ready(page, "/agenda");
  await expect(page.locator(".gantt-ticket-badge")).toHaveText("3 张");

  const dialog = await openEditor(page);
  await dialog.getByRole("button", { name: "删除第 2 张", exact: true }).click();
  await expect(dialog.locator(".ticket-seats-count")).toHaveText("2 张票");
  await dialog.getByRole("button", { name: "保存票务信息", exact: true }).click();

  await expect(page.locator(".gantt-ticket-badge")).toHaveText("2 张");
  expect(JSON.parse((await storage(page))[V2])).toEqual({ "008": { seats: ["F12", "F14"] } });
});

test("旧的 v1 结构一次性迁到 v2:count 折成座位行、accountId 丢弃、旧键删掉", async ({
  page,
}) => {
  await seed(page, {
    "biff.picks.v2": picks("008"),
    // v1 把「几张」放在独立字段里,还带着已撤销的账号方案
    [V1]: JSON.stringify({ "008": { count: 2, seats: ["F12"], accountId: "a1" } }),
  });
  await ready(page, "/agenda");
  await expect(page.locator(".gantt-ticket-badge")).toHaveText("2 张");

  const data = await storage(page);
  expect(JSON.parse(data[V2])).toEqual({ "008": { seats: ["F12", ""] } });
  // ⚠ 旧键必须被删掉:留着它下次载入会再迁一遍,云端那份也永远收敛不掉
  expect(data[V1]).toBeUndefined();
  // ★ 阴性对照:账号 / 密码方案的键**从来没被建过**(该功能已整体撤销)
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys.filter((key) => key.includes("ticketaccounts"))).toEqual([]);
});
