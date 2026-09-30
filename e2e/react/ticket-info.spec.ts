import { test, expect, type Locator, type Page } from "@playwright/test";
import { keyOf, openExport, ready, seed, storage } from "./helpers";

// 票据明细:日程表上的座位表 = 票数(2026-09-24,`PLAN-20260924141442`)。
//
// ⚠ 本 spec 守的**五条不变量**比 UI 本身更重要:
//   ① **票数是座位行数的派生值**,没有独立的数字字段 —— 空行也是「一张票」,归一化不许把它收掉;
//   ② **「不划位」没有独立字段**:它落库就是全空的座位行,档位由界面推断(修订 4);
//   ③ **票务导入只写票务,且必须先并行行程再写明细**(否则 rebuild 会把刚导的票 prune 掉,修订 5);
//   ④ **账号名只在本地键里**:`biff.*` 里一个字符都不许出现(修订 7,由全仓扫描的阴性对照守着);
//   ⑤ 已撤销的账号 / 密码方案**一个键都不许留**(`iffday.workspace.ticketaccounts.v1` 应当从不存在)。
//
// ⚠⚠ 本文件里的姓名 / 预约号 / 账号一律是**假数据** —— 这个仓库是**公开**的,
//    2026-09-24 曾把真实姓名与真实预约号写进来,被用户发现后全部替换。别再抄真实数据。

const V1 = "biff.ticketinfo.v1";
const V2 = "biff.ticketinfo.v2";
const V3 = "biff.ticketinfo.v3";
/** 账号名表(修订 7)—— ⚠ **本地专属**:不带 `biff.` 前缀,所以不上云、不进导出备份。 */
const ACCOUNT_KEY = "iffday.workspace.ticketaccount.v1";

/** 行程播种:`biff.picks.v2` 每场一个 key(与行程页口径一致)。 */
const picks = (...codes: string[]) =>
  JSON.stringify(
    codes.map((code) => ({ key: keyOf(code), picks: [{ code }], note: "" })),
  );

const editDialog = (page: Page, code = "008") =>
  page.getByRole("dialog", { name: `编辑场次 ${code} 的票务`, exact: true });

/** 从格子上的票按钮打开编辑弹层(右键那条路径由下面第一条用例单独覆盖)。 */
async function openEditor(page: Page, code = "008") {
  await page.getByRole("button", { name: `编辑场次 ${code} 的票务`, exact: true }).click();
  return editDialog(page, code);
}

/** 加 n 张(点 n 次「添加一张」)。 */
async function addRows(dialog: Locator, n: number) {
  const add = dialog.getByRole("button", { name: /添加一张/ });
  for (let i = 0; i < n; i++) await add.click();
}

/** **本地专属键**的读取口。
 *  ⚠ **不能用 `storage(page)`** —— 它按既定契约排除 `iffday.*`(`helpers.ts` 的注释写明它是
 *    「应用数据契约快照」),而账号表正是一只本地专属键。这里只能直读 localStorage。 */
const localItem = (page: Page, key: string) =>
  page.evaluate((k) => localStorage.getItem(k), key);

/** 「这场不划位」复选框的状态断言口。 */
const unreservedBox = (dialog: Locator) =>
  dialog.getByRole("checkbox", { name: /这场不划位/ });

/** 切「不划位」档。
 *  ⚠ RAC 的复选框:真正的 `<input>` 是**视觉隐藏**的,直接 `click()` / `check()` 会被上层
 *    样式 div 挡掉(`intercepts pointer events`)—— 按用户的做法点**标签文字**
 *    (与 `redblack.spec.ts` / `schedule-toolbar.spec.ts` 同手法),状态照旧断言在 checkbox 角色上。 */
async function toggleUnreserved(dialog: Locator) {
  await dialog.getByText(/这场不划位/).click();
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
  expect(JSON.parse((await storage(page))[V3])).toEqual({ "008": { seats: ["F12", ""] } });

  // 刷新后仍在(不是只活在 React state 里)
  await page.reload();
  await expect(page.locator('[data-grid-slot="008"] .gantt-ticket-badge')).toHaveText("2 张");
});

