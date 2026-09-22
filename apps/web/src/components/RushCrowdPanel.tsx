// 分析页 · ①「群体行为与口碑」（2026-09-20 精简版）。
//
// ★ 用户对上一版的原话：「太复杂了…只留下 群体行为与口碑（能够根据场次和电影筛选想看人数）」。
//   所以这一组**只做三件事**：想看人数、红黑票、以及把这两者按**影片 / 场次**筛出来看。
//   讨论数保留在数字卡里（它是「场次」维度的唯一信号），但不单独占一块版面。
//
// ★ 为什么筛选要「影片 + 场次」两个：想看人数是**影片级**的，而用户是**按场次**买票的。
//   两个下拉分别对应这两种视角 ——
//   · 选影片 → 看这部片整体有多少人想看、口碑如何；
//   · 选场次 → 看这一场属于哪部片，并把它与本场「同场 N 人」摆在一起对照
//     （前者是「多少人想看这部片」，后者是「多少人真把这场排进了行程」，不是一回事）。

import { useId, useMemo, useState } from "react";
import type { ChartTokens } from "../chart-theme";
import { useCatalog } from "../app/store";
import { peekWantCounts } from "../want-counts";
import { peekFilmVotes } from "../film-votes";
import { peekScreeningCounts } from "../screening-counts";
import { MIN_VOTES_FOR_VERDICT } from "../rush-analysis";
import { wantCountLabel, WANT_LABEL } from "../actions-copy";
import type { Catalog, Screening } from "../types";
import { dateInfo, normText } from "../util";
import { venueShort } from "../legend";
import { DonutChart, RankBarChart, StackedBarChart } from "./charts/bars";

/** 两个榜最多列多少行 —— 这是「扫一眼」的面板，不是让人翻页的报表。 */
const TOP = 10;
/** 明细表最多取多少行（用户 2026-09-20：「改成 TOP 30」）。
 *  ⚠ 被截断的是「按想看降序」的第 31 名之后，**不是抽样** —— 图看形态，这些行是查具体数字用的。 */
const LIST_ROWS = 30;
/** 一次看得见几行（用户 2026-09-20：「只显示 10 个，剩余的用滚动条实现展示」）。
 *  ⚠ 真正的裁剪在 CSS `.ra-table-scroll` 的 `max-height` 上（那个值按行高推导）；
 *    这里只用于 caption 文案与 E2E 断言 —— 改「一次看得见几行」要 CSS 与这里一起改。 */
const VISIBLE_ROWS = 10;

/** 影厅缺记录时的占位（`venueShort` 只读 name / group）。 */
const NO_VENUE = { id: "", name: "", name_kr: "", group: "" };

/** 场次的可搜索文本：场次号 / 日期 / 开场时间 / 影院。
 *  ⚠ **刻意不含片名** —— 片名归「电影」那个搜索框；两个框都能搜片名就是同一件事有两个入口。 */
function showSearchText(screening: Screening, venueLabel: string): string {
  return normText(
    `${screening.code} ${dateInfo(screening.date).label} ${screening.start_time} ${venueLabel}`,
  );
}

/** 影厅短名（缺记录时退到空串）。 */
function venueLabelOf(cat: Catalog, venueId: string): string {
  return venueShort(cat.venueById.get(venueId) ?? NO_VENUE);
}

