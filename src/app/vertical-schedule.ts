import type { Catalog, Screening } from "../types";
import { ganttGeometry, clampZoom } from "../grid";
import { hmsToMin } from "../util";
import { filmEndMin, gvTalkMin } from "../gv";

export const TIME_RAIL_WIDTH = 72;
export const VENUE_COLUMN_WIDTH = 260;
export const VERTICAL_PX_PER_MIN = 4;
export const GRID_TOP_PAD = 18;
export const VENUE_HEADER_HEIGHT = 64;

export function verticalGeometry(cat: Catalog, date: string, zoom: number, venueCount: number, viewportWidth: number) {
  const shows = cat.schedule.screenings.filter(s => s.date === date);
  const start = shows.length ? Math.max(0, Math.floor(Math.min(...shows.map(s => hmsToMin(s.start_time))) / 60) * 60) : 8 * 60;
  const end = ganttGeometry(cat, date, 1).end;
  const ppm = VERTICAL_PX_PER_MIN * zoom;
  const columnWidth = Math.max(VENUE_COLUMN_WIDTH * zoom, venueCount ? (viewportWidth - TIME_RAIL_WIDTH) / venueCount : 0);
  return {
    start, end, ppm, columnWidth,
    railWidth: TIME_RAIL_WIDTH,
    topPad: GRID_TOP_PAD,
    headerHeight: VENUE_HEADER_HEIGHT,
    width: Math.ceil(Math.max(viewportWidth, TIME_RAIL_WIDTH + venueCount * columnWidth)),
    height: Math.ceil(GRID_TOP_PAD + (end - start) * ppm + 24),
  };
}
export type VerticalGeometry = ReturnType<typeof verticalGeometry>;

/** Fit a whole number of readable venue columns, leaving the rest horizontally accessible. */
export function fitVerticalZoom(venueCount: number, viewportWidth: number) {
  const available = Math.max(1, viewportWidth - TIME_RAIL_WIDTH);
  const columns = Math.max(1, Math.min(venueCount, Math.round(available / VENUE_COLUMN_WIDTH)));
  return clampZoom(available / (columns * VENUE_COLUMN_WIDTH));
}

export function visualEnd(s: Screening) {
  return gvTalkMin(s) > 0 ? filmEndMin(s) + gvTalkMin(s) : hmsToMin(s.end_time);
}

/** Only overlapping intervals in the same venue share its column width. */
export function screeningLanes(shows: Screening[]) {
  const result = new Map<string, {lane: number; count: number}>();
  let group: Screening[] = [];
  let groupEnd = -Infinity;
  const flush = () => {
    const ends: number[] = [];
    const lanes = group.map(s => {
      const start = hmsToMin(s.start_time);
      let lane = ends.findIndex(end => end <= start);
      if (lane < 0) lane = ends.length;
      ends[lane] = visualEnd(s);
      return {code: s.code, lane};
    });
    lanes.forEach(({code, lane}) => result.set(code, {lane, count: ends.length}));
    group = [];
  };
  for (const s of [...shows].sort((a,b) => hmsToMin(a.start_time) - hmsToMin(b.start_time) || a.code.localeCompare(b.code))) {
    const start = hmsToMin(s.start_time);
    if (group.length && start >= groupEnd) flush();
    if (!group.length) groupEnd = -Infinity;
    group.push(s); groupEnd = Math.max(groupEnd, visualEnd(s));
  }
  flush();
  return result;
}

export interface VerticalAnchor {
  venue: number;
  screenX: number;
  minute: number | null;
  screenY: number;
  pageY: number;
}
export function captureVerticalAnchor(
  geometry: VerticalGeometry,
  viewport: {scrollLeft: number; clientWidth: number; top: number},
  page: {scrollY: number; height: number},
): VerticalAnchor {
  const screenX = Math.max(geometry.railWidth, viewport.clientWidth / 2);
  const screenY = geometry.headerHeight + Math.max(0, page.height - geometry.headerHeight) / 2;
  return {
    venue: (viewport.scrollLeft + screenX - geometry.railWidth) / geometry.columnWidth,
    screenX,
    minute: viewport.top < geometry.headerHeight ? geometry.start + (screenY - viewport.top - geometry.topPad) / geometry.ppm : null,
    screenY,
    pageY: page.scrollY,
  };
}
export function restoreVerticalAnchor(anchor: VerticalAnchor, geometry: VerticalGeometry, documentTop: number, fromLeft = false) {
  return {
    left: fromLeft ? 0 : Math.max(0, geometry.railWidth + anchor.venue * geometry.columnWidth - anchor.screenX),
    pageY: anchor.minute === null ? anchor.pageY : Math.max(0, documentTop + geometry.topPad + (anchor.minute - geometry.start) * geometry.ppm - anchor.screenY),
  };
}
