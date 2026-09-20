import { test, expect } from "@playwright/test";
import { keyOf, ready, seed } from "./helpers";

// 排期数据更新提示(`PLAN-20260914192552`)。
//
// 为什么用**真实 code** 造夹具:`myFilmsAdded` 判的是「这条新增场次属不属于我选过的影片」,
// 口径是 `util.ts::filmNodeKey()`(官网英文名 → 中文名 → 原始片名三条路)—— 拿真排期里的片名
// 造一条新增场次,才能验证「同一部片换个影院」会被认出来,而不是靠字符串巧合。
const CHANGELOG = {
  generated_at: "2026-09-14T19:30:00+08:00",
  schedule_generated_at: "e2e-v2",
  added: [
    // ① 与用户无关的新片(概况区)
    {
      code: "901", title_en: "Stop Making Sense", title_zh: "", date: "2026-10-08",
      start_time: "15:30", end_time: "16:58", duration_min: 88,
      venue_id: "m1", venue_display: "MEGABOX Busan Theater 1", is_gv: false,
    },
    // ② 用户已选影片的新排期(片名与 001 同片 → `filmNodeKey` 必须认出是同一部)
    {
      code: "9901", title_en: "The Table: Day and Night", title_zh: "", date: "2026-10-12",
      start_time: "19:00", end_time: "20:20", duration_min: 80,
      venue_id: "c6", venue_display: "CGV Centum City 6", is_gv: false,
    },
  ],
  changed: [
    {
      code: "001", title_en: "The Table: Day and Night", title_zh: "彼此的日夜",
      date: "2026-10-06", venue_display: "Busan Cinema Center Roof Theater",
      fields: [{ key: "duration_min", label: "片长", from: "80", to: "90" }],
    },
  ],
};

test("数据更新提示:顶栏入口 → 弹层三块 → 知道了后消失", async ({ page }) => {
  await page.route("**/changelog.json", (route) => route.fulfill({ json: CHANGELOG }));
  await seed(page, {
    "biff.picks.v2": JSON.stringify([
      { key: keyOf("001"), picks: [{ code: "001" }], note: "" },
    ]),
  });
  await ready(page, "/schedule");

  const entry = page.getByRole("button", { name: /数据更新/ });
  await expect(entry).toBeVisible();
  // 徽章数字 = 与我相关:1 场变化 + 1 场我选过影片的新排期
  await expect(entry).toContainText("2");
  await entry.click();

  const dialog = page.getByRole("dialog", { name: "排期数据更新" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("本次同步：新增 2 场 · 1 场信息有变化");

  // ① 我的场次变化:必须给出 from → to
  await expect(dialog.getByRole("heading", { name: "你的行程有 1 场变化" })).toBeVisible();
  await expect(dialog).toContainText("片长 80 → 90");

  // ② 我选过影片的新排期:同一部片换个影院也要认出来
  await expect(dialog.getByRole("heading", { name: "你选过的影片有 1 场新排期" })).toBeVisible();
  await expect(dialog).toContainText("CGV Centum City 6");

  // ③ 概况:与用户无关的新片按放映厅归并。
  // 标题断言写**全串**:两个数字来自不同集合时(场次=全部新增、放映厅数曾误用「其余新增」)
  // 会变成「2 场(1 家影院)」—— 夹具这 2 场分属 m1 / c6 两个厅,所以必须是 2。
  await expect(
    dialog.getByRole("heading", { name: "本次新增 2 场（2 个放映厅）" }),
  ).toBeVisible();
  await expect(dialog).toContainText("MEGABOX Busan Theater 1");

  await dialog.getByRole("button", { name: "知道了" }).click();
  await expect(dialog).toBeHidden();
  await expect(entry).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("biff.dataver.v1")))
    .toBe("e2e-v2");

  // 已确认的版本在刷新后不该再提示
  await ready(page, "/schedule");
  await expect(page.getByRole("button", { name: /数据更新/ })).toHaveCount(0);
});

test("排进行程:新增场次可直接落进行程,按钮变「已排进行程」", async ({ page }) => {
  await page.route("**/changelog.json", (route) => route.fulfill({ json: CHANGELOG }));
  await seed(page, {
    "biff.picks.v2": JSON.stringify([
      { key: keyOf("001"), picks: [{ code: "001" }], note: "" },
    ]),
  });
  await ready(page, "/schedule");
  await page.getByRole("button", { name: /数据更新/ }).click();
  const dialog = page.getByRole("dialog", { name: "排期数据更新" });
  await dialog.getByRole("button", { name: "排进行程" }).click();
  await expect(dialog).toContainText("已排进行程");
  const picks = await page.evaluate(() => localStorage.getItem("biff.picks.v2") ?? "");
  expect(picks).toContain("9901");
});
