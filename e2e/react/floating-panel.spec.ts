import {test, expect} from '@playwright/test';
import {ready} from './helpers';

test('desktop split squeezes the schedule to about 1:3 when viewing opens', async ({page, isMobile}) => {
  test.skip(isMobile, '1:3 挤压分栏只在桌面 ≥1100；窄屏仍是浮层，宽度不应被挤');

  await ready(page, '/schedule?date=2026-10-07');
  // ⚠ 收在「排片表那一列」:面板打开后「我的行程」自己也有一张甘特(`PLAN-20260921223658`),
  //   不加作用域会同时命中两边
  const grid = page.locator('.schedule-column .gantt-scroll');
  const before = (await grid.boundingBox())!.width;
  await page.locator('[data-grid-code="008"]').click();
  await expect(page.locator('[data-grid-code="008"]')).toHaveAttribute('aria-pressed','true');
  expect(new URL(page.url()).pathname).toBe('/schedule');
  await expect(page.locator('#viewing-panel')).toHaveCount(0);
  expect((await grid.boundingBox())!.width).toBe(before);
  const position = await grid.evaluate(el=>({left:el.scrollLeft,y:scrollY}));
  await page.getByRole('button',{name:'打开我的观影',exact:true}).click();
  await expect(page.getByRole('complementary',{name:'我的观影'})).toBeVisible();
  const after = (await grid.boundingBox())!.width;
  // 桌面 ≥1100 真实分栏：排片应变窄（不再「宽度不变」）
  expect(after).toBeLessThan(before * 0.95);
  const panel = (await page.locator('#viewing-panel').boundingBox())!;
  const schedule = (await page.locator('.schedule-column').boundingBox())!;
  const ratio = panel.width / schedule.width;
  expect(ratio).toBeGreaterThan(0.25);
  expect(ratio).toBeLessThan(0.45);
  expect(await grid.evaluate(el=>({left:el.scrollLeft,y:scrollY}))).toEqual(position);
  expect(panel.x).toBeGreaterThanOrEqual(0);
  expect(panel.y).toBeGreaterThanOrEqual(0);
  expect(panel.x + panel.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await page.locator("#viewing-panel").getByRole('link',{name:/^我的选片/}).click();
  await expect(page.getByRole('region',{name:'我的选片',exact:true})).toBeVisible();
  // 「定位场次」现在挂在「我的选片」的场次卡上(行程卡片 2026-09-21 摘掉,见 PLAN-20260921223658
  // 修订 1);面板里那部片默认收着,先「查看场次」把它展开才露出场次卡
  await page.locator('#viewing-panel').getByRole('button',{name:/^展开 .+ 场次$/}).first().click();
  await page.getByRole('button',{name:'定位场次 008',exact:true}).click();
  await expect(page.locator('#viewing-panel')).toHaveCount(0);
  await expect(page.locator('[data-grid-slot="008"]')).toHaveClass(/schedule-located/);
  await page.getByRole('button',{name:'打开我的观影',exact:true}).click();
  await page.getByRole('button',{name:'收起选片面板',exact:true}).click();
  await expect(page.getByRole('button',{name:'打开我的观影',exact:true})).toBeFocused();
});

test('navigation opens full pages while quick viewing stays optional', async ({page}) => {
  await ready(page, '/schedule?date=2026-10-07');
  const nav = page.getByRole('navigation',{name:'主要导航'});
  await nav.getByRole('link',{name:'我的选片',exact:true}).click();
  await expect(page.getByRole('region',{name:'我的选片',exact:true})).toBeVisible();
  await expect(page.locator('#viewing-panel')).toHaveCount(0);
  await expect(page.locator('.schedule-column')).toBeHidden();
  await nav.getByRole('link',{name:'我的行程',exact:true}).click();
  await expect(page.getByRole('region',{name:'我的行程',exact:true})).toBeVisible();
  await page.reload();
  await expect(page.locator('#viewing-panel')).toHaveCount(0);
  await nav.getByRole('link',{name:'排片表',exact:true}).click();
  await page.getByRole('button',{name:'打开我的观影',exact:true}).click();
  await expect(page.locator('#viewing-panel')).toBeVisible();
  await expect(page.locator('.schedule-column')).toBeVisible();
  await page.getByRole('link',{name:'打开完整页面',exact:true}).click();
  await expect(page.locator('#viewing-panel')).toHaveCount(0);
  await expect(page.locator('.schedule-column')).toBeHidden();
  expect(new URL(page.url()).searchParams.has('quick')).toBe(false);
});