test("删掉一行,票数跟着减", async ({ page }) => {
  await seed(page, {
    "biff.picks.v2": picks("008"),
    [V3]: JSON.stringify({ "008": { seats: ["F12", "F13", "F14"] } }),
  });
  await ready(page, "/agenda");
  await expect(page.locator(".gantt-ticket-badge")).toHaveText("3 张");

  const dialog = await openEditor(page);
  await dialog.getByRole("button", { name: "删除第 2 张", exact: true }).click();
  await expect(dialog.locator(".ticket-seats-count")).toHaveText("2 张票");
  await dialog.getByRole("button", { name: "保存票务信息", exact: true }).click();

  await expect(page.locator(".gantt-ticket-badge")).toHaveText("2 张");
  expect(JSON.parse((await storage(page))[V3])).toEqual({ "008": { seats: ["F12", "F14"] } });
});

test("旧的 v1 结构一次性迁到 v3:count 折成座位行、accountId 丢弃、旧键删掉", async ({
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
  expect(JSON.parse(data[V3])).toEqual({ "008": { seats: ["F12", ""] } });
  // ⚠ 旧键必须被删掉:留着它下次载入会再迁一遍,云端那份也永远收敛不掉
  expect(data[V1]).toBeUndefined();
  expect(data[V2]).toBeUndefined();
  // ★ 阴性对照:账号 / 密码方案的键**从来没被建过**(该功能已整体撤销)
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys.filter((key) => key.includes("ticketaccounts"))).toEqual([]);
});

test("不划位:只记张数、不填座位号;落库与划位档同形,重开仍判回不划位", async ({
  page,
}) => {
  await seed(page, { "biff.picks.v2": picks("008") });
  await ready(page, "/agenda");

  // 008 在 b1(非露天)→ 默认落在「划位」档
  const dialog = await openEditor(page);
  await expect(unreservedBox(dialog)).not.toBeChecked();
  await expect(dialog.locator(".ticket-seats-title")).toContainText("座位表");

  // 先按划位填一张座位,再切到不划位 —— **值要留着**:在弹层里来回切一下不该丢刚抄下来的座位号
  await addRows(dialog, 1);
  const seat1 = dialog.getByRole("textbox", { name: "第 1 张", exact: true });
  await seat1.fill("F12");

  // 切到不划位:座位输入框整排消失,只剩张数加减
  await toggleUnreserved(dialog);
  await expect(unreservedBox(dialog)).toBeChecked();
  await expect(dialog.locator(".ticket-seats-title")).toContainText("只记张数");
  await expect(seat1).toHaveCount(0);
  await expect(dialog.locator(".ticket-seats-count")).toHaveText("1 张票");

  // 切回去:刚填的座位号还在
  await toggleUnreserved(dialog);
  await expect(seat1).toHaveValue("F12");
  await toggleUnreserved(dialog); // 再切过去,继续走不划位这条路

  await addRows(dialog, 1);
  await expect(dialog.locator(".ticket-seats-count")).toHaveText("2 张票");
  // 「减一张」砍掉最后一行 —— 票数跟着回到 1
  await dialog.getByRole("button", { name: "－ 减一张", exact: true }).click();
  await expect(dialog.locator(".ticket-seats-count")).toHaveText("1 张票");
  await dialog.getByRole("button", { name: /添加一张/ }).click();
  await expect(dialog.locator(".ticket-seats-count")).toHaveText("2 张票");

  await dialog.getByRole("button", { name: "保存票务信息", exact: true }).click();

  const badge = page.locator('[data-grid-slot="008"] .gantt-ticket-badge');
  await expect(badge).toHaveText("2 张");
  // 没有座位号可报 → tooltip 陈述事实,而不是假装还有后半句
  await expect(badge).toHaveAttribute("title", "2 张，座位未填");

  // ★ 落库形态与划位档**完全一样**:N 个空座行 —— 「不划位」不落任何字段
  expect(JSON.parse((await storage(page))[V3])).toEqual({ "008": { seats: ["", ""] } });

  // 重开:按「座位行全空」判回不划位档(档位只活在界面上,靠推断复现)
  await page.reload();
  const again = await openEditor(page);
  await expect(unreservedBox(again)).toBeChecked();
  await expect(again.locator(".ticket-seats-count")).toHaveText("2 张票");
  await expect(again.getByRole("textbox", { name: "第 1 张", exact: true })).toHaveCount(0);
});

