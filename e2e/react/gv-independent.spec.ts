import {test,expect} from '@playwright/test';
import {ready,storage} from './helpers';

test('GV attendance toggles independently and survives selecting the film and reload', async ({page}) => {
  await ready(page,'/schedule?date=2026-10-07');
  const film=page.locator('[data-grid-code="008"]');
  const talk=page.getByRole('button',{name:'008 参加映后谈',exact:true});
  // 未选片时点映后 = 加入影片并参加映后谈
  await talk.click();
  await expect(film).toHaveAttribute('aria-pressed','true');
  await expect(talk).toHaveAttribute('aria-pressed','true');
  // 再点：保留正片，关掉映后
  await talk.click();
  await expect(talk).toHaveAttribute('aria-pressed','false');
  await expect(film).toHaveAttribute('aria-pressed','true');
  expect(JSON.parse((await storage(page))['biff.gvtalk.v1'])['008']).toBe(false);
  await talk.click();
  await expect(talk).toHaveAttribute('aria-pressed','true');
  await expect(film).toHaveAttribute('aria-pressed','true');
  await page.reload();
  await expect(talk).toHaveAttribute('aria-pressed','true');
  await expect(film).toHaveAttribute('aria-pressed','true');
});
