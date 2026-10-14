import {test,expect} from '@playwright/test';
import {keyOf,ready,seed} from './helpers';

test('venue header stays in flow until reaching the viewport top', async ({page}) => {
  await ready(page,'/schedule?date=2026-10-07');
  const grid=page.locator('.gantt-scroll');
  const header=page.locator('.venue-header-scroll');
  await grid.evaluate(el=>window.scrollTo(0,Math.max(1,el.getBoundingClientRect().top+scrollY-180)));
  await expect(page.locator('.floating-venue-overlay')).toHaveCount(0);
  expect((await header.boundingBox())!.y).toBeGreaterThan(100);
  await grid.evaluate(el=>window.scrollTo(0,el.getBoundingClientRect().top+scrollY+200));
  await expect.poll(async()=>Math.abs((await header.boundingBox())!.y)).toBeLessThanOrEqual(1);
  await grid.evaluate(el=>{el.scrollLeft=300;});
  expect((await header.locator('.vertical-venue').first().boundingBox())!.x).toBe((await page.locator('.gantt-row').first().boundingBox())!.x);
});

/** 行程里放一对**真实重叠**的场次(008 08:40–11:20 与 033 09:00–10:53,同日跨厅重叠),
 *  这样顶栏那枚「重叠 N」按钮**本该**出现 —— 断言「它不出现」才有意义。
 *  ⚠ 回归目标(2026-10-14,PLAN-20261014235720):顶栏冲突提示按钮已整体删除。删除前这条会红
 *    (按钮存在、文案含「重叠 1」)。冲突体系本身**不受影响** —— 甘特红卡 / 图例 / 卡片提示仍在,
 *    由 `agenda-gantt.spec.ts` 与 `share-export.spec.ts` 守着。 */
const overlapPicks = JSON.stringify(
  ['008', '033'].map((code) => ({key: keyOf(code), picks: [{code}], note: ''})),
);

test('顶栏不再显示「重叠 N」冲突按钮', async ({page}) => {
  await seed(page, {'biff.picks.v2': overlapPicks});
  await ready(page, '/schedule');
  const header = page.locator('.app-header');
  await expect(header.locator('.header-conflict')).toHaveCount(0);
  await expect(header).not.toContainText('重叠');
});
