/**
 * 榜单页 ·「热门影片」（编辑式排行榜，2026-10-14，`PLAN-20261014162246`）。
 *
 * ★ 版式（参考 Letterboxd 榜单 + 独立电影杂志的编辑式编排）：
 *   · **刊头**：主标题「热门影片」+ 英文副标题 + 一句说明 + 真实影片数（只印真实数据）；
 *   · **榜首主视觉**（#01）：桌面左右分栏（海报 2:3 占左半），右栏是排名 / 片名 / 原名 /
 *     单元·国家·年份·导演 / 官方简介 / 想看人数 / 去看详情的入口；移动端自然纵排；
 *   · **海报墙**（第 2 名起）：4–5 / 3 / 2 列响应式网格，统一 2:3；
 *   · **hover**：`scale(1.03)` + 亮度变化 + 底部渐变遮罩 + 信息淡入，**纯 CSS**（见 `hot-board.css`）。
 *
 * ★ 分层的边界（与 `hot-board.ts` 的纯逻辑分开，业务规则不进模板）：
 *   · 排序 / 三档 / 名次变化 = `hot-board.ts`（纯函数、可单测）；
 *   · 「今日新增想看」 = `want-trend.ts`（服务端日账本，口径见该文件）；
 *   · 本文件只管**取数 + 编排 + 交互**。
 *
 * ⚠ 数据**一律来自既有接口**，一项都不编：片名 / 原名 / 单元 / 年份 / 国家 / 导演 / 简介
 *   取自目录条目（`FilmNode.cats[0]`），想看人数取自 `want-counts`，今日新增取自 `want-trend`
 *   （日账本），口碑评分复用 `redblack.ts::scoreOf`。缺哪一项就不画哪一项。
 * ⚠ 刻意**不引 ECharts / 动画库**：榜单页是非 lazy 路由，右侧那些依赖会把首屏一起拖胖
 *   （数字与理由见 `hot-board.ts` 文件头）。
 * ⚠ 打开影片详情走 `app/film-navigation.ts::useFilmNavigation()` —— 那是全站唯一一条
 *   「打开某个影片」的写法（它会带上当前页上下文与 `?code=`），不要在本地再拼一遍 URL。
 */

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { wantCountLabel } from "../actions-copy";
import type { FilmNode } from "../app/model";
import { useFilmNavigation } from "../app/film-navigation";
import { useCatalog } from "../app/store";
import { loadFilmVotes, onFilmVotesChange, peekFilmVotes } from "../film-votes";
import {
  buildHotRows,
  groupByUnit,
  hotTotals,
  HOT_MODES,
  type HotMode,
  type HotRow,
} from "../hot-board";
import { crowdOf, priorOf } from "../redblack";
import { catMetaLine } from "../util";
import { loadWantCounts, onWantCountsChange, peekWantCounts } from "../want-counts";
import { loadWantTrend, onWantTrendChange, peekWantTrend, type WantTrend } from "../want-trend";

/** 分享图弹层**按需加载**（与 `RedBlackPage` 那三个弹层同一手法）：
 *  它一条链上带着 `hot-poster.ts`（整张 canvas 的模型 + 绘制），而进榜单页的人多数不会点
 *  「生成分享图」—— 同步 import 等于让每个人先下载它再进页面。
 *  ⚠ 具名导出，而 `lazy` 要的是 `{ default }`，所以这里包一层（不动组件文件）。
 *  ⚠ 不给 loading 占位：同源、体积小，加载是毫秒级。 */
const HotBoardShareDialog = lazy(() =>
  import("./HotBoardShareDialog").then((m) => ({ default: m.HotBoardShareDialog })),
);

/** 海报墙首屏渲染多少张（「显示更多」每次再加这么多）——
 *  247 部片一次性铺出来会让首屏同时发几百个海报请求（本页是非 lazy 路由，进页即有压力）。 */
const GRID_STEP = 24;

