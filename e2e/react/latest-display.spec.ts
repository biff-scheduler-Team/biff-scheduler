import {test, expect} from '@playwright/test';
import {ready} from './helpers';

test('schedule uses the official still and a single time-range row', async ({page}) => {
  await ready(page, '/schedule?date=2026-10-07');
  const card = page.locator('[data-grid-code="008"]');
  const img = card.locator('img');
  await expect(img).toHaveAttribute('src', 'https://d2j6u4o1bq9z89.cloudfront.net/9611_DATA/FILM_PHOTO/2026_MS8H_SL8F/1787042573.jpg');
  await expect(card.locator('.gantt-time > span').nth(1)).toHaveText('08:40-10:55');
});

test('empty time before and after the day is trimmed and explained', async ({page}) => {
  await ready(page, '/schedule?date=2026-10-06');
  await expect(page.locator('.ruler-track button').first()).toHaveText('18:00');
  await expect(page.locator('.ruler-track button').last()).toHaveText('20:00');
  await expect(page.getByText('18:00 之前无影片',{exact:true})).toBeVisible();
  await expect(page.getByText('20:00 之后无影片',{exact:true})).toBeVisible();
});

test('legacy promotes the new version while other header actions are neutral', async ({page}) => {
  await page.goto('/legacy/');
  const link = page.getByRole('link',{name:'体验新版',exact:true});
  await expect(link).toHaveCSS('background-color','rgb(206, 30, 54)');
  await expect(page.locator('#ticket-banner')).not.toHaveCSS('background-image',/linear-gradient/);
  await link.click();
  await expect(page.getByRole('navigation',{name:'主要导航'})).toBeVisible();
});
