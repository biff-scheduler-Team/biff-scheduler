import { useLayoutEffect, useRef } from "react";
import { ActionButton, ToggleButton, ToastQueue } from "../components/spectrum";
import { ScheduleGantt } from "../components/ScheduleGantt";
import { useCatalog } from "../app/store";
import { useScheduleSelection } from "../app/schedule-selection";
import { useFilters, useMedia, useQuery } from "../app/hooks";
import { LS_FILTERS_GRID, venueAllowed } from "../filters";
import { talkOnOf } from "../gv";
import { store } from "../state";
import { dateInfo, fmtEndClock } from "../util";
import { timelineEntries } from "../timeline";
import "./schedule-parity.css";

export function SchedulePage() {
  const { cat } = useCatalog();
  const { params, update } = useQuery();
  const mobile = useMedia("(max-width: 768px)");
  const { filters, update: changeFilters } = useFilters(LS_FILTERS_GRID);
  const { date, hour } = useScheduleSelection();
  const previousMobile = useRef(mobile);
  useLayoutEffect(() => {
    const changed = previousMobile.current !== mobile;
    previousMobile.current = mobile;
    if (changed && hour !== null) update({ hour: null }, true);
  }, [mobile, hour, update]);
  const dateCounts = new Map(cat.dates.map(d => [d, timelineEntries(cat, d, {
    filters,
    slots: store.slotIndex,
    gvTalkOf: talkOnOf,
    transitMin: store.settings.transitMin,
  }).length]));
  const focusCode = params.get("focus");
  const focusDate = params.get("focusDate");
  const locateRequest = params.get("locate") ?? `${date}|${focusCode}|${focusDate}`;
  const lastFilterLocate = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (lastFilterLocate.current === locateRequest) return;
    lastFilterLocate.current = locateRequest;
    const target = focusCode ? cat.byCode.get(focusCode) : null;
    if (target && filters.venues.size && !venueAllowed(target.venue_id, filters)) {
      changeFilters({ venues: new Set() });
      ToastQueue.neutral("已清除影厅筛选，目标场次所在影厅此前被隐藏。", { timeout: 5000 });
    }
  }, [cat, focusCode, locateRequest, filters, changeFilters]);
  return (
    <section className="schedule-page" aria-label="排片表">
      <div className="panel-heading">
        <div>
          <h1 className="schedule-title">排片表 <span>{date.slice(0, 4)} 年 {Number(date.slice(5, 7))} 月</span></h1>
        </div>
      </div>
      <div className="date-strip calendar-strip" aria-label="排片日期">
        {cat.dates.map((d) => (
          <ToggleButton
            key={d}
            isSelected={d === date}
            onChange={() => update({ date: d, focus: null, focusDate: null, hour: null, locate: null })}
            aria-label={`选择日期 ${d}`}
          >
            <span className="calendar-day"><span className="calendar-weekday">{dateInfo(d).weekday}</span><span className="calendar-number">{Number(d.slice(-2))}</span><span className="calendar-count">{dateCounts.get(d)} 场</span></span>
          </ToggleButton>
        ))}
      </div>
      {hour !== null && (
        <div className="inline-actions">
          <p>正在查看 {fmtEndClock(hour * 60)} 时段</p>
          <ActionButton onPress={() => update({ hour: null }, true)}>
            清除时段筛选
          </ActionButton>
        </div>
      )}
      <ScheduleGantt
        date={date}
        filters={filters}
        hour={hour}
        changeFilters={changeFilters}
      />
    </section>
  );
}
