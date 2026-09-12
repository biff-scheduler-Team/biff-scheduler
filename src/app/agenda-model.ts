import type { PlanSet, RankClashSpot } from "../plans";
import type { SavedPlan } from "../state";
import type { Catalog, Screening } from "../types";
import { dateInfo } from "../util";

/** A saved plan is the user's first choices, never an enumerated replacement. */
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

/** A snapshot's validity is determined by the catalog, not the current picks. */
export function describeSavedPlan(cat: Pick<Catalog, "byCode">, plan: Pick<SavedPlan, "codes">) {
  const shows = plan.codes
    .map((code) => cat.byCode.get(code))
    .filter((s): s is Screening => Boolean(s))
    .sort((a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time));
  const gone = plan.codes.length - shows.length;
  const parts = [`${shows.length} 场`];
  if (shows.length) {
    const first = dateInfo(shows[0].date).label;
    const last = dateInfo(shows[shows.length - 1].date).label;
    parts.push(first === last ? first : `${first}–${last}`);
  }
  if (gone) parts.push(`${gone} 场已不在排期`);
  const details = plan.codes.map((code) => {
    const s = cat.byCode.get(code);
    return s ? `${s.start_time.slice(0, 5)} · ${code}` : code;
  }).join("\n");
  return { outline: parts.join("，"), details };
}
