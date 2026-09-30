import { test } from "@playwright/test";

/* ★ 本文件的两条用例已于 2026-09-30 删除(`PLAN-20260930213528`),它们断言的元素只长在
 * 「我的行程」的**卡片视图**上,而卡片视图整体下线:
 *
 * ① 「hour selection highlights only same-day agenda cards using the official slot」
 *    —— 排片表的整点筛选通过 `slotFilter` 在**场次卡**上打 `data-hour-match` / `title`。
 *    卡片视图是那条联动的唯一展示面;日程表画布不接 `slotFilter`(这一页没有整点筛选,
 *    见 `agenda-gantt.spec.ts` 的同名断言)。
 * ② 「a non-GV preceding screening is never labeled as skipping a talk」
 *    —— 「间隔 N 分钟 / 上场弃映后」那行(`.gap-label`)只存在于卡片视图的按日列表里。
 *
 * ⚠ 留一个空文件而不是直接删:`scripts/test-map.json` 与 `docs/TEST-MAP.md` 里登记着
 *   这个 spec 名,删文件要同时动那两处 —— 等哪天真有新的「跨视图联动手势」用例要落,
 *   直接复用这个名字即可。 */

test.skip("（占位）卡片视图下线后暂无跨视图联动用例", () => {});