test("初始档位:露天场(bt)默认不划位,但露天场里的开闭幕不默认", async ({ page }) => {
  // 001 = 露天场的开幕场(10-06,典礼场 → 固定座席);003 = 露天场 20:00 的 Open Cinema(10-07)
  await seed(page, { "biff.picks.v2": picks("003", "001") });
  await ready(page, "/agenda");

  // ⚠ 日程表**一次只画一天**(上面那排日期 tab),而这两场不在同一天 ——
  //   不切日期的话格子根本不在 DOM 里,报出来是「等按钮超时」,看着像入口坏了。
  // 默认选中 10-06,先看那天的开幕场。
  const gala = await openEditor(page, "001");
  await expect(unreservedBox(gala)).not.toBeChecked();
  await expect(gala.locator(".ticket-seats-title")).toContainText("座位表");
  await gala.getByRole("button", { name: "取消", exact: true }).click();

  await page.getByRole("button", { name: "选择日期 2026-10-07", exact: true }).click();
  const open = await openEditor(page, "003");
  await expect(unreservedBox(open)).toBeChecked();
  await expect(open.locator(".ticket-seats-title")).toContainText("只记张数");
});

test("持票信息(姓名 / 预约号 / 账号)随票保存;BIFF 真实长座号不被截断", async ({
  page,
}) => {
  await seed(page, { "biff.picks.v2": picks("008") });
  await ready(page, "/agenda");

  const dialog = await openEditor(page);
  await addRows(dialog, 2);
  // ⚠ 这两串就是 BIFF 的真实形态(带区 / 排前缀,13~14 字符)—— 上限曾是 12,会被**静默截断**
  await dialog.getByRole("textbox", { name: "第 1 张", exact: true }).fill("Floor 3 · R1 S8");
  await dialog.getByRole("textbox", { name: "第 2 张", exact: true }).fill("Floor 3 · R1 S9");
  await dialog.getByRole("textbox", { name: "姓名", exact: true }).fill("LISI");
  await dialog
    .getByRole("textbox", { name: "预约号", exact: true })
    .fill("269EXAMPLE0000001");
  await dialog.getByRole("textbox", { name: /只记账号名/ }).fill("sample-account");
  await dialog.getByRole("button", { name: "保存票务信息", exact: true }).click();

  const badge = page.locator('[data-grid-slot="008"] .gantt-ticket-badge');
  await expect(badge).toHaveText("2 张");
  // 预约号排姓名前面 —— 换票窗口要的是那串号
  await expect(badge).toHaveAttribute(
    "title",
    "2 张，座位 第 1 张 Floor 3 · R1 S8 / 第 2 张 Floor 3 · R1 S9，预约号 269EXAMPLE0000001，LISI，账号 sample-account",
  );
  // ★ 姓名 / 预约号进 v3(随片单上云);⚠ **账号不在里面**(修订 7)
  expect(JSON.parse((await storage(page))[V3])).toEqual({
    "008": {
      seats: ["Floor 3 · R1 S8", "Floor 3 · R1 S9"],
      name: "LISI",
      bookingNo: "269EXAMPLE0000001",
    },
  });

  // ★★ 红线(修订 7):账号名写进**本地专属**键,且**在 `biff.*` 里一个字符都不许出现** ——
  //    `biff.` 前缀同时是「账号云同步的收集范围」与「导出备份的快照范围」两条外流通道。
  //    (与修订 3 守密码那条是同一套阴性对照写法。)
  const data = await storage(page);
  expect(JSON.parse((await localItem(page, ACCOUNT_KEY))!)).toEqual({ "008": "sample-account" });
  const holders = await page.evaluate((account) =>
    Object.keys(localStorage).filter((key) =>
      (localStorage.getItem(key) ?? "").includes(account),
    ),
  "sample-account");
  expect(holders).toEqual([ACCOUNT_KEY]);

  // 重开弹层三项回填(不是只活在 React state 里)
  await page.reload();
  const again = await openEditor(page);
  await expect(again.getByRole("textbox", { name: "预约号", exact: true })).toHaveValue(
    "269EXAMPLE0000001",
  );
  await expect(again.getByRole("textbox", { name: "姓名", exact: true })).toHaveValue("LISI");
  await expect(again.getByRole("textbox", { name: /只记账号名/ })).toHaveValue("sample-account");
});

test("旧的 v3 里残留的 account 会被搬到本地键,并从 v3 里删掉(修订 7 的搬家)", async ({
  page,
}) => {
  // 修订 5 那版把账号写在 v3 里 —— 那正是「账号跟着上云/进备份」的来源
  await seed(page, {
    "biff.picks.v2": picks("008"),
    [V3]: JSON.stringify({
      "008": { seats: ["F12"], name: "LISI", bookingNo: "269EXAMPLE0000001", account: "old-account" },
    }),
  });
  await ready(page, "/agenda");

  const data = await storage(page);
  expect(JSON.parse((await localItem(page, ACCOUNT_KEY))!)).toEqual({ "008": "old-account" });
  // ★ v3 被重写过:account 已经不在那份随片单上云的记录里了
  expect(JSON.parse(data[V3])).toEqual({
    "008": { seats: ["F12"], name: "LISI", bookingNo: "269EXAMPLE0000001" },
  });
  // 弹层里仍然看得见(读的是本地键)
  const dialog = await openEditor(page);
  await expect(dialog.getByRole("textbox", { name: /只记账号名/ })).toHaveValue("old-account");
});

