import {test, expect} from '@playwright/test';
import {ready} from './helpers';

test('ticket timer ticks each second and advances to the next batch at opening', async ({page}) => {
  // install 后时钟仍随墙钟走；pauseAt 钉住再进页，避免 ready 耗时吞掉倒计时
  await page.clock.install({time: new Date('2026-09-17T13:59:58+09:00')});
  await page.clock.pauseAt(new Date('2026-09-17T13:59:58+09:00'));
  await ready(page, '/schedule');
  const timer = page.getByRole('timer');
  await expect(timer).toContainText('00:00:02');
  await page.clock.fastForward(1000);
  await expect(timer).toContainText('00:00:01');
  await page.clock.fastForward(1000);
  await expect(page.getByRole('button',{name:/距第 2 批开票/})).toBeVisible();
  await page.getByRole('button',{name:/距第 2 批开票/}).click();
  await expect(page.getByRole('dialog',{name:'购票信息',exact:true})).toBeVisible();
});

test('seconds appear only in the final hour, including the one-hour boundary', async ({page}) => {
  await page.clock.install({time: new Date('2026-09-17T12:59:59+09:00')});
  await page.clock.pauseAt(new Date('2026-09-17T12:59:59+09:00'));
  await ready(page, '/schedule');
  const timer = page.getByRole('timer');
  await expect(timer).toHaveText('0天01:00');
  await expect(timer).not.toHaveAttribute('aria-label', /秒/);
  await page.clock.fastForward(1000);
  await expect(timer).toHaveText('0天01:00:00');
  await page.clock.fastForward(1000);
  await expect(timer).toHaveText('0天00:59:59');
});
