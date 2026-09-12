import { useHighlight } from "../app/highlight";
import { Component, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useLocation, useNavigate } from "react-router";
import { ActionButton, ToggleButton, ToastQueue } from "../components/spectrum";
import {
  Badges,
  ScreeningCard,
  useFilmNavigation,
} from "../components/ScreeningCard";
import { FilterBar } from "../components/FilterBar";
import { useCatalog } from "../app/store";
import { useScheduleSelection } from "../app/schedule-selection";
import { useFilters, useMedia, useQuery } from "../app/hooks";
import {
  LS_FILTERS_GRID,
  matchesFilters,
  venueAllowed,
  type FilterState,
} from "../filters";
import {
  clampZoom,
  stepZoom,
  fitZoomLevel,
  ganttGeometry,
  cardStateOf,
  ZOOM_MAX,
  ZOOM_MIN,
} from "../grid";
import { effEndMin, filmEndMin, gvTalkMin, talkOnOf } from "../gv";
import {
  setGvTalk,
  setSettings,
  slotOf,
  store,
  toggleScreening,
} from "../state";
import {
  dateInfo,
  doubanScoreOf,
  filmInfoOf,
  filmNodeKey,
  fmtEndClock,
  hmsToMin,
  todayIsoLocal,
} from "../util";
import { venueShort, venueTip } from "../legend";
import { timelineEntries } from "../timeline";
import type { Screening } from "../types";
import { ganttScrollAnchor, ganttScrollPosition, screeningCenter, tightScreeningTips, type GanttScrollAnchor } from "../app/schedule-model";
import "./schedule-parity.css";

function useScreeningToggle(onOpen: (code: string) => void) {
  const { cat } = useCatalog();
  const navigate = useNavigate();
  const location = useLocation();
  const compact = useMedia("(max-width: 1099px)");
  return (s: Screening) => {
    const adding = !slotOf(s.code);
    toggleScreening(filmNodeKey(cat, s), s.code);
    if (adding && !compact && location.pathname === "/schedule") {
      onOpen(s.code);
      navigate(`/agenda${location.search}`);
    }
  };
}

const locateAnimations = new WeakMap<HTMLElement, Animation>();
function flashScreenings(root: HTMLElement, codes: string[]) {
  for (const code of codes) {
    const node = root.querySelector<HTMLElement>(
      `[data-grid-slot="${CSS.escape(code)}"], [data-timeline-code="${CSS.escape(code)}"]`,
    );
    if (!node) continue;
    locateAnimations.get(node)?.cancel();
    node.classList.add("schedule-located");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animation = node.animate(
      reduced ? [{ opacity: 1 }, { opacity: 1 }] : [{ opacity: 0.55 }, { opacity: 1 }],
      { duration: 1000, iterations: 3 },
    );
    locateAnimations.set(node, animation);
    void animation.finished.then(() => node.classList.remove("schedule-located"), () => {});
  }
}

function centerOf(viewport: HTMLElement, card: HTMLElement) {
  const rect = viewport.getBoundingClientRect();
  return screeningCenter(
    { ...rect.toJSON(), width: viewport.clientWidth, height: viewport.clientHeight,
      scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop },
    card.getBoundingClientRect(),
    viewport.querySelector<HTMLElement>(".gantt-ruler")?.offsetHeight ?? 0,
  );
}

interface GanttViewportProps {
  date: string;
  zoom: number;
  geometry: ReturnType<typeof ganttGeometry>;
  viewportRef: RefObject<HTMLDivElement | null>;
  fitFromLeft: RefObject<boolean>;
  children: ReactNode;
}

/** This lifecycle reads the old DOM before React mutates canvas dimensions.
 * A layout effect is too late: shrinking has already clamped scrollLeft/Top.
 */
class GanttViewport extends Component<GanttViewportProps, object, GanttScrollAnchor | null> {
  getSnapshotBeforeUpdate(previous: GanttViewportProps) {
    const viewport = this.props.viewportRef.current;
    if (!viewport || previous.zoom === this.props.zoom || previous.date !== this.props.date) return null;
    return ganttScrollAnchor(
      viewport,
      previous.geometry,
      viewport.querySelector<HTMLElement>(".gantt-ruler")?.offsetHeight ?? 0,
    );
  }

