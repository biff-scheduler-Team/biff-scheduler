import { describe, expect, it } from "vitest";
import { agendaItems, describeSavedPlan, rankSpotOrder, topPlanCodes } from "../src/app/agenda-model";
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

  it("describes valid snapshot dates and missing catalog codes independently of current picks", () => {
    const shows = [show("001", "18:00", "2026-10-06"), show("008", "08:40")];
    const cat = { byCode: new Map(shows.map((s) => [s.code, s])) };
    const description = describeSavedPlan(cat, { codes: ["008", "missing", "001"] });
    expect(description.outline).toBe("2 场，OCT 6–OCT 7，1 场已不在排期");
    expect(description.details).toBe("08:40 · 008\nmissing\n18:00 · 001");
  });
});