/** 订阅「想看人数 / 红黑票」两份计数并各拉一次（直链打开本页也能有数）。
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

/** 今日新增（日账本）。返回 `state` 是为了让界面能分开「还没读到」「读失败」「今天真没人新增」。 */
function useWantTrend(): { trend: WantTrend | null; failed: boolean } {
  const [trend, setTrend] = useState<WantTrend | null>(() => peekWantTrend());
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const stop = onWantTrendChange(() => {
      if (alive) setTrend(peekWantTrend());
    });
    void loadWantTrend().then((value) => {
      if (!alive) return;
      setTrend(value);
      setFailed(value === null);
    });
    return () => {
      alive = false;
      stop();
    };
  }, []);
  return { trend, failed };
}

/** 卡片副行：**原名优先，其次年份**（需求：仅在数据存在时展示）。
 *  ⚠ 用 `FilmNode.names[0]` 而不是 `cats[0].title_orig`：`names` 已经排掉了
 *    「原始片名与中英名相同」的重复（见 `app/model.ts::buildFilms`），直接印 `title_orig`
 *    会出现「In Winter」上下两行一模一样。 */
function cardSub(film: FilmNode | undefined): string {
  if (!film) return "";
  const orig = film.names[0];
  if (orig) return orig;
  const year = film.cats[0]?.year;
  return year ? String(year) : "";
}

/** 名次变化：▲ 上升 / ▼ 下降。`null` 与 `0` 都不画（两者都表示「没有可说的变化」）—— */
function RankDelta({ delta }: { delta: number | null }) {
  if (!delta) return null;
  return (
    <span className={`hb-trend${delta > 0 ? " hb-trend--up" : " hb-trend--down"}`} data-hot-delta={delta}>
      {delta > 0 ? "▲" : "▼"}
      {Math.abs(delta)}
    </span>
  );
}

/** 一张海报。⚠ 整格是一个 `<button>`：点击区就是海报本体（移动端与键盘都够大、够清楚），
 *  hover 遮罩与提示都挂 `pointer-events: none`，绝不吃掉这一次点击。 */
