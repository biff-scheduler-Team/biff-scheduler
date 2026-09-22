import { describe, expect, it } from "vitest";
import { agendaItems, rankSpotOrder, topPlanCodes } from "../src/app/agenda-model";
import { computeConflicts } from "../src/conflict";
import { buildPlanSet } from "../src/plans";
import type { Screening } from "../src/types";

function show(code: string, start = "09:00", date = "2026-10-07"): Screening {
  return {
    code, start_time: start, date, end_time: "11:00", duration_min: 120,
    title_en: code, title_zh: code, title_kr: code,
    venue_id: "b1", venue_display: "BCC 1", is_gv: false,
  };
}

describe("legacy agenda decisions", () => {
  it("keeps the actual first choices even when enumeration substitutes a different film", () => {
    const groups = [["008", "033"], ["143", "080"]];
    const slots = groups.flatMap((group, i) => group.map((code) => ({
      code, date: `2026-10-0${i + 7}`, start: 600, end: 720, venue: "b1",
    })));
    const plans = buildPlanSet(
      ["common", ...groups.flat()], computeConflicts(slots, () => 0),
      new Map(groups.flatMap((group) => group.map((code, i) => [code, i + 1] as const))),
      () => 0, (code) => code === "143" ? "008" : code,
    );
    expect(plans.rankClashes.some((clash) => clash.layer === 1)).toBe(true);
    expect(plans.options[0].codes).toEqual(["common", "008", "080"]);
    expect(topPlanCodes(plans)).toEqual(["common", "008", "143"]);
  });

  it("a group yielding swaps exactly its two named spots without touching any others", () => {
    const groups = [["a", "b", "c", "d"], ["e", "f"]];
    expect(rankSpotOrder(groups, { group: 0, code: "b", alt: "d" })).toEqual(["a", "d", "c", "b"]);
    expect(groups).toEqual([["a", "b", "c", "d"], ["e", "f"]]);
    expect(rankSpotOrder(groups, { group: 0, code: "a", alt: null })).toBeNull();
  });

  it("does not manufacture a predecessor after a group, and resumes gaps between single screenings", () => {
    const rows = ["before", "008", "033", "after", "later"].map((code) => show(code));
    const items = agendaItems(rows, [["033", "008"]]);
    expect(items).toEqual([
      { kind: "screening", screening: rows[0], before: null },
      { kind: "group", codes: ["033", "008"] },
      { kind: "screening", screening: rows[3], before: null },
      { kind: "screening", screening: rows[4], before: rows[3] },
    ]);
  });

  // ⚠ 「方案快照的日期 / 缺片概要」那条用例随 `describeSavedPlan` 一起删除
  //   (2026-09-22,`PLAN-20260922105228`):快照这个形态已经没有了。
});
