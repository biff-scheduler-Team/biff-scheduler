import {test, expect} from '@playwright/test';
import {ready} from './helpers';

test('dates share a time range and every hourly tick has the same spacing', async ({page}) => {
  // 10-07 场次多，轴未裁到只剩 2–3 小时；10-06 会被 trim 成 18–20
  await ready(page, '/schedule?date=2026-10-07');
  const ticks = page.locator('.ruler-track button');
  const labels = await ticks.allTextContents();
  expect(labels.length).toBeGreaterThan(12);
  const positions = await ticks.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().top));
  const interval = positions[1] - positions[0];
  for(let i = 1; i < positions.length; i++) expect(positions[i]-positions[i-1]).toBeCloseTo(interval, 1);
  await page.getByRole('button',{name:'选择日期 2026-10-08',exact:true}).click();
  await expect(ticks.first()).toBeVisible();
  const labels2 = await ticks.allTextContents();
  // 换日后仍等距；刻度集合可因当日场次窗不同而变化，但间距不变
  const positions2 = await ticks.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().top));
  if (positions2.length > 1) {
    const interval2 = positions2[1] - positions2[0];
    for(let i = 1; i < positions2.length; i++) expect(positions2[i]-positions2[i-1]).toBeCloseTo(interval2, 1);
  }
  expect(labels2.length).toBeGreaterThan(8);
  await expect(page.locator('.vertical-corner svg')).toBeVisible();
  await expect(page.locator('.vertical-corner')).toHaveAttribute('aria-label', /韩国时间 KST/);
  await page.getByRole('button',{name:'筛选 09:00 时段',exact:true}).click();
  await expect(page.getByText('正在查看 09:00 时段',{exact:true})).toBeVisible();
});
