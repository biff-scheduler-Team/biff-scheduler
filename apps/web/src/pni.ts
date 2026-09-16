// P&I(Press & Industry)记者 / 业界场 —— 册子排期页的 BD(BCC Indieplus)/ CGV 7 两列。
//
// 口径(逐条都有依据,别改回去)
// ----------------------------
// * 官方**不印这两列的场次编号**,官网排期页(`date.asp`)与影片介绍页也都不列它们(实测);
//   对照:同页 Community BIFF 的 MEGABOX 1–4 是免费场,**印了** 901–942 ——
//   所以「不印编号」不是排版疏忽,是有意区分公开 / 非公开(`tools/extract_schedule.py` 陷阱 9)。
// * 因此线上产物分两份:`public/schedule.json`(对外售票的普通场次)+
//   `public/pni.json`(P&I)。公开那份**一个字节都不含** P&I —— 哨兵见
//   `apps/web/tests/catalogue-data.test.ts`。
// * 默认**不显示**(`Settings.showPni = false`);设置里勾选「显示 P&I 场次」后才并进来。
//
// 为什么合并点放在 `app/store.tsx::derive()` 的入口
// ------------------------------------------------
// 冲突 / 排片网格 / 片单 / 行程 / 导出 / 抢票读的都是**同一份 catalog**。
// 只要在 derive 入口换掉 catalog,这些视图自动跟着一致,不必每处各判一次「这场算不算 P&I」
// —— 那正是「同一口径写第二份实现」的开始。

import type { Catalog, Screening, Venue } from "./types";

/** 是否 P&I 场次(记者 / 业界场)。数据侧只写 `true`,不写 `false`(见 `tools/extract_schedule.py`)。 */
export function isPni(s: Screening): boolean {
  return s.pni === true;
}

/** catalog 里有没有可合并的 P&I 数据(旧部署缺 `pni.json` 时为 false → 设置项不必展示)。 */
export function hasPni(cat: Catalog): boolean {
  return cat.pniScreenings.length > 0;
}

/**
 * 把 P&I 场次并进 catalog(返回**新对象**,不改入参)。
 *
 * ⚠ 必须是纯函数:`derive()` 每次 store 变更都会重算并调用它。一旦原地 mutate,
 *    P&I 场次就会被永久写进基础 catalog —— 用户取消勾选后再也去不掉(只能刷新页面)。
 */
export function withPni(base: Catalog): Catalog {
  if (base.pniScreenings.length === 0) return base;

  const screenings = [...base.schedule.screenings, ...base.pniScreenings];
  const venues = insertPniVenues(base.venues, base.pniVenues);

  const byCode = new Map(base.byCode);
  for (const s of base.pniScreenings) byCode.set(s.code, s);

  // dates 要求「字典序 = 时间序」(YYYY-MM-DD),P&I 与普通场次同日,去重后仍成立
  const dates = [...new Set(screenings.map((s) => s.date))].sort();

  return {
    ...base,
    schedule: { ...base.schedule, screenings },
    dates,
    venues,
    venueById: new Map(venues.map((v) => [v.id, v])),
    byCode,
  };
}

/**
 * 把 P&I 厅插进**同一影院(group)最后一个厅之后**。
 *
 * 甘特图泳道顺序 = `venues` 数组顺序(`data.ts::screeningsByVenue` 按它排),
 * 直接追加到末尾会让 Indieplus / CGV 7 漂到分区之外、与同影院的厅撕裂。
 * 未登记的 group 兜底追加到末尾(宁可位置怪,也不静默丢一个厅)。
 */
function insertPniVenues(venues: Venue[], extra: Venue[]): Venue[] {
  const out = [...venues];
  for (const v of extra) {
    if (out.some((x) => x.id === v.id)) continue;
    const lastOfGroup = out.reduce((acc, x, i) => (x.group === v.group ? i : acc), -1);
    if (lastOfGroup < 0) out.push(v);
    else out.splice(lastOfGroup + 1, 0, v);
  }
  return out;
}
