/**
 * 榜单页 ·「热门榜」（2026-10-14，`PLAN-20261014150805` 修订 1 / 2）。
 *
 * ★ 它是**纯 CSS 排名榜**：海报 + 片名 + 想看数（带条形）+ 红黑口碑角标。
 *   ⚠ 刻意**不用图表**：原「群体行为与口碑」（`RushCrowdPanel`）是环形图 / 柱状图，
 *     而那是 ECharts（gzip 193.9 KB）。榜单页是非 lazy 路由，引进来会拖进首屏主包 ——
 *     理由与数字见 `hot-board.ts` 文件头。
 *
 * ★ 数据三件套全部来自既有公开读接口，**不新增后端**：
 *   · 想看人数 `want-counts.ts`（热度，排序依据）；
 *   · 红黑票 `film-votes.ts`（口碑角标，评分复用 `redblack.ts::scoreOf`）。
 *
 * ★ 订阅手法照 `RushAnalysisPage::useLiveCounters`（三份计数共用同一形状：subscribe + load），
 *   只是这里只要两份 —— 榜单不看抢票人数。
 */

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { wantCountLabel } from "../actions-copy";
import { useCatalog } from "../app/store";
import { loadFilmVotes, onFilmVotesChange, peekFilmVotes } from "../film-votes";
import { buildHotRows, groupByUnit, hotTotals, type HotRow } from "../hot-board";
import { crowdOf, priorOf } from "../redblack";
import { loadWantCounts, onWantCountsChange, peekWantCounts } from "../want-counts";

/** 分享图弹层**按需加载**（与 `RedBlackPage` 那三个弹层同一手法）：
 *  它一条链上带着 `hot-poster.ts`（整张 canvas 的模型 + 绘制），而进榜单页的人多数不会点
 *  「生成分享图」—— 同步 import 等于让每个人先下载它再进页面。
 *  ⚠ 具名导出，而 `lazy` 要的是 `{ default }`，所以这里包一层（不动组件文件）。
 *  ⚠ 不给 loading 占位：同源、体积小，加载是毫秒级。 */
const HotBoardShareDialog = lazy(() =>
  import("./HotBoardShareDialog").then((m) => ({ default: m.HotBoardShareDialog })),
);

/** 订阅「想看 / 红黑票」两份计数并各拉一次（直链打开本页也能有数）。
 *
 * ⚠ **必须返回一个递增的 revision 并在下面当作依赖用**：`peek*` 读的是模块级缓存，
 *   拿到新数据本身不会让 React 重渲染 —— 少了这一步，页面会永远停在第一帧的空表上
 *   （接口明明有数据、页面 0 行。2026-10-14 本地验收时实测踩到）。
 *   手法与 `RushAnalysisPage::useLiveCounters` 逐字相同。 */
function useLiveCounters(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const bump = () => setRevision((n) => n + 1);
    const stops = [onWantCountsChange(bump), onFilmVotesChange(bump)];
    void loadWantCounts();
    void loadFilmVotes();
    return () => stops.forEach((stop) => stop());
  }, []);
  return revision;
}

/**
 * 榜单行。⚠ **纯展示**（无状态、无交互）—— 贴纸墙才需要交互，这里是「读一眼排名」。
 * 想看条的宽度按**榜首**归一：条形只回答「相对第一名的规模」，不回答绝对值（右边有数字）。
 */
function HotRowItem({ row, rank, peak }: { row: HotRow; rank: number; peak: number }) {
  const ratio = peak > 0 ? Math.max(2, Math.round((row.want / peak) * 100)) : 0;
  return (
    <li className="hb-row" data-hot-row={row.key} data-hot-want={row.want}>
      <span className="hb-rank" aria-hidden="true">
        {rank}
      </span>
      {row.poster ? (
        <img className="hb-poster" src={row.poster} alt="" loading="lazy" decoding="async" />
      ) : (
        // 缺图是常态（247 部里只有一部分有）—— 走占位块，**不编一个路径**（与卡片同口径）
        <span className="hb-poster hb-poster--empty" aria-hidden="true" />
      )}
      <span className="hb-main">
        <span className="hb-title">{row.title}</span>
        {row.unitName && <span className="hb-unit-name">{row.unitName}</span>}
        <span className="hb-bar" aria-hidden="true">
          <span className="hb-bar-fill" style={{ width: `${ratio}%` }} />
        </span>
      </span>
      <span className="hb-want">
        <strong>{wantCountLabel(row.want)}</strong>
        <small>想看</small>
      </span>
      {/* 口碑角标：评分与红黑数一起给 —— 只给评分的话，读的人看不出它由多少票算出来 */}
      <span className="hb-score" data-hot-score={row.score ?? undefined} title={`红 ${row.red} · 黑 ${row.black}`}>
        <strong>{row.score === null ? "—" : row.score}</strong>
        <small>
          红 {row.red} · 黑 {row.black}
        </small>
      </span>
    </li>
  );
}