function PosterCard({
  row,
  rank,
  film,
  onOpen,
}: {
  row: HotRow;
  rank: number;
  film: FilmNode | undefined;
  onOpen: (key: string) => void;
}) {
  const sub = cardSub(film);
  return (
    <li className="hb-card" data-hot-row={row.key} data-hot-want={row.want}>
      <button
        type="button"
        className="hb-card-btn"
        onClick={() => onOpen(row.key)}
        aria-label={`第 ${rank} 名 ${row.title}，${wantCountLabel(row.want)}，查看影片详情`}
      >
        <span className="hb-frame">
          {row.poster ? (
            <img className="hb-frame-img" src={row.poster} alt="" loading="lazy" decoding="async" />
          ) : (
            // 缺图是常态（247 部里只有一部分有）—— 走统一的占位块，**不编一个路径**。
            // 印片名首字，让占位也认得出是哪一部（与分享图的占位块同一手法）。
            <span className="hb-frame-empty" aria-hidden="true">
              {row.title.trim().charAt(0)}
            </span>
          )}
          {/* 遮罩与 hover 信息都是**装饰**（同一批信息在下面那行里常驻、读屏读得到），
              所以整体 aria-hidden + pointer-events:none —— 只负责好看，不承担可达性。 */}
          <span className="hb-veil" aria-hidden="true" />
          <span className="hb-hover" aria-hidden="true">
            {row.unitName && <span className="hb-hover-unit">{row.unitName}</span>}
            <span className="hb-hover-more">查看详情 →</span>
          </span>
        </span>
        <span className="hb-cap">
          <span className="hb-cap-rank">{String(rank).padStart(2, "0")}</span>
          <span className="hb-cap-text">
            <span className="hb-cap-title">{row.title}</span>
            {sub && <span className="hb-cap-sub">{sub}</span>}
          </span>
          <span className="hb-cap-want">
            {wantCountLabel(row.want)}
            <RankDelta delta={row.rankDelta} />
          </span>
        </span>
      </button>
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
  const { trend, failed: trendFailed } = useWantTrend();
  const crowd = useMemo(() => crowdOf(votes), [votes]);
  const priorRate = useMemo(() => priorOf(crowd), [crowd]);
  const open = useFilmNavigation();

  /** 榜单档位。默认「最受关注」（就是原先的热门榜口径）。 */
  const [mode, setMode] = useState<HotMode>("want");
  /** 选中的单元键；空串 = 全部单元 */
  const [unitId, setUnitId] = useState("");
  /** 海报墙渲染到第几张（「显示更多」） */
  const [limit, setLimit] = useState(GRID_STEP);

  const rows = useMemo(
    () => buildHotRows(films, wants, crowd, priorRate, { mode, rising: trend?.deltas }),
    [films, wants, crowd, priorRate, mode, trend],
  );
  const units = useMemo(() => groupByUnit(rows), [rows]);
  const shown = useMemo(
    // ⚠ 用 `units.includes`（不是 `unit ===`）：联映块成员片可能同时属于这个单元，
    //   与 `groupByUnit` 把同一行放进多个组是同一条口径（否则「头部说 N 部、列表少几行」）
    () => (unitId ? rows.filter((row) => row.units.includes(unitId)) : rows),
    [rows, unitId],
  );
  const totals = useMemo(() => hotTotals(shown), [shown]);
  /** 今日新增合计（只在「正在升温」档露出来，其余档不显示这个数 —— 免得被读成热度） */
  const risingTotal = useMemo(
    () => shown.reduce((sum, row) => sum + row.rising, 0),
    [shown],
  );

  /** 影片 key → 影片节点：榜首与卡片都要读目录里的原名 / 年份 / 简介 / 单元行。 */
  const byKey = useMemo(() => new Map(films.map((film) => [film.key, film])), [films]);

  const lead = shown[0];
  // ⚠ `limit` 数的是**海报墙**（第 2 名起）的条数，不是整个榜单 —— 写成 `slice(1, limit)`
  //   会让「首屏 24 张」实际只有 23 张，而「还有 N 部」也跟着差一
  const rest = shown.slice(1, 1 + limit);
  const remaining = Math.max(0, shown.length - 1 - limit);
  const leadFilm = lead ? byKey.get(lead.key) : undefined;
  const leadCat = leadFilm?.cats[0];
  const leadSynopsis = leadCat?.catalogue?.synopsis_en || leadCat?.catalogue?.synopsis_ko || "";
  const currentMode = HOT_MODES.find((entry) => entry.id === mode) ?? HOT_MODES[0];

  // 换档 / 换单元 = 换一份榜单：海报墙回到首屏那么长（否则在「全部影片」里点了显示更多，
  // 切到别的档会接着铺几百张）
  const pickMode = (next: HotMode) => {
    setMode(next);
    setLimit(GRID_STEP);
  };
  const pickUnit = (next: string) => {
    setUnitId(next);
    setLimit(GRID_STEP);
  };

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

  /** 空态文案：**分开说清是哪一种空**（没数据 / 数据缺口 / 换个单元），别都写成一句话 —— */
  const emptyText = (() => {
    if (unitId) return "这个单元还没有人标记想看 —— 换个单元试试。";
    if (mode === "rising" && !trend) {
      return trendFailed
        ? "读不到逐日数据 —— 这一档按服务端的日账本统计，接口暂时不可用，稍后再看。"
        : "正在读取今日新增…";
    }
    if (mode === "rising") {
      return `${trend?.toDay ?? "今天"}（KST）还没有人新增想看 —— 这一档按「今日新增」排序，明天再来看看。`;
    }
    if (mode === "all") return "本届还没有影片数据。";
    return "还没有人标记想看 —— 去影片页点一下「想看」吧。";
  })();

  return (
    <section className="hb-panel" aria-label="热门影片排行榜">
      {/* 刊头：字体层级 + 留白，只印真实数据（当前这份榜单的条数 / 想看合计） */}
      <header className="hb-masthead">
        <p className="hb-kicker">MOST ANTICIPATED FILMS</p>
        <div className="hb-masthead-row">
          <h1 className="hb-title">热门影片</h1>
          <p className="hb-count" data-hot-films={totals.films} data-hot-want={totals.want}>
            {totals.films} 部影片 · {totals.want.toLocaleString("zh-CN")} 人想看
            {mode === "rising" && trend ? ` · 今日 +${risingTotal.toLocaleString("zh-CN")}` : ""}
          </p>
        </div>
        <p className="hb-lede">
          发现本届电影节最受关注的作品。<span className="hb-note">想看是映前意愿，不是购票人数。</span>
        </p>

        <div className="hb-controls">
          <nav className="hb-modes" role="tablist" aria-label="榜单切换">
            {HOT_MODES.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                className="hb-mode"
                data-hot-mode={entry.id}
                aria-selected={mode === entry.id}
                onClick={() => pickMode(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </nav>
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
        </div>
        <p className="hb-hint">
          {currentMode.hint}
          {mode === "rising" && trend ? ` · ${trend.fromDay} 起（KST 日账本）` : ""}
        </p>

        {/* 单元筛选：22 个单元都有一行（实测每个都有想看数据），所以不折叠、不隐藏。
            形态是一条安静的细筛选带 —— 不与上面那排档位抢视线。 */}
        <div className="hb-units" role="group" aria-label="按单元筛选">
          <button
            type="button"
            className="hb-unit-btn"
            data-hot-unit=""
            aria-pressed={unitId === ""}
            onClick={() => pickUnit("")}
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
              onClick={() => pickUnit(unit.id)}
            >
              {unit.name}
              <small>{unit.want.toLocaleString("zh-CN")}</small>
            </button>
          ))}
        </div>
      </header>

      {shown.length === 0 ? (
        <p className="empty-state">{emptyText}</p>
      ) : (
        <>
          {/* ── 榜首：主视觉（#01）────────────────────────────── */}
          <section className="hb-lead" data-hot-row={lead.key} aria-label="榜首">
            <div className="hb-lead-media">
              {lead.poster ? (
                <img className="hb-lead-img" src={lead.poster} alt="" decoding="async" />
              ) : (
                <span className="hb-lead-empty" aria-hidden="true">
                  {lead.title.trim().charAt(0)}
                </span>
              )}
            </div>
            <div className="hb-lead-body">
              <p className="hb-lead-tag">TOP 01 · {currentMode.label}</p>
              <p className="hb-lead-rank" aria-hidden="true">
                #01
              </p>
              <h2 className="hb-lead-title">{lead.title}</h2>
              {leadFilm?.names[0] && <p className="hb-lead-orig">{leadFilm.names[0]}</p>}
              {/* 单元 · 国家 · 年份 · 导演 —— 走全站唯一那支 `catMetaLine`（空位自动省略），
                  不在这里各取各的字段再拼一遍 */}
              {leadCat && catMetaLine(leadCat) && (
                <p className="hb-lead-meta">{catMetaLine(leadCat)}</p>
              )}
              {leadSynopsis && <p className="hb-lead-summary">{leadSynopsis}</p>}
              <div className="hb-lead-foot">
                <p className="hb-lead-want">
                  <strong>{wantCountLabel(lead.want)}</strong>
                  <RankDelta delta={lead.rankDelta} />
                  {lead.score !== null && (
                    <span className="hb-lead-score" title={`红 ${lead.red} · 黑 ${lead.black}`}>
                      口碑 {lead.score}
                    </span>
                  )}
                </p>
                <button type="button" className="hb-lead-cta" onClick={() => open(lead.key)}>
                  查看放映场次 →
                </button>
              </div>
            </div>
          </section>

          {/* ── 第 2 名起：海报墙 ────────────────────────────── */}
          {rest.length > 0 && (
            <ol className="hb-grid" data-hot-rows={shown.length}>
              {rest.map((row, index) => (
                <PosterCard
                  key={row.key}
                  row={row}
                  rank={index + 2}
                  film={byKey.get(row.key)}
                  onOpen={open}
                />
              ))}
            </ol>
          )}
          {remaining > 0 && (
            <div className="hb-more">
              <button
                type="button"
                className="hb-more-btn"
                onClick={() => setLimit((n) => n + GRID_STEP)}
              >
                显示更多（还有 {remaining} 部）
              </button>
            </div>
          )}
        </>
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
