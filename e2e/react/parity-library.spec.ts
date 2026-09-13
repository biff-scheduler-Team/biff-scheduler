import { expect, test } from "@playwright/test";
import { catalog, ready, seed, storage } from "./helpers";

const pick = (key: string, codes: string[] = [], note = "") => ({ key, picks: codes.map((code) => ({ code })), note });

test("activity search and normalized award sections retain legacy results", async ({ page }) => {
  await ready(page, "/library");
  const library = page.getByRole("region", { name: "影片库", exact: true });
  await library.getByRole("searchbox", { name: "搜索影片" }).fill("范冰冰");
  await expect(library.locator("[data-film-key]")).toHaveCount(1);
  await expect(library.locator('[data-film-key="cat:f072"] [data-screening]')).not.toHaveCount(0);
  await library.getByRole("searchbox", { name: "搜索影片" }).fill("");
  await expect(library.locator("[data-film-key]")).toHaveCount(40);
  await library.getByRole("button", { name: /单元/ }).click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.type("Asian Filmmaker");
  const award = page.getByRole("option", { name: /年度亚洲电影人奖/ });
  await expect(award).toHaveCount(1);
  await award.click();
  await expect(library.locator("[data-film-key]")).toHaveCount(4);
});

test("removing a scheduled film can be cancelled and confirms before deleting its data", async ({ page }) => {
  const entry = pick("cat:f001", ["001", "156"], "保留这条备注");
  await seed(page, { "biff.picks.v2": JSON.stringify([entry]) });
  await ready(page, "/picks");
  const remove = page.getByRole("button", { name: "移除影片 彼此的日夜", exact: true });
  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    expect(dialog.message()).toContain("已排 2 场");
    await dialog.dismiss();
  });
  await remove.click();
  expect(JSON.parse((await storage(page))["biff.picks.v2"])).toEqual([entry]);
  page.once("dialog", async (dialog) => { await dialog.accept(); });
  await remove.click();
  await expect(page.locator('[data-film-key="cat:f001"]')).toHaveCount(0);
  expect(JSON.parse((await storage(page))["biff.picks.v2"])).toEqual([]);
});

test("removing the only screening keeps the film in my picks, marked unscheduled", async ({ page }) => {
  // 2026-09-13 用户实测回归:一部片只排了一场,移出行程后**整部片从「我的选片」消失**
  // (旧实现把「最后一场 + 无备注」的记录整条删了,与帮助里「选片保留、标注未排场」相左)。
  await seed(page, { "biff.picks.v2": JSON.stringify([pick("cat:f001", ["001"])]) });
  await ready(page, "/picks?expand=cat%3Af001");
  const picks = page.getByRole("region", { name: "我的选片", exact: true });
  const film = picks.locator('[data-film-key="cat:f001"]');
  await film.getByRole("button", { name: "移出场次 001", exact: true }).click();
  // 片还在,状态行明说「未排场」,场次行可再次加入
  await expect(film).toBeVisible();
  await expect(film).toContainText("未排场");
  await expect(film.locator("[data-screening]")).toHaveCount(4);
  await expect(
    film.getByRole("button", { name: "加入场次 001", exact: true }),
  ).toBeVisible();
  expect(JSON.parse((await storage(page))["biff.picks.v2"])).toEqual([
    { key: "cat:f001", picks: [], note: "" },
  ]);
});

test("multiple selected dates filter picks only and disappear when no picked film offers them", async ({ page }) => {
  await seed(page, { "biff.picks.v2": JSON.stringify([pick("cat:f001"), pick("cat:f002")]) });
  await ready(page, "/picks?expand=cat%3Af001");
  const picks = page.getByRole("region", { name: "我的选片", exact: true });
  await picks.getByRole("button", { name: /选片日期/ }).click();
  await page.getByRole("option", { name: /^OCT 6 / }).click();
  await page.getByRole("option", { name: /^OCT 8 / }).click();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/pickDate=2026-10-06%2C2026-10-08/);
  await expect(picks.locator('[data-film-key="cat:f001"] [data-screening]')).toHaveCount(2);
  await expect(picks.locator('[data-film-key="cat:f002"]')).toHaveCount(0);
  await page.getByRole("link", { name: "影片库", exact: true }).click();
  const library = page.getByRole("region", { name: "影片库", exact: true });
  await expect(library.locator('[data-film-key="cat:f002"]')).toBeVisible();
  await expect(library.getByRole("button", { name: /选片日期/ })).toHaveCount(0);
  // /library 与 /picks 都是整页视图(App.tsx::fullPage):「打开我的观影」胶囊在这两条路由上
  // 是 hidden 的 —— 旧用例照 legacy 的抽屉假设写,自 945bd06 起就点不到。回选片走顶栏导航。
  // (2026-09-13 随 PLAN-20260913180837 修正;与本需求无关,只是这两条用例一直是红的。)
  await page.getByRole("link", { name: /^我的选片/ }).click();
  await page.getByRole("button", { name: "移除影片 彼此的日夜", exact: true }).click();
  await expect(page.locator('[data-film-key="cat:f002"]')).toBeVisible();
  await expect(page).not.toHaveURL(/pickDate=/);
});

test("go to screenings reveals an expanded film beyond the first 40 and clears dates", async ({ page }) => {
  await seed(page, { "biff.picks.v2": JSON.stringify(catalog.films.slice(0, 60).map((film) => pick(`cat:${film.id}`))) });
  await ready(page, "/library?q=贝德福德公园&pickDate=2026-10-06");
  await page.getByRole("button", { name: "已在选片，去排场次", exact: true }).click();
  await expect(page).toHaveURL(/\/picks\?.*expand=cat%3Af060/);
  await expect(page).not.toHaveURL(/pickDate=/);
  const target = page.locator('[data-film-key="cat:f060"]');
  await expect(target).toBeFocused();
  await expect(target.locator("[data-screening]")).toHaveCount(4);
  await expect(target).toBeInViewport();
});

