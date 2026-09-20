// 「抢票分析」页（2026-09-20，PLAN-20260920161837）。
//
// 目标：把「票务」从**需求 → 难度 → 结果 → 口碑**四个面量化出来，供开票前判断该抢哪几场、
// 哪些场次根本没戏，开票后复盘自己的判断准不准。
//
// ★ 为什么单开一页，而不是塞进「抢票」页：
//   抢票页是**开票当天**要用的清单（按批次分组 + 票务三态控件），它必须短、必须稳；
//   分析页是**选片 / 预判期**的视图，一次要看 800 行。读者与使用场景都不同。
//   导航上紧挨着放（行程 → 抢票 → 抢票分析），因为它们读的是同一份数据。
//
// ★ 口径全部复用，不另起一套（红线 5）：
//   · 抢票人数 = 「同场 N 人」（`screening-counts.ts`，服务端加权聚合，**零新增采集**）；
//   · 想看人数 = `want-counts.ts`；红黑票 = `film-votes.ts`；抢票结果 = `ticket-stats.ts`；
//   · 难度分级 / 相对分位 = `capacity.ts`；六个区块的聚合 = `rush-analysis.ts`（纯逻辑，已单测）；
//   · 日期写法 = `util.ts::dateInfo`；影厅短名 = `legend.ts::venueShort`；搜索框 = `QuerySearchField`。
//
// ★ 本页不算任何百分比之外的派生口径，也**不发额外请求**：四个计数 store 各拉一次，
//   其余全是 O(场次数) 的纯整数运算。榜单每行挂 `content-visibility: auto`（见 css），
//   让屏外行跳过布局 —— 这是 800 行长清单能一屏渲染的前提。

import { useEffect, useState } from "react";
import { QuerySearchField } from "../components/QuerySearchField";
import { useQuery } from "../app/hooks";
import { useCatalog } from "../app/store";
import { DIFFICULTY_LABELS, capacityOf } from "../capacity";
import {
  HEAT_VERDICT_LABELS,
  MIN_RATE_SAMPLES,
  MIN_VOTES_FOR_VERDICT,
  demandByDate,
  demandByHour,
  demandConcentration,
  difficultyBoard,
  hotVsVotes,
  startHourOf,
  ticketOutcomeStats,
  type DifficultyRow,
  type FilmHeatRow,
  type FilmSignals,
  type ShowDemandRow,
} from "../rush-analysis";
import {
  loadScreeningCounts,
  onScreeningCountsChange,
  peekScreeningCounts,
} from "../screening-counts";
import { loadWantCounts, onWantCountsChange, peekWantCounts } from "../want-counts";
import { loadFilmVotes, onFilmVotesChange, peekFilmVotes } from "../film-votes";
import { loadTicketCounts, onTicketCountsChange, peekTicketCounts } from "../ticket-stats";
import { store } from "../state";
import { dateInfo, filmInfoOf, normText } from "../util";
import { venueShort } from "../legend";
import "./rush-analysis.css";

/** 四份「单例缓存 + 广播」的客户端计数（形状一致，见各自文件头）。 */
const LIVE_STORES: Array<{
  subscribe: (listener: () => void) => () => void;
  load: () => Promise<unknown>;
}> = [
  { subscribe: onScreeningCountsChange, load: loadScreeningCounts },
  { subscribe: onWantCountsChange, load: loadWantCounts },
  { subscribe: onFilmVotesChange, load: loadFilmVotes },
  { subscribe: onTicketCountsChange, load: loadTicketCounts },
];

/** 订阅四份计数并各拉一次（直链打开本页也能有数）。
 *
 *  ⚠ 返回值只用来**驱动重渲染**，读值仍走各自的 `peek()` —— 存快照会与广播竞态
 *    （`want-counts` 无变更时返回同一个对象引用，`setState` 同引用不重渲染，改了看不出来）。
 *  ⚠ `loadScreeningCounts()` 在 `bootstrap` 里已经拉过，这里再调是命中缓存、不发第二次请求。 */
