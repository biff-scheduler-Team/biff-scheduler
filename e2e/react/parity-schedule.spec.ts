import { expect, test } from "@playwright/test";
import { keyOf, ready, seed, storage } from "./helpers";

const picks = (codes: string[]) =>
  JSON.stringify(
    codes.map((code) => ({
      key: keyOf(code),
      picks: [{ code }],
      note: "",
    })),
  );

test.describe("schedule interaction parity", () => {
  test.use({ timezoneId: "Asia/Seoul" });

  test("GV clicks change attendance without adding the film", async ({
    page,
  }) => {
    await ready(page);
    const talk = page.locator('[data-grid-slot="001"] .gantt-talk');
    const film = page.locator('[data-grid-code="001"]');
    // 未选：点映后 = 加入并参加
    await talk.click();
    await expect(film).toHaveAttribute("aria-pressed", "true");
    await expect(talk).toHaveAttribute("aria-pressed", "true");
    // 已选：再点只关映后，保留正片
    await talk.click();
    await expect(film).toHaveAttribute("aria-pressed", "true");
    await expect(talk).toHaveAttribute("aria-pressed", "false");
    expect(JSON.parse((await storage(page))["biff.gvtalk.v1"])["001"]).toBe(
      false,
    );
    await talk.click();
    await expect(talk).toHaveAttribute("aria-pressed", "true");
  });

  test("locating a hidden venue restores it, clears the hour, and preserves the agenda", async ({
    page,
  }) => {
    await seed(page, {
      "biff.picks.v2": picks(["001"]),
      "biff.filters.v1": JSON.stringify({
        venues: ["br"],
        venueMode: "exclude",
        subs: [],
        gv: null,
      }),
    });
    await ready(page, "/agenda?date=2026-10-06&hour=18");
    await expect(page.locator('[data-grid-code="001"]')).toHaveCount(0);
    const locate = page.getByRole("button", {
      name: "定位场次 001",
      exact: true,
    });
    await locate.click();
    await expect(page.locator('[data-grid-code="001"]')).toBeVisible();
    await expect(page.locator(".side-panel")).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/schedule");
    expect(new URL(page.url()).searchParams.has("hour")).toBe(false);
    expect(JSON.parse((await storage(page))["biff.filters.v1"]).venues).toEqual(
      [],
    );
    const token = new URL(page.url()).searchParams.get("locate");
    await page.getByRole("button", {name: "打开我的观影", exact: true}).click();
    await locate.click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("locate"))
      .not.toBe(token);
    await expect(page.locator('[data-grid-slot="001"]')).toHaveClass(
      /schedule-located/,
    );
  });

  test("locating a day returns to the top and highlights every selected screening", async ({
    page,
  }) => {
    await seed(page, { "biff.picks.v2": picks(["008", "009"]) });
    await ready(page, "/agenda?date=2026-10-07");
    const grid = page.locator(".gantt-scroll");
    await grid.evaluate((el) => {
      el.scrollTop = 600;
    });
    await page
      .getByRole("button", { name: "定位当日 2026-10-07", exact: true })
      .click();
    await expect.poll(() => grid.evaluate((el) => el.scrollTop)).toBe(0);
    await expect(page.locator('[data-grid-slot="008"]')).toHaveClass(
      /schedule-located/,
    );
    await expect(page.locator('[data-grid-slot="009"]')).toHaveClass(
      /schedule-located/,
    );
    await expect(page.locator(".side-panel")).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has("focus")).toBe(false);
  });

  test("card dragging pans without picking, while Ctrl and Meta wheel zoom the Gantt", async ({
    page,
  }) => {
    await ready(page, "/schedule?date=2026-10-07");
    const grid = page.locator(".gantt-scroll");
    await grid.evaluate((el) => {
      el.scrollLeft = 350;
      window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 100);
    });
    const point = await grid.evaluate((el) => {
      const parent = el.getBoundingClientRect();
      const card = [...el.querySelectorAll<HTMLElement>(".gantt-film")].find(
        (node) => {
          const r = node.getBoundingClientRect();
          return (
            r.left > parent.left + 200 &&
            r.left + 40 < parent.right &&
            r.top > parent.top + 44 &&
            r.bottom < innerHeight
          );
        },
      )!;
      const r = card.getBoundingClientRect();
      return { x: r.left + 30, y: r.top + 25, code: card.dataset.gridCode };
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x - 100, point.y, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => grid.evaluate((el) => el.scrollLeft)).toBe(450);
    await expect(
      page.locator(`[data-grid-code="${point.code}"]`),
    ).toHaveAttribute("aria-pressed", "false");
    for (const modifier of ["ctrlKey", "metaKey"] as const) {
      const prevented = await grid.evaluate((el, modifier) => {
        const event = new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          [modifier]: true,
          deltaY: 60,
        });
        el.dispatchEvent(event);
        return event.defaultPrevented;
      }, modifier);
      expect(prevented).toBe(true);
    }
    await expect(
      page.getByRole("group", { name: "排片大小" }).getByRole("button", { name: "小", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("selecting a screening keeps the panel closed and the screening visible", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await ready(page, "/schedule?date=2026-10-07");
    await page
      .locator('[data-grid-code="009"]')
      .click({ position: { x: 30, y: 25 } });
    await expect(page.locator(".side-panel")).toHaveCount(0);
    await expect
      .poll(() =>
        page.locator(".gantt-scroll").evaluate((el) => {
          const view = el.getBoundingClientRect();
          const card = el
            .querySelector('[data-grid-code="009"]')!
            .getBoundingClientRect();
          return card.left >= view.left && card.right <= view.right;
        }),
      )
      .toBe(true);
  });

  test("fit keeps readable columns and changing the date resets horizontal scrolling", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 1000 });
    await ready(page, "/schedule?date=2026-10-07");
    const grid = page.locator(".gantt-scroll");
    // React 排片表已无「适应」按钮：窄视口下仍应可横向滚动影厅列
    await expect
      .poll(() => grid.evaluate((el) => el.scrollWidth > el.clientWidth))
      .toBe(true);
    await page
      .getByRole("button", { name: "选择日期 2026-10-07", exact: true })
      .click();
    await expect(page.locator('[data-grid-code="008"]')).toHaveCount(1);
    await grid.evaluate((el) => {
      el.scrollLeft = 500;
      el.scrollTop = 700;
    });
    await page
      .getByRole("button", { name: "选择日期 2026-10-08", exact: true })
      .click();
    await expect
      .poll(() => grid.evaluate((el) => [el.scrollLeft, el.scrollTop]))
      .toEqual([0, 0]);
  });

  test("the current-time marker advances across a minute without moving the viewport", async ({
    page,
  }) => {
    await page.clock.install({ time: new Date("2026-10-07T12:00:00+09:00") });
    await ready(page, "/schedule?date=2026-10-07");
    const grid = page.locator(".gantt-scroll");
    await expect(page.locator(".schedule-now-label")).toHaveText("现在 12:00");
    await grid.evaluate((el) => {
      el.scrollLeft = 300;
      el.scrollTop = 500;
    });
    await page.clock.fastForward(60_000);
    await expect(page.locator(".schedule-now-label")).toHaveText("现在 12:01");
    await expect(grid).toHaveJSProperty("scrollLeft", 300);
    await expect(grid).toHaveJSProperty("scrollTop", 0);
  });

  test("a conflict tooltip identifies the other screening and its venue", async ({
    page,
  }) => {
    await seed(page, { "biff.picks.v2": picks(["008", "033"]) });
    await ready(page, "/agenda?date=2026-10-07");
    await expect(page.locator('[data-grid-code="008"]')).toHaveAttribute(
      "title",
      /033《.+》09:00–10:53 · C5/,
    );
    await expect(page.locator('[data-grid-code="008"]')).toHaveAttribute(
      "aria-description",
      /033/,
    );
  });
});
