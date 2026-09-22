import type { PlanSet, RankClashSpot } from "../plans";
import type { Screening } from "../types";

/** 「当前行程」的**真值**:共同场次 + 每个冲突组的第一顺位。
 *  ⚠ 名字里的 plan 是历史包袱(2026-09-22 之前它同时是「保存方案」的取值口径,`PLAN-20260922105228`)——
 *  方案整体下线后它**只剩一个调用方**:`ExportDialog` 的「导出范围 = 当前行程」。别再往它身上挂新语义。 */
export function topPlanCodes(plans: Pick<PlanSet, "common" | "groups">): string[] {
  return [...plans.common, ...plans.groups.map((group) => group[0])];
}

/** Let this group yield by swapping only the two spots shown in the clash note. */
export function rankSpotOrder(groups: string[][], spot: RankClashSpot): string[] | null {
  const group = groups[spot.group];
  if (!group || spot.alt === null) return null;
  const from = group.indexOf(spot.code);
  const to = group.indexOf(spot.alt);
  if (from < 0 || to < 0) return null;
  const next = [...group];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export type AgendaItem =
  | { kind: "group"; codes: string[] }
  | { kind: "screening"; screening: Screening; before: Screening | null };

/** A conflict group has no single predecessor to use for the next transfer. */
export function agendaItems(rows: Screening[], groups: string[][]): AgendaItem[] {
  const groupOf = new Map(groups.flatMap((group) => group.map((code) => [code, group] as const)));
  const rendered = new Set<string[]>();
  const items: AgendaItem[] = [];
  let before: Screening | null = null;
  for (const screening of rows) {
    const group = groupOf.get(screening.code);
    if (group) {
      if (rendered.has(group)) continue;
      rendered.add(group);
      items.push({ kind: "group", codes: group });
      before = null;
    } else {
      items.push({ kind: "screening", screening, before });
      before = screening;
    }
  }
  return items;
}

/* `describeSavedPlan()` 随「已保存方案」一起下线(2026-09-22,`PLAN-20260922105228`)。
 * 它的职责是「按目录核验一份**快照**还剩几场有效」,而快照这个形态已经没有了 ——
 * 现在唯一要出的概要(`ExportDialog` 的导出范围标签)走 `ExportDialog.tsx::codesOutline`,
 * 那份永远对着**当前行程**算,不存在「已不在排期」以外的失效形态。 */
