import { screeningMembers } from "../app/screening-members";
import { ScreeningInfoPopover } from "./ScreeningInfoPopover";
import { TicketEditDialog } from "./TicketEditDialog";
import { officialStills } from "../app/official-stills";
import { highlightCodesFor, highlightedCode, setHighlight, subscribeHighlight } from "../app/highlight";
import { Component, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import {
  ActionButton,
  Button,
  ButtonGroup,
  Content,
  Dialog,
  DialogContainer,
  Heading,
  ToggleButton,
} from "./spectrum";
import { Badges, FilmBadge, GvDurationButton } from "./ScreeningCard";
import { FilterBar } from "./FilterBar";
import { useCatalog } from "../app/store";
import { useQuery } from "../app/hooks";
import {
  makeFilterState,
  matchesFilters,
  venueAllowed,
  type FilterState,
} from "../filters";
import { cardStateOf } from "../grid";
import { effEndMin, filmEndMin, gvTalkMin, talkOnOf } from "../gv";
import { setGvTalk, setSettings, slotOf, store, ticketInfoOf } from "../state";
import { ticketBadgeText, ticketInfoTitle } from "../ticket-info";
import { scheduleAria } from "../actions-copy";
import { removalDropsPick, useScreeningPicker } from "./screening-actions";
import {
  dateInfo,
  doubanScoreOf,
  filmInfoOf,
  fmtDuration,
  fmtEndClock,
  hmsToMin,
  todayIsoLocal,
} from "../util";
import { venueShort, venueTip } from "../legend";
import { tightScreeningTips } from "../app/schedule-model";
import { verticalGeometry, screeningLanes, captureVerticalAnchor, restoreVerticalAnchor, type VerticalAnchor, type VerticalGeometry } from "../app/vertical-schedule";
import type { Screening } from "../types";

/** 纵向日程表的**两种口径**(2026-09-21,`PLAN-20260921223658`)。
 *  - `schedule` = 排片表:画当日**全部**排片,三道筛选 + 可点整点刻度 + 「已选」图例;
 *  - `agenda`   = 「我的行程 → 日程表」:画布只有**我的场次**,影厅列只有**我有影片的影院**
 *    (由 `shows` 入参收窄),因此三道筛选 / 整点筛选 / 「已选」图例全部失去意义 —— 一并去掉。
 *  ⚠ 两档共用同一套几何(`app/vertical-schedule.ts`)、同一份卡片状态(`grid.ts::cardStateOf`)、
 *    同一处有效结束 / GV 口径(`gv.ts`)。不要在这里为某一档另算。 */
export type GanttScope = "schedule" | "agenda";

const SIZE_OPTIONS = [{label: "小", zoom: 0.45}, {label: "默认", zoom: 0.55}, {label: "大", zoom: 0.75}];
function scheduleZoom(value = 0.55) {
  const saved = Number.isFinite(value) ? value : 0.55;
  return SIZE_OPTIONS.reduce((nearest, option) => Math.abs(option.zoom - saved) < Math.abs(nearest.zoom - saved) ? option : nearest).zoom;
}

/** 画布图例的**色块**(时间紧张 / 时间重叠 / 韩国时间 KST)。
 *  两档画布共用这**一份**实现:排片表把它摆在 `.schedule-legend` 行里(连同「排片筛选」与「已选」),
 *  「我的行程」把它摆进顶部工具栏的左侧(见 `AgendaPage`,2026-09-22 `PLAN-20260922103307`)——
 *  两处的样式仍来自 `schedule-parity.css` 那套 `.schedule-legend > .legend-*`。
 *  ⚠ 图例只在**有画布**的视图里才有意义(行程的卡片视图没有画布),由调用方自己判。 */
export function GanttLegendChips() {
  return (
    <>
      <span className="legend-tight">时间紧张</span>
      <span className="legend-conflict">时间重叠</span>
      <span className="muted">韩国时间 KST</span>
    </>
  );
}

/** 缩放档位(小 / 默认 / 大)。挂在**父级**工具栏的行尾 —— 排片表在 `.schedule-legend` 行里,
 *  「我的行程」在顶部工具栏的右侧(见 `AgendaPage`)。
 *  ⚠ 档位表(`SIZE_OPTIONS`)与写入口径(`setSettings({zoom})`)仍只有这一处,别在页面里再写一份。 */
export function GanttZoomControls() {
  const zoom = scheduleZoom(store.settings.zoom);
  const current = SIZE_OPTIONS.reduce((nearest, candidate) => Math.abs(candidate.zoom - zoom) < Math.abs(nearest.zoom - zoom) ? candidate : nearest);
  return (
    <div className="zoom-controls" role="group" aria-label="排片大小">
      {SIZE_OPTIONS.map(option => <ToggleButton key={option.label} isSelected={option === current}
        onChange={() => setSettings({zoom: option.zoom})}>{option.label}</ToggleButton>)}
    </div>
  );
}

/** 行程档的「无筛选」状态 —— 行程画布不做字幕 / 影厅 / GV 筛选,但卡片状态仍要一份合法的筛选
 *  (空集 = 不过滤),不能传 `undefined` 让 `cardStateOf` 各判一次。 */
const NO_FILTERS = makeFilterState();
const noop = () => {};

/** 「行程画布上点掉一场」的二次确认(2026-09-22,`PLAN-20260922123138`)。
 *
 *  ★ 为什么**只有行程档**需要它:行程画布只画我的场次(`shows` = 当天我的场次),每一格都是
 *    「已选」,点一下的语义**只有「移出行程」一种**,而且原先静默生效、没有撤销,票务标记
 *    (`biff.tickets.v1`)还会随 `rebuildIndex()` 的 prune 一起消失。
 *    排片表那档点格子是「加入 / 移出」双向的日常动作 —— 每次拦一下才是增加成本,故不动。
 *  ★ 为什么用站内弹层而不是 `window.confirm`(用户拍板):① 与「删除方案 / 顺位修复」同一套观感;
 *    ② 原生 confirm 装不下「票务标记会一起清掉」「只剩这一场会连带移除选片」这两条必要前提。
 *  ★ 为什么挂 `DialogContainer` 而不是 `DialogTrigger`:格子是个原生 `<button>`,S2 的 DialogTrigger
 *    只把 `onPress` 交给 S2 组件;`DialogContainer` + 条件挂载是仓库既有路径
 *    (`App.tsx` / `FilmDialog` / `AccountHost`),也顺带避开「常驻 `Dialog` 被当成当前弹层」的坑
 *    (见 `SettingsDialog::ClearDialog` 的注释)。
 *  ★ 「只剩这一场」那句与弹原生 confirm 的判据**同一处**(`removalDropsPick`),确认时带
 *    `soleShowAsked: true` —— 用户不会为同一个后果被问两次。 */
function AgendaRemoveDialog({
  screening: s,
  onDismiss,
}: {
  screening: Screening;
  onDismiss: () => void;
}) {
  const { cat } = useCatalog();
  const toggle = useScreeningPicker();
  const venue = cat.venueById.get(s.venue_id);
  const title = filmInfoOf(cat, s, store.mappings.get(s.code)).title;
  return (
    <DialogContainer onDismiss={onDismiss}>
      <Dialog size="S">
        <Heading slot="title">把《{title}》移出行程？</Heading>
        <Content>
          <p>
            {dateInfo(s.date).label} {s.start_time.slice(0, 5)}–
            {fmtEndClock(effEndMin(s, talkOnOf(s.code)))}
            {venue ? `，${venueShort(venue)}` : ""}（场次 {s.code}）。
          </p>
          <p>移出后这一场不再出现在日程表与行程里，它的票务标记也会一起清掉。</p>
          {removalDropsPick(cat, s) && (
            <p>这部片只有这一场，移出会把它一起从「我的选片」移除。</p>
          )}
        </Content>
        <ButtonGroup>
          <Button variant="secondary" onPress={onDismiss}>
            取消
          </Button>
          <Button
            onPress={() => {
              toggle(s, { soleShowAsked: true });
              onDismiss();
            }}
          >
            移出行程
          </Button>
        </ButtonGroup>
      </Dialog>
    </DialogContainer>
  );
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

/** 这一生命周期要在 React 改动画布尺寸**之前**读到旧 DOM。
 * 用 layout effect 就太晚了：缩小已经先把 scrollLeft/Top 夹住了。
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

export interface ScheduleGanttProps {
  date: string;
  /** 整点筛选(点击左侧时间刻度)。日程表档传 `null`,且刻度渲染为不可点。 */
  hour: number | null;
  /** 排片表那套筛选(字幕 / 影厅 / GV)。缺省 = 不过滤(行程档不传)。 */
  filters?: FilterState;
  changeFilters?: (patch: Partial<FilterState>) => void;
  /** 画布**只画这些场次**(缺省 = 当日全部排片)。
   *  「我的行程」的日程表传自己的场次 —— 轴范围与影厅列随之只留「我的」。 */
  shows?: readonly Screening[];
  /** 画布口径,见 `GanttScope`。缺省 = 排片表。 */
  scope?: GanttScope;
}

export function ScheduleGantt({
  date,
  hour,
  filters = NO_FILTERS,
  changeFilters = noop,
  shows,
  scope = "schedule",
}: ScheduleGanttProps) {
  const agenda = scope === "agenda";
  const { cat, conflicts, codes } = useCatalog();
  const [filtersOpen, setFiltersOpen] = useState(false);
  // 待确认移除的那一场(只有行程档会写它,见 `AgendaRemoveDialog`)。
  // 存整条 `Screening` 而不是 code:弹层要印片名 / 时间 / 影院,而移除动作还没发生。
  const [pendingRemove, setPendingRemove] = useState<Screening | null>(null);
  // 待编辑票务的那一场(同样只有行程档会写它,见 `TicketEditDialog`)。
  // ⚠ 与 `pendingRemove` **是两个弹层**:右键和左键在同一格上的语义完全不同 ——
  //   左键 = 移出行程(带确认),右键 = 编辑票务。别把它们合到一个 state 上。
  const [pendingTicket, setPendingTicket] = useState<Screening | null>(null);
  const { params, update } = useQuery();
  const toggle = useScreeningPicker();
  const scroll = useRef<HTMLDivElement>(null);
  // 悬停高亮：**DOM 直改**而不是 React state（见 `highlight.tsx` 文件头）——
  // 每次 hover 若要重渲染，整张画布的所有 slot 都要重跑 filmInfoOf / cardStateOf / screeningMembers。
  //
  // ⚠ 每次渲染后都要重算一遍：React 重渲染 slot 时会把 imperative 写上的属性冲掉，
  //   而 store 订阅只覆盖「只有 hover 变化、没有重渲染」的那条路径。
  const applyHighlight = useRef<() => void>(() => {});
  useEffect(() => {
    applyHighlight.current = () => {
      const codes = highlightCodesFor(cat, conflicts, highlightedCode());
      for (const node of scroll.current?.querySelectorAll<HTMLElement>("[data-grid-slot]") ?? []) {
        const code = node.dataset.gridSlot;
        if (code && codes.has(code)) node.dataset.highlighted = "true";
        else delete node.dataset.highlighted;
      }
    };
    applyHighlight.current();
  });
  useEffect(() => subscribeHighlight(() => applyHighlight.current()), []);
  const zoom = scheduleZoom(store.settings.zoom);
  const [viewportWidth, setViewportWidth] = useState(0);
  const header = useRef<HTMLDivElement>(null);
  const day = shows ?? cat.schedule.screenings.filter((s) => s.date === date);
  const venues = cat.venues.filter(
    (v) => venueAllowed(v.id, filters) && day.some((s) => s.venue_id === v.id),
  );
  const geometry = verticalGeometry(cat, date, zoom, venues.length, viewportWidth + 72, day);
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
      {/* 这一行是**排片表**的图例 + 缩放。行程档没有它:那边的图例与缩放已由 `AgendaPage` 摆进
          页面顶部工具栏,与「添加转票场次 / 仅看实际行程 / 视图切换」并成一条
          (2026-09-22,`PLAN-20260922103307`)。组件仍是这一份,只是挂到了别处。 */}
      {!agenda && (
        <div className="schedule-legend">
          <ActionButton aria-expanded={filtersOpen} aria-controls="schedule-filter-fields" onPress={() => setFiltersOpen(open => !open)}>排片筛选</ActionButton>
          {/* 「已选」图例只在排片表有意义:行程画布上的每一格都是我的场次(2026-09-21)。 */}
          <span className="legend-selected">已选</span>
          <GanttLegendChips />
          <GanttZoomControls />
        </div>
      )}
      {!agenda && filtersOpen && <div id="schedule-filter-fields" className="schedule-filter-fields"><FilterBar filters={filters} onChange={changeFilters} label="排片筛选" fieldsOnly /></div>}
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
              ).map((h) => agenda ? (
                // 行程档的整点刻度**只是刻度**:这一页没有整点筛选,做成按钮就是个点了没反应的死控件;
                // 点了还会把 `hour` 写进 /agenda 的 URL(见 PLAN-20260921223658 方案取舍 D4)。
                <span key={h} className="ruler-tick" style={{ top: topPad + (h * 60 - start) * ppm }}>
                  {fmtEndClock(h * 60)}
                </span>
              ) : (
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
          {/* 边界文案是「当天还有别片」的补充说明 —— 画布只有我的场次时它反而误导
              (「10:00 之前无影片」其实当天有,只是不是我的),行程档不画(见 `GanttScope`)。 */}
          {!agenda && start > 8 * 60 && <div className="schedule-boundary schedule-boundary-before" style={{left: 0}}>{fmtEndClock(start)} 之前无影片</div>}
          {!agenda && end < 23 * 60 && <div className="schedule-boundary schedule-boundary-after" style={{left: 0, transform: `translateY(${height - 18}px)`}}>{fmtEndClock(end)} 之后无影片</div>}
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
                    // 票务标注:徽章只在有票务明细(加过座位行)时给出文案(见下面的渲染条件)
                    const ticketInfo = ticketInfoOf(s.code);
                    const badge = ticketBadgeText(ticketInfo);
                    // 正片末 = 有效结束的「弃映后」那一路（唯一来源 `gv.ts::effEndMin`）
                    const bodyEnd = effEndMin(s, false);
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
                        // `data-highlighted` 由上面的订阅直改 DOM（不在 render 里读 store）
                        onMouseEnter={() => setHighlight(s.code)}
                        onMouseLeave={() => setHighlight(null)}
                        // 右键 = 编辑这一场的票务(2026-09-24,`PLAN-20260924141442`),**只挂在行程档**:
                        // 排片表那档画的是全届排片,在那儿右键会盖掉浏览器原生菜单的日常用途
                        //(在新标签打开 / 复制链接),代价大于收益。
                        // ⚠ 必须 `preventDefault()`,否则原生菜单照样弹出来压在弹层上。
                        onContextMenu={
                          agenda
                            ? (event) => {
                                event.preventDefault();
                                setPendingTicket(s);
                              }
                            : undefined
                        }
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
                          // 行程档的每一格都是我的场次 → 这里的点击**只有「移出行程」一种含义**,
                          // 先出确认弹层再动手(2026-09-22,`PLAN-20260922123138`)。
                          // ⚠ 判据是 `agenda && isSelected`:排片表那档(以及理论上会出现在任何一档的
                          //   「未选」状态)仍是即时 `toggle` —— 那是双向日常动作,不拦。
                          onClick={() => {
                            if (agenda && isSelected) setPendingRemove(s);
                            else toggle(s);
                          }}
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
                              {fmtDuration(s.duration_min)}
                              {score ? `，豆瓣 ${score.rating.toFixed(1)}` : ""}
                              {conflict ? "，时间重叠" : ""}
                            </span>
                            <Badges screening={s} />
                          </span>
                        </button>
                        <ScreeningInfoPopover screening={s} />
                        {/* 票务标注(2026-09-24,`PLAN-20260924141442`)。两件都只挂行程档:
                            排片表那档画的是全届排片,一堆「N 张」只会挤掉片名与时间。
                            ⚠ 徽章只在**显式填过张数**时出现(`ticketBadgeText` 返回 null 即不渲染)——
                              不做「已抢到 = 1 张」的兜底徽章,否则整张画布都是「1 张」,标注失去信息量。 */}
                        {agenda && badge && (
                          <span className="gantt-ticket-badge" title={ticketInfoTitle(ticketInfo)}>
                            {badge}
                          </span>
                        )}
                        {/* 非右键入口(触摸设备没有右键,键盘也需要一个可聚焦的锚点)。
                            ⚠ 它与 `.gantt-film` 是**兄弟节点**,不是子节点 —— 点它不会冒泡到
                              「移出行程」那个按钮上,不存在误删场次的风险。 */}
                        {agenda && (
                          <button
                            type="button"
                            className="gantt-ticket-edit"
                            data-has-info={ticketInfoOf(s.code) ? "true" : undefined}
                            aria-label={`编辑场次 ${s.code} 的票务`}
                            title="编辑这一场的票数 / 座位 / 账号（也可以直接右键格子）"
                            onClick={() => setPendingTicket(s)}
                          >
                            <svg
                              width="16"
                              height="16"
                              viewBox="0 0 20 20"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.6"
                              aria-hidden="true"
                            >
                              <path d="M2 7.5V5.5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2a2.5 2.5 0 0 0 0 5v2a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-2a2.5 2.5 0 0 0 0-5Z" />
                              <path d="M11.5 4.5v11" strokeDasharray="2 2" />
                            </svg>
                          </button>
                        )}
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
      {/* 移除确认弹层(只有行程档会把它打开)。条件挂载:不进 DOM 就没有「常驻弹层」可言 */}
      {pendingRemove && (
        <AgendaRemoveDialog
          screening={pendingRemove}
          onDismiss={() => setPendingRemove(null)}
        />
      )}
      {/* 票务编辑弹层(右键 / 票按钮打开)。同样条件挂载 —— `SettingsDialog::ClearDialog`
          记过这个坑:常驻的 `Dialog` 会被当成「当前弹层」,一次打开冒出好几个。
          `key` 带上 code:连续编辑不同场次时保证状态重新初始化。 */}
      {pendingTicket && (
        <TicketEditDialog
          key={pendingTicket.code}
          screening={pendingTicket}
          onDismiss={() => setPendingTicket(null)}
        />
      )}
    </div>
  );
}
