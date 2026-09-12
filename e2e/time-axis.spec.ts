import {test, expect} from '@playwright/test';
import {ready} from './helpers';

test('dates share a time range and every hourly tick has the same spacing', async ({page}) => {
  await ready(page, '/schedule?date=2026-10-06');
  const ticks = page.locator('.ruler-track button');
  const labels = await ticks.allTextContents();
  expect(labels.length).toBeGreaterThan(12);
  const positions = await ticks.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().top));
  const interval = positions[1] - positions[0];
  for(let i = 1; i < positions.length; i++) expect(positions[i]-positions[i-1]).toBeCloseTo(interval, 1);
  await page.getByRole('button',{name:'选择日期 2026-10-07',exact:true}).click();
  await expect(ticks).toHaveText(labels);
  await expect(page.locator('.vertical-corner svg')).toBeVisible();
  await expect(page.locator('.vertical-corner')).toHaveAttribute('aria-label', /韩国时间 KST/);
  await page.getByRole('button',{name:'筛选 09:00 时段',exact:true}).click();
  await expect(page.getByText('正在查看 09:00 时段',{exact:true})).toBeVisible();
});
