import { test, expect } from "@playwright/test";
import { keyOf, ready, seed, storage } from "./helpers";
const picks = (codes: string[]) =>
  JSON.stringify(
    codes.map((code) => ({ key: keyOf(code), picks: [{ code }], note: "" })),
  );

test("hour selection highlights only same-day agenda cards using the official slot", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1512, height: 982 });
  await seed(page, {
    "biff.picks.v2": picks(["001", "008", "011"]),
    "biff.gvtalk.v1": '{"008":false}',
  });
  await ready(page, "/agenda?date=2026-10-07&quick=1");
  await page
    .getByRole("button", { name: "筛选 11:00 时段", exact: true })
    .click();
  const agenda = page.getByRole("region", { name: "我的行程", exact: true });
  // 008 film-only ends10:55, but official end11:20 still overlaps the selected hour, as in legacy.
  await expect(agenda.locator('[data-screening="008"]')).toHaveAttribute(
    "data-hour-match",
    "true",
  );
  await expect(agenda.locator('[data-screening="008"]')).toHaveAttribute(
    "title",
    /11:00–12:00/,
  );
  await expect(agenda.locator('[data-screening="011"]')).toHaveAttribute(
    "data-hour-match",
    "false",
  );
  await expect(agenda.locator('[data-screening="001"]')).not.toHaveAttribute(
    "data-hour-match",
    /./,
  );
  await page.getByRole("button", { name: "清除时段筛选", exact: true }).click();
  await expect(agenda.locator("[data-hour-match]")).toHaveCount(0);
  expect(JSON.parse((await storage(page))["biff.gvtalk.v1"])).toEqual({
    "008": false,
  });
});

test("a non-GV preceding screening is never labeled as skipping a talk", async ({
  page,
}) => {
  await seed(page, {
    "biff.picks.v2": picks(["033", "034"]),
    "biff.settings.v1": '{"gvTalkOn":false}',
  });
  await ready(page, "/agenda");
  const gaps = page
    .getByRole("region", { name: "我的行程", exact: true })
    .locator(".gap-label");
  await expect(gaps).toHaveCount(1);
  await expect(gaps).toContainText("间隔 67 分钟");
  await expect(gaps).not.toContainText("上场弃映后");
});
