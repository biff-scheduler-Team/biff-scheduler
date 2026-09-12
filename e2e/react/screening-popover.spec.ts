import {test,expect} from '@playwright/test';
import {ready,storage} from './helpers';

test('info click opens an anchored preview without picking or navigation; full details remain available', async ({page}) => {
  await ready(page,'/schedule?date=2026-10-07');
  const before=await storage(page);
  const trigger=page.getByRole('button',{name:'场次 008 影片资料',exact:true});
  await trigger.click();
  const preview=page.getByRole('dialog',{name:'场次 008 影片预览',exact:true});
  await expect(preview).toBeVisible();
  await expect(preview.locator('.preview-poster')).toHaveAttribute('src', /\/posters\//);
  await expect(preview.getByRole('link',{name:'在豆瓣打开',exact:true})).toHaveAttribute('href', /douban.com/);
  await expect(preview).toHaveCSS('gap','4px');
  expect(new URL(page.url()).pathname).toBe('/schedule');
  expect(await storage(page)).toEqual(before);
  await page.mouse.move(0,0);
  await expect(preview).toBeVisible();
  await preview.getByRole('button',{name:'查看完整影片资料',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'宛如星辰的你',exact:true})).toBeVisible();
  expect(new URL(page.url()).searchParams.get('filmCode')).toBe('008');
});

test('hover preview stays open across the gap and closes when leaving; Escape restores click focus', async ({page}) => {
  await ready(page,'/schedule?date=2026-10-07');
  const trigger=page.getByRole('button',{name:'场次 008 影片资料',exact:true});
  await trigger.hover();
  const preview=page.getByRole('dialog',{name:'场次 008 影片预览',exact:true});
  await expect(preview).toBeVisible();
  const previewBox = (await preview.boundingBox())!;
  await page.mouse.move(previewBox.x + 12, Math.max(12, previewBox.y + 12));
  await expect(preview).toBeVisible();
  await page.mouse.move(0,0);
  await expect(preview).toHaveCount(0);
  await trigger.click();
  await expect(preview).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('preview includes the complete synopsis and both related-film groups in smaller type', async ({page}) => {
  await ready(page,'/schedule?date=2026-10-07');
  await page.getByRole('button',{name:'场次 005 影片资料',exact:true}).click();
  const preview=page.getByRole('dialog',{name:'场次 005 影片预览',exact:true});
  await expect(preview).toBeVisible();
  await expect(preview.locator('.preview-intro')).toHaveCSS('-webkit-line-clamp','none');
  const festival=preview.getByRole('region',{name:'本届相关影片'});
  const more=preview.getByRole('region',{name:'更多相关电影'});
  await expect(festival).toBeVisible();
  await expect(more).toBeVisible();
  await expect(more.getByRole('link').first()).toHaveCSS('font-size','11px');
  await festival.getByRole('button').first().click();
  await expect(page).toHaveURL(/\/films\//);
  expect(new URL(page.url()).searchParams.get('filmCode')).not.toBe('005');
});
