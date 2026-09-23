import type { Catalog, Screening } from "../types";
import { axisRangeOf, clampZoom } from "../grid";
import { hmsToMin } from "../util";
// 有效结束只在 `gv.ts` 有一份实现：这里此前有个等价的 `visualEnd`（第二份实现，已删）
import { effEndMin } from "../gv";

export const TIME_RAIL_WIDTH = 72;
export const VENUE_COLUMN_WIDTH = 260;
/** 影厅列「填满视口」时的拉伸上限(基准宽的倍数)。
 *  当日影厅很少时(如开幕式只有 1 个影厅)`(viewportWidth - rail) / venueCount` 会把这一列拉到整个视口宽
 *  —— 卡片随之宽逾千像素,官方剧照按 100% 宽等比放大后被裁成一条,片名 / 时间反被挤出卡外。
 *  设上限后少影厅的日子只在右侧留出画布空白,卡片宽度回到可读区间。 */
export const VENUE_COLUMN_STRETCH_LIMIT = 2;
export const VERTICAL_PX_PER_MIN = 4;
export const GRID_TOP_PAD = 18;
export const VENUE_HEADER_HEIGHT = 64;

export function verticalGeometry(
  cat: Catalog,
  date: string,
  zoom: number,
  venueCount: number,
  viewportWidth: number,
  /** 画布**只画这些场次**(缺省 = 当日全部排片)。
   *  「我的行程」的日程表传自己的场次进来:轴范围随首场 / 末场收紧,
   *  影厅列数由调用点按同一份场次算(见 `ScheduleGantt` 的 `shows` 入参)。 */
  shows: readonly Screening[] = cat.schedule.screenings.filter(s => s.date === date),
) {
  const start = shows.length ? Math.max(0, Math.floor(Math.min(...shows.map(s => hmsToMin(s.start_time))) / 60) * 60) : 8 * 60;
  const end = axisRangeOf(shows).end;
  const ppm = VERTICAL_PX_PER_MIN * zoom;
  const stretch = venueCount ? (viewportWidth - TIME_RAIL_WIDTH) / venueCount : 0;
  const columnWidth = Math.max(
    VENUE_COLUMN_WIDTH * zoom,
    Math.min(stretch, VENUE_COLUMN_WIDTH * zoom * VENUE_COLUMN_STRETCH_LIMIT),
  );
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

/** 放整数条「看得清」的影厅列，剩下的横向可滚。 */
export function fitVerticalZoom(venueCount: number, viewportWidth: number) {
  const available = Math.max(1, viewportWidth - TIME_RAIL_WIDTH);
  const columns = Math.max(1, Math.min(venueCount, Math.round(available / VENUE_COLUMN_WIDTH)));
  return clampZoom(available / (columns * VENUE_COLUMN_WIDTH));
}


/** 只有同一影厅里时间重叠的场次才会分占列宽。 */
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
      ends[lane] = effEndMin(s, true);
      return {code: s.code, lane};
    });
    lanes.forEach(({code, lane}) => result.set(code, {lane, count: ends.length}));
    group = [];
  };
  for (const s of [...shows].sort((a,b) => hmsToMin(a.start_time) - hmsToMin(b.start_time) || a.code.localeCompare(b.code))) {
    const start = hmsToMin(s.start_time);
    if (group.length && start >= groupEnd) flush();
    if (!group.length) groupEnd = -Infinity;
    group.push(s); groupEnd = Math.max(groupEnd, effEndMin(s, true));
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