  componentDidUpdate(_previous: GanttViewportProps, _state: object, anchor: GanttScrollAnchor | null) {
    const viewport = this.props.viewportRef.current;
    if (viewport && anchor) {
      viewport.scrollTo(ganttScrollPosition(
        anchor,
        this.props.geometry,
        viewport.querySelector<HTMLElement>(".gantt-ruler")?.offsetHeight ?? 0,
        this.props.fitFromLeft.current,
      ));
    }
    this.props.fitFromLeft.current = false;
  }

  render() {
    return (
      <div className="gantt-scroll" ref={this.props.viewportRef} aria-label="排片时间表" tabIndex={0}>
        {this.props.children}
      </div>
    );
  }
}

function Gantt({
  date,
  filters,
  hour,
}: {
  date: string;
  filters: FilterState;
  hour: number | null;
}) {
  const { cat, conflicts, codes } = useCatalog();
  const highlight = useHighlight();
  const location = useLocation();
  const { params, update } = useQuery();
  const openFilm = useFilmNavigation();
  const pendingVisibleCode = useRef<string | null>(null);
  const toggle = useScreeningToggle((code) => { pendingVisibleCode.current = code; });
  const scroll = useRef<HTMLDivElement>(null);
  const zoom = clampZoom(store.settings.zoom ?? 1);
  const geometry = ganttGeometry(cat, date, zoom);
  const { ppm, rowH, labelW, start, end, width } = geometry;
  const day = cat.schedule.screenings.filter((s) => s.date === date);
  const venues = cat.venues.filter(
    (v) => venueAllowed(v.id, filters) && day.some((s) => s.venue_id === v.id),
  );
  const selected = codes
    .map((c) => cat.byCode.get(c)!)
    .filter((s) => s.date === date)
    .sort((a, b) => a.start_time.localeCompare(b.start_time));
  const tight = tightScreeningTips(cat, date, codes, conflicts.get(date)?.codeSet, talkOnOf, store.settings.transitMin);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow((previous) => {
      const next = new Date();
      return Math.floor(previous.getTime() / 60000) === Math.floor(next.getTime() / 60000) ? previous : next;
    });
    const timer = window.setInterval(tick, 20_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  const minute = now.getHours() * 60 + now.getMinutes();
  const nowX = todayIsoLocal() === date && minute >= start && minute <= end
    ? (minute - start) * ppm : null;
  useEffect(() => {
    const viewport = scroll.current;
    if (!viewport) return;
    const fit = () => {
      const height = Math.max(
        260,
        window.innerHeight - viewport.getBoundingClientRect().top - 24,
      );
      viewport.style.maxHeight = `${Math.round(height)}px`;
    };
    const observer = new ResizeObserver(fit);
    const panel = viewport.closest(".schedule-page");
    if (panel) observer.observe(panel);
    window.addEventListener("resize", fit);
    fit();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);

  const fitFromLeft = useRef(false);

  useLayoutEffect(() => {
    scroll.current?.scrollTo({ left: 0, top: 0 });
  }, [date]);

  useLayoutEffect(() => {
    const viewport = scroll.current;
    const code = pendingVisibleCode.current;
    if (!viewport || !code) return;
    const card = viewport.querySelector<HTMLElement>(`[data-grid-code="${CSS.escape(code)}"]`);
    if (card) {
      const parent = viewport.getBoundingClientRect(), rect = card.getBoundingClientRect();
      if (rect.left < parent.left + 48 || rect.right > parent.right - 48)
        viewport.scrollTo({ left: centerOf(viewport, card).left });
    }
    pendingVisibleCode.current = null;
  }, [location.pathname]);

  const focus = params.get("focus");
  const focusDate = params.get("focusDate");
  const locateRequest = params.get("locate") ?? `${date}|${focus}|${focusDate}`;
  const visibleVenueKey = venues.map((v) => v.id).join("|");
  const selectedCodeKey = selected.map((s) => s.code).join("|");
  const lastLocate = useRef("");
  useLayoutEffect(() => {
    const viewport = scroll.current;
    if (!viewport || (!focus && focusDate !== date)) return;
    const request = locateRequest;
    if (lastLocate.current === request) return;
    const targets = focus ? [focus] : selectedCodeKey.split("|").filter(Boolean);
    const target = targets[0] && viewport.querySelector<HTMLElement>(
      `[data-grid-code="${CSS.escape(targets[0])}"]`,
    );
    if (focus && !target) return; // The parent may be restoring a hidden venue.
    const center = target ? centerOf(viewport, target) : { left: viewport.scrollLeft, top: 0 };
    viewport.scrollTo({ left: center.left, top: focus ? center.top : 0 });
    if (focus && target) target.focus({ preventScroll: true });
    flashScreenings(viewport, targets);
    lastLocate.current = request;
  }, [date, focus, focusDate, locateRequest, visibleVenueKey, selectedCodeKey]);

  useEffect(() => {
    const viewport = scroll.current;
    if (!viewport) return;
    let wheelAcc = 0;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      wheelAcc += event.deltaY;
      if (Math.abs(wheelAcc) < 60) return;
      setSettings({ zoom: stepZoom(clampZoom(store.settings.zoom ?? 1), wheelAcc < 0 ? 1 : -1) });
      wheelAcc = 0;
    };
    let drag: { id: number; x: number; left: number } | null = null;
    let moved = false;
    const swallow = (event: MouseEvent) => {
      document.removeEventListener("click", swallow, true);
      if (moved) {
        event.preventDefault();
        event.stopPropagation();
      }
      moved = false;
    };
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const delta = event.clientX - drag.x;
      if (Math.abs(delta) > 5) moved = true;
      if (moved) {
        viewport.classList.add("schedule-panning");
        viewport.scrollLeft = drag.left - delta;
      }
    };
    const up = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      drag = null;
      viewport.classList.remove("schedule-panning");
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      if (!moved || event.type === "pointercancel") {
        moved = false;
        document.removeEventListener("click", swallow, true);
      }
    };
    const down = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || event.button !== 0 || viewport.scrollWidth <= viewport.clientWidth + 1) return;
      drag = { id: event.pointerId, x: event.clientX, left: viewport.scrollLeft };
      moved = false;
      document.addEventListener("click", swallow, true);
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
      document.addEventListener("pointercancel", up);
    };
    const preventImageDrag = (event: DragEvent) => event.preventDefault();
    viewport.addEventListener("wheel", wheel, { passive: false });
    viewport.addEventListener("pointerdown", down);
    viewport.addEventListener("dragstart", preventImageDrag);
    return () => {
      viewport.removeEventListener("wheel", wheel);
      viewport.removeEventListener("pointerdown", down);
      viewport.removeEventListener("dragstart", preventImageDrag);
      document.removeEventListener("click", swallow, true);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
    };
  }, []);
  return (
    <>
      <div className="schedule-legend">
        <span className="legend-selected">已选</span>
        <span className="legend-tight">时间紧张</span>
        <span className="legend-conflict">时间重叠</span>
        <span className="muted">韩国时间 KST</span>
        <div className="zoom-controls">
          <ActionButton
            aria-label="缩小排片表"
            isDisabled={zoom <= ZOOM_MIN}
            onPress={() => setSettings({ zoom: stepZoom(zoom, -1) })}
          >
            −
          </ActionButton>
          <span aria-label="缩放比例">{Math.round(zoom * 100)}%</span>
          <ActionButton
            aria-label="放大排片表"
            isDisabled={zoom >= ZOOM_MAX}
            onPress={() => setSettings({ zoom: stepZoom(zoom, 1) })}
          >
            ＋
          </ActionButton>
          <ActionButton
            onPress={() => {
              const next = fitZoomLevel(cat, date, scroll.current?.clientWidth ?? 800);
              fitFromLeft.current = next !== zoom;
              if (scroll.current) scroll.current.scrollLeft = 0;
              setSettings({ zoom: next });
            }}
          >
            适应
          </ActionButton>
          <ActionButton onPress={() => setSettings({ zoom: 1 })}>
            1:1
          </ActionButton>
        </div>
      </div>
      <GanttViewport date={date} zoom={zoom} geometry={geometry} viewportRef={scroll} fitFromLeft={fitFromLeft}>
        <div
          className="gantt-canvas"
          style={
            {
              width,
              "--row-h": `${rowH}px`,
              "--label-w": `${labelW}px`,
              "--hour-w": `${ppm * 60}px`,
              "--gantt-zoom": zoom,
            } as CSSProperties
          }
        >
          <div className="gantt-ruler">
            <div className="gantt-corner">影厅 / 时间</div>
            <div className="ruler-track">
              {Array.from(
                { length: (end - start) / 60 + 1 },
                (_, i) => start / 60 + i,
              ).map((h) => (
                <button
                  key={h}
                  type="button"
                  aria-label={`筛选 ${fmtEndClock(h * 60)} 时段`}
                  aria-pressed={hour === h}
                  style={{ left: (h * 60 - start) * ppm }}
                  onClick={() =>
                    update({ hour: hour === h ? null : String(h), focus: null, focusDate: null, locate: null }, true)
                  }
                >
                  {fmtEndClock(h * 60)}
                </button>
              ))}
              {start < 1440 && end > 1440 && (
                <span className="schedule-midnight" style={{ left: (1440 - start) * ppm }} title="跨午夜分界，右侧为次日凌晨" />
              )}
              {nowX !== null && (
                <span className="schedule-now-label" style={{ left: nowX }}>
                  现在 {fmtEndClock(minute)}
                </span>
              )}
            </div>
          </div>
          {venues.map((v) => (
            <div className="gantt-row" key={v.id}>
              <div className="venue-label" title={venueTip(v)}>
                <span className="code">{v.code}</span>
                <strong>{venueShort(v)}</strong>
              </div>
              <div className="gantt-track">
                {day
                  .filter((s) => s.venue_id === v.id)
                  .map((s) => {
                    const isSelected = Boolean(slotOf(s.code));
                    const conflict = conflicts.get(date)?.codeSet.has(s.code);
                    const info = filmInfoOf(cat, s, store.mappings.get(s.code));
                    const score = doubanScoreOf(
                      info.cats[0],
                      store.mappings.get(s.code),
                    );
                    const talk = gvTalkMin(s);
                    const cardState = cardStateOf(s, {
                      cat, pxPerMin: ppm,
                      row: { rowH, fontScale: zoom, insetY: 4 * zoom, showBadges: rowH >= 80 },
                      slots: store.slotIndex,
                      mappingOf: (code) => store.mappings.get(code),
                      conflictCodes: conflicts.get(date)?.codeSet,
                      conflictPairs: conflicts.get(date)?.pairs,
                      transitMin: store.settings.transitMin,
                      gvTalkOf: talkOnOf,
                      hourFilter: hour,
                      filters,
                    });
                    const detailTip = [
                      info.title,
                      `${s.code} ${s.start_time}–${fmtEndClock(effEndMin(s, talkOnOf(s.code)))}`,
                      cardState.conflictTip,
                      tight.get(s.code),
                    ].filter(Boolean).join("\n");
                    const bodyEnd =
                      talk > 0 ? filmEndMin(s) : hmsToMin(s.end_time);
                    const dim =
                      !matchesFilters(s, filters) ||
                      (hour !== null &&
                        !(
                          hmsToMin(s.start_time) < (hour + 1) * 60 &&
                          hmsToMin(s.end_time) > hour * 60
                        ));
                    const tone = conflict
                      ? "conflict"
                      : isSelected && tight.has(s.code)
                        ? "tight"
                        : isSelected
                          ? "selected"
                          : "";
                    return (
                      <div
                        data-grid-slot={s.code}
                        data-highlighted={
                          highlight.codes.has(s.code) || undefined
                        }
                        onMouseEnter={() => highlight.setCode(s.code)}
                        onMouseLeave={() => highlight.setCode(null)}
                        className={`gantt-slot ${dim ? "dimmed" : ""} ${tone}`}
                        key={s.code}
                        style={{
                          left: (hmsToMin(s.start_time) - start) * ppm + 2,
                          width:
                            (bodyEnd - hmsToMin(s.start_time) + talk) * ppm - 4,
                        }}
                      >
                        <button
                          type="button"
                          className="gantt-film"
                          data-grid-code={s.code}
                          aria-label={`${isSelected ? "移出" : "加入"}场次 ${s.code} ${info.title}`}
                          aria-pressed={isSelected}
                          onClick={() => toggle(s)}
                          style={{
                            width: (bodyEnd - hmsToMin(s.start_time)) * ppm - 4,
                          }}
                          title={detailTip}
                          aria-description={detailTip}
                        >
                          {info.cats[0]?.poster && (
                            <img
                              src={info.cats[0].poster}
                              alt=""
                              loading="lazy"
                            />
                          )}
                          <span className="gantt-film-text">
                            <span className="gantt-time">
                              <b>{s.code}</b> {s.start_time.slice(0, 5)}–
                              {fmtEndClock(bodyEnd)}
                            </span>
                            <strong>{info.title}</strong>
                            <span className="gantt-details">
                              {s.duration_min} 分钟
                              {score ? `，豆瓣 ${score.rating.toFixed(1)}` : ""}
                              {conflict ? "，时间重叠" : ""}
                            </span>
                            <Badges screening={s} />
                          </span>
                        </button>
                        <button
                          className="gantt-info"
                          type="button"
                          aria-label={`场次 ${s.code} 影片资料`}
                          onClick={() => openFilm(filmNodeKey(cat, s), s.code)}
                        >
                          ⓘ
                        </button>
                        {talk > 0 && (
                          <button
                            type="button"
                            className={`gantt-talk ${talkOnOf(s.code) ? "" : "talk-off"}`}
                            aria-label={isSelected ? `${talkOnOf(s.code) ? "放弃" : "参加"} ${s.code} 映后谈` : `仅加入 ${s.code} 正片，放弃映后谈`}
                            aria-pressed={talkOnOf(s.code) && isSelected}
                            title={cardState.talk?.tip}
                            aria-description={cardState.talk?.tip}
                            style={{ width: talk * ppm }}
                            onClick={() => {
                              if (!isSelected) toggle(s);
                              setGvTalk(
                                s.code,
                                isSelected ? !talkOnOf(s.code) : false,
                              );
                            }}
                          >
                            <span>映后</span>
                            <span>{talk}′</span>
                          </button>
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>
          ))}
          {nowX !== null && (
            <span
              className="schedule-now-line"
              aria-hidden="true"
              style={{ left: labelW + nowX, height: venues.length * rowH + 44 }}
            />
          )}
          <svg
            className="conflict-links"
            width={width}
            height={venues.length * rowH + 44}
            aria-hidden="true"
          >
            {conflicts.get(date)?.pairs.map(([a, b]) => {
              const sa = cat.byCode.get(a)!,
                sb = cat.byCode.get(b)!;
              const ia = venues.findIndex((v) => v.id === sa.venue_id),
                ib = venues.findIndex((v) => v.id === sb.venue_id);
              if (ia < 0 || ib < 0 || ia === ib) return null;
              const mid =
                (Math.max(hmsToMin(sa.start_time), hmsToMin(sb.start_time)) +
                  Math.min(
                    effEndMin(sa, talkOnOf(a)),
                    effEndMin(sb, talkOnOf(b)),
                  )) /
                2;
              const x = labelW + (mid - start) * ppm;
              return (
                <line
                  key={`${a}-${b}`}
                  x1={x}
                  x2={x}
                  y1={44 + (ia + 0.5) * rowH}
                  y2={44 + (ib + 0.5) * rowH}
                />
              );
            })}
          </svg>
        </div>
      </GanttViewport>
    </>
  );
}

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
  const entries = timelineEntries(cat, date, {
    filters,
    slots: store.slotIndex,
    gvTalkOf: talkOnOf,
    transitMin: store.settings.transitMin,
  });
  const shown = entries.filter(
    (e) =>
      hour === null ||
      (hmsToMin(e.s.start_time) < (hour + 1) * 60 &&
        effEndMin(e.s, talkOnOf(e.s.code)) > hour * 60),
  );
  const timeline = useRef<HTMLDivElement>(null);
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
  const timelineKey = shown.map((e) => e.s.code).join("|");
  const selectedTimelineKey = shown.filter((e) => e.picked).map((e) => e.s.code).join("|");
  const lastTimelineLocate = useRef("");
  useLayoutEffect(() => {
    const root = timeline.current;
    if (!mobile || !root || (!focusCode && focusDate !== date)) return;
    const request = locateRequest;
    if (lastTimelineLocate.current === request) return;
    const targets = focusCode ? [focusCode] : selectedTimelineKey.split("|").filter(Boolean);
    const target = targets[0] && root.querySelector<HTMLElement>(`[data-timeline-code="${CSS.escape(targets[0])}"]`);
    if (focusCode && !target) return;
    if (focusCode && target) target.scrollIntoView({ block: "center" });
    else root.scrollIntoView({ block: "start" });
    flashScreenings(root, targets);
    lastTimelineLocate.current = request;
  }, [mobile, date, focusCode, focusDate, locateRequest, timelineKey, selectedTimelineKey]);
  return (
    <section className="schedule-page panel" aria-label="排片表">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">
            {cat.dates[0]} 至 {cat.dates.at(-1)}
          </p>
          <h1>排片表</h1>
        </div>
        <span className="count">{entries.length} 场</span>
      </div>
      <div className="date-strip" aria-label="排片日期">
        {cat.dates.map((d) => (
          <ToggleButton
            key={d}
            isSelected={d === date}
            onChange={() => update({ date: d, focus: null, focusDate: null, hour: null, locate: null })}
            aria-label={`选择日期 ${d}`}
          >
            {dateInfo(d).label} {dateInfo(d).weekday}
          </ToggleButton>
        ))}
      </div>
      <FilterBar filters={filters} onChange={changeFilters} label="排片筛选" />
      {hour !== null && (
        <div className="inline-actions">
          <p>正在查看 {fmtEndClock(hour * 60)} 时段</p>
          <ActionButton onPress={() => update({ hour: null }, true)}>
            清除时段筛选
          </ActionButton>
        </div>
      )}
      <h2 className="schedule-date">
        {dateInfo(date).label} {dateInfo(date).weekday}
        <span className="muted">韩国时间 KST</span>
      </h2>
      {mobile ? (
        <div className="timeline" ref={timeline} aria-label="单日时间线">
          {shown.length === 0 && (
            <div className="empty-state">
              <h2>这一天没有符合条件的场次</h2>
              <p>调整筛选或选择其他日期。</p>
            </div>
          )}
          {shown.map((e) => (
            <div
              className="timeline-entry"
              key={e.s.code}
              data-timeline-code={e.s.code}
            >
              <time className="timeline-time">
                {e.s.start_time.slice(0, 5)}
              </time>
              <div>
                {e.slack && (
                  <p
                    className={`gap-label ${e.slack.verdict === "ok" ? "" : "gap-warning"}`}
                  >
                    {e.overlapMin
                      ? `与上一场重叠 ${e.overlapMin} 分钟`
                      : `距上一场 ${e.slack.gap} 分钟${e.crossVenue ? `，跨馆缓冲 ${store.settings.transitMin} 分钟` : ""}`}
                  </p>
                )}
                <ScreeningCard screening={e.s} controls={e.picked} wholeCard />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Gantt date={date} filters={filters} hour={hour} />
      )}
    </section>
  );
}
