import {test,expect} from '@playwright/test';
import {ready,storage} from './helpers';

test('three size choices scale the schedule and persist', async ({page}) => {
  await ready(page,'/schedule?date=2026-10-07');
  const group=page.getByRole('group',{name:'排片大小'});
  await expect(group.getByRole('button')).toHaveCount(3);
  await expect(group.getByRole('button',{name:'默认',exact:true})).toHaveAttribute('aria-pressed','true');
  const initial=(await page.locator('[data-grid-code="008"]').boundingBox())!.height;
  await group.getByRole('button',{name:'大',exact:true}).click();
  await expect(group.getByRole('button',{name:'大',exact:true})).toHaveAttribute('aria-pressed','true');
  expect((await page.locator('[data-grid-code="008"]').boundingBox())!.height).toBeGreaterThan(initial);
  expect(JSON.parse((await storage(page))['biff.settings.v1']).zoom).toBe(0.75);
  await page.reload();
  await expect(group.getByRole('button',{name:'大',exact:true})).toHaveAttribute('aria-pressed','true');
});
