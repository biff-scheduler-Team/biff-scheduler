import { useScheduleSelection } from "../app/schedule-selection";
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import {
  ActionButton,
  Button,
  ButtonGroup,
  Dialog,
  DialogTrigger,
  Heading,
  Content,
  ToggleButton,
} from "../components/spectrum";
import { TransferAddEntry } from "../components/TransferAddDialog";
import { ScreeningCard } from "../components/ScreeningCard";
// 日程表视图与排片表共用同一个甘特组件(2026-09-21,PLAN-20260921223658):
// `scope="agenda"` 换掉图例 / 刻度 / 边界文案,`shows` 把画布收成「我的场次」。
// 图例与缩放档位也复用排片表那两只组件(2026-09-22,PLAN-20260922103307):它们的**实现**只有一份,
// 只是行程档把它们挂进了页面顶部工具栏(见下方 `toolbar`),不再挂在画布自己的 `.schedule-legend` 行里。
import {
  GanttLegendChips,
  GanttZoomControls,
  ScheduleGantt,
} from "../components/ScheduleGantt";
import { useCatalog } from "../app/store";
import { useHighlight } from "../app/highlight";
import { navSearch } from "../app/nav-query";
import { useScheduleNavigation } from "../app/navigation";
import { agendaItems, rankSpotOrder } from "../app/agenda-model";
import {
  isAgendaFolded,
  setRanks,
  store,
  tickets,
  toggleAgendaFold,
} from "../state";
import { actualCodeSet } from "../tickets";
import { autoFixRanks } from "../plans";
import {
  dateInfo,
  displayTitle,
  fmtEndClock,
  groupByDate,
  hmsToMin,
  slackBetween,
  todayIsoLocal,
} from "../util";
import { effEndMin, gvTalkMin, talkOnOf } from "../gv";
import { scorePlanRows } from "../score";
import { formatKrw, priceOf } from "../extras";
import type { Screening } from "../types";
import { SCHEDULE_LABEL } from "../actions-copy";
import "./agenda-parity.css";

/* `saveCodes()`(保存方案的 toast 包装)与 `DeletePlanButton`(删除入口 + 二次确认)
 * 随「已保存方案」一起下线(2026-09-22,`PLAN-20260922105228`)——
 * 页面上的保存 / 查看场次 / 删除三个入口都在这一个区块里,方案没了它们就没有宿主了。 */

