import type { Catalog, Screening } from "../types";
import { effEndMin, gvTalkMin } from "../gv";
import { fmtEndClock, hmsToMin, slackBetween } from "../util";

interface GanttGeometry {
  start: number;
  ppm: number;
  labelW: number;
  rowH: number;
}

export interface GanttScrollAnchor {
  minute: number;
  screenX: number;
  row: number;
  rowScreenY: number;
}

/** Capture against the old canvas, before a smaller canvas clamps its scroll offsets. */
export function ganttScrollAnchor(
  viewport: { scrollLeft: number; scrollTop: number; clientWidth: number },
  geometry: GanttGeometry,
  rulerHeight: number,
): GanttScrollAnchor {
  const screenX = Math.max(viewport.clientWidth / 2, geometry.labelW);
  return {
    minute: geometry.start + (viewport.scrollLeft + screenX - geometry.labelW) / geometry.ppm,
    screenX,
    row: Math.max(0, viewport.scrollTop - rulerHeight) / geometry.rowH,
    rowScreenY: Math.max(0, rulerHeight - viewport.scrollTop),
  };
}

export function ganttScrollPosition(
  anchor: GanttScrollAnchor,
  geometry: GanttGeometry,
  rulerHeight: number,
  fromLeft = false,
) {
  return {
    left: fromLeft ? 0 : Math.max(0, geometry.labelW + (anchor.minute - geometry.start) * geometry.ppm - anchor.screenX),
    top: Math.max(0, rulerHeight + anchor.row * geometry.rowH - anchor.rowScreenY),
  };
}

/** Same adjacent-selected-screening calculation as legacy markTightCards. */
export function tightScreeningTips(
  cat: Catalog,
  date: string,
  codes: string[],
  conflictCodes: Set<string> | undefined,
  talkOn: (code: string) => boolean,
  transitMin: number,
): Map<string, string> {
  const selected = codes
    .map((code) => cat.byCode.get(code))
    .filter((s): s is Screening => Boolean(s && s.date === date))
    .sort((a, b) => a.start_time.localeCompare(b.start_time));
  const marks = new Map<string, { bad: boolean; notes: string[] }>();
  for (let i = 1; i < selected.length; i++) {
    const a = selected[i - 1], b = selected[i];
    if (conflictCodes?.has(a.code) || conflictCodes?.has(b.code)) continue;
    const end = effEndMin(a, talkOn(a.code));
    const r = slackBetween(end, hmsToMin(b.start_time), a.venue_id === b.venue_id, transitMin);
    if (r.gap <= 0 || r.verdict === "ok") continue;
    const dropped = gvTalkMin(a) > 0 && !talkOn(a.code) ? "（已弃映后）" : "";
    const note = `${a.code} ${fmtEndClock(end)} 结束${dropped} → ${b.code} ${b.start_time} 开始，间隔 ${r.gap} 分钟${r.need ? `，跨馆缓冲 ${r.need} 分钟` : ""}，余量 ${r.slack} 分钟`;
    for (const code of [a.code, b.code]) {
      const mark = marks.get(code) ?? { bad: false, notes: [] };
      mark.bad ||= r.verdict === "bad";
      mark.notes.push(note);
      marks.set(code, mark);
    }
  }
  return new Map([...marks].map(([code, mark]) => [
    code,
    `${mark.bad ? "时间紧张，缓冲后赶不上" : "衔接偏紧，余量不足 15 分钟"}\n${mark.notes.join("\n")}`,
  ]));
}

export function screeningCenter(
  viewport: { left: number; top: number; width: number; height: number; scrollLeft: number; scrollTop: number },
  card: { left: number; top: number; width: number; height: number },
  rulerHeight: number,
) {
  return {
    left: Math.max(0, viewport.scrollLeft + card.left - viewport.left - viewport.width / 2 + card.width / 2),
    top: Math.max(0, viewport.scrollTop + card.top - viewport.top - rulerHeight - (viewport.height - rulerHeight) / 2 + card.height / 2),
  };
}
