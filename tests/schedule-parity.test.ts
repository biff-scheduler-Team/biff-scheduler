import { beforeEach, describe, expect, it } from "vitest";
import { fitZoomLevel, ganttGeometry, ZOOM_LEVELS } from "../src/grid";
import { screeningCenter, tightScreeningTips } from "../src/app/schedule-model";
import { gvTalkMinOv, store } from "../src/state";
import { catalog, show } from "./helpers";

beforeEach(() => {
  gvTalkMinOv.clear();
  store.settings = { ...store.settings, gvTalkMin: 25, gvTalkOn: true };
});

describe("schedule parity: geometry", () => {
  it("fits the rendered venue column, axis, and trailing labels", () => {
    const cat = catalog([show({ code: "001", start_time: "18:00", end_time: "19:45", duration_min: 80, is_gv: true })]);
    const zoom = fitZoomLevel(cat, cat.dates[0], 736);
    expect(zoom).toBe(0.9);
    expect(ganttGeometry(cat, cat.dates[0], zoom).width).toBeLessThanOrEqual(736);
    for (const larger of ZOOM_LEVELS.filter((level) => level > zoom))
      expect(ganttGeometry(cat, cat.dates[0], larger).width).toBeGreaterThan(736);
  });

  it("extends the shared canvas when a GV duration goes beyond the official slot", () => {
    const cat = catalog([show({ code: "001", start_time: "23:00", end_time: "24:30", duration_min: 60, is_gv: true })]);
    gvTalkMinOv.set("001", 150);
    const geometry = ganttGeometry(cat, cat.dates[0], 1);
    expect(geometry.end).toBe(27 * 60);
    expect(geometry.width).toBe(148 + (geometry.end - geometry.start) * 3 + 60);
  });

  it("centers within the unobscured area below the sticky ruler", () => {
    expect(screeningCenter(
      { left: 100, top: 200, width: 800, height: 400, scrollLeft: 500, scrollTop: 800 },
      { left: 700, top: 550, width: 200, height: 100 },
      44,
    )).toEqual({ left: 800, top: 978 });
  });
});

describe("schedule parity: transfer details", () => {
  it("names both screenings and reports buffer, remaining time, and dropped GV", () => {
    const first = show({ code: "A", start_time: "10:00", end_time: "11:45", duration_min: 80, is_gv: true });
    const second = show({ code: "B", start_time: "11:25", end_time: "13:00", venue_id: "b2" });
    const cat = catalog([first, second]);
    const tips = tightScreeningTips(cat, first.date, ["B", "A"], undefined, () => false, 20);
    const tip = tips.get("A")!;
    expect(tip).toContain("A 11:20 结束（已弃映后） → B 11:25 开始");
    expect(tip).toContain("跨馆缓冲 20 分钟，余量 -15 分钟");
    expect(tip).toContain("赶不上");
    expect(tips.get("B")).toBe(tip);
  });

  it("does not replace conflict explanations with adjacent transfer warnings", () => {
    const a = show({ code: "A", end_time: "11:00" });
    const b = show({ code: "B", start_time: "11:05" });
    expect(tightScreeningTips(catalog([a, b]), a.date, ["A", "B"], new Set(["A"]), () => true, 20).size).toBe(0);
  });

  it("preserves the legacy boundary: positive gaps below 15 are tight; zero and 15 are not", () => {
    const a = show({ code: "A", end_time: "11:00" });
    for (const [start, expected] of [["11:00", 0], ["11:14", 2], ["11:15", 0]] as const) {
      const b = show({ code: "B", start_time: start });
      expect(tightScreeningTips(catalog([a, b]), a.date, ["A", "B"], undefined, () => true, 0).size).toBe(expected);
    }
  });
});
