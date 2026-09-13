import {test, expect} from '@playwright/test';
import {catalog, hourTickPx, ready} from './helpers';

test('larger posters retain their ratio and empty overnight hours are omitted', async ({page}) => {
  await ready(page, '/schedule?date=2026-10-07');
  await expect(page.locator('.ruler-track button')).not.toContainText(['次日 01:00']);
  const poster = page.locator('[data-grid-code="008"] img');
  const box = (await poster.boundingBox())!;
  // 官方剧照 16:9（不再是旧竖版海报 2:3）
  expect(box.width / box.height).toBeCloseTo(16 / 9, 1);
  expect(box.width).toBeGreaterThan(80);
  const ticks = await page.locator('.ruler-track button').evaluateAll(els => els.slice(0,2).map(el=>el.getBoundingClientRect().top));
  expect(ticks[1]-ticks[0]).toBe(hourTickPx());
  const night = catalog.schedule.screenings.find(s=>Number(s.end_time.split(':')[0]) >= 25)!;
  await page.getByRole('button',{name:`选择日期 ${night.date}`,exact:true}).click();
  await expect(page.getByRole('button',{name:'筛选 次日 01:00 时段',exact:true})).toBeVisible();
  await expect(page.locator(`[data-grid-code="${night.code}"]`)).toHaveCount(1);
});
