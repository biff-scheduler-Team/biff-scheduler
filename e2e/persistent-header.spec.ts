import {test,expect} from '@playwright/test';
import {ready} from './helpers';

test('venue header stays in flow until reaching the viewport top', async ({page}) => {
  await ready(page,'/schedule?date=2026-10-07');
  const grid=page.locator('.gantt-scroll');
  const header=page.locator('.venue-header-scroll');
  await grid.evaluate(el=>window.scrollTo(0,Math.max(1,el.getBoundingClientRect().top+scrollY-180)));
  await expect(page.locator('.floating-venue-overlay')).toHaveCount(0);
  expect((await header.boundingBox())!.y).toBeGreaterThan(100);
  await grid.evaluate(el=>window.scrollTo(0,el.getBoundingClientRect().top+scrollY+200));
  await expect.poll(async()=>Math.abs((await header.boundingBox())!.y)).toBeLessThanOrEqual(1);
  await grid.evaluate(el=>{el.scrollLeft=300;});
  expect((await header.locator('.vertical-venue').first().boundingBox())!.x).toBe((await page.locator('.gantt-row').first().boundingBox())!.x);
});
