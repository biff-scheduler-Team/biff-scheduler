// GV 映后谈语义 — 单一数据源:网格卡拆分 / 冲突 / 紧转场 / 行程 / 质量分 / 导出 共用。
//
// **时长口径(2026-09-10 起改为可配置)**:映后谈时长 = 单场覆写 `store.gvTalkMinOv[code]`
//   ?? 全局默认 `Settings.gvTalkMin`(默认 25 分钟)。**不再从数据推导** ——
//   官方 `end_time` 里隐含的谈后时间(2025 版 347 场 GV 中 345 场 = 25min)只是默认值 25 的来源,
//   用户可在设置里改全局默认,也可在行程行逐场覆写。
//
// 生效范围:仅 `is_gv` 场次(非 GV 恒 0)。时长归零 = 该场不拆、无谈段、无开关。
//
// 有效结束口径:
//   · 有谈段:含映后 = 正片末 + 时长;弃映后 = 正片末。
//   · 无谈段(非 GV / 时长 0):**仍取官方 `end_time`** —— 保护性分支:2025 有 6 场非 GV 片长 ≠ 槽位
//     (−2 / +1 / +15 / +90min),若一律改走 `start + duration` 会静默改变这 6 场的冲突判定。
//
// 跨午夜:本文件所有算术都直接用分钟数,**不做任何取模** —— 24+ 时制下 `end_time` 可 ≥ "24:00"
//   (如 "29:35"),`hmsToMin` 得 1775 > start;`minToHms` 输出 24+ 值供 ICS `Date.UTC` 自动进位。
//   一旦在数据侧折回 "05:35",`filmEndMin` 会算到 `end_time` 之后 → 谈段区间静默错乱。

import type { Screening } from "./types";
import { hmsToMin, minToHms } from "./util";
import { gvTalk, gvTalkMinOv, store } from "./state";

/** 单场映后谈时长上限(分钟)—— 24h,防手输天文数字把轴界/卡片撑爆。 */
const TALK_MIN_CAP = 24 * 60;

/** 该场映后谈分钟数:单场覆写 ?? 全局默认;非 GV → 0。 */
export function gvTalkMin(s: Screening): number {
  if (!s.is_gv) return 0;
  const m = gvTalkMinOv.get(s.code) ?? store.settings.gvTalkMin;
  if (!Number.isFinite(m)) return 0;
  return Math.min(Math.max(Math.round(m), 0), TALK_MIN_CAP);
}

/** 正片结束(分钟,当日) —— 放弃映后谈后的有效结束。 */
export function filmEndMin(s: Screening): number {
  return hmsToMin(s.start_time) + s.duration_min;
}

/** 某场在「参加 / 放弃映后谈」两种选择下的有效结束分钟。
 *  有谈段 → 正片末 + 时长(不再取官方 end_time —— 否则改配置不会改结束时间,配置就是假的);
 *  无谈段 → 官方槽位末(原语义,见文件头保护性分支)。 */
export function effEndMin(s: Screening, talkOn: boolean): number {
  const talk = gvTalkMin(s);
  if (talk <= 0) return hmsToMin(s.end_time);
  return filmEndMin(s) + (talkOn ? talk : 0);
}

/** 有效结束 HH:MM。 */
export function effEndHms(s: Screening, talkOn: boolean): string {
  return minToHms(effEndMin(s, talkOn));
}

/** 三态解析:单场覆写(boolean)优先,缺省回退全局默认。 */
export function resolveTalk(override: boolean | undefined, globalOn: boolean): boolean {
  return override ?? globalOn;
}

/** 当前配置下某场映后谈**是否参加**:单场覆写 `store.gvTalk[code]` 优先,缺省跟随 `Settings.gvTalkOn`。
 *  与时长解析(`gvTalkMin`)正交 —— 一个管「去不去」,一个管「多久」。
 *  网格 / 行程 / .ics 导出共用这一处 —— 谁按官方槽位算而不走有效结束,
 *  映后时长一调大就会在网格里显示冲突。 */
export function talkOnOf(code: string): boolean {
  return resolveTalk(gvTalk.get(code), store.settings.gvTalkOn);
}
