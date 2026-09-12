import type {Catalog, Screening} from './types';
import {hmsToMin, slackBetween, type SlackResult} from './util';
import {effEndMin, gvTalkMin} from './gv';
import {matchesFilters, type FilterState} from './filters';

export interface TimelineOpts {
  /** **甘特图那套**排片筛选(字幕 / 影厅 / GV)—— 时间线读同一份:被筛掉的场次不列 */
  filters?: FilterState;
  /** 已选场次投影:code → 影片 key(唯一数据源) */
  slots: Map<string, { key: string }>;
  /** GV 映后谈是否参加(全局默认 + 单场覆写解析后)—— 有效结束口径与网格 / 行程同源 */
  gvTalkOf: (code: string) => boolean;
  /** 跨馆转场缓冲(分钟) */
  transitMin: number;
}

export interface TimelineEntry {
  s: Screening;
  /** 是否已加入行程(底色 / 连接件的判定源) */
  picked: boolean;
  /** 与**上一场已选**的重叠分钟(>0 = 画红色「重叠」连接件);本场未选 / 前面无已选 = 0 */
  overlapMin: number;
  /** 与上一场已选的余量判定;null = 本场未选 / 前面没有已选场 */
  slack: SlackResult | null;
  /** 与上一场已选是否**跨馆**(连接件文案用) */
  crossVenue: boolean;
}

export function timelineEntries(cat: Catalog, date: string, o: TimelineOpts): TimelineEntry[] {
  const list = cat.schedule.screenings
    .filter((s) => s.date === date)
    .filter((s) => !o.filters || matchesFilters(s, o.filters))
    .sort((a, b) => a.start_time.localeCompare(b.start_time) || a.venue_id.localeCompare(b.venue_id));

  const out: TimelineEntry[] = [];
  let prev: Screening | null = null;
  let prevEnd = 0;
  for (const s of list) {
    const picked = o.slots.has(s.code);
    let overlapMin = 0;
    let slack: SlackResult | null = null;
    let crossVenue = false;
    if (picked && prev) {
      const cross = prev.venue_id !== s.venue_id;
      const r = slackBetween(prevEnd, hmsToMin(s.start_time), !cross, o.transitMin);
      slack = r;
      overlapMin = r.gap < 0 ? -r.gap : 0;
      crossVenue = cross;
    }
    out.push({ s, picked, overlapMin, slack, crossVenue });
    if (picked) {
      prev = s;
      // 有效结束口径与网格 / 行程 / .ics 同源:有谈段且参加 → 正片末 + 映后时长;
      // 无谈段(非 GV / 时长配成 0)→ 仍取官方 end_time(见 gv.ts 文件头)。
      prevEnd = effEndMin(s, gvTalkMin(s) > 0 ? o.gvTalkOf(s.code) : true);
    }
  }
  return out;
}
