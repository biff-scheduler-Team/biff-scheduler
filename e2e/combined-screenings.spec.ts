import {test,expect} from '@playwright/test';
import {ready,storage} from './helpers';

test('combined screenings show each film and remain a single selectable session', async ({page}) => {
  await ready(page,'/schedule?date=2026-10-07');
  const card=page.locator('[data-grid-code="010"]');
  await expect(card.locator('.gantt-member-artwork img')).toHaveCount(2);
  await expect(card).toContainText('巴士站');
  await expect(card).toContainText('肉体冲击力');
  await expect(card.locator('[data-badge="batch"]')).toHaveCount(1);
  await card.click();
  const picks=JSON.parse((await storage(page))['biff.picks.v2']);
  expect(picks.flatMap((p:{picks:{code:string}[]})=>p.picks.map(s=>s.code))).toEqual(['010']);
  await page.getByRole('button',{name:'场次 010 影片资料',exact:true}).click();
  const preview=page.getByRole('dialog',{name:'场次 010 影片预览',exact:true});
  await expect(preview.getByRole('region',{name:'联映影片'})).toContainText('2 部联映');
  await expect(preview).toContainText('96 分钟');
  await expect(preview).toContainText('17 分钟');
  await preview.getByRole('button',{name:'查看 肉体冲击力 影片资料',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'肉体冲击力',exact:true})).toBeVisible();
  expect(JSON.parse((await storage(page))['biff.picks.v2'])).toEqual(picks);
});
