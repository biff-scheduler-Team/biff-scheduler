import { describe, expect, it } from "vitest";
import { ganttScrollAnchor, ganttScrollPosition } from "../src/app/schedule-model";

const geometry = (zoom: number) => ({ start: 8 * 60, ppm: 3 * zoom, labelW: 148 * zoom, rowH: 112 * zoom });

describe("review regression: Gantt scroll anchors", () => {
  it("retains the pre-resize anchor when the browser later clamps both scroll axes", () => {
    const anchor = ganttScrollAnchor({ scrollLeft: 1540, scrollTop: 1845, clientWidth: 1368 }, geometry(1), 44);
    const position = ganttScrollPosition(anchor, geometry(0.9), 44);
    // The new canvas ends at (1255, 1610). Restoration must reach both bounds,
    // not rescale the already-clamped offsets and jump to (1061, 1453).
    expect(position.left).toBeGreaterThan(1255);
    expect(position.top).toBeGreaterThan(1610);
    expect(Math.min(position.left, 1255)).toBe(1255);
    expect(Math.min(position.top, 1610)).toBe(1610);
  });

  it("keeps the first row at the top while zooming", () => {
    const anchor = ganttScrollAnchor({ scrollLeft: 0, scrollTop: 0, clientWidth: 1000 }, geometry(1), 44);
    expect(ganttScrollPosition(anchor, geometry(0.9), 44).top).toBe(0);
  });

  it("preserves an interior row and time across a zoom round trip", () => {
    const original = { scrollLeft: 620, scrollTop: 740, clientWidth: 900 };
    const smaller = ganttScrollPosition(ganttScrollAnchor(original, geometry(1), 44), geometry(0.7), 44);
    const restored = ganttScrollPosition(
      ganttScrollAnchor({ scrollLeft: smaller.left, scrollTop: smaller.top, clientWidth: original.clientWidth }, geometry(0.7), 44),
      geometry(1), 44,
    );
    expect(restored.left).toBeCloseTo(original.scrollLeft);
    expect(restored.top).toBeCloseTo(original.scrollTop);
  });

  it("fits from the left while retaining the vertical row anchor", () => {
    const anchor = ganttScrollAnchor({ scrollLeft: 600, scrollTop: 716, clientWidth: 1000 }, geometry(1), 44);
    const position = ganttScrollPosition(anchor, geometry(0.55), 44, true);
    expect(position.left).toBe(0);
    expect(position.top).toBeCloseTo(413.6);
  });
});
