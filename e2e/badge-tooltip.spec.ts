import {test,expect} from '@playwright/test';
import {ready} from './helpers';

test('each film badge immediately explains itself without changing selection', async ({page}) => {
  await ready(page,'/schedule?date=2026-10-07');
  const card=page.locator('[data-grid-code="008"]');
  for(const [kind,text] of [['rating-15','未满 15 岁不得入场'],['subs-KE','韩'],['gv','嘉宾'],['code','场次编号']]) {
    await card.locator(`[data-badge="${kind}"]`).hover();
    await expect(page.getByRole('tooltip')).toContainText(text,{timeout:500});
    await expect(card).toHaveAttribute('aria-pressed','false');
    await page.mouse.move(0,0);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
  }
});
