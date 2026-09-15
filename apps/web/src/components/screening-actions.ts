// 场次「加入行程 / 移出行程」的唯一 UI 出口(2026-09-16,`PLAN-20260916004024`)。
//
// 为什么单开一处:取消**只有一场**的影片会连选片记录一起移除(`state.ts::toggleScreening`)——
// 那是必须的(留下空记录会被载入时的 `fillSoleShowPicks()` 补回来,用户看到的是「删不掉」),
// 但**必须先告诉用户**,否则他会以为「怎么点一下整部片就没了」。
// 网格点选(`SchedulePage`)与场次卡(`ScreeningCard`,`我的选片` / `我的行程` 共用)都走这里 ——
// 提示只有一处实现,不会出现「某条路径静默删了选片」。
//
// ⚠ 多场片一律**不弹**:移出一场是日常操作,每次都打断才是真的增加使用成本。

import { useCallback } from "react";
import { useCatalog } from "../app/store";
import { slotOf, soleShowCode, store, toggleScreening } from "../state";
import { filmInfoOf, filmNodeKey } from "../util";
import { ToastQueue } from "./spectrum";
import type { Screening } from "../types";

export function useScreeningPicker(): (s: Screening) => void {
  const { cat } = useCatalog();
  return useCallback(
    (s: Screening) => {
      const key = filmNodeKey(cat, s);
      // 只有「已在行程 + 该片只有这一场」才提示并连带移除选片
      if (slotOf(s.code) && soleShowCode(key) === s.code) {
        const title = filmInfoOf(cat, s, store.mappings.get(s.code)).title;
        // window.confirm 而非弹层:与「移除影片」同一套确认方式(见 `LibraryPage`)
        if (
          !window.confirm(
            `《${title}》只有这一场，移出行程会同时把它从「我的选片」移除。`,
          )
        ) {
          return;
        }
        toggleScreening(key, s.code);
        ToastQueue.positive("已移出行程，并从「我的选片」移除。");
        return;
      }
      toggleScreening(key, s.code);
    },
    [cat],
  );
}