function RankGroup({ codes }: { codes: string[] }) {
  const slotFilter = useScheduleSelection();
  const { cat, plans } = useCatalog();
  const list = useRef<HTMLOListElement>(null);
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      dragCleanup.current?.();
    },
    [codes],
  );
  const move = (code: string, to: number) => {
    const next = codes.filter((c) => c !== code);
    next.splice(to, 0, code);
    setRanks(next);
  };
  const startDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    code: string,
  ) => {
    if ((event.pointerType === "mouse" && event.button !== 0) || !list.current)
      return;
    event.preventDefault();
    dragCleanup.current?.();
    const handle = event.currentTarget;
    const container = list.current;
    const pointerId = event.pointerId;
    const rows = Array.from(container.children) as HTMLLIElement[];
    const from = codes.indexOf(code);
    const row = rows[from];
    // ⚠ 判定坐标必须与容器同基准:拖拽中途页面可能被滚动(拖到视口边缘的自动滚动 /
    //   浏览器把目标元素滚进视口),此时 pointerdown 时刻捕获的视口 rect 与后续的
    //   `e.clientY` 不再是同一坐标系,阈值会整体偏移、顺位判定错位。
    //   这里统一换算成「相对容器顶」的局部坐标,滚动量由 paint() 里重新读取的容器 rect 吸收。
    const containerTop = container.getBoundingClientRect().top;
    const rects = rows.map((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top - containerTop, height: rect.height };
    });
    const startY = event.clientY - containerTop;
    const centerY = rects[from].top + rects[from].height / 2;
    const gap = Number.parseFloat(getComputedStyle(container).rowGap) || 0;
    let target = from;
    let moved = false;
    let finished = false;
    container.dataset.rankDragging = "true";
    row.dataset.dragging = "true";
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      /* Window listeners also retain the gesture. */
    }
    const paint = (y: number) => {
      // 容器 rect 每次现取:页面在拖拽期间滚动时,行与指针一起位移,差值才是真实拖拽距离
      const dy = y - container.getBoundingClientRect().top - startY;
      target = rects.filter(
        (rect, i) => i !== from && rect.top + rect.height / 2 < centerY + dy,
      ).length;
      rows.forEach((element, i) => {
        const shift =
          from < target && i > from && i <= target
            ? -(rects[from].height + gap)
            : from > target && i >= target && i < from
              ? rects[from].height + gap
              : 0;
        element.style.transform = `translateY(${i === from ? dy : shift}px)`;
      });
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      e.preventDefault();
      moved = true;
      paint(e.clientY);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        /* Capture may already be released. */
      }
      delete container.dataset.rankDragging;
      for (const element of rows) {
        element.style.removeProperty("transform");
        delete element.dataset.dragging;
      }
      dragCleanup.current = null;
    };
    const finish = (e: PointerEvent) => {
      if (finished || e.pointerId !== pointerId) return;
      finished = true;
      if (moved) paint(e.clientY);
      cleanup();
      if (moved && target !== from) move(code, target);
    };
    dragCleanup.current = cleanup;
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };
  const shows = codes.map((code) => cat.byCode.get(code)!);
  const from = shows
    .map((s) => s.start_time)
    .sort()[0]
    .slice(0, 5);
  const to = fmtEndClock(Math.max(...shows.map((s) => hmsToMin(s.end_time))));
  const broken = codes.some((code) => plans.broken.has(code));
  return (
    <section
      className="rank-group"
      aria-label={`冲突组 ${codes.join(" ")}`}
      data-broken={broken || undefined}
    >
      <div className="rank-heading">
        <strong>
          {from}–{to}，{codes.length} 场重叠
        </strong>
        <span>{broken ? "方案内部仍重叠" : "已排偏好次序"}</span>
        <span>拖动左侧把手调整抢票顺位，顺位 1 为首选。</span>
      </div>
      <ol ref={list}>
        {codes.map((code, i) => (
          <li key={code} data-rank-code={code}>
            <div className="rank-controls">
              <button
                type="button"
                className="drag-handle"
                aria-label={`拖动场次 ${code} 排序`}
                onPointerDown={(event) => startDrag(event, code)}
              >
                ⠿
              </button>
              <strong>顺位 {i + 1}</strong>
              <ActionButton
                aria-label={`提高 ${code} 顺位`}
                isDisabled={i === 0}
                onPress={() => move(code, i - 1)}
              >
                上移
              </ActionButton>
              <ActionButton
                aria-label={`降低 ${code} 顺位`}
                isDisabled={i === codes.length - 1}
                onPress={() => move(code, i + 1)}
              >
                下移
              </ActionButton>
            </div>
            {/* ⚠ 不再传 `locate`(2026-09-21,`PLAN-20260921223658` 修订 1):行程页默认就是日程表,
                单场「定位」跳去排片表没有意义;要跨页定位从「我的选片」的场次卡进。 */}
            <ScreeningCard
              screening={cat.byCode.get(code)!}
              controls
              venueInfo
              slotFilter={slotFilter}
              social
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

function RankClashes() {
  const { cat, plans, keyOf } = useCatalog();
  const clashes = plans.rankClashes;
  if (!clashes.length) return null;
  const fix = autoFixRanks(plans.groups, keyOf);
  const firstLayer = clashes.filter((clash) => clash.layer === 1).length;
  const groupLabel = (code: string) => {
    const s = cat.byCode.get(code);
    return s ? `${dateInfo(s.date).label} ${s.start_time.slice(0, 5)}` : code;
  };
  const shortCode = (code: string) => {
    const s = cat.byCode.get(code);
    return s ? `${s.start_time.slice(0, 5)} · ${code}` : code;
  };
  return (
    <section className="notice rank-clashes" aria-label="顺位撞车">
      <strong>
        {firstLayer
          ? `${firstLayer} 个冲突组在第 1 顺位撞到同一部片`
          : `${clashes.length} 处顺位撞车`}
      </strong>
      <p>同一层里的同片重复会被剔除，让一组让路即可恢复。</p>
      <DialogTrigger>
        <ActionButton>预览顺位修复</ActionButton>
        <Dialog>
          {({ close }) => (
            <>
              <Heading slot="title">调整抢票顺位</Heading>
              <Content>
                {!fix.changes.length ? (
                  <p>
                    {fix.remaining.length
                      ? "没有可让路的场次，每个撞车组里其余场次也都是同一部片。"
                      : "顺位已经是干净的，无需修复。"}
                  </p>
                ) : (
                  <>
                    <p>将调整 {fix.changes.length} 个组的顺位：</p>
                    {fix.changes.map((change) => (
                      <p key={change.group}>
                        {groupLabel(change.before[0])}：
                        {change.before.map(shortCode).join(" → ")} 改为{" "}
                        {change.after.map(shortCode).join(" → ")}
                      </p>
                    ))}
                    {fix.remaining.length > 0 && (
                      <p>
                        另有 {fix.remaining.length}{" "}
                        处撞车未能自动修复，无处可让。
                      </p>
                    )}
                  </>
                )}
              </Content>
              <ButtonGroup>
                <Button onPress={close} variant="secondary">
                  取消
                </Button>
                {fix.changes.length > 0 && (
                  <Button
                    onPress={() => {
                      fix.changes.forEach((change) => setRanks(change.after));
                      close();
                    }}
                  >
                    应用修复
                  </Button>
                )}
              </ButtonGroup>
            </>
          )}
        </Dialog>
      </DialogTrigger>
      {clashes.map((clash) => {
        const first = cat.byCode.get(clash.spots[0].code);
        const film = first
          ? displayTitle(first, store.mappings.get(first.code)?.title_cn)
          : clash.filmKey;
        return (
          <div
            className="rank-clash-item"
            key={`${clash.layer}-${clash.filmKey}`}
          >
            <p>
              第 {clash.layer} 顺位，{clash.spots.length} 个冲突组都把《{film}
              》排在这里
            </p>
            <div className="inline-actions">
              {clash.spots.map((spot) =>
                spot.alt === null ? (
                  <span className="muted" key={spot.group}>
                    {groupLabel(spot.code)}{" "}
                    组：组内其余场次都是同一部片，无法让路
                  </span>
                ) : (
                  <ActionButton
                    key={spot.group}
                    onPress={() => {
                      const next = rankSpotOrder(plans.groups, spot);
                      if (next) setRanks(next);
                    }}
                  >
                    {groupLabel(spot.code)} 组改选 {spot.alt}
                  </ActionButton>
                ),
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function Gap({ before, after }: { before: Screening; after: Screening }) {
  const gap = slackBetween(
    effEndMin(before, talkOnOf(before.code)),
    hmsToMin(after.start_time),
    before.venue_id === after.venue_id,
    store.settings.transitMin,
  );
  return (
    <p
      className={`gap-label ${gap.verdict === "ok" ? "" : "gap-warning"}`}
      title={`上一场 ${before.code} 至 ${fmtEndClock(effEndMin(before, talkOnOf(before.code)))} 结束，转场余量 ${gap.slack} 分钟`}
    >
      间隔 {gap.gap} 分钟
      {before.venue_id !== after.venue_id && gap.need > 0
        ? `，跨馆缓冲 ${gap.need} 分钟`
        : ""}
      {gvTalkMin(before) > 0 && !talkOnOf(before.code) ? "，上场弃映后" : ""}
      {gap.verdict === "bad"
        ? "，赶不上"
        : gap.verdict === "tight"
          ? "，时间紧张"
          : ""}
    </p>
  );
}

/** 「我的行程」的两种呈现(2026-09-21,`PLAN-20260921223658`)。
 *  - `gantt`(默认)= 单日**日程表**:与排片表同一套纵向甘特,但画布只有我的场次、
 *    X 轴只有我有影片的影厅、冲突画成连线(见 `components/ScheduleGantt.tsx` 的 `scope`)
 *  - `cards` = 原来的按天卡片列表(顺位卡 / 间隔提示 / 按日折叠),完整保留为回退路径 */
type AgendaView = "gantt" | "cards";

/** 视图选择的**会话内记忆**(模块级变量,卸载不丢)。
 *  为什么不是散在组件里的 `useState`:「我的行程 → 定位场次 → 排片表 → 切回来」会整页卸载重挂,
 *  没有它用户每来回一次就得重切一遍。
 *  ⚠ 故意**不落 localStorage**、刷新即回默认「日程表」:见 `PLAN-20260921223658` 方案取舍 D1 ——
 *   `biff.*` 的读写会被 E2E 的字节级存储快照断言看见,为「记住一次切换」打红一批无关 spec 不划算。 */
let agendaViewMemory: AgendaView = "gantt";

/** 右侧栏是否折叠(**会话内记忆**,与 `agendaViewMemory` 同一取舍与同一理由)。 */
let agendaSideFoldedMemory = false;

export function AgendaPage() {
  const slotFilter = useScheduleSelection();
  const { cat, codes, plans, conflicts, keyOf } = useCatalog();
  const navigate = useNavigate();
  const location = useLocation();
  const { locateDate } = useScheduleNavigation();
  // 「仅看实际行程」(2026-09-14,PLAN-20260914164050):只显示票务状态标了「已抢到」的场次。
  // 纯视图筛选 —— 数据仍在同一份行程里,票务状态存在独立键 `biff.tickets.v1`。
  const [actualOnly, setActualOnly] = useState(false);
  const [view, setView] = useState<AgendaView>(() => agendaViewMemory);
  // 换视图要同时写回会话记忆(见 `agendaViewMemory` 的注释)
  const changeView = (next: AgendaView) => {
    agendaViewMemory = next;
    setView(next);
  };
  // 右侧栏的折叠(2026-09-22,`PLAN-20260922105228`):与 `agendaViewMemory` 同口径 ——
  // **会话内记忆、刷新即回默认展开**,理由见 `agendaViewMemory`(不落 localStorage,
  // 免得为「记住一次折叠」打红一批字节级存储断言)。
  const [sideFolded, setSideFolded] = useState(agendaSideFoldedMemory);
  const toggleSide = () => {
    agendaSideFoldedMemory = !sideFolded;
    setSideFolded(!sideFolded);
  };
  const highlight = useHighlight();
  const actual = actualCodeSet(tickets);
  const selected = codes
    .filter((code) => !actualOnly || actual.has(code))
    .map((code) => cat.byCode.get(code)!)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.start_time.localeCompare(b.start_time),
    );
  const score = scorePlanRows(
    selected.map((screening) => ({ screening })),
    store.settings.transitMin,
    15,
    (s) => effEndMin(s, talkOnOf(s.code)),
  );
  // 日程表是**单日**视图,日期条只列「我有行程的日期」(排片表那条列全届日期)。
  const days = groupByDate(selected, (s) => s.date);
  // 「选中的日子」不额外存状态,由「当前行程 + 上次点的那天」派生 —— 移出行程 / 切「仅看实际行程」
  // 之后不会留在一个已经不存在的日期上(否则画布会空着且日期条上没有对应项)。
  // 默认落哪天:**今天**有我的场次就落今天;今天没有就落最近的未来场次;整段都在过去则落最后一天。
  // ⚠ 别退回「直接取 days[0]」——电影节期间用户每次进来看到的都是已经过完的第一天。
  const [pickedDate, setPickedDate] = useState<string | null>(null);
  const dateKeys = days.map(([date]) => date);
  const today = todayIsoLocal();
  const fallbackDate = today && dateKeys.includes(today)
    ? today
    : (dateKeys.find((date) => date > today) ?? dateKeys[dateKeys.length - 1] ?? null);
  const activeDate = dateKeys.includes(pickedDate ?? "")
    ? pickedDate
    : fallbackDate;
  const dayRows = days.find(([date]) => date === activeDate)?.[1] ?? [];
  // 「仅看实际行程」时不摆顺位卡:票都抢完了,再显示「顺位 1 / 备选」只会误导
  const activeGroups = actualOnly
    ? []
    : plans.groups.filter(
        (group) => cat.byCode.get(group[0])?.date === activeDate,
      );
  // 日期条(2026-09-22,`PLAN-20260922103307`):从画布容器里**提**到概览条下面 —— 用户原话是
  // 「作为主视图的全局日期 Filter」,它不是画布内部的装饰。夹在工具栏与画布之间时,它看起来
  // 既像工具栏的第三行、又看不出自己在筛谁。
  // ⚠ 只在日程表视图且**确实有可排场次**时渲染:卡片视图按日整段列出、自带折叠,
  //   再给一条单选日期条就成了第二套「看哪天」的入口;一场都没标「已抢到」时整条会空着。
  const dateStrip = (
    <div className="date-strip calendar-strip" aria-label="行程日期">
      {days.map(([date, rows]) => (
        <ToggleButton
          key={date}
          isSelected={date === activeDate}
          onChange={() => setPickedDate(date)}
          aria-label={`选择日期 ${date}`}
        >
          <span className="calendar-day">
            <span className="calendar-weekday">{dateInfo(date).weekday}</span>
            <span className="calendar-number">{Number(date.slice(-2))}</span>
            <span className="calendar-count">{rows.length} 场</span>
          </span>
        </ToggleButton>
      ))}
    </div>
  );
  const hasCanvas = view === "gantt" && days.length > 0;
  // 一条工具栏(2026-09-22,`PLAN-20260922103307`)—— 左组「状态 / 操作」,右组「视图 / 核心操作」。
  // 改动前这里是**两行**:上一行「添加转票场次 + 仅看实际行程 + 视图切换」,下一行是画布自己的
  // 图例(时间紧张 / 时间重叠 / 韩国时间 KST)与缩放 —— 两组功能各不相同,却都横在首屏,焦点很散。
  // ⚠ 图例与缩放只属于**画布**:卡片视图 / 没有可排场次时,它们点了没有任何效果,故不渲染
  //   (别为了「看起来稳定」把死控件常驻)。
  const toolbar = (
    <div className="agenda-actions">
      <div className="agenda-actions-left">
        {/* 日期导航并进工具栏(2026-09-22,`PLAN-20260922105228`):它是主视图的**全局日期 Filter**,
            不该独占一行 —— 与图例 / 操作同排,左组仍是「状态与操作」。
            ⚠ 日历卡与排片表**同一份**样式(`.date-strip.calendar-strip`),别为这一页另做小号卡。 */}
        {hasCanvas && dateStrip}
        {hasCanvas && (
          // 类名沿用排片表那条口径(`.schedule-legend`),两处共用同一份图例样式
          <div className="schedule-legend agenda-legend">
            <GanttLegendChips />
          </div>
        )}
        <TransferAddEntry />
        <ToggleButton isSelected={actualOnly} onChange={setActualOnly}>
          仅看实际行程（{actual.size}）
        </ToggleButton>
      </div>
      <div className="agenda-actions-right">
        <div className="view-switch" role="group" aria-label="行程视图">
          <ToggleButton isSelected={view === "gantt"} onChange={() => changeView("gantt")}>
            日程表
          </ToggleButton>
          <ToggleButton isSelected={view === "cards"} onChange={() => changeView("cards")}>
            卡片
          </ToggleButton>
        </div>
        {hasCanvas && <GanttZoomControls />}
      </div>
    </div>
  );
  // 视图无关的页级区块 —— 方案整体下线后这里**只剩顺位撞车提示**(2026-09-22,`PLAN-20260922105228`)。
  // ⚠ 行程为空时不渲染它(它读的是当前行程,空行程上没有任何撞车可言;
  //   少一个 `codes.length > 0` 就会在空状态多出一块空提示)。
  const panels = (
    <>
      {!actualOnly && codes.length > 0 && <RankClashes />}
    </>
  );
  const agendaDays = (
    <div className="agenda-days">
      {days.map(([date, rows]) => {
        const groups = actualOnly
          ? []
          : plans.groups.filter((group) => cat.byCode.get(group[0])?.date === date);
        const folded = isAgendaFolded(date);
        const last = rows[rows.length - 1];
        const overlapCount = conflicts.get(date)?.pairs.length ?? 0;
        return (
          <section className="agenda-day" key={date}>
            <div className="agenda-date">
              <ActionButton
                aria-label={`${folded ? "展开" : "收起"}行程 ${date}`}
                aria-expanded={!folded}
                onPress={() => toggleAgendaFold(date)}
              >
                {folded ? "展开" : "收起"}
              </ActionButton>
              <h2>
                {dateInfo(date).label} {dateInfo(date).weekday}
              </h2>
              <span className="agenda-day-count">{rows.length} 场</span>
              {/* 与场次卡里的「定位」（定位单场）区分：这里定位的是整日排片,故文案写明「当日」 */}
              <ActionButton
                aria-label={`定位当日 ${date}`}
                onPress={() => locateDate(date)}
              >
                定位当日
              </ActionButton>
              <div className="agenda-day-summary">
                {overlapCount > 0 && (
                  <span className="agenda-overlap-count">
                    {overlapCount} 处时间重叠
                  </span>
                )}
                <span>
                  当日 {formatKrw(rows.reduce((n, s) => n + priceOf(s), 0))}
                </span>
                {folded && (
                  <span>
                    {rows[0].start_time.slice(0, 5)}–
                    {fmtEndClock(effEndMin(last, talkOnOf(last.code)))}
                  </span>
                )}
              </div>
            </div>
            {!folded && (
              <div className="day-screenings">
                {agendaItems(rows, groups).map((item) =>
                  item.kind === "group" ? (
                    <RankGroup
                      key={[...item.codes].sort().join(",")}
                      codes={item.codes}
                    />
                  ) : (
                    <div key={item.screening.code}>
                      {item.before && (
                        <Gap before={item.before} after={item.screening} />
                      )}
                      {/* 同上:行程卡片不再挂「定位」 */}
                      <ScreeningCard
                        screening={item.screening}
                        controls
                        venueInfo
                        slotFilter={slotFilter}
                        social
                      />
                    </div>
                  ),
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
  const agendaGantt = (
    <div className="agenda-gantt">
      {days.length === 0 ? (
        <p className="muted-strong agenda-gantt-empty">
          这些场次都还没标「已抢到」，日程表里没有可排的场次。
        </p>
      ) : (
        activeDate && (
          <ScheduleGantt
            scope="agenda"
            date={activeDate}
            hour={null}
            shows={dayRows}
          />
        )
      )}
    </div>
  );
  // 侧栏要显示的那一场 = **当前高亮**的场次,且必须是画布**当天**的
  // (换日后残留的 code 不该在侧栏里显示一场画布上根本没有的场次)。
  const highlighted = highlight.code ? cat.byCode.get(highlight.code) : undefined;
  const detail = highlighted && highlighted.date === activeDate ? highlighted : undefined;
  // 右侧栏(2026-09-22,`PLAN-20260922105228`):宽屏那块约 780px 的空白改放「当天冲突组顺位 + 场次详情」。
  // ★ 顺位卡为什么从画布**下方**搬进来:它读的正是画布上那几条连线(同一批 `activeGroups`),
  //   两块内容本来就该并排看 —— 这一步同时消掉了「画布很长、顺位卡在最底下」。
  // ★ 「场次详情」为什么用**高亮**而不是"点击选中":画布上点击的语义是「加入 / 移出行程」(`toggle(s)`),
  //   拿它兼做"查看详情"会把用户已选的场次点掉。高亮走既有 `useHighlight`(鼠标 hover / 键盘 focus),
  //   零新增交互口径。⚠ 触摸端没有 hover,故那里给一句说明,而不是放一个按不动的死控件。
  const agendaSide = (
    <aside
      className="agenda-side"
      aria-label="行程侧栏"
      data-folded={sideFolded || undefined}
    >
      <button
        type="button"
        className="agenda-side-toggle"
        aria-expanded={!sideFolded}
        aria-label={sideFolded ? "展开行程侧栏" : "收起行程侧栏"}
        onClick={toggleSide}
      >
        {sideFolded ? "‹" : "›"}
      </button>
      {!sideFolded && (
        <>
          <section className="agenda-side-ranks" aria-label="当天冲突组顺位">
            <h2>冲突组顺位</h2>
            {activeGroups.length === 0 ? (
              <p className="muted-strong">
                {actualOnly
                  ? "「仅看实际行程」时不排顺位：票都抢完了。"
                  : "当天没有时间重叠的冲突组。"}
              </p>
            ) : (
              <>
                <p className="muted-strong">
                  画布上的连线就是这 {activeGroups.length} 组时间重叠；拖动把手排抢票顺位，顺位 1 为首选。
                </p>
                {activeGroups.map((group) => (
                  <RankGroup key={[...group].sort().join(",")} codes={group} />
                ))}
              </>
            )}
          </section>
          <section className="agenda-side-detail" aria-label="场次详情">
            <h2>场次详情</h2>
            {detail ? (
              // ⚠ 侧栏这份卡是**只读检视器**:不带 `controls` / `social`(2026-09-22,`PLAN-20260922105228`)。
              //   理由有两层:① 画布上的格子本身就带同名的控件(场次格 / 场次卡),同一控件在两处出现
              //   既会让用户犹豫"点哪个",也会让 `getByRole` 之类的选择器撞成两个;
              //   ② 侧栏是"看一眼这条是什么"的地方,动手改行程仍回画布 / 卡片。
              <ScreeningCard screening={detail} venueInfo slotFilter={slotFilter} />
            ) : (
              <p className="muted-strong">
                把鼠标移到日程表上的场次，这里会显示它的详情。
              </p>
            )}
          </section>
        </>
      )}
    </aside>
  );
  return (
    <>
      <section className="agenda-page" aria-label="我的行程">
        <div className="panel-heading">
          <div>
            {/* ⚠ 副标题**必须**留在 `h1` 外面:塞进去会把标题的 accessible name 污染成
                「我的行程 挑场次，留备选」,`getByRole("heading", { name: "我的行程" })` 会全线失配
                (与「豆瓣入口别塞进片名 h3」同一课)。同行只靠这一行的 flex 对齐实现。 */}
            <div className="agenda-title-row">
              <h1>我的行程</h1>
              {/* 这句原先独立占一行:收成同行(2026-09-22,`PLAN-20260922105228`)——
                  首屏每压掉一行,画布就早一步进视野。文案 / 字阶都没变,只是不再独占一行。 */}
              <p className="eyebrow-inline">挑场次，留备选</p>
            </div>
          </div>
          {/* 概览微型化(2026-09-22,`PLAN-20260922105228`):原先它独占一行、还带一条分隔线,
              把画布往下推了 36px —— 这些数字是**读一眼**的东西,做成标题右侧的灰 tag 就够。 */}
          <div className="agenda-overview" aria-label="行程概览">
            <span className="overview-tag">
              {new Set(selected.map((s) => keyOf(s.code))).size} 部电影
            </span>
            <span className="overview-tag">{days.length} 天</span>
            <span
              className="overview-tag"
              title="票务状态标为「已抢到」的场次（含转票补入）"
            >
              实际 {actual.size} 场
            </span>
            <span className="overview-tag">
              {formatKrw(selected.reduce((n, s) => n + priceOf(s), 0))}
            </span>
            <span
              className="overview-tag"
              title={`场次 ${score.count} + GV ${score.gv} − 紧转场 ${score.tight}`}
            >
              质量分 {score.total}
            </span>
            <span className="count" aria-live="polite">
              {codes.length} 场
            </span>
          </div>
        </div>
        {toolbar}
        {codes.length === 0 ? (
          <>
            <div className="empty-state">
              <h2>还没有安排场次</h2>
              <p>从排片表把场次{SCHEDULE_LABEL}，或先到影片库挑选电影。</p>
              {/* 跨页导航走 `nav-query` 口径:只带排片表的 `date` / `hour`,不搬本页 / 上一页的搜索词 */}
              <Button onPress={() => navigate(`/library${navSearch(location.search, location.pathname, "/library")}`)}>
                浏览影片库
              </Button>
            </div>
            {panels}
          </>
        ) : view === "gantt" ? (
          <>
            {/* 两栏(2026-09-22,`PLAN-20260922105228`):左画布 / 右侧栏。用 grid 而不是 flex ——
                折叠时改的是**列模板**一处,不会留下 flex 的残宽;窄屏(`≤1099`)回落单列,
                侧栏叠到画布下方(顺位卡是那一天唯一能改顺位的入口,不能整块藏掉)。 */}
            <div className="agenda-columns">
              <div className="agenda-column-main">{agendaGantt}</div>
              {agendaSide}
            </div>
            {panels}
          </>
        ) : (
          <>
            {panels}
            {agendaDays}
          </>
        )}
      </section>
      <Outlet />
    </>
  );
}