export function RushCrowdPanel({ tokens }: { tokens: ChartTokens }) {
  const { cat, films } = useCatalog();
  const wantCounts = peekWantCounts();
  const votes = peekFilmVotes();
  const { attendance, discussions } = peekScreeningCounts();

  // 两个搜索框（2026-09-20，PLAN-20260920193638 —— 用户「场次电影全部采用搜索框」）：
  // 输入即筛。原来的「关键词」框已删 —— 它与「电影」框都是按片名模糊筛，留两个等于同一件事两个入口。
  const [filmQuery, setFilmQuery] = useState("");
  const [codeQuery, setCodeQuery] = useState("");
  // 明细表的视角开关：勾上后同一张表从「影片」切成「场次」（含影厅）
  // （2026-09-20，PLAN-20260920193834 —— 用户「需要勾选一个选项 能够区分影厅 知道哪一个场次最多人」）
  const [byShow, setByShow] = useState(false);
  // 表格标题与 `<table>` 的关联 id：标题在滚动区外面，用 `aria-labelledby` 保住「这是哪张表」的语义
  const captionId = useId();

  // 影片行：只保留有想看或已有票的片（其余片子在这组里没有任何信号，列出来只是噪声）
  const filmRows = useMemo(
    () =>
      films
        .map((film) => {
          const want = wantCounts[film.key] ?? 0;
          const vote = votes[film.key] ?? { red: 0, black: 0 };
          return {
            key: film.key,
            title: film.title,
            want,
            red: vote.red,
            black: vote.black,
            demand: film.shows.reduce((sum, screening) => sum + (attendance[screening.code] ?? 0), 0),
            shows: film.shows,
          };
        })
        .filter((row) => row.want > 0 || row.red + row.black > 0)
        .sort((a, b) => b.want - a.want || a.title.localeCompare(b.title)),
    [films, wantCounts, votes, attendance],
  );

  const filtered = useMemo(() => {
    const filmWord = normText(filmQuery);
    const showWord = normText(codeQuery);
    return filmRows.filter((row) => {
      if (filmWord && !normText(row.title).includes(filmWord)) return false;
      if (showWord) {
        const hit = row.shows.some((screening) =>
          showSearchText(screening, venueLabelOf(cat, screening.venue_id)).includes(showWord),
        );
        if (!hit) return false;
      }
      return true;
    });
  }, [filmRows, filmQuery, codeQuery, cat]);

  // 场次框搜到的场次（只在**当前筛出的影片**里找，与清单口径一致）
  const matchedShows = useMemo(() => {
    const word = normText(codeQuery);
    if (!word) return [];
    return filtered
      .flatMap((row) => row.shows)
      .filter((screening) => showSearchText(screening, venueLabelOf(cat, screening.venue_id)).includes(word));
  }, [filtered, codeQuery, cat]);

  // ★ 场次视角（勾选后启用）：把当前筛选下的场次摊平，按**抢票人数降序**取前 10 ——
  //   第一行就是「人最多的那一场」，影厅单独一列以便区分。
  //   ⚠ 影片视角的「抢票人数」是该片各场次数**之和**（见 `filmRows`），这里必须是**单场**人数 ——
  //     两个数不是一回事，故各算一份、互不顶替。
  const showRows = useMemo(
    () =>
      filtered
        .flatMap((film) =>
          film.shows.map((screening) => ({
            code: screening.code,
            title: film.title,
            when: `${dateInfo(screening.date).label} ${screening.start_time.slice(0, 5)}`,
            venue: venueLabelOf(cat, screening.venue_id),
            demand: attendance[screening.code] ?? 0,
          })),
        )
        .sort((a, b) => b.demand - a.demand)
        .slice(0, LIST_ROWS),
    [filtered, cat, attendance],
  );

  // ★ 选中语义改由搜索框承担（2026-09-20）：筛到**唯一**一部片 / 唯一一场就算选中 ——
  //   于是「口碑构成环」与「本场同场 N 人」照常出现，用户不必再点一次。
  const selectedFilm = filtered.length === 1 ? filtered[0] : undefined;
  const selectedShow = matchedShows.length === 1 ? matchedShows[0] : undefined;

  const wantTotal = filtered.reduce((sum, row) => sum + row.want, 0);
  const redTotal = filtered.reduce((sum, row) => sum + row.red, 0);
  const blackTotal = filtered.reduce((sum, row) => sum + row.black, 0);
  const talkTotal = filtered.reduce(
    (sum, row) => sum + row.shows.reduce((inner, screening) => inner + (discussions[screening.code] ?? 0), 0),
    0,
  );

  // 选中场次时，把这一场的两个「人数」摆在一起（影片级意愿 vs 本场实际排进行程）
  const showAttendance = selectedShow ? (attendance[selectedShow.code] ?? 0) : 0;

  // 口碑构成环：红票 / 黑票 / （本片有想看但没贴票）——后者必须单列，否则「红+黑」看起来就是全部意见
  const voteSplit = selectedFilm
    ? [
        { name: "红票（好看）", value: selectedFilm.red },
        { name: "黑票（不好看）", value: selectedFilm.black },
        {
          name: "想看但没贴票",
          value: Math.max(0, selectedFilm.want - selectedFilm.red - selectedFilm.black),
        },
      ].filter((part) => part.value > 0)
    : [];

  const voteTop = [...filtered]
    .map((row) => ({ ...row, votes: row.red + row.black }))
    .filter((row) => row.votes > 0)
    .sort((a, b) => b.votes - a.votes)
    .slice(0, TOP);

  if (filmRows.length === 0) {
    return (
      <section className="ra-block" aria-label="群体行为与口碑">
        <h2>群体行为与口碑</h2>
        <p className="ra-hint">
          还没有群体数据 —— 在影片库点「{WANT_LABEL}」、在红黑榜贴票之后，这里就会有内容。
        </p>
      </section>
    );
  }

  return (
    <section
      className="ra-block"
      aria-label="群体行为与口碑"
      data-crowd-films={filtered.length}
      data-crowd-want={wantTotal}
    >
      <h2>群体行为与口碑</h2>

      {/* 筛选条：两个搜索框（2026-09-20，PLAN-20260920193638 —— 用户「场次电影全部采用搜索框」）。
       *  ⚠ 原来这里是「电影 / 场次」两个下拉 + 一个「关键词」框：下拉在手机上是滚轮，
       *    几百项根本滚不动；而「关键词」与「电影」又都是按片名模糊筛 —— 于是合并成两个搜索框。 */}
      <div className="ra-filters">
        <label>
          <span>电影</span>
          <input
            type="search"
            value={filmQuery}
            data-filter="film"
            placeholder="输片名搜索"
            onChange={(event) => setFilmQuery(event.target.value)}
          />
        </label>
        <label>
          <span>场次</span>
          <input
            type="search"
            value={codeQuery}
            data-filter="screening"
            placeholder="场次号 / 日期 / 影院"
            onChange={(event) => setCodeQuery(event.target.value)}
          />
        </label>
      </div>

      <div className="ra-metrics">
        <div className="ra-metric">
          <b>{filtered.length}</b>
          <span>影片（符合筛选）</span>
        </div>
        <div className="ra-metric">
          <b>{wantTotal}</b>
          <span>想看人次</span>
        </div>
        <div className="ra-metric">
          <b>{redTotal}</b>
          <span>红票</span>
        </div>
        <div className="ra-metric">
          <b>{blackTotal}</b>
          <span>黑票</span>
        </div>
        <div className="ra-metric">
          <b>{talkTotal}</b>
          <span>场次讨论</span>
        </div>
      </div>

      {selectedShow && (
        <p
          className="ra-hint"
          title="「想看人数」是影片级的（多少人想看这部片）；「同场人数」是场次级（多少人把这一场排进了自己的行程）。"
        >
          <strong>{selectedShow.code}</strong> {dateInfo(selectedShow.date).label}{" "}
          {selectedShow.start_time.slice(0, 5)} · 本场同场 {showAttendance} 人 · 本片想看{" "}
          {selectedFilm ? wantCountLabel(selectedFilm.want) : "—"}
        </p>
      )}

      <div className="ra-grid">
        <RankBarChart
          chart="crowd-want"
          label="想看人数排行"
          valueName="想看人数"
          data={filtered.slice(0, TOP).map((row) => ({ label: row.title, value: row.want }))}
          tokens={tokens}
          footnote={`前 ${Math.min(TOP, filtered.length)} 部（按想看人数降序）。`}
        />
        {voteTop.length > 0 ? (
          // 横放：类目是片名（竖放会被 ECharts 抽稀成只剩一两个标签）
          <StackedBarChart
            chart="crowd-votes"
            label="红黑票分布"
            data={voteTop.map((row) => ({ label: row.title, red: row.red, black: row.black }))}
            series={[
              // ⚠ 颜色按**贴纸本义**给：红票 = 品牌红、黑票 = 正文色（浅色主题下就是黑）。
              //   这里别用语义色 —— 语义色里 `--selected-line` 是**绿**，拿它画红票等于
              //   把「好看」画成绿色，与「红黑榜」这套叫法直接冲突（2026-09-20 实测踩到）。
              { key: "red", name: "红票（好看）", color: tokens.brand },
              { key: "black", name: "黑票（不好看）", color: tokens.text },
            ]}
            tokens={tokens}
            horizontal
            footnote={`总票数前 ${voteTop.length} 部；红黑都有票且都 ≥ ${MIN_VOTES_FOR_VERDICT} 才算「有争议」。`}
          />
        ) : (
          // ⚠ 空态**不画空图**：一张空环 + 藏进 ⓘ 的原因只会让人以为图坏了。
          //   「XX 还没有人做」是状态、不是口径解释，必须可见（2026-09-20，PLAN-20260920193412）。
          <p className="ra-chart-empty">还没有人贴过红黑榜 —— 贴票之后这里会出现分布。</p>
        )}
        {voteSplit.length > 0 && (
          <DonutChart
            chart="crowd-film-split"
            label={`${selectedFilm?.title ?? ""} 的群体构成`}
            data={voteSplit}
            tokens={tokens}
            centerLabel={String(selectedFilm?.want ?? 0)}
            footnote="中间数字是这部片的想看人次；环里是红票 / 黑票 / 想看但没贴票的构成。"
          />
        )}
      </div>

      {/* 标题与视角开关刻意放在滚动区**外面**：滚到第 20 行时仍要能切视角、也仍要知道这张表是什么。
       *  表格最多 30 行、一次看得见 10 行（由 `.ra-table-scroll` 的 max-height 决定，见该处注释）。 */}
      <p className="ra-hint ra-table-title" id={captionId}>
        {byShow
          ? `场次明细 · 抢票人数 TOP ${showRows.length}（按单场人数降序；前 ${VISIBLE_ROWS} 行可见，其余滚动）`
          : `影片明细 · 想看 TOP ${Math.min(LIST_ROWS, filtered.length)}（按想看人数降序；前 ${VISIBLE_ROWS} 行可见，其余滚动）`}
        {/* 视角开关：默认「影片」（谁想看的人多），勾上换「场次」（哪一场 / 哪个厅人最多） */}
        <label className="ra-toggle">
          <input
            type="checkbox"
            checked={byShow}
            data-toggle="by-show"
            onChange={(event) => setByShow(event.target.checked)}
          />
          按场次看（区分影厅）
        </label>
      </p>
      <div className="ra-table-scroll">
        <table
          className="ra-table"
          aria-labelledby={captionId}
          data-crowd-table={filtered.length}
          data-crowd-mode={byShow ? "show" : "film"}
          data-crowd-shows={showRows.length}
        >
          <thead>
            {byShow ? (
              <tr>
                <th scope="col">影片</th>
                <th scope="col">场次</th>
                <th scope="col">时间</th>
                <th scope="col">影厅</th>
                <th scope="col">抢票人数</th>
              </tr>
            ) : (
              <tr>
                <th scope="col">影片</th>
                <th scope="col">想看</th>
                <th scope="col">抢票人数</th>
                <th scope="col">红</th>
                <th scope="col">黑</th>
              </tr>
            )}
          </thead>
          <tbody>
            {byShow
              ? showRows.map((row) => (
                  <tr key={row.code} data-show={row.code}>
                    {/* 长片名 / 长影厅名在窄屏会被省略号截掉(见 `rush-analysis.css` 的行高口径),
                        故把完整值挂到 `title` 上 —— 鼠标可看,手机长按也能看 */}
                    <td title={row.title}>{row.title}</td>
                    <td>{row.code}</td>
                    <td>{row.when}</td>
                    <td title={row.venue}>{row.venue}</td>
                    <td>{row.demand}</td>
                  </tr>
                ))
              : filtered.slice(0, LIST_ROWS).map((row) => (
                  <tr key={row.key} data-film={row.key}>
                    <td title={row.title}>{row.title}</td>
                    <td>{row.want}</td>
                    <td>{row.demand}</td>
                    <td>{row.red}</td>
                    <td>{row.black}</td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
