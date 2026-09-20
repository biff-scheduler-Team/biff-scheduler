import { screeningMembers } from "../app/screening-members";
import { ScreeningInfoPopover } from "../components/ScreeningInfoPopover";
import { officialStills } from "../app/official-stills";
import { useHighlight } from "../app/highlight";
import { Component, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { ActionButton, ToggleButton, ToastQueue } from "../components/spectrum";
import {
  Badges,
  FilmBadge,
  GvDurationButton,
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
  cardStateOf,
} from "../grid";
import { effEndMin, filmEndMin, gvTalkMin, talkOnOf } from "../gv";
import {
  setGvTalk,
  setSettings,
  slotOf,
  store,
} from "../state";
import { scheduleAria } from "../actions-copy";
import { useScreeningPicker } from "../components/screening-actions";
import {
  dateInfo,
  doubanScoreOf,
  filmInfoOf,
  fmtEndClock,
  hmsToMin,
  todayIsoLocal,
} from "../util";
import { venueShort, venueTip } from "../legend";
import { timelineEntries } from "../timeline";
import { tightScreeningTips } from "../app/schedule-model";
import { verticalGeometry, screeningLanes, captureVerticalAnchor, restoreVerticalAnchor, type VerticalAnchor, type VerticalGeometry } from "../app/vertical-schedule";
import "./schedule-parity.css";

const SIZE_OPTIONS = [{label: "小", zoom: 0.45}, {label: "默认", zoom: 0.55}, {label: "大", zoom: 0.75}];
function scheduleZoom(value = 0.55) {
  const saved = Number.isFinite(value) ? value : 0.55;
  return SIZE_OPTIONS.reduce((nearest, option) => Math.abs(option.zoom - saved) < Math.abs(nearest.zoom - saved) ? option : nearest).zoom;
}

function ScheduleArtwork({ still, poster }: { still?: string; poster?: string }) {
  const [failed, setFailed] = useState(false);
  const source = (!failed && still) || poster;
  if (!source) return null;
  return <img src={source} alt="" loading="lazy" data-official-still={!failed && Boolean(still)} onError={() => setFailed(true)} />;
}

// 网格点选 / 取消走共享出口(`components/screening-actions.ts`):
// 取消「只有一场」的影片要先提示「会连选片一起移除」,提示只有一处实现(2026-09-16)。

const locateAnimations = new WeakMap<HTMLElement, Animation>();
function flashScreenings(root: HTMLElement, codes: string[]) {
  for (const code of codes) {
    const node = root.querySelector<HTMLElement>(
      `[data-grid-slot="${CSS.escape(code)}"], [data-timeline-code="${CSS.escape(code)}"]`,
    );
    if (!node) continue;
    locateAnimations.get(node)?.cancel();
    node.classList.add("schedule-located");
    // ⚠ 只闪**描边**,绝不动整格的 opacity(2026-09-17,`PLAN-20260917095517`)。
    //   动 opacity 会把整格内容一起抹淡 —— 红框 CODE 徽章本来就是透明底 + 红框
    //   (`style.css` 的 `.film-badge[data-badge="code"]`),格子一淡,用户读到的就是
    //   「CODE 197 一直在变透明又变不透明」,而不是「这一格被定位到了」。
    //   legacy 的 `biff-flash` 当年就用描边闪烁避开同一个坑(见 `legacy/src/style.css`)。
    // ⚠ 颜色必须取**计算后的 outline-color**:WAAPI 关键帧不收 `var()`,而 `.schedule-located`
    //   已经把 `outline: 3px solid var(--brand)` 解析成具体颜色 —— 亮/暗主题各取各的,
    //   这里再写一份品牌色就会在暗色下写死。
    const ring = getComputedStyle(node).outlineColor;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animation = node.animate(
      reduced
        ? [{ outlineColor: ring }, { outlineColor: ring }]
        : [
            { outlineColor: "transparent" },
            { outlineColor: ring },
            { outlineColor: "transparent" },
          ],
      { duration: 1000, iterations: 3 },
    );
    locateAnimations.set(node, animation);
    void animation.finished.then(() => node.classList.remove("schedule-located"), () => {});
  }
}

function centerOf(viewport: HTMLElement, card: HTMLElement) {
  const rect = viewport.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  return {
    left: viewport.scrollLeft + cardRect.left - rect.left - (viewport.clientWidth - cardRect.width) / 2,
    top: window.scrollY + cardRect.top - 64 - (window.innerHeight - 64 - Math.min(cardRect.height, window.innerHeight - 100)) / 2,
  };
}

interface GanttViewportProps {
  date: string;
  zoom: number;
  geometry: VerticalGeometry;
  viewportRef: RefObject<HTMLDivElement | null>;
  fitFromLeft: RefObject<boolean>;
  children: ReactNode;
}

/** This lifecycle reads the old DOM before React mutates canvas dimensions.
 * A layout effect is too late: shrinking has already clamped scrollLeft/Top.
 */
class GanttViewport extends Component<GanttViewportProps, object, VerticalAnchor | null> {
  getSnapshotBeforeUpdate(previous: GanttViewportProps) {
    const viewport = this.props.viewportRef.current;
    if (!viewport || previous.zoom === this.props.zoom || previous.date !== this.props.date) return null;
    return captureVerticalAnchor({...previous.geometry, railWidth: 0}, {scrollLeft: viewport.scrollLeft, clientWidth: viewport.clientWidth, top: viewport.getBoundingClientRect().top + 64}, {scrollY: window.scrollY, height: window.innerHeight});
  }

  componentDidUpdate(_previous: GanttViewportProps, _state: object, anchor: VerticalAnchor | null) {
    const viewport = this.props.viewportRef.current;
    if (viewport && anchor) {
      const position = restoreVerticalAnchor(anchor, {...this.props.geometry, railWidth: 0}, viewport.getBoundingClientRect().top + window.scrollY + 64, this.props.fitFromLeft.current);
      viewport.scrollLeft = position.left;
      window.scrollTo({top: position.pageY});
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
  changeFilters,
}: {
  date: string;
  filters: FilterState;
  hour: number | null;
  changeFilters: (patch: Partial<FilterState>) => void;
}) {
  const { cat, conflicts, codes } = useCatalog();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const highlight = useHighlight();
  const { params, update } = useQuery();
  const toggle = useScreeningPicker();
  const scroll = useRef<HTMLDivElement>(null);
  const zoom = scheduleZoom(store.settings.zoom);
  const [viewportWidth, setViewportWidth] = useState(0);
  const header = useRef<HTMLDivElement>(null);
  const day = cat.schedule.screenings.filter((s) => s.date === date);
  const venues = cat.venues.filter(
    (v) => venueAllowed(v.id, filters) && day.some((s) => s.venue_id === v.id),
  );
  const geometry = verticalGeometry(cat, date, zoom, venues.length, viewportWidth + 72);
  const { ppm, columnWidth, railWidth: labelW, topPad, start, end, width, height } = geometry;
  const rowH = 112 * zoom;
  const lanes = new Map(venues.flatMap(v => [...screeningLanes(day.filter(s => s.venue_id === v.id))]));
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
    const pinHeader = () => {
      if (header.current) {
        const top = Math.min(Math.max(0, -viewport.getBoundingClientRect().top), Math.max(0, viewport.clientHeight - 64));
        header.current.style.opacity = "1";
        header.current.style.transform = `translateY(${top}px)`;
      }
    };
    const fit = () => { setViewportWidth(viewport.clientWidth); pinHeader(); };
    const observer = new ResizeObserver(fit);
    observer.observe(viewport);
    window.addEventListener("scroll", pinHeader, {passive: true});
    window.addEventListener("resize", fit);
    fit();
    return () => { observer.disconnect(); window.removeEventListener("scroll", pinHeader); window.removeEventListener("resize", fit); };
  }, []);

  const fitFromLeft = useRef(false);

  useLayoutEffect(() => {
    scroll.current?.scrollTo({ left: 0, top: 0 });
  }, [date]);


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
    viewport.scrollLeft = center.left;
    window.scrollTo({top: focus ? center.top : window.scrollY + viewport.getBoundingClientRect().top - 64});
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
      const current = scheduleZoom(store.settings.zoom);
      const next = wheelAcc < 0 ? SIZE_OPTIONS.find(option => option.zoom > current)?.zoom : [...SIZE_OPTIONS].reverse().find(option => option.zoom < current)?.zoom;
      if (next !== undefined) setSettings({zoom: next});
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
    <div className="vertical-schedule">
      <div className="schedule-legend">
        <ActionButton aria-expanded={filtersOpen} aria-controls="schedule-filter-fields" onPress={() => setFiltersOpen(open => !open)}>排片筛选</ActionButton>
        <span className="legend-selected">已选</span>
        <span className="legend-tight">时间紧张</span>
        <span className="legend-conflict">时间重叠</span>
        <span className="muted">韩国时间 KST</span>
        <div className="zoom-controls" role="group" aria-label="排片大小">
          {SIZE_OPTIONS.map(option => <ToggleButton key={option.label}
            isSelected={option === SIZE_OPTIONS.reduce((nearest, candidate) => Math.abs(candidate.zoom - zoom) < Math.abs(nearest.zoom - zoom) ? candidate : nearest)}
            onChange={() => setSettings({zoom: option.zoom})}>{option.label}</ToggleButton>)}
        </div>
      </div>
      {filtersOpen && <div id="schedule-filter-fields" className="schedule-filter-fields"><FilterBar filters={filters} onChange={changeFilters} label="排片筛选" fieldsOnly /></div>}
      <div className="schedule-grid" style={{"--label-w": `${labelW}px`, "--hour-w": `${ppm * 60}px`} as CSSProperties}>
        <div className="schedule-time-column">
          <div className="vertical-corner" style={{width: labelW}} title="横轴：影厅；纵轴：韩国时间 KST（UTC+9）" aria-label="横轴影厅，纵轴韩国时间 KST">
            <svg className="axis-corner-diagram" viewBox="0 0 72 64" aria-hidden="true">
              <path className="axis-divider" d="M0 0L72 64" />
              <text className="axis-venue-label" x="47" y="21" textAnchor="middle">影厅</text>
              <g className="axis-clock" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                <circle cx="16" cy="35" r="7" />
                <path d="M16 31v4l3 2" />
              </g>
              <text className="axis-timezone" x="25" y="55" textAnchor="middle">KST</text>
            </svg>
          </div>
          <div className="gantt-ruler" style={{width: labelW, height}}>
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
                  style={{ top: topPad + (h * 60 - start) * ppm }}
                  onClick={() =>
                    update({ hour: hour === h ? null : String(h), focus: null, focusDate: null, locate: null }, true)
                  }
                >
                  {fmtEndClock(h * 60)}
                </button>
              ))}
              {start < 1440 && end > 1440 && (
                <span className="schedule-midnight" style={{ top: topPad + (1440 - start) * ppm }} title="跨午夜分界，下方为次日凌晨" />
              )}
              {nowX !== null && (
                <span className="schedule-now-label" style={{ top: topPad + nowX }}>
                  现在 {fmtEndClock(minute)}
                </span>
              )}
            </div>
          </div>
        </div>
        <GanttViewport date={date} zoom={zoom} geometry={geometry} viewportRef={scroll} fitFromLeft={fitFromLeft}>
          <div className="venue-header-scroll" ref={header} style={{width: width - labelW}}>
            <div className="venue-headers" style={{width: width - labelW, height: 64}}>
              {venues.map(v => <div className="vertical-venue" key={v.id} title={venueTip(v)} style={{width: columnWidth}}><span className="code venue-code">{v.code}</span><strong>{venueShort(v)}</strong></div>)}
            </div>
          </div>
        <div
          className="gantt-canvas"
          style={
            {
              width: width - labelW, height,
              "--row-h": `${rowH}px`,
              "--label-w": `${labelW}px`,
              "--hour-w": `${ppm * 60}px`,
              "--gantt-zoom": zoom,
            } as CSSProperties
          }
        >
          {start > 8 * 60 && <div className="schedule-boundary schedule-boundary-before" style={{left: 0}}>{fmtEndClock(start)} 之前无影片</div>}
          {end < 23 * 60 && <div className="schedule-boundary schedule-boundary-after" style={{left: 0, transform: `translateY(${height - 18}px)`}}>{fmtEndClock(end)} 之后无影片</div>}
          {venues.map((v, venueIndex) => (
            <div className="gantt-row" key={v.id} style={{left: venueIndex * columnWidth, width: columnWidth, height}}>
              <div className="gantt-track" style={{height, backgroundPositionY: topPad}}>
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
                    const members = screeningMembers(cat, s);
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
                          top: topPad + (hmsToMin(s.start_time) - start) * ppm + 2,
                          left: (lanes.get(s.code)?.lane ?? 0) * columnWidth / (lanes.get(s.code)?.count ?? 1) + 3,
                          width: columnWidth / (lanes.get(s.code)?.count ?? 1) - 6,
                          height: (bodyEnd - hmsToMin(s.start_time) + talk) * ppm - 4,
                        }}
                      >
                        <button
                          type="button"
                          className="gantt-film"
                          data-grid-code={s.code}
                          aria-label={scheduleAria(isSelected, s.code, info.title)}
                          aria-pressed={isSelected}
                          onClick={() => toggle(s)}
                          style={{
                            height: (bodyEnd - hmsToMin(s.start_time)) * ppm - 6,
                          }}
                          title={detailTip}
                          aria-description={detailTip}
                        >
                          {members.length ? <div className={`gantt-member-artwork ${members.length === 2 ? "gantt-member-pair" : ""}`} >{members.map(member => <ScheduleArtwork key={member.name} still={officialStills[member.name]} poster={member.film?.poster} />)}{members.length === 2 && <span className="member-plus" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg></span>}</div> : <ScheduleArtwork key={`${s.code}-${info.en}`} still={officialStills[info.en]} poster={info.cats[0]?.poster} />}
                          <span className="gantt-film-text">
                            <span className="gantt-time">
                              <FilmBadge kind="code" label={s.code} />
                              <span>{s.start_time.slice(0, 5)}-{fmtEndClock(bodyEnd)}</span>
                            </span>
                            <strong className="gantt-bilingual-title">
                              {members.length ? members.map(member => <span key={member.name} className="gantt-member-title">{member.name}{member.film?.title_zh && member.film.title_zh !== member.name && <span>{member.film.title_zh}</span>}</span>) : [...new Set([info.en, info.zh].map(name => name?.trim()).filter(Boolean))].map(name => <span key={name}>{name}</span>)}
                            </strong>
                            <span className="gantt-details">
                              {s.duration_min} 分钟
                              {score ? `，豆瓣 ${score.rating.toFixed(1)}` : ""}
                              {conflict ? "，时间重叠" : ""}
                            </span>
                            <Badges screening={s} />
                          </span>
                        </button>
                        <ScreeningInfoPopover screening={s} />
                        {isSelected && s.is_gv && talk === 0 && <div className="grid-gv-duration" style={{bottom: 4}}><GvDurationButton screening={s} iconOnly /></div>}
                        {talk > 0 && (
                          <div className="gantt-talk-section" style={{height: talk * ppm}}>
                          <button
                            type="button"
                            className={`gantt-talk ${talkOnOf(s.code) ? "" : "talk-off"}`}
                            data-film-selected={isSelected}
                            aria-label={`${s.code} 参加映后谈`}
                            aria-pressed={talkOnOf(s.code)}
                            title={isSelected ? "切换是否参加映后谈，保留正片选择" : "加入影片并参加映后谈"}
                            style={{ height: "100%" }}
                            onClick={() => {
                              if (!isSelected) {
                                toggle(s);
                                setGvTalk(s.code, true);
                              } else setGvTalk(s.code, !talkOnOf(s.code));
                            }}
                          >
                            <span className="gv-time-range">{fmtEndClock(filmEndMin(s))}-{fmtEndClock(filmEndMin(s) + talk)}</span>
                            <span className="gv-attendance-label"><span aria-hidden="true">{talkOnOf(s.code) ? "✓" : "×"}</span> 映后 {talk}′</span>
                          </button>
                          {isSelected && <div className="gv-inline-edit"><GvDurationButton screening={s} iconOnly /></div>}
                          </div>
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
              style={{ top: topPad + nowX, left: 0, width: width - labelW }}
            />
          )}
          <svg
            className="conflict-links"
            width={width - labelW}
            height={height}
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
              const y = topPad + (mid - start) * ppm;
              return (
                <line
                  key={`${a}-${b}`}
                  x1={(ia + 0.5) * columnWidth}
                  x2={(ib + 0.5) * columnWidth}
                  y1={y}
                  y2={y}
                />
              );
            })}
          </svg>
        </div>
      </GanttViewport>
      </div>
    </div>
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
      <Gantt date={date} filters={filters} hour={hour} changeFilters={changeFilters} />
    </section>
  );
}
