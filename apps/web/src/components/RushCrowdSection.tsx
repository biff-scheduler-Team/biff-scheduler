// 分析页 · C 组「群体行为与口碑」（2026-09-20，第 2 轮，PLAN-20260920203010 修订 1）。
//
// 三个子面各自的**计量单位不同**（想看按影片 / 红黑票按影片 / 讨论按场次），
// 所以页面上必须把它们分开摆，不能合成一个「热度」数字（合成后就再也说不清它是什么）。

import { allCodes } from "../state";
import type { ChartTokens } from "../chart-theme";
import { MIN_VOTES_FOR_VERDICT, type ShowDemandRow } from "../rush-analysis";
import { myCrowdOverlap, talkBoard, voteBoard, wantBoard } from "../rush-crowd";
import type { Catalog } from "../types";
import type { FilmNode } from "../app/model";
import { filmNodeKey } from "../util";
import { peekFilmVotes } from "../film-votes";
import { peekWantCounts } from "../want-counts";
import { peekScreeningCounts } from "../screening-counts";
import { RankBarChart, StackedBarChart } from "./charts/bars";

/** 榜单长度：三个榜各列前 10 —— 再多就变成「翻页」而不是「一眼看」。 */
const TOP = 10;

export function RushCrowdSection({
  cat,
  films,
  rows,
  tokens,
}: {
  cat: Catalog;
  films: FilmNode[];
  rows: ShowDemandRow[];
  tokens: ChartTokens;
}) {
  const wantCounts = peekWantCounts();
  const votes = peekFilmVotes();
  const discussions = peekScreeningCounts().discussions;

  const wantRows = films.map((film) => ({
    key: film.key,
    title: film.title,
    want: wantCounts[film.key] ?? 0,
  }));
  const voteRows = films.map((film) => ({
    key: film.key,
    title: film.title,
    red: votes[film.key]?.red ?? 0,
    black: votes[film.key]?.black ?? 0,
  }));
  // 场次 code → 片名（一次 O(场次) 建表，避免在 map 里重复查映射）
  const titleByCode = new Map<string, string>();
  for (const film of films) for (const s of film.shows) titleByCode.set(s.code, film.title);
  const talkRows = rows.map((row) => ({
    code: row.code,
    title: titleByCode.get(row.code) ?? row.code,
    count: discussions[row.code] ?? 0,
  }));

  const want = wantBoard(wantRows);
  const voted = voteBoard(voteRows);
  const talk = talkBoard(talkRows);

  // 我排了场次的影片（去重）—— 与全站想看对照用
  const myFilmKeys = new Set<string>();
  for (const code of allCodes()) {
    const screening = cat.byCode.get(code);
    if (screening) myFilmKeys.add(filmNodeKey(cat, screening));
  }
  const overlap = myCrowdOverlap([...myFilmKeys], wantRows);

  if (want === null && voted === null && talk === null) {
    return (
      <section className="ra-block" aria-label="群体行为与口碑">
        <h2>群体行为与口碑</h2>
        <p className="ra-hint">
          还没有任何群体数据 —— 在影片库点「想看」、在红黑榜贴票、在场次下发文，这里就会开始有内容。
        </p>
      </section>
    );
  }

  const voteTop = [...voteRows]
    .map((row) => ({ ...row, votes: row.red + row.black }))
    .filter((row) => row.votes > 0)
    .sort((a, b) => b.votes - a.votes)
    .slice(0, TOP);

  return (
    <section
      className="ra-block"
      aria-label="群体行为与口碑"
      // 有讨论的场次数留在容器上（E2E 与「讨论榜」的图注同源，不另算一遍）
      data-talk-shows={talk?.shows ?? 0}
    >
      <h2>群体行为与口碑</h2>
      <p
        className="ra-hint"
        title="三个榜的计量单位不同：想看人数按影片、红黑票按影片、讨论按场次 —— 不能横向比大小，只能各自看排序。"
      >
        想看 / 红黑票按<strong>影片</strong>，讨论按<strong>场次</strong>（单位不同，别横比）。
      </p>

      <div className="ra-metrics">
        <div className="ra-metric">
          <b>{want?.wantTotal ?? 0}</b>
          <span>全站想看人次（{want?.withWant ?? 0} 部影片）</span>
        </div>
        <div className="ra-metric">
          <b>{voted?.red ?? 0}</b>
          <span>红票（共 {voted?.total ?? 0} 票）</span>
        </div>
        <div className="ra-metric">
          <b>{voted?.black ?? 0}</b>
          <span>黑票</span>
        </div>
        <div className="ra-metric">
          <b>{talk?.total ?? 0}</b>
          <span>场次讨论（{talk?.shows ?? 0} 场）</span>
        </div>
        <div className="ra-metric">
          <b>{overlap.mine === 0 ? "—" : `${overlap.hot}/${overlap.mine}`}</b>
          <span>我的选片里属群体热门</span>
        </div>
      </div>

      {overlap.mine > 0 && (
        <p
          className="ra-hint"
          title="群体热门的基准是「全站想看人数的中位数」而不是写死的阈值 —— 站点规模会变，写死迟早失真。"
        >
          {overlap.median === null
            ? "全站还没有想看数据，暂时比不了。"
            : `中位数 ${overlap.median} 人想看：我的 ${overlap.mine} 部里 ${overlap.hot} 部达到` +
              `${overlap.cold > 0 ? `，${overlap.cold} 部无人想看` : ""}。`}
        </p>
      )}

      <div className="ra-grid">
        {want && (
          <RankBarChart
            chart="crowd-want"
            label="想看人数榜"
            valueName="想看人数"
            data={want.top.slice(0, TOP).map((row) => ({ label: row.title, value: row.want }))}
            tokens={tokens}
            footnote={`只列前 ${Math.min(TOP, want.withWant)} 部；想看是影片级意愿，与场次难度不是一回事。`}
          />
        )}
        {voted && voteTop.length > 0 && (
          <StackedBarChart
            chart="crowd-votes"
            label="红黑票分布"
            data={voteTop.map((row) => ({ label: row.title, red: row.red, black: row.black }))}
            series={[
              { key: "red", name: "红票", color: tokens.selectedLine },
              { key: "black", name: "黑票", color: tokens.conflictLine },
            ]}
            tokens={tokens}
            footnote={`按总票数取前 ${voteTop.length} 部；红黑都有票的片才可能进「有争议」，单边票不算。`}
          />
        )}
      </div>

      {/* 「有争议」压成一行 chip：它是上面红黑图的**子集**，再列十行文字是重复表达 */}
      {voted && voted.divided.length > 0 && (
        <p className="ra-chips" title={`红黑两边都 ≥ ${MIN_VOTES_FOR_VERDICT} 票 = 站内看法分裂`}>
          <span className="ra-meta">看法分裂：</span>
          {voted.divided.slice(0, TOP).map((row) => (
            <span className="ra-chip" key={row.key} data-divided={row.key}>
              {row.title}
              <span className="ra-num ra-meta">
                红{row.red}/黑{row.black}
              </span>
            </span>
          ))}
        </p>
      )}

      {/* 讨论数也走横排图（原先是一列文字行） */}
      {talk && talk.top.length > 0 && (
        <RankBarChart
          chart="crowd-talk"
          label="讨论最多的场次"
          valueName="讨论条数"
          data={talk.top.slice(0, TOP).map((row) => ({ label: `${row.code} ${row.title}`, value: row.count }))}
          tokens={tokens}
          footnote={`${talk.shows} 场有讨论，共 ${talk.total} 条。`}
        />
      )}
    </section>
  );
}
