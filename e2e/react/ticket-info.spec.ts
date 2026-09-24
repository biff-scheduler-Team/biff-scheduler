import { test, expect, type Locator } from "@playwright/test";
import { headerAction, keyOf, ready, seed, storage } from "./helpers";

// 票据明细:日程表上的张数 / 座位 / 账号(2026-09-24,`PLAN-20260924141442`)。
//
// ⚠ 本 spec 守的**两条不变量**比 UI 本身更重要:
//   ① `biff.ticketinfo.v1`(张数 / 座位 / 账号覆盖)走 `biff.` 前缀 —— 与片单一起上云是**设计**;
//   ② 账号与密码走 `iffday.workspace.ticketaccounts.v1` —— **既不上云、也不进「导出数据备份」**,
//      因为 `sync-data.ts::readWorkspace` 与 `backup.ts::BACKUP_PREFIX` 都按 `biff.` 前缀全量收集。
//      最后一条断言就是这条红线的机械守卫,别删。

const ACCOUNTS_KEY = "iffday.workspace.ticketaccounts.v1";

/** 行程播种:`biff.picks.v2` 每场一个 key(与行程页口径一致)。 */
const picks = (...codes: string[]) =>
  JSON.stringify(
    codes.map((code) => ({ key: keyOf(code), picks: [{ code }], note: "" })),
  );

test("右键格子填张数与座位:格子标出「2 张」,概览按张数合计,刷新后仍在", async ({
  page,
}) => {
  await seed(page, { "biff.picks.v2": picks("008", "033") });
  await ready(page, "/agenda");
  const slot = page.locator('[data-grid-slot="008"]');
  await expect(slot).toBeVisible();

  // 右键 = 编辑票务(不是「移出行程」:那个走左键 + 确认弹层)
  await slot.locator(".gantt-film").click({ button: "right" });
  const dialog = page.getByRole("dialog", { name: "编辑场次 008 的票务", exact: true });
  await expect(dialog).toBeVisible();

  const count = dialog.getByRole("textbox", { name: "购票数量", exact: true });
  await count.fill("2");
  await count.press("Tab");
  // 座位号的标签走 `labelPosition="side"`,文字就是「第 N 张」——
  // 它同时是**唯一**的可访问名(改版前顶部 label 与左侧自绘标签重复,读屏与选择器都会撞名)。
  await dialog.getByRole("textbox", { name: "第 1 张", exact: true }).fill("F12");
  await dialog.getByRole("button", { name: "保存票务信息", exact: true }).click();

  // 标注回到画布上(徽章带 tooltip,里面是「3 件事」的完整口径)
  const badge = slot.locator(".gantt-ticket-badge");
  await expect(badge).toHaveText("2 张");
  await expect(badge).toHaveAttribute("title", /2 张，座位 第 1 张 F12/);

  // 概览:「共 N 张票」按**张数**合计(008 填了 2 张;033 没标已抢到也没填明细 → 不计)
  await expect(page.locator(".agenda-overview")).toContainText("共 2 张票");

  // 落盘形状:尾部空座位被收掉,没填的账号不下发
  expect(JSON.parse((await storage(page))["biff.ticketinfo.v1"])).toEqual({
    "008": { count: 2, seats: ["F12"] },
  });

  // 刷新后仍在(不是只活在 React state 里)
  await page.reload();
  await expect(page.locator('[data-grid-slot="008"] .gantt-ticket-badge')).toHaveText("2 张");
});

test("票里单独指定的账号优先于设置里的默认账号;密码只落 iffday 本地键", async ({
  page,
}) => {
  await seed(page, {
    "biff.picks.v2": picks("008"),
    "biff.ticketinfo.v1": JSON.stringify({
      "008": { count: 2, seats: ["F12", "F13"], accountId: "a2" },
    }),
    [ACCOUNTS_KEY]: JSON.stringify({
      accounts: [
        { id: "a1", label: "主号", username: "me@example.com", password: "pw-one" },
        { id: "a2", label: "朋友号", username: "friend@example.com", password: "pw-two" },
      ],
      defaultId: "a1",
    }),
  });
  await ready(page, "/agenda");

  const badge = page.locator('[data-grid-slot="008"] .gantt-ticket-badge');
  await expect(badge).toHaveText("2 张");
  // 覆盖的账号(朋友号)而不是默认账号(主号)
  await expect(badge).toHaveAttribute("title", /账号 朋友号/);

  await page.getByRole("button", { name: "编辑场次 008 的票务", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑场次 008 的票务", exact: true });
  await expect(dialog).toContainText("当前账号 朋友号");
  // 未解析出账号时这两只按钮**根本不渲染**(而不是禁用),所以这里断言的是「在」
  await expect(dialog.getByRole("button", { name: "复制密码", exact: true })).toBeVisible();

  // ★ 阴性对照:密码**只**出现在 `iffday.workspace.*` 那只键里 ——
  //   `biff.*` 一个字符都不能沾(沾了就会被账号云同步上传,并被写进可分享的备份文件)。
  const holders = await page.evaluate((password) =>
    Object.keys(localStorage).filter((key) =>
      (localStorage.getItem(key) ?? "").includes(password),
    ),
  "pw-two");
  expect(holders).toEqual([ACCOUNTS_KEY]);
  expect(holders.some((key) => key.startsWith("biff."))).toBe(false);
});

test("设置里的票务账号:保存落在本地专属键;取消则一个字都不写", async ({ page }) => {
  await ready(page, "/schedule");
  const storedAccounts = () =>
    page.evaluate(() => localStorage.getItem("iffday.workspace.ticketaccounts.v1"));

  const fillAccount = async (dialog: Locator) => {
    await dialog.getByRole("button", { name: "添加账号", exact: true }).click();
    await dialog.getByRole("textbox", { name: "名称", exact: true }).fill("主号");
    await dialog
      .getByRole("textbox", { name: "用户名（必填）", exact: true })
      .fill("me@example.com");
    await dialog
      .getByRole("textbox", { name: "密码（留空 = 不保存）", exact: true })
      .fill("pw-one");
  };

  await headerAction(page, "设置");
  let dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await fillAccount(dialog);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  expect(await storedAccounts()).toBeNull();

  await headerAction(page, "设置");
  dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await fillAccount(dialog);
  await dialog.getByRole("button", { name: "保存设置", exact: true }).click();

  const raw = await storedAccounts();
  expect(raw).not.toBeNull();
  expect(JSON.parse(raw!)).toEqual({
    accounts: [
      { id: expect.any(String), label: "主号", username: "me@example.com", password: "pw-one" },
    ],
    defaultId: null,
  });

  // 同一条红线的第二处守卫:密码在 `biff.*` 里一个字符都不能出现。
  // (只要它沾到那个前缀,`sync-data.ts` 就会把它传上云端,`backup.ts` 就会把它写进可分享的备份。)
  const holders = await page.evaluate((password) =>
    Object.keys(localStorage).filter((key) =>
      (localStorage.getItem(key) ?? "").includes(password),
    ),
  "pw-one");
  expect(holders).toEqual([ACCOUNTS_KEY]);
});