function useLiveCounters(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const bump = () => setRevision((n) => n + 1);
    const stops = LIVE_STORES.map((source) => source.subscribe(bump));
    for (const source of LIVE_STORES) void source.load();
    return () => stops.forEach((stop) => stop());
  }, []);
  return revision;
}

const percentText = (value: number | null): string =>
  value === null ? "—" : `${Math.round(value * 100)}%`;

const ratioText = (value: number | null): string => (value === null ? "—" : `${value.toFixed(2)}×`);

/** 难度榜一行：CODE / 分级章 / 倍率 / 片名 / 时间 / 影厅 / 原始三元组 + 判据说明。 */
function DifficultyLine({ row, title }: { row: DifficultyRow; title: string }) {
  const { cat } = useCatalog();
  const screening = cat.byCode.get(row.code);
  const venue = screening ? cat.venueById.get(screening.venue_id) : undefined;
  return (
    <li
      className="ra-row"
      data-code={row.code}
      data-level={row.level}
      data-demand={row.demand}
      data-capacity={row.capacity ?? ""}
      data-ratio={row.ratio ?? ""}
    >
      <div className="ra-row-main">
        <span className="ra-code">{row.code}</span>
        <span className="ra-level" data-level={row.level}>
          {DIFFICULTY_LABELS[row.level]}
        </span>
        <span className="ra-num">{ratioText(row.ratio)}</span>
        <span className="ra-title">{title}</span>
        <span className="ra-meta">{dateInfo(row.date).label}</span>
        <span className="ra-meta ra-num">{screening?.start_time.slice(0, 5) ?? ""}</span>
        <span className="ra-meta">{venue ? venueShort(venue) : (screening?.venue_display ?? "")}</span>
        <span className="ra-meta ra-num">
          需求 {row.demand} · 容量 {row.capacity === null ? "未收录" : row.capacity}
          {row.percentile === null ? "" : ` · 高于 ${row.percentile}% 场次`}
        </span>
      </div>
      <p className="ra-reason">{row.reason}</p>
    </li>
  );
}

/** 分布表的行 —— 日期 / 时段两种分桶在这里收敛成同一个形状（免去在渲染里做类型断言）。 */
interface DistributionRow {
  key: string;
  label: string;
  demand: number;
  shows: number;
}

