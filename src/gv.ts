// GV 映后谈语义 — 单一数据源:网格卡拆分 / 冲突 / 紧转场 / 行程 / 质量分 / 导出 共用。
//
// 数据口径:schedule.json 里 GV 场次(is_gv)的 end_time 官方已含映后谈时长(现 mock 全部恰好 +25min,
// 正片时长另存 duration_min)。本工具把「映后谈」建模为可选段 —— 全局默认 Settings.gvTalkOn +
// 单场覆写 store.gvTalk[code](undefined=跟随全局)。放弃映后谈 = 该场有效结束提前到正片末。
//
// 规则:映后谈时长一律按数据推导(槽位 − 正片),不新增字段 —— 真实排期若某场未把谈后算进
// end_time 则自动 = 0(该场不拆、无开关),向前兼容。
//
// 跨午夜:本文件所有算术都直接用 `hmsToMin(end_time)`,**不做任何取模** ——
// 24+ 时制下 end_time 可 ≥ "24:00"(如 "29:35"),`hmsToMin` 得 1775 > start,推导天然正确;
// 一旦在数据侧折回 "05:35",gvTalkMin 会算出负数并被 max(0,·) 吞掉(映后谈静默消失)。

import type { Screening } from "./types";
import { hmsToMin, minToHms } from "./util";

/** 该场映后谈分钟数(非 GV / 数据未含谈后 → 0)。 */
export function gvTalkMin(s: Screening): number {
  if (!s.is_gv) return 0;
  const talk = hmsToMin(s.end_time) - hmsToMin(s.start_time) - s.duration_min;
  return Math.max(0, talk);
}

/** 正片结束(分钟,当日) —— 放弃映后谈后的有效结束。 */
export function filmEndMin(s: Screening): number {
  return hmsToMin(s.start_time) + s.duration_min;
}

/** 某场在「参加 / 放弃映后谈」两种选择下的有效结束分钟。 */
export function effEndMin(s: Screening, talkOn: boolean): number {
  return talkOn ? hmsToMin(s.end_time) : filmEndMin(s);
}

/** 有效结束 HH:MM。 */
export function effEndHms(s: Screening, talkOn: boolean): string {
  return minToHms(effEndMin(s, talkOn));
}

/** 三态解析:单场覆写(boolean)优先,缺省回退全局默认。 */
export function resolveTalk(override: boolean | undefined, globalOn: boolean): boolean {
  return override ?? globalOn;
}
