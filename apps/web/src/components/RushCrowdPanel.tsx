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

import { useMemo, useState } from "react";
import type { ChartTokens } from "../chart-theme";
import { useCatalog } from "../app/store";
import { peekWantCounts } from "../want-counts";
import { peekFilmVotes } from "../film-votes";
import { peekScreeningCounts } from "../screening-counts";
import { MIN_VOTES_FOR_VERDICT } from "../rush-analysis";
import { wantCountLabel, WANT_LABEL } from "../actions-copy";
import { dateInfo, normText } from "../util";
import { venueShort } from "../legend";
import { DonutChart, RankBarChart, StackedBarChart } from "./charts/bars";

/** 两个榜最多列多少行 —— 这是「扫一眼」的面板，不是让人翻页的报表。 */
const TOP = 10;
/** 明细表只列 **前 10 部**（用户 2026-09-20 明确「影片明细（只需要 TOP10）」）。
 *  ⚠ 它已经是「按想看降序」的第 11~N 名，不是抽样 —— 图看形态，这 10 行是查具体数字用的。 */
const LIST_ROWS = 10;

export function RushCrowdPanel({ tokens }: { tokens: ChartTokens }) {
  const { cat, films } = useCatalog();
  const wantCounts = peekWantCounts();
  const votes = peekFilmVotes();
  const { attendance, discussions } = peekScreeningCounts();

  const [filmKey, setFilmKey] = useState("");
  const [code, setCode] = useState("");
  const [keyword, setKeyword] = useState("");

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

  const selectedFilm = filmRows.find((row) => row.key === filmKey);
  const selectedShow = code ? cat.byCode.get(code) : undefined;

  const filtered = useMemo(() => {
    const word = normText(keyword);
    return filmRows.filter((row) => {
      if (filmKey && row.key !== filmKey) return false;
      if (code && !row.shows.some((screening) => screening.code === code)) return false;
      if (word && !normText(row.title).includes(word)) return false;
      return true;
    });
  }, [filmRows, filmKey, code, keyword]);

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

      {/* 筛选条：影片 / 场次 / 关键词。默认「全部」，选影片后场次下拉只列该片的场次 */}
      <div className="ra-filters">
        <label>
          <span>电影</span>
          <select
            value={filmKey}
            data-filter="film"
            onChange={(event) => {
              setFilmKey(event.target.value);
              setCode("");
            }}
          >
            <option value="">全部影片（{filmRows.length}）</option>
            {filmRows.map((row) => (
              <option key={row.key} value={row.key}>
                {row.title}（{wantCountLabel(row.want)}）
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>场次</span>
          <select value={code} data-filter="screening" onChange={(event) => setCode(event.target.value)}>
            <option value="">全部场次</option>
            {(selectedFilm?.shows ?? cat.schedule.screenings).slice(0, 400).map((screening) => (
              <option key={screening.code} value={screening.code}>
                {screening.code} · {dateInfo(screening.date).label} {screening.start_time.slice(0, 5)} ·{" "}
                {venueShort(cat.venueById.get(screening.venue_id) ?? { id: "", name: "", name_kr: "", group: "" })}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>关键词</span>
          <input
            type="search"
            value={keyword}
            data-filter="keyword"
            placeholder="片名"
            onChange={(event) => setKeyword(event.target.value)}
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
          <DonutChart
            chart="crowd-votes-empty"
            label="红黑票分布"
            data={[]}
            tokens={tokens}
            footnote="还没有人贴过红黑榜。"
          />
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

      <table className="ra-table" data-crowd-table={filtered.length}>
        <caption className="ra-hint">
          影片明细 · 想看 TOP {Math.min(LIST_ROWS, filtered.length)}（按想看人数降序）
        </caption>
        <thead>
          <tr>
            <th scope="col">影片</th>
            <th scope="col">想看</th>
            <th scope="col">抢票人数</th>
            <th scope="col">红</th>
            <th scope="col">黑</th>
          </tr>
        </thead>
        <tbody>
          {filtered.slice(0, LIST_ROWS).map((row) => (
            <tr key={row.key} data-film={row.key}>
              <td>{row.title}</td>
              <td>{row.want}</td>
              <td>{row.demand}</td>
              <td>{row.red}</td>
              <td>{row.black}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
