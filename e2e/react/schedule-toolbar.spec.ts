import {test, expect} from '@playwright/test';
import {ready} from './helpers';

test('dragging venue headers scrolls the screenings and scrolling screenings moves headers', async ({page}) => {
  await ready(page, '/schedule?date=2026-10-07');
  const header = page.locator('.venue-header-scroll');
  const body = page.locator('.gantt-scroll');
  await header.scrollIntoViewIfNeeded();
  const box = (await header.boundingBox())!;
  await page.mouse.move(box.x+230,box.y+28);
  await page.mouse.down();
  await page.mouse.move(box.x+110,box.y+28,{steps:6});
  await page.mouse.up();
  await expect.poll(()=>body.evaluate(el=>el.scrollLeft)).toBe(120);
  expect(await header.evaluate(el => el.closest('.gantt-scroll') !== null)).toBe(true);
  await body.evaluate(el=>{el.scrollLeft=480;});
  expect((await page.locator('.vertical-venue').first().boundingBox())!.x).toBe((await page.locator('.gantt-row').first().boundingBox())!.x);
  expect(await header.evaluate(el=>el.scrollLeft)).toBe(0);
});

test('filter trigger shares the legend row and expands working filters below', async ({page}) => {
  await ready(page, '/schedule?date=2026-10-07');
  const toolbar = page.locator('.schedule-legend');
  const trigger = toolbar.getByRole('button',{name:'排片筛选',exact:true});
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded','true');
  await page.locator('#schedule-filter-fields').getByText('KE',{exact:true}).click();
  await expect(page.locator('#schedule-filter-fields').getByRole('checkbox',{name:'KE',exact:true})).toBeChecked();
  await expect(page.locator('.gantt-slot.dimmed').first()).toBeVisible();
  await trigger.click();
  await expect(page.locator('#schedule-filter-fields')).toHaveCount(0);
});
