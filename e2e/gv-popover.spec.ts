import {test,expect} from '@playwright/test';
import {ready,storage} from './helpers';

test('GV edit uses an anchored popover with draft, cancel, save and restore-default behavior', async ({page}) => {
  await ready(page,'/schedule?date=2026-10-07');
  const film=page.locator('[data-grid-code="008"]');
  await film.click();
  const trigger=page.getByRole('button',{name:'调整 008 映后时长',exact:true});
  await trigger.click();
  const dialog=page.locator('.gv-duration-popover').getByRole('dialog',{name:'008 映后谈',exact:true});
  await expect(dialog).toBeVisible();
  const input=dialog.getByRole('textbox',{name:'本场映后时长（分钟）',exact:true});
  await input.fill('40');
  await input.press('Tab');
  expect((await storage(page))['biff.gvtalkmin.v1']).toBeUndefined();
  await dialog.getByRole('button',{name:'取消',exact:true}).click();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(input).toHaveValue('');
  await input.fill('40');
  await dialog.getByRole('button',{name:'保存映后时长',exact:true}).click();
  expect(JSON.parse((await storage(page))['biff.gvtalkmin.v1'])['008']).toBe(40);
  await expect(film).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('button',{name:'008 参加映后谈',exact:true})).toHaveAttribute('aria-pressed','true');
  await trigger.click();
  await dialog.getByRole('button',{name:'跟随默认（25 分钟）',exact:true}).click();
  expect(JSON.parse((await storage(page))['biff.gvtalkmin.v1'])['008']).toBeUndefined();
});
