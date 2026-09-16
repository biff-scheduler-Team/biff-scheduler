// 电影红黑榜(2026-09-16,PLAN-20260916102339)
//
// 交互口径(用户当天三轮修订后的最终形态):
//   · 卡片**左**边是海报与影片信息,**右**边一大片留白就是贴纸画布;
//   · 在左侧标记「看过」解锁,点红 / 黑按钮 → 画布上**随机位置生成**一枚(允许重叠、±15° 歪斜);
//   · 已贴的贴纸可以拖动微调(也能拖到另一张卡上),**单击**就取下;
//   · 一部片红 / 黑**各一枚**(同框双色并存),贴过就保留。
//
// ⚠ 拖拽手写 Pointer Events(仓库无 dnd 依赖,范式见 `pages/AgendaPage.tsx::startDrag`);
//   ghost 用 DOM 直接操作而不是每帧 setState —— 一次拖拽只重渲染「目标卡高亮」变化的那几帧。

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { SearchField, ToastQueue } from "../components/spectrum";
import type { FilmNode } from "../app/model";
import { searchFilm } from "../app/model";
import { useQuery } from "../app/hooks";
import { useCatalog } from "../app/store";
import {
  boardFilms,
  countsOf,
  crowdOf,
  crowdStickers,
  makeSticker,
  moveSticker,
  placeSticker,
  purgeDemoLeavings,
  saveStickers,
  saveWatched,
  scoreOf,
  sortByCounts,
  takeSticker,
  tallyOf,
  tiltOf,
  votesOf,
  type CrowdCounts,
  type SortMode,
  type StickerBoard,
  type StickerType,
} from "../redblack";
import {
  loadFilmVotes,
  onFilmVotesChange,
  peekFilmVotes,
  scheduleFilmVotesPing,
  type FilmVoteCounts,
} from "../film-votes";
import "./redblack-parity.css";

const SORTS: Array<[SortMode, string]> = [
  ["total", "总数"],
  ["red", "红榜"],
  ["black", "黑榜"],
];

/** 拖起来的贴纸固定歪 5°(手拿着贴纸不会端端正正)。
 *  ⚠ 必须拼进 `transform` 而不是用 CSS 的 `rotate: -5deg`:独立 `rotate` 会连
 *    `transform` 里的平移量一起旋转,贴纸会比指针偏出几十像素(实测 59px)。 */
const GHOST_TILT = "rotate(-5deg)";

interface RbDrag {
  type: StickerType;
  /** null = 从**暂存区**(海报下方那两枚)拖出;有值 = 拖动已经贴在画布上的那一枚 */
  fromKey: string | null;
  fromId: string | null;
}

