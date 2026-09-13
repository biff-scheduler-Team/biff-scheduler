import {expect, test} from '@playwright/test';
import {ready, seed, keyOf, storage} from './helpers';

test('page owns vertical scrolling and the grid owns venue scrolling', async ({page, browserName, isMobile}) => {
  await ready(page, '/schedule?date=2026-10-07');
  const grid = page.locator('.gantt-scroll');
  await grid.evaluate(el => window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 100));
  const before = await page.evaluate(() => scrollY);
  if (browserName === 'webkit' && isMobile) {
    // Playwright cannot inject wheel or swipe input into mobile WebKit.
    // Verify its document scroll geometry; Chromium below exercises real wheel input.
    await page.evaluate(() => window.scrollBy(0, 350));
  } else {
    await page.mouse.move(200, 300);
    await page.mouse.wheel(0, 350);
  }
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(before + 100);
  await expect(grid).toHaveJSProperty('scrollTop', 0);
  expect(await grid.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await grid.evaluate(el => {el.scrollLeft = 400;});
  expect((await page.locator('.vertical-venue').first().boundingBox())!.x).toBe((await page.locator('.gantt-row').first().boundingBox())!.x);
  const header = await page.locator('.venue-header-scroll').boundingBox();
  expect(header!.y).toBeLessThanOrEqual(1);
  const rail = await page.locator('.schedule-time-column').boundingBox();
  const viewport = await grid.boundingBox();
  expect(rail!.x + rail!.width).toBeCloseTo(viewport!.x, 0);
});

test('GV duration changes the vertical segment and survives reload without altering attendance', async ({page}) => {
  await seed(page, {'biff.picks.v2': JSON.stringify([{key: keyOf('001'), picks: [{code:'001'}], note:''}])});
  await ready(page, '/schedule?date=2026-10-06');
  const talk = page.locator('[data-grid-slot="001"] .gantt-talk');
  await page.getByRole('button', {name:'调整 001 映后时长', exact:true}).click();
  const dialog = page.getByRole('dialog', {name:'001 映后谈', exact:true});
  await dialog.getByRole('textbox', {name:'本场映后时长（分钟）'}).fill('40');
  await dialog.getByRole('button', {name:'保存映后时长', exact:true}).click();
  expect((await talk.boundingBox())!.height).toBeCloseTo(40 * 4 * 0.55, 0);
  expect(JSON.parse((await storage(page))['biff.picks.v2'])[0].picks).toEqual([{code:'001'}]);
  await page.reload();
  await expect(talk).toContainText('40′');
  const film = await page.locator('[data-grid-code="001"]').boundingBox();
  const segment = await talk.boundingBox();
  expect(segment!.y).toBeCloseTo(film!.y + film!.height, 0);
});