export function HotBoardPanel() {
  const { films } = useCatalog();
  // ⚠ `revision` 是这两份数据的**唯一变化信号**（见 `useLiveCounters` 的说明）：
  //   进了依赖，数据到达才会重算下面的整条链。
  const revision = useLiveCounters();
  const wants = useMemo(() => peekWantCounts(), [revision]);
  const votes = useMemo(() => peekFilmVotes(), [revision]);
  const crowd = useMemo(() => crowdOf(votes), [votes]);
  const priorRate = useMemo(() => priorOf(crowd), [crowd]);
  const rows = useMemo(
    () => buildHotRows(films, wants, crowd, priorRate),
    [films, wants, crowd, priorRate],
  );
  const units = useMemo(() => groupByUnit(rows), [rows]);
  /** 选中的单元原串；空串 = 全部单元 */
  const [unitId, setUnitId] = useState("");
  const shown = useMemo(
    () => (unitId ? rows.filter((row) => row.unit === unitId) : rows),
    [rows, unitId],
  );
  const totals = useMemo(() => hotTotals(shown), [shown]);
  const peak = shown[0]?.want ?? 0;

  // 「生成分享图」弹层。⚠ 焦点归还必须在弹层**真正卸载之后**再做（S2 `DialogContainer`
  // 自己也会 restoreFocus，而 WebKit 上点按钮不会让按钮获得焦点、它记下的原焦点是 body）——
  // 所以放 `useEffect` 而不是写在 onDismiss 里，与 `RedBlackPage` 同一手法。
  const [shareOpen, setShareOpen] = useState(false);
  const shareBtnRef = useRef<HTMLButtonElement | null>(null);
  const shareWasOpenRef = useRef(false);
  useEffect(() => {
    if (shareWasOpenRef.current && !shareOpen) shareBtnRef.current?.focus();
    shareWasOpenRef.current = shareOpen;
  }, [shareOpen]);

  return (
    <section className="hb-panel" aria-label="热门榜">
      <header className="hb-hero">
        <div className="hb-hero-text">
          <p className="hb-eyebrow">热度 × 口碑</p>
          <h1>热门榜</h1>
          <p className="hb-lede">
            按<strong>想看人数</strong>排序，右侧是红黑口碑。
            <span className="hb-note">想看是映前意愿，不是购票人数。</span>
          </p>
        </div>
        <div className="hb-stats" aria-live="polite">
          <span className="hb-stat">
            <strong>{totals.films}</strong>
            <small>部上榜</small>
          </span>
          <span className="hb-stat">
            <strong>{totals.want.toLocaleString("zh-CN")}</strong>
            <small>人想看</small>
          </span>
          <span className="hb-stat">
            <strong>{totals.votes}</strong>
            <small>枚贴纸</small>
          </span>
        </div>
      </header>

      {/* 出 PNG 的出口 —— 用户 2026-10-14：「只要出 PNG，我自己上传」。
          图里不带任何应用 UI，是给公众号直接用的成品。 */}
      <div className="hb-toolbar">
        <button
          ref={shareBtnRef}
          type="button"
          className="hb-share-btn"
          onClick={() => setShareOpen(true)}
        >
          生成分享图
        </button>
      </div>

      {/* 单元筛选：22 个单元都有一行（实测每个都有想看数据），所以不折叠、不隐藏 */}
      <div className="hb-units" role="group" aria-label="按单元筛选">
        <button
          type="button"
          className="hb-unit-btn"
          data-hot-unit=""
          aria-pressed={unitId === ""}
          onClick={() => setUnitId("")}
        >
          全部单元
        </button>
        {units.map((unit) => (
          <button
            key={unit.id || "__none"}
            type="button"
            className="hb-unit-btn"
            data-hot-unit={unit.id}
            aria-pressed={unitId === unit.id}
            onClick={() => setUnitId(unit.id)}
          >
            {unit.name}
            <small>{unit.want.toLocaleString("zh-CN")}</small>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="empty-state">这个单元还没有人标记想看 —— 换个单元试试。</p>
      ) : (
        <ol className="hb-list" data-hot-rows={shown.length}>
          {shown.map((row, index) => (
            <HotRowItem key={row.key} row={row} rank={index + 1} peak={peak} />
          ))}
        </ol>
      )}

      {shareOpen && (
        // ⚠ `Suspense` 写在条件**内部**：不打开时连它都不挂，不多包一层没有内容的边界
        <Suspense fallback={null}>
          <HotBoardShareDialog
            /* 传**全量**行 + 分组：弹层里也能换单元（它自己管那份选择，见组件文件头） */
            rows={rows}
            units={units}
            /* 初值 = 页面上当前的单元 —— 在「主竞赛」那一档点出图，默认就该是主竞赛 */
            unit={unitId}
            onDismiss={() => setShareOpen(false)}
          />
        </Suspense>
      )}
    </section>
  );
}
