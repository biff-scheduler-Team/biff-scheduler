// 场次「加入行程 / 移出行程」的唯一 UI 出口(2026-09-16,`PLAN-20260916004024`)。
//
// 为什么单开一处:取消**只有一场**的影片会连选片记录一起移除(`state.ts::toggleScreening`)——
// 那是必须的(留下空记录会被载入时的 `fillSoleShowPicks()` 补回来,用户看到的是「删不掉」),
// 但**必须先告诉用户**,否则他会以为「怎么点一下整部片就没了」。
// 网格点选(`SchedulePage`)与场次卡(`ScreeningCard`,`我的选片` / `我的行程` 共用)都走这里 ——
// 提示只有一处实现,不会出现「某条路径静默删了选片」。
//
// ⚠ 多场片一律**不弹**:移出一场是日常操作,每次都打断才是真的增加使用成本。
//
// ★ 2026-09-22(`PLAN-20260922123138`)把「会不会连带移除选片」抽成 `removalDropsPick()`:
//   「我的行程 → 日程表」的画布上每一格都是我的场次,点一下 = 移出行程,原先**静默无撤销**,
//   用户要求二次确认。那个弹层要用**同一判据**写「这一场移出会顺带把这部片一起移除」的文案,
//   并且不能让用户先看弹层、再吃一个原生 confirm —— 于是判据抽出来,调用方用
//   `soleShowAsked` 声明「我已经问过了」。默认(不传)行为与改前逐字一致。

import { useCallback } from "react";
import { useCatalog } from "../app/store";
import { slotOf, soleShowCode, store, toggleScreening } from "../state";
import { UNSCHEDULE_LABEL } from "../actions-copy";
import { filmInfoOf, filmNodeKey } from "../util";
import { ToastQueue } from "./spectrum";
import type { Catalog, Screening } from "../types";

/** 「移出这一场会不会**连带把整部片移出「我的选片」**」—— 唯一判据。
 *
 *  读它的有两处:① 本文件的 `useScreeningPicker`(决定要不要拦);② 行程画布的二次确认弹层
 *  (`components/ScheduleGantt.tsx::AgendaRemoveDialog`,用来写准确认文案)。
 *  ⚠ 条件里两个都必须有:`slotOf` 判「这一场确实在行程里」(移出才谈得上连带),
 *  `soleShowCode` 判「这部片全届只有这一场」。单看后者会把没排过的片也算进来。 */
export function removalDropsPick(cat: Catalog, s: Screening): boolean {
  return Boolean(slotOf(s.code)) && soleShowCode(filmNodeKey(cat, s)) === s.code;
}

/** `useScreeningPicker` 的可选口径。 */
export interface ScreeningPickOptions {
  /** 置 `true` = 调用方**已经**把「只有一场会连带移除选片」跟用户说清了(站内弹层),
   *  别再弹一次原生 `window.confirm` —— 两层确认拦同一个动作只会让人烦。 */
  soleShowAsked?: boolean;
}

export function useScreeningPicker(): (
  s: Screening,
  options?: ScreeningPickOptions,
) => void {
  const { cat } = useCatalog();
  return useCallback(
    (s: Screening, options?: ScreeningPickOptions) => {
      const dropsPick = removalDropsPick(cat, s);
      // 只有「已在行程 + 该片只有这一场」才提示并连带移除选片
      if (dropsPick && !options?.soleShowAsked) {
        const title = filmInfoOf(cat, s, store.mappings.get(s.code)).title;
        // window.confirm 而非弹层:与「移除影片」同一套确认方式(见 `LibraryPage`)
        if (
          !window.confirm(
            `《${title}》只有这一场，${UNSCHEDULE_LABEL}会同时把它从「我的选片」移除。`,
          )
        ) {
          return;
        }
      }
      toggleScreening(filmNodeKey(cat, s), s.code);
      if (dropsPick) {
        ToastQueue.positive(`已${UNSCHEDULE_LABEL}，并从「我的选片」移除。`);
      }
    },
    [cat],
  );
}