export function RedBlackPage() {
  const { films } = useCatalog();
  const { params, update } = useQuery();
  const query = params.get("q") ?? "";
  const mode = (params.get("sort") as SortMode | null) ?? "total";

  // 榜单**从空榜开始**:贴纸只来自用户自己(用户 2026-09-16:「正式环境不应该是空的让用户自己贴的吗」)。
  // ⚠ 早先版本会在这里自动铺一份示例,那段逻辑已删;`purgeDemoLeavings` 负责把**已经铺出去**
  //   的那份数据收干净 —— 老用户本机存着示例,光删代码他们还是会一直顶着一堆没贴过的贴纸。
  const [boot] = useState(() => purgeDemoLeavings());
  const [board, setBoard] = useState<StickerBoard>(boot.board);
  const [watched, setWatched] = useState(boot.watched);
  const [drag, setDrag] = useState<RbDrag | null>(null);

  // 全体票数(服务端聚合,见 `film-votes.ts`)。节奏与「想看人数」完全一致:
  // 拉一次 → 我贴完 1200ms 防抖上报 → 上报成功后再拉一次,所以「我自己这一票」
  // 大约一秒后才出现在数字里(画布上那一枚是立刻可见的,不会让人觉得没反应)。
  const [votes, setVotes] = useState<FilmVoteCounts>(() => peekFilmVotes());
  useEffect(() => {
    void loadFilmVotes().then(setVotes);
    return onFilmVotesChange(() => setVotes(peekFilmVotes()));
  }, []);
  const crowd: CrowdCounts = useMemo(() => crowdOf(votes), [votes]);
  // 我的贴纸一变就上报整份(服务端据此校正)。
  // ⚠ **只在用户动过手之后**才上报:载入时把空榜报上去,会把「服务端上属于我的那些票」误清掉 ——
  //   换设备 / 清过缓存时本地本来就是空的,而那不是「我撤票了」,只是「这台机器还没数据」。
  const actedRef = useRef(false);
  useEffect(() => {
    if (!actedRef.current) return;
    scheduleFilmVotesPing(votesOf(board));
  }, [board]);

  const candidates = useMemo(
    () => boardFilms(films).filter((film) => searchFilm(film, query)),
    [films, query],
  );
  // ⚠ **顺序不跟票数走**(用户反馈「跳动很频繁」)。按数量降序时,别人贴一枚就让那张卡跳到榜首、
  //   整页两列跟着重排 —— 而排序本来就是用户主动想看才需要的动作。
  //   所以顺序只在「搜索词 / 排序档位」变化、或点「重新排序」时刷新;
  //   卡片里的数字 / 颜色仍然即时更新(那是内容,不影响排布)。
  const [sortTick, setSortTick] = useState(0);
  const orderRef = useRef(votes);
  const sorted = useMemo(() => {
    orderRef.current = votes;
    return sortByCounts(candidates, crowd, mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 故意不依赖 crowd,见上面的注释
  }, [candidates, mode, sortTick]);
  const orderStale = orderRef.current !== votes;
  // 我自己那一份 —— 只用来控制「能不能贴 / 还能贴几枚」
  const tallies = useMemo(
    () => new Map(sorted.map((film) => [film.key, tallyOf(film.key, watched.has(film.key), board)])),
    [sorted, watched, board],
  );
  // 每一部的**全体票数**(服务端聚合)。⚠ 它**已经含我自己那一票**(上报成功后),
  //   所以不能再拿它跟本地贴纸相加 —— 会把我算两次。
  const filmCounts = useMemo(
    () =>
      new Map(
        sorted.map((film) => [
          film.key,
          crowd.get(film.key) ?? { total: 0, red: 0, black: 0 },
        ] as const),
      ),
    [sorted, crowd],
  );
  const totals = useMemo(() => {
    let marked = 0;
    let placed = 0;
    let quota = 0;
    for (const tally of tallies.values()) {
      if (tally.marked) marked++;
      placed += tally.total;
      quota += tally.quota;
    }
    // 全站总票数:只用来判断「榜是不是空的」(决定要不要显示那句引导)。
    // ⚠ 分数**不是**看全站 —— 评分是**每部各自的**(见卡片里的 `filmScore`)。
    let total = 0;
    for (const counts of filmCounts.values()) total += counts.red + counts.black;
    return { marked, placed, quota, total };
  }, [tallies, filmCounts]);

  // 落点处理要按 key 反查影片(提示里要片名、贴纸要挂到它上面),先按当前榜单建索引
  const filmByKey = useMemo(
    () => new Map(sorted.map((film) => [film.key, film])),
    [sorted],
  );

  const commitBoard = (next: StickerBoard) => {
    setBoard(next);
    // 用户动过手了 —— 从这里开始才允许把「我的票」上报给服务端(见上面 actedRef 的说明)。
    actedRef.current = true;
    saveStickers(next);
  };

  /** 标记 / 取消标记。
   *  ⚠ 取消时要把**这一部自己的贴纸全部收回**(用户口径):画布上的那枚与暂存区里的选择一起清掉 ——
   *    不这么做的后果是「没标记却贴着一张纸」,谁看都觉得是 bug。 */
  const toggleWatched = (film: FilmNode) => {
    const next = new Set(watched);
    const on = !next.has(film.key);
    if (on) next.add(film.key);
    else next.delete(film.key);
    setWatched(next);
    saveWatched(next);
    if (on) {
      ToastQueue.positive(`已标记《${film.zh}》看过，可以在下面挑一枚贴纸。`, { timeout: 3500 });
      return;
    }
    const placed = board.get(film.key);
    if (placed?.length) commitBoard(takeSticker(board, film.key, placed[0].id));
    ToastQueue.neutral(`已取消《${film.zh}》的「看过」，它的贴纸也收回了。`, { timeout: 3500 });
  };

  /** 贴一枚:点一下 → 落点随机;从暂存区拖进来 → 落在松手那一点 */
  const place = (filmKey: string, type: StickerType, spot?: { posX: number; posY: number }) => {
    const name = filmByKey.get(filmKey)?.zh ?? "这部";
    const tally = tallies.get(filmKey);
    if (!tally?.marked) {
      ToastQueue.neutral(`先给《${name}》标一下「看过」，就能贴了。`, { timeout: 4000 });
      return;
    }
    if (!tally.canPlace) {
      ToastQueue.neutral(`《${name}》已经贴了一枚，把那张拖到画布外就能收回。`, { timeout: 4000 });
      return;
    }
    commitBoard(placeSticker(board, filmKey, makeSticker(type, spot)));
  };

  // ⚠ 落点处理要用**最新**的 board,而 window 监听只在开始拖拽时挂一次 ——
  //   所以把处理函数放进 ref,每次渲染更新,监听器里读 ref.current。
  const finishRef = useRef<(drag: RbDrag, canvas: HTMLElement | null, x: number, y: number) => void>(
    () => {},
  );
  finishRef.current = (meta, canvas, x, y) => {
    const key = canvas?.dataset.rbCanvas ?? null;

    // ① 从画布上拖出去 → **收回暂存区**(用户口径:「贴纸拖到外面就需要取消」)
    if (meta.fromKey && !key) {
      commitBoard(takeSticker(board, meta.fromKey, meta.fromId!));
      ToastQueue.neutral(`《${filmByKey.get(meta.fromKey)?.zh ?? "这部"}》的贴纸收回暂存区了。`, {
        timeout: 3000,
      });
      return;
    }
    if (!key || !canvas) return;

    const rect = canvas.getBoundingClientRect();
    const posX = (x - rect.left) / rect.width;
    const posY = (y - rect.top) / rect.height;

    // ② 已经贴着的 → 挪位置(也能挪到另一张卡上)
    if (meta.fromKey) {
      const next = moveSticker(board, meta.fromKey, meta.fromId!, key, posX, posY);
      if (next === board && key !== meta.fromKey) {
        ToastQueue.neutral(`《${filmByKey.get(key)?.zh ?? "这部"}》已经有贴纸了。`, { timeout: 3500 });
        return;
      }
      commitBoard(next);
      return;
    }

    // ③ 从暂存区拖进来 → 落在松手那一点
    place(key, meta.type, { posX, posY });
  };

  const dragMeta = useRef({ startX: 0, startY: 0 });

  /** ⚠ 这里**不 preventDefault**:暂存区那两枚贴纸既要能拖、也要能点(点一下随机贴),
   *  在 pointerdown 上拦掉默认行为会把 click 一起吃掉。 */
  const beginDrag = (
    event: ReactPointerEvent<HTMLElement>,
    type: StickerType,
    fromKey: string | null,
    fromId: string | null,
  ) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    dragMeta.current = { startX: event.clientX, startY: event.clientY };
    setDrag({ type, fromKey, fromId });
  };

  useEffect(() => {
    if (!drag) return;
    const { startX, startY } = dragMeta.current;
    // ⚠ ghost 只在**真的开始移动**之后才创建:「点一下贴纸」是合法操作(随机贴),
    //   在 pointerdown 就造浮标会让每次点击都闪一下。
    let ghost: HTMLElement | null = null;
    // ⚠ 目标卡高亮**直接改 DOM 属性**而不走 state:榜单有近 300 张卡,
    //   每跨一张卡就 setState 会整页重渲染一次,贴纸立刻跟不上指针。
    let hoverCard: HTMLElement | null = null;
    const setHover = (card: HTMLElement | null) => {
      if (card === hoverCard) return;
      hoverCard?.removeAttribute("data-rb-hover");
      card?.setAttribute("data-rb-hover", "");
      hoverCard = card;
    };
    let moved = false;

    const onMove = (event: PointerEvent) => {
      if (!moved) {
        if (Math.abs(event.clientX - startX) <= 4 && Math.abs(event.clientY - startY) <= 4) return;
        moved = true;
        event.preventDefault();
        ghost = document.createElement("span");
        ghost.className = `rb-ghost rb-ghost--${drag.type}`;
        document.body.appendChild(ghost);
      }
      ghost!.style.transform = `translate3d(${event.clientX}px, ${event.clientY}px, 0) ${GHOST_TILT}`;
      setHover(cardAt(event.clientX, event.clientY));
    };
    const onUp = (event: PointerEvent) => {
      // 没移动 = 一次单击(交给元素自己的 onClick),不要误当成一次拖动
      if (moved) {
        finishRef.current(drag, canvasAt(event.clientX, event.clientY), event.clientX, event.clientY);
      }
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      ghost?.remove();
      setHover(null);
    };
  }, [drag]);

  return (
    <section className="rb-page" aria-label="红黑榜">
      <header className="rb-hero">
        <div className="rb-hero-text">
          <p className="rb-eyebrow">看过就贴</p>
          <h1>红黑榜</h1>
          <p className="rb-lede">
            一部电影一枚贴纸：标记「看过」，点红或黑，贴纸就落在右边的空地上；大家的票一起排榜。
          </p>
        </div>
        <div className="rb-totals" aria-live="polite">
          <span className="rb-total">
            <strong>{totals.marked}</strong>
            <small>标记看过</small>
          </span>
          <span className="rb-total rb-total--hot">
            <strong>{totals.quota}</strong>
            <small>还能贴</small>
          </span>
          <span className="rb-total">
            <strong>{totals.placed}</strong>
            <small>已贴</small>
          </span>
        </div>
      </header>

      <div className="rb-controls">
        <SearchField
          label="搜索影片或场次编号"
          placeholder="片名 / 场次 code，如 0412"
          value={query}
          onChange={(value) => update({ q: value || null }, true)}
        />
        <div className="rb-sort" role="group" aria-label="榜单排序">
          {SORTS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="rb-sort-btn"
              aria-pressed={mode === value}
              onClick={() => update({ sort: value === "total" ? null : value }, true)}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            className="rb-resort"
            data-rb-stale={orderStale || undefined}
            aria-label="按当前的贴纸数量重新排序"
            onClick={() => setSortTick((count) => count + 1)}
          >
            {orderStale ? "有新贴纸 · 重新排序" : "重新排序"}
          </button>
          <span className="rb-sort-hint">
            {mode === "total" ? "按贴纸总数" : mode === "red" ? "按红贴纸数" : "按黑贴纸数"}
            从高到低；贴纸变化不会打乱当前顺序
          </span>
        </div>
      </div>

      {totals.marked === 0 && totals.total === 0 && (
        <p className="rb-hint" role="status">
          榜还是空的。在卡片上点「标记看过」，再挑一枚红或黑贴上去 —— 这是你自己的榜。
        </p>
      )}

      {sorted.length === 0 ? (
        <div className="empty-state">
          <h2>没有符合条件的影片</h2>
          <p>试试其他片名，或换一个场次编号。</p>
        </div>
      ) : (
        <div className="rb-grid">
          {sorted.map((film) => {
            const tally = tallies.get(film.key)!;
            const placed = board.get(film.key) ?? [];
            const counts = filmCounts.get(film.key)!;
            // 这一部**自己的**评分(红票占比折算 0–10);还没有人贴过 → null(显示成「—」)
            const filmScore = scoreOf(counts);
            // 「别人的贴纸」= 全体票数 − 我自己那几枚。服务端那份**含我**,不减掉会把我这枚画重。
            const mine = countsOf(placed);
            const others = {
              total: Math.max(0, counts.total - mine.total),
              red: Math.max(0, counts.red - mine.red),
              black: Math.max(0, counts.black - mine.black),
            };
            return (
              <article
                key={film.key}
                className="rb-card"
                data-film-key={film.key}
                data-rb-marked={tally.marked || undefined}
              >
                <div className="rb-card-info">
                  {film.poster ? (
                    <img className="rb-poster" src={film.poster} loading="lazy" alt="" />
                  ) : (
                    <span className="rb-poster rb-poster--none" aria-hidden="true">
                      {film.zh.slice(0, 1)}
                    </span>
                  )}
                  <h2 className="rb-title">{film.zh}</h2>
                  {film.en && film.en !== film.zh && <p className="rb-en">{film.en}</p>}
                  <p className="rb-chips">
                    <span
                      className="rb-chip rb-chip--score"
                      title="这部片的红票占比折算成 0–10 分；还没有人贴时不显示分数"
                    >
                      评分 {filmScore === null ? "—" : filmScore.toFixed(1)}
                    </span>
                    <button
                      type="button"
                      className="rb-mark"
                      aria-pressed={tally.marked}
                      aria-label={`${tally.marked ? "取消标记" : "标记"}《${film.zh}》看过`}
                      onClick={() => toggleWatched(film)}
                    >
                      {tally.marked ? "看过 ✓" : "标记看过"}
                    </button>
                    {counts.red > 0 && <span className="rb-chip rb-chip--red">红 {counts.red}</span>}
                    {counts.black > 0 && (
                      <span className="rb-chip rb-chip--black">黑 {counts.black}</span>
                    )}
                  </p>
                  {/* 暂存区(海报下方那两枚):点一下 → 随机贴到画布;拖到画布 → 落在松手那一点。
                      ⚠ 这里**不写状态文案**(2026-09-16 用户:「太占空间」):
                      按钮亮着就说明能贴、暗了就是贴过了 —— 靠形态表达,不靠解释。 */}
                  <div className="rb-tray" aria-label={`《${film.zh}》的贴纸暂存区`}>
                    <button
                      type="button"
                      className="rb-src rb-src--red"
                      data-rb-spent={!tally.canPlace || undefined}
                      aria-label={`给《${film.zh}》贴红贴纸（点一下随机贴，也可以拖到右边画布上）`}
                      onClick={() => place(film.key, "red")}
                      onPointerDown={(event) => beginDrag(event, "red", null, null)}
                    >
                      红
                    </button>
                    <button
                      type="button"
                      className="rb-src rb-src--black"
                      data-rb-spent={!tally.canPlace || undefined}
                      aria-label={`给《${film.zh}》贴黑贴纸（点一下随机贴，也可以拖到右边画布上）`}
                      onClick={() => place(film.key, "black")}
                      onPointerDown={(event) => beginDrag(event, "black", null, null)}
                    >
                      黑
                    </button>
                  </div>
                </div>

                <div className="rb-canvas" data-rb-canvas={film.key}>
                  {/* 别人的贴纸:只读(不挂 pointerdown),位置由 (影片 key, 序号) 确定性推导 ——
                      用随机坐标的话每次重排这些点都会换地方,看着像在跳。 */}
                  {crowdStickers(film.key, others).map((sticker) => (
                    <span
                      key={sticker.id}
                      className={`rb-dot rb-dot--${sticker.type} rb-dot--crowd`}
                      style={
                        {
                          left: `${sticker.posX * 100}%`,
                          top: `${sticker.posY * 100}%`,
                          "--rb-tilt": `${tiltOf(sticker.id)}deg`,
                        } as CSSProperties
                      }
                      aria-hidden="true"
                    />
                  ))}
                  {placed.map((sticker) => (
                    <span
                      key={sticker.id}
                      className={`rb-dot rb-dot--${sticker.type}`}
                      style={
                        {
                          left: `${sticker.posX * 100}%`,
                          top: `${sticker.posY * 100}%`,
                          "--rb-tilt": `${tiltOf(sticker.id)}deg`,
                        } as CSSProperties
                      }
                      role="img"
                      aria-label={`${sticker.type === "red" ? "红" : "黑"}贴纸；拖动可挪位置或挪到别的片，拖到画布外就收回暂存区`}
                      onPointerDown={(event) =>
                        beginDrag(event, sticker.type, film.key, sticker.id)
                      }
                    />
                  ))}
                  {placed.length === 0 && others.total === 0 && (
                    <span className="rb-canvas-hint">
                      {tally.marked ? "点左边的红 / 黑，或把贴纸拖进来" : "标记「看过」后就能贴"}
                    </span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** 指针落点所在的**画布**(ghost 是 `pointer-events: none`,不会挡住命中测试) */
function canvasAt(x: number, y: number): HTMLElement | null {
  const hit = document.elementFromPoint(x, y);
  return hit instanceof HTMLElement ? hit.closest<HTMLElement>("[data-rb-canvas]") : null;
}

/** 指针落点所在的**卡片**(拖拽时直接挂 `data-rb-hover`,不经过 React 状态) */
function cardAt(x: number, y: number): HTMLElement | null {
  const hit = document.elementFromPoint(x, y);
  return hit instanceof HTMLElement ? hit.closest<HTMLElement>("[data-film-key]") : null;
}