test("旧的 v2 结构一次性迁到 v3(只有 seats,新字段缺席),旧键删掉", async ({ page }) => {
  await seed(page, {
    "biff.picks.v2": picks("008"),
    [V2]: JSON.stringify({ "008": { seats: ["F12", "F13"] } }),
  });
  await ready(page, "/agenda");
  await expect(page.locator(".gantt-ticket-badge")).toHaveText("2 张");

  const data = await storage(page);
  // v3 相对 v2 只多了三个**可选**字段,故迁移就是换只键名、值原样过一遍同一个归一
  expect(JSON.parse(data[V3])).toEqual({ "008": { seats: ["F12", "F13"] } });
  // ⚠ 旧键必须删掉:留着它下次载入会再迁一遍,云端那份也永远收敛不掉
  expect(data[V2]).toBeUndefined();
});

test("票务导入:并进空行程 + 标已抢到 + 写明细;不在排期里的场次跳过", async ({ page }) => {
  // ★ 起点是**空行程**:导入必须自己把场次并进去 —— 否则明细会在下一次 rebuild 时被 prune 掉
  await seed(page, { "biff.picks.v2": "[]" });
  await ready(page, "/agenda");

  const dialog = await openExport(page);
  await dialog
    .getByRole("textbox", { name: "或粘贴备份 / 日历 / 票务内容", exact: true })
    .fill(
      JSON.stringify({
        app: "biff-scheduler-tickets",
        version: 1,
        tickets: [
          {
            code: "008",
            seats: ["Floor 3 · R1 S8", "Floor 3 · R1 S9"],
            name: "LISI",
            bookingNo: "269EXAMPLE0000001",
            account: "sample-account",
          },
          // 不划位场次:数字写法 = 这么多张、都没座号
          { code: "003", seats: 2, name: "ZHANGSAN", bookingNo: "269EXAMPLE0000002" },
          { code: "999", seats: ["X"] }, // 排期里没有 999
        ],
      }),
    );

  // 预览把「认了几笔 / 几场会跳过」说清楚,而不是只给一个按钮
  await expect(dialog.getByText(/识别到 2 笔票务、4 张票/)).toBeVisible();
  await expect(dialog.getByText(/另有 1 笔的场次不在当前排期/)).toBeVisible();
  await dialog.getByRole("button", { name: "导入票务", exact: true }).click();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();

  const data = await storage(page);
  expect(JSON.parse(data[V3])).toEqual({
    "003": { seats: ["", ""], name: "ZHANGSAN", bookingNo: "269EXAMPLE0000002" },
    "008": {
      seats: ["Floor 3 · R1 S8", "Floor 3 · R1 S9"],
      name: "LISI",
      bookingNo: "269EXAMPLE0000001",
    },
  });
  // ★ 账号只在本地键里(修订 7)—— 没写 account 的那笔不产生条目
  expect(JSON.parse((await localItem(page, ACCOUNT_KEY))!)).toEqual({ "008": "sample-account" });
  // ⚠ 票务三态(`biff.tickets.v1`)已整体下线(2026-09-30,`PLAN-20260930213528`):
  //   导入票务只写**明细**,不再顺手把场次标成「已抢到」—— 概览里那条「实际 N 场」也随之删除。
  expect(data["biff.tickets.v1"]).toBeUndefined();

  // ★ 最要紧的一条:刷新后明细**还在**(说明场次真的并行进了行程,没被 prune)
  await page.reload();
  await expect(page.locator('[data-grid-slot="008"] .gantt-ticket-badge')).toHaveText("2 张");
  await expect(page.locator('[data-grid-slot="003"] .gantt-ticket-badge')).toHaveText("2 张");
  await expect(page.locator(".agenda-overview")).toContainText("共 4 张票");
  // 徽章 tooltip 从本地键取账号(它已不在 TicketInfo 上)
  await expect(page.locator('[data-grid-slot="008"] .gantt-ticket-badge')).toHaveAttribute(
    "title",
    "2 张，座位 第 1 张 Floor 3 · R1 S8 / 第 2 张 Floor 3 · R1 S9，预约号 269EXAMPLE0000001，LISI，账号 sample-account",
  );
});
