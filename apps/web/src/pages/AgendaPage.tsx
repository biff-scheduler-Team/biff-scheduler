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
  ToastQueue,
  ToggleButton,
} from "../components/spectrum";
import { TransferAddEntry } from "../components/TransferAddDialog";
import { ScreeningCard } from "../components/ScreeningCard";
import { useCatalog } from "../app/store";
import { useScheduleNavigation } from "../app/navigation";
import {
  agendaItems,
  describeSavedPlan,
  rankSpotOrder,
  topPlanCodes,
} from "../app/agenda-model";
import {
  deletePlan,
  isAgendaFolded,
  savePlan,
  savedPlans,
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
} from "../util";
import { effEndMin, gvTalkMin, talkOnOf } from "../gv";
import { scorePlanRows } from "../score";
import { formatKrw, priceOf } from "../extras";
import type { Screening } from "../types";
import "./agenda-parity.css";

export function saveCodes(codes: string[]) {
  const result = savePlan(codes);
  if (result.ok)
    ToastQueue.positive(`已保存${result.plan!.name}`, { timeout: 5000 });
  else
    ToastQueue.neutral(
      result.reason === "empty"
        ? "先加入场次，再保存方案。"
        : "这个方案已经保存。",
      { timeout: 5000 },
    );
}

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
            <ScreeningCard
              screening={cat.byCode.get(code)!}
              locate
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

export function AgendaPage() {
  const slotFilter = useScheduleSelection();
  const { cat, codes, plans, conflicts, keyOf } = useCatalog();
  const navigate = useNavigate();
  const location = useLocation();
  const { locateDate } = useScheduleNavigation();
  // 「仅看实际行程」(2026-09-14,PLAN-20260914164050):只显示票务状态标了「已抢到」的场次。
  // 纯视图筛选 —— 数据仍在同一份行程里,票务状态存在独立键 `biff.tickets.v1`。
  const [actualOnly, setActualOnly] = useState(false);
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
  const firstLayerClash = plans.rankClashes.some((clash) => clash.layer === 1);
  return (
    <>
      <section className="agenda-page" aria-label="我的行程">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">挑场次，留备选</p>
            <h1>我的行程</h1>
          </div>
          <span className="count" aria-live="polite">
            {codes.length} 场
          </span>
        </div>
        <div className="summary-strip">
          <span>{new Set(selected.map((s) => keyOf(s.code))).size} 部电影</span>
          <span>{groupByDate(selected, (s) => s.date).length} 天</span>
          <span title="票务状态标为「已抢到」的场次（含转票补入）">
            实际 {actual.size} 场
          </span>
          <span>{formatKrw(selected.reduce((n, s) => n + priceOf(s), 0))}</span>
          <span
            title={`场次 ${score.count} + GV ${score.gv} − 紧转场 ${score.tight}`}
          >
            质量分 {score.total}
          </span>
        </div>
        <div className="agenda-actions">
          <TransferAddEntry />
          <ToggleButton isSelected={actualOnly} onChange={setActualOnly}>
            仅看实际行程（{actual.size}）
          </ToggleButton>
        </div>
        {codes.length === 0 ? (
          <div className="empty-state">
            <h2>还没有安排场次</h2>
            <p>从排片表加入场次，或先到影片库挑选电影。</p>
            <Button onPress={() => navigate(`/library${location.search}`)}>
              浏览影片库
            </Button>
          </div>
        ) : (
          !actualOnly && (
            <>
              <RankClashes />
              <div className="agenda-save">
                <Button
                  onPress={() => saveCodes(topPlanCodes(plans))}
                  isDisabled={firstLayerClash}
                >
                  保存当前方案
                </Button>
                <p className="muted">
                  {firstLayerClash
                    ? "第一顺位有撞车，请先让路再保存。"
                    : "保存每个冲突组的第一顺位场次与共同场次。"}
                </p>
              </div>
            </>
          )
        )}
        <section className="saved-plans" aria-label="已保存方案">
          <h2>已保存方案，{savedPlans.length} 套</h2>
          {savedPlans.length === 0 && (
            <p className="muted">
              还没有保存方案。在上方保存当前第一顺位方案，导出与分享时按方案选择。
            </p>
          )}
          {savedPlans.map((plan) => {
            const summary = describeSavedPlan(cat, plan);
            return (
              <div className="saved-plan" key={plan.id}>
                <div>
                  <strong>{plan.name}</strong>
                  <p className="muted" title={summary.details}>
                    {summary.outline}
                  </p>
                  <details className="saved-plan-details">
                    <summary>查看场次</summary>
                    <p>{summary.details}</p>
                  </details>
                </div>
                <ActionButton
                  aria-label={`删除${plan.name}`}
                  onPress={() => deletePlan(plan.id)}
                >
                  删除
                </ActionButton>
              </div>
            );
          })}
        </section>
        <div className="agenda-days">
          {groupByDate(selected, (s) => s.date).map(([date, rows]) => {
            // 「仅看实际行程」时不摆顺位卡:票都抢完了,再显示「顺位 1 / 备选」只会误导
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
                          <ScreeningCard
                            screening={item.screening}
                            locate
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
      </section>
      <Outlet />
    </>
  );
}