test("film expansion survives tab switches and temporary search filters", async ({ page }) => {
  await seed(page, { "biff.picks.v2": JSON.stringify([pick("cat:f001")]) });
  await ready(page, "/library");
  const film = page.locator('[data-film-key="cat:f001"]');
  await film.getByRole("button", { name: "展开 彼此的日夜 场次", exact: true }).click();
  await expect(film.locator("[data-screening]")).toHaveCount(4);
  // /library 与 /picks 都是整页视图(App.tsx::fullPage):「打开我的观影」胶囊在这两条路由上
  // 是 hidden 的 —— 旧用例照 legacy 的抽屉假设写,自 945bd06 起就点不到。回选片走顶栏导航。
  // (2026-09-13 随 PLAN-20260913180837 修正;与本需求无关,只是这两条用例一直是红的。)
  await page.getByRole("link", { name: /^我的选片/ }).click();
  await page.getByRole("link", { name: "影片库", exact: true }).click();
  await expect(film.locator("[data-screening]")).toHaveCount(4);
  await page.getByRole("searchbox", { name: "搜索影片" }).fill("蓦然回首");
  await expect(film).toHaveCount(0);
  await page.getByRole("searchbox", { name: "搜索影片" }).fill("");
  await expect(film.locator("[data-screening]")).toHaveCount(4);
});

test("only my picks offers screening selection and stale codes are explained", async ({ page }) => {
  await seed(page, { "biff.picks.v2": JSON.stringify([pick("cat:f001", ["001", "old-code"])]) });
  await ready(page, "/library?q=彼此的日夜");
  const film = page.locator('[data-film-key="cat:f001"]');
  await expect(film.getByRole("button", { name: /^(加入|移出)场次 / })).toHaveCount(0);
  await expect(film.getByRole("button", { name: "定位场次 001", exact: true })).toBeVisible();
  await film.getByRole("button", { name: "已在选片，去排场次", exact: true }).click();
  await expect(film).toContainText("另有 1 场已排场次不在当前排期里");
  await expect(film.getByRole("button", { name: "移出场次 001", exact: true })).toBeVisible();
  await film.getByRole("button", { name: "彼此的日夜 影片资料", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "彼此的日夜", exact: true });
  await expect(detail.getByRole("button", { name: /^(加入|移出)场次 / })).toHaveCount(0);
  await expect(detail.locator("[data-screening]")).toHaveCount(0);
});

test("catalog-only details retain remarks, bilingual search and collection context", async ({ page }) => {
  await page.route("**/douban.json", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    delete data.mappings.f219;
    await route.fulfill({ json: data });
  });
  await ready(page, "/library?q=Beneath the Barren");
  const film = page.locator('[data-film-key="cat:f219"]');
  await expect(film.getByRole("button", { name: /^加入我的选片/ })).toHaveCount(0);
  await expect(film).toContainText("收录于合集");
  await film.getByRole("button", { name: "Beneath 影片资料", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "Beneath", exact: true });
  await expect(detail).toContainText("International Premiere");
  await expect(detail).toContainText("收录于合集");
  await expect(detail.getByRole("link", { name: "中文搜索", exact: true })).toHaveAttribute("href", "https://www.douban.com/search?q=Beneath");
  await expect(detail.getByRole("link", { name: "英文搜索", exact: true })).toHaveAttribute("href", "https://www.douban.com/search?q=Beneath%20the%20Barren");
});

test("related films retain year and rating alongside navigation", async ({ page }) => {
  await page.route("**/douban-related.json", (route) => route.fulfill({ json: {
    recs: { "37019225": [
      { id: "37269723", title: "本届推荐测试", year: "2026", rating: 8.2, url: "https://movie.douban.com/subject/37269723/" },
      { id: "123456789", title: "站外推荐测试", year: "1999", rating: 7.1, url: "https://movie.douban.com/subject/123456789/" },
    ] },
  } }));
  await ready(page, "/library/films/cat%3Af001");
  const detail = page.getByRole("dialog", { name: "彼此的日夜", exact: true });
  await expect(detail.getByRole("button", { name: "本届推荐测试，2026，豆瓣 8.2", exact: true })).toBeVisible();
  await expect(detail.getByRole("link", { name: "站外推荐测试，1999，豆瓣 7.1", exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "本届推荐测试，2026，豆瓣 8.2", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "蓦然回首", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(detail).toBeVisible();
});

test("the douban link is pinned to the right end of the film card action row", async ({ page }) => {
  // 2026-09-13 用户反馈:影片卡底部操作行里「豆瓣」是纯文本外链,夹在两个按钮中间显得像没做完
  // → 移到操作行最后一位并由 CSS 顶到行右端(PLAN-20260913183205)。
  // 断言两件事:它是该行最后一个子元素;它的右边缘贴齐行右端(而不是紧跟「资料」)。
  await ready(page, "/library?q=彼此的日夜");
  const film = page.locator('[data-film-key="cat:f001"]');
  const actions = film.locator(".film-actions");
  const douban = actions.getByRole("link", { name: /^豆瓣/ });
  await expect(douban).toBeVisible();
  await expect(actions.locator("> :last-child")).toHaveAttribute("href", /douban\.com/);
  const row = await actions.boundingBox();
  const link = await douban.boundingBox();
  if (!row || !link) throw new Error("操作行或豆瓣外链不可见,无法比对右边缘");
  expect(Math.abs(row.x + row.width - (link.x + link.width))).toBeLessThanOrEqual(2);
});