function DistributionTable({
  caption,
  head,
  rows,
  max,
}: {
  caption: string;
  head: string;
  rows: DistributionRow[];
  max: number;
}) {
  return (
    <table className="ra-table">
      <caption className="ra-hint">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{head}</th>
          <th scope="col">需求人数</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} data-demand={row.demand}>
            <td>
              {row.label}
              <span className="ra-bar" aria-hidden="true">
                <span style={{ width: `${max > 0 ? (row.demand / max) * 100 : 0}%` }} />
              </span>
            </td>
            <td>
              {row.demand} · {row.shows} 场
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RushAnalysisPage() {
  const { cat, films } = useCatalog();
  const { params } = useQuery();
  const query = params.get("q") ?? "";
  useLiveCounters();

  // ⚠ 刻意**不用 useMemo**：一是读的是可变单例（依赖数组无法诚实表达），二是 800 次整数运算
  //   比记忆化本身还便宜。重渲染由四个 store 的广播驱动，见 `useLiveCounters`。
  const attendance = peekScreeningCounts().attendance;
  const rows: ShowDemandRow[] = [];
  for (const screening of cat.schedule.screenings) {
    const hour = startHourOf(screening.start_time);
    if (hour === null) continue;
    rows.push({
      code: screening.code,
      date: screening.date,
      startHour: hour,
      demand: attendance[screening.code] ?? 0,
      capacity: capacityOf(cat.venueById.get(screening.venue_id)),
    });
  }

  const titleOf = (code: string): string => {
    const screening = cat.byCode.get(code);
    return screening ? filmInfoOf(cat, screening, store.mappings.get(code)).title : code;
  };

  const board = difficultyBoard(rows);
  const keyword = normText(query);
  const shown = keyword
    ? board.filter((row) => {
        const screening = cat.byCode.get(row.code);
        const venue = screening ? cat.venueById.get(screening.venue_id) : undefined;
        return (
          normText(row.code).includes(keyword) ||
          normText(titleOf(row.code)).includes(keyword) ||
          (venue
            ? normText(venueShort(venue)).includes(keyword) || normText(venue.name).includes(keyword)
            : false)
        );
      })
    : board;

  const concentration = demandConcentration(rows.map((row) => row.demand));
  const dates = demandByDate(rows);
  const hours = demandByHour(rows);
  const maxDateDemand = dates.reduce((max, row) => Math.max(max, row.demand), 0);
  const maxHourDemand = hours.reduce((max, row) => Math.max(max, row.demand), 0);

  const tickets = ticketOutcomeStats(peekTicketCounts());
  const wantCounts = peekWantCounts();
  const votes = peekFilmVotes();
  const wantTotal = films.reduce((sum, film) => sum + (wantCounts[film.key] ?? 0), 0);
  const signals: FilmSignals[] = films.map((film) => ({
    key: film.key,
    title: film.title,
    want: wantCounts[film.key] ?? 0,
    demand: film.shows.reduce((sum, show) => sum + (attendance[show.code] ?? 0), 0),
    red: votes[film.key]?.red ?? 0,
    black: votes[film.key]?.black ?? 0,
  }));
  const heat: FilmHeatRow[] = hotVsVotes(
    signals.filter((row) => row.demand > 0 || row.want > 0),
  ).slice(0, 30);

  const demandShows = rows.filter((row) => row.demand > 0).length;

  if (rows.length === 0) {
    return (
      <section className="ra-page" aria-label="抢票分析">
        <div className="empty-state">
          <h2>还没有排期数据</h2>
          <p>排期载入后，这里会按需求、难度、结果、口碑四个面统计全站票务。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="ra-page" aria-label="抢票分析">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">需求 · 难度 · 结果 · 口碑</p>
          <h1>抢票分析</h1>
        </div>
        <span className="count" aria-live="polite" data-board-total={board.length}>
          {rows.length} 场
        </span>
      </div>

      <div className="summary-strip">
        <span>有需求 {demandShows} 场</span>
        <span title="把该场排进行程的人数（含没抢到票的；只统计人数，不显示名单）">
          全站抢票人数 {concentration?.total ?? 0}
        </span>
        <span title="影片级「想看人数」合计">想看 {wantTotal}</span>
        <span title="已标记抢票结果的场次数">已标记结果 {tickets?.shows ?? 0} 场</span>
      </div>

      <section className="ra-block" aria-label="抢票难度榜">
        <h2>抢票难度榜</h2>
        <p className="ra-hint">
          难度 = 抢票人数 ÷ 影厅座位数（倍率）。按倍率降序 —— <strong>≥ 1 极高</strong>（想抢的人多过座位）、
          ≥ 0.5 高、≥ 0.2 中、其余低。未收录座位数的影厅只给相对排名，**不估数**。
        </p>
        <QuerySearchField label="搜索场次" placeholder="按场次编号 / 片名 / 影厅筛选" />
        <ol className="ra-list" data-shown={shown.length}>
          {shown.map((row) => (
            <DifficultyLine key={row.code} row={row} title={titleOf(row.code)} />
          ))}
        </ol>
        {shown.length === 0 && <p className="ra-hint">没有匹配的场次。</p>}
      </section>

      <section className="ra-block" aria-label="需求时间分布">
        <h2>需求时间分布</h2>
        <p className="ra-hint">
          按日期与按开场时段两列，回答「哪天、哪个时段最挤」。跨午夜场按开场时间的原始小时归属，
          <strong>不对 24 取模</strong>（次日档会单独标注）。
        </p>
        {dates.length === 0 ? (
          <p className="ra-hint">还没有任何场次被排进行程。</p>
        ) : (
          <div className="ra-grid">
            <DistributionTable
              caption="按日期"
              head="日期"
              rows={dates.map((row) => ({
                key: row.date,
                label: dateInfo(row.date).label,
                demand: row.demand,
                shows: row.shows,
              }))}
              max={maxDateDemand}
            />
            <DistributionTable
              caption="按开场时段"
              head="时段"
              rows={hours.map((row) => ({
                key: String(row.hour),
                label: row.label,
                demand: row.demand,
                shows: row.shows,
              }))}
              max={maxHourDemand}
            />
          </div>
        )}
      </section>

      <section className="ra-block" aria-label="需求集中度">
        <h2>需求集中度</h2>
        {concentration === null ? (
          <p className="ra-hint">还没有任何场次被排进行程。</p>
        ) : (
          <>
            <p className="ra-hint">
              {percentText(concentration.top10.share)} 的需求集中在最热的 {concentration.top10.count} 场；
              想覆盖全站一半需求，只要盯住最热的 <strong>{concentration.halfCount}</strong> 场。
            </p>
            <div className="ra-metrics">
              <div className="ra-metric">
                <b>{concentration.shows}</b>
                <span>有需求的场次</span>
              </div>
              <div className="ra-metric">
                <b>{percentText(concentration.top10.share)}</b>
                <span>Top {concentration.top10.count} 占比</span>
              </div>
              <div className="ra-metric">
                <b>{percentText(concentration.top20.share)}</b>
                <span>Top {concentration.top20.count} 占比</span>
              </div>
              <div className="ra-metric">
                <b>{concentration.halfCount}</b>
                <span>承载半数需求所需场次</span>
              </div>
            </div>
          </>
        )}
      </section>

      <section className="ra-block" aria-label="抢票结果">
        <h2>抢票结果</h2>
        {tickets === null ? (
          <p className="ra-hint">
            还没有人标记抢票结果。在「抢票」页把每场标成「已抢到 / 没抢到 / 放弃」后，
            这里会给出全站的抢到率与落榜率。
          </p>
        ) : (
          <>
            <p className="ra-hint">
              抢到率 = 已抢到 ÷（已抢到 + 没抢到 + 放弃），<strong>转票不计入</strong> ——
              票是别人转的不等于自己抢到。有效样本少于 {MIN_RATE_SAMPLES} 条时只给计数，不给率值。
            </p>
            <div className="ra-metrics" data-samples={tickets.samples} data-shows={tickets.shows}>
              <div className="ra-metric">
                <b>{percentText(tickets.gotRate)}</b>
                <span>抢到率</span>
              </div>
              <div className="ra-metric">
                <b>{percentText(tickets.missedRate)}</b>
                <span>落榜率</span>
              </div>
              <div className="ra-metric">
                <b>{percentText(tickets.droppedRate)}</b>
                <span>放弃率</span>
              </div>
              <div className="ra-metric">
                <b>{tickets.transfer}</b>
                <span>转票获得</span>
              </div>
              <div className="ra-metric">
                <b>{tickets.samples}</b>
                <span>有效样本（已抢到 + 没抢到 + 放弃）</span>
              </div>
            </div>
            {tickets.gotRate === null && (
              <p className="ra-hint">样本不足（{tickets.samples}）—— 先攒够人再看比例。</p>
            )}
          </>
        )}
      </section>

      <section className="ra-block" aria-label="热度与口碑">
        <h2>热度与口碑</h2>
        <p className="ra-hint">
          想看人数 / 抢票人数（热度）与红黑榜票数（口碑）并排看。红黑票合计少于{" "}
          {MIN_VOTES_FOR_VERDICT} 张不下结论；热度基准是本表样本需求人数的中位数。
        </p>
        {heat.length === 0 ? (
          <p className="ra-hint">还没有可对照的影片。</p>
        ) : (
          <ul className="ra-list">
            {heat.map((row) => (
              <li className="ra-row" key={row.key} data-film={row.key} data-verdict={row.verdict}>
                <div className="ra-row-main">
                  <span className="ra-title">{row.title}</span>
                  <span className="ra-level" data-level={row.verdict === "unknown" ? "unknown" : "low"}>
                    {HEAT_VERDICT_LABELS[row.verdict]}
                  </span>
                  <span className="ra-meta ra-num">
                    想看 {row.want} · 抢票 {row.demand} · 红 {row.red} / 黑 {row.black}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
