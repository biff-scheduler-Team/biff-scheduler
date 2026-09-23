// 电影红黑榜(2026-09-16,PLAN-20260916102339)
//
// 交互口径(用户当天三轮修订后的最终形态):
//   · 卡片**左**边是海报与影片信息,**右**边一大片留白就是贴纸画布;
//   · 在左侧标记「看过」解锁,点红 / 黑按钮 → 画布上**随机位置生成**一枚(允许重叠、±15° 歪斜);
//   · 已贴的贴纸可以在**这一部自己的**张贴区里拖动微调 —— 张贴区**按片独立**(2026-09-23:
//     「贴纸张贴区应该是电影之间独立的」),别片的画布不是落点;拖出这张画布、或**单击**它,都收回暂存区;
//   · 一部片**只有一枚**(2026-09-16 用户:「标记看过只能选一个贴纸」)—— 红 / 黑 是同一个名额的
//     两种取舍,不是可以并存的两色(旧版「红黑各一枚、同框双色并存」的口径已作废);
//   · 刚贴下的那一枚会**闪一下描边**告诉用户它落在哪(票多时否则根本找不着);闪完仍留一圈
//     **常驻纸白边**(2026-09-23,见 `redblack-parity.css` 的 `.rb-dot`)—— 一片同色同尺寸的群点里,
//     得先找得到自己那枚,「自己贴的贴纸始终能被自己拖动」才成立。
//
// ⚠ 拖拽手写 Pointer Events(仓库无 dnd 依赖,范式见 `pages/AgendaPage.tsx::startDrag`);
//   ghost 与「落点高亮」都用 DOM 直接操作:一次拖拽**一次 React 渲染都不做**;
//   监听器在 pointerdown 里**同步挂上**、`pointermove` 合并到一帧一次(见 `beginDrag`)。

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ToastQueue } from "../components/spectrum";
import { QuerySearchField } from "../components/QuerySearchField";
import { RedBlackShareDialog } from "../components/RedBlackShareDialog";
import { StickerCanvas } from "../components/StickerCanvas";
import { StickerZoomDialog } from "../components/StickerZoomDialog";
import type { FilmNode } from "../app/model";
import { searchFilm } from "../app/model";
import { useQuery } from "../app/hooks";
import { useCatalog } from "../app/store";
import {
  boardFilms,
  countsOf,
  crowdOf,
  crowdSignature,
  makeSticker,
  moveSticker,
  othersOf,
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
  type Sticker,
  type StickerBoard,
  type StickerCounts,
  type StickerType,
} from "../redblack";
import {
  loadFilmVotes,
  onFilmVotesChange,
  peekFilmVotes,
  scheduleFilmVotesPing,
  type FilmVoteCounts,
} from "../film-votes";
import { useInView } from "../use-in-view";
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
  /** 这枚贴纸**属于**哪一部电影 —— 张贴区按片独立,落点不是它的画布就只能算「出界」。
   *  ⚠ 暂存区那两枚也带自己的 `film.key`:否则「《A》的暂存区拖到《B》的画布」会当场复现同一个 bug。 */
  srcKey: string;
  /** 已经贴在画布上那一枚的 id;`null` = 从**暂存区**(海报下方那两枚)拖出 */
  fromId: string | null;
}

/** 没有票的影片共用这一个常量:
 *  ⚠ 必须共用(`?? { total: 0, red: 0, black: 0 }` 会每次造新对象)—— 卡片是 `memo` 的,
 *    prop 引用一变就白重渲染一次,299 张卡一起白渲染正是本轮要修的那个卡顿(PLAN-20260922145815)。 */
const EMPTY_COUNTS: StickerCounts = { total: 0, red: 0, black: 0 };
const EMPTY_STICKERS: readonly Sticker[] = [];

/** 「刚贴的那一枚」高亮多久(ms)。
 *  ⚠ 三个数必须**同拍**:`FRESH_MS` = `FRESH_BLINK_MS × FRESH_BLINKS`,否则会出现
 *    「闪完了描边还亮着」或「还在闪就被撤掉」的半截状态(`redblack-parity.css` 的
 *    `.rb-dot[data-rb-fresh]` 提供常驻描边,WAAPI 只负责让它明暗起伏)。
 *  取 2400ms:约等于「上报防抖 1200ms + 一次重拉 + 一拍」—— 用户贴完抬手,动效刚好收尾。 */
const FRESH_MS = 2400;
const FRESH_BLINK_MS = 800;
const FRESH_BLINKS = 3;
/** 判定「算拖、不算点」的位移阈值(px)。手指比鼠标抖得多:4px 在触屏上几乎必然越过,
 *  于是「想点一下收回」会变成「挪了个位置」—— 所以触屏放宽到 10px。 */
const DRAG_SLOP_MOUSE = 4;
const DRAG_SLOP_TOUCH = 10;

interface RbCardProps {
  film: FilmNode;
  /** 是否标记过「看过」;`canPlace` = 标记过且这一部还没贴 */
  marked: boolean;
  canPlace: boolean;
  /** 我贴的那几枚。⚠ 直接传 `board.get(key)`,**不要** `?? []` —— 那会每次造个新数组,`memo` 失效 */
  placed: readonly Sticker[] | undefined;
  /** 这一部的**全体**票数(已含我自己那一票) */
  counts: StickerCounts;
  /** 这一部是不是「刚贴下那一枚」的持有者 —— 只有它**多一圈会起伏的亮描边**;
   *  ⚠ 与「常驻纸白边」是两回事:后者在 `.rb-dot` 上恒有,不靠这个 prop(见 CSS 里的说明) */
  fresh: boolean;
  /** 回调都必须是**稳定引用**(见 `RedBlackPage` 里 `latest` 那段注释) */
  onToggleWatched: (film: FilmNode) => void;
  onPlace: (filmKey: string, type: StickerType, spot?: { posX: number; posY: number }) => void;
  onBeginDrag: (
    event: ReactPointerEvent<HTMLElement>,
    type: StickerType,
    srcKey: string,
    fromId: string | null,
  ) => void;
  /** 单击「我贴的那一枚」→ 收回暂存区(拖出画布是同一个出口,见 `takeBack`)。
   *  `detail` 直接透传 `MouseEvent.detail` —— 调用方靠它区分「指针来的 click」与
   *  键盘 / `element.click()`(后者恒为 0),见 `takeBackByTap`。 */
  onTakeBack: (filmKey: string, stickerId: string, detail: number) => void;
}

export function RedBlackPage() {
  const { films } = useCatalog();
  const { params, update } = useQuery();
  const query = params.get("q") ?? "";
  const mode = (params.get("sort") as SortMode | null) ?? "total";
  // 「只看我贴过」——**独立参数**(与 `sort` 正交:排序是给全站排名次,筛选是换一个视野)。
  // 塞进 `sort` 会与「顺序冻结 / 重新排序」那套机制纠缠,得不偿失。
  const onlyMine = params.get("only") === "mine";

  // 榜单**从空榜开始**:贴纸只来自用户自己(用户 2026-09-16:「正式环境不应该是空的让用户自己贴的吗」)。
  // ⚠ 早先版本会在这里自动铺一份示例,那段逻辑已删;`purgeDemoLeavings` 负责把**已经铺出去**
  //   的那份数据收干净 —— 老用户本机存着示例,光删代码他们还是会一直顶着一堆没贴过的贴纸。
  const [boot] = useState(() => purgeDemoLeavings());
  const [board, setBoard] = useState<StickerBoard>(boot.board);
  const [watched, setWatched] = useState(boot.watched);
  // 「生成分享图」弹层。⚠ 焦点归还必须在弹层**真正卸载之后**再做(S2 `DialogContainer`
  // 自己也会 restoreFocus,而 WebKit 上点按钮不会让按钮获得焦点、它记下的原焦点是 body)——
  // 所以放 `useEffect` 而不是写在 onDismiss 里,与卡片上的「放大看全部」同一手法。
  const [shareOpen, setShareOpen] = useState(false);
  const shareBtnRef = useRef<HTMLButtonElement | null>(null);
  const shareWasOpenRef = useRef(false);
  useEffect(() => {
    if (shareWasOpenRef.current && !shareOpen) shareBtnRef.current?.focus();
    shareWasOpenRef.current = shareOpen;
  }, [shareOpen]);

  // 全体票数(服务端聚合,见 `film-votes.ts`)。节奏与「想看人数」完全一致:
  // 拉一次 → 我贴完 1200ms 防抖上报 → 上报成功后再拉一次,所以「我自己这一票」
  // 大约一秒后才出现在数字里(画布上那一枚是立刻可见的,不会让人觉得没反应)。
  const [votes, setVotes] = useState<FilmVoteCounts>(() => peekFilmVotes());
  // 票数**结算**了没有(成功、失败、空表都算结算)—— 首屏那次排序发生在它之前,见下面的补排
  const [votesSettled, setVotesSettled] = useState(false);
  useEffect(() => {
    void loadFilmVotes().then((next) => {
      setVotes(next);
      setVotesSettled(true);
    });
    return onFilmVotesChange(() => setVotes(peekFilmVotes()));
  }, []);
  const crowd: CrowdCounts = useMemo(() => crowdOf(votes), [votes]);
  /** 重排触发器 —— 每 +1 就重排一次(见下面 `sorted` 的依赖)。
   *  声明在这里而不是紧跟 `sorted`,是因为「票数落定后自动补排一次」也要用它。 */
  const [sortTick, setSortTick] = useState(0);
  // 票数是**异步**到的,而榜单在它到达之前就排过一次序了 —— 那一次把每部都判成 0 分(并列),
  // 稳定排序于是原样返回 `boardFilms(films)`,也就是**影片库目录序**。结果就是默认档写着
  // 「按贴纸总数从高到低」,首屏给的却是目录序(用户 2026-09-22:「好像既不是总数 也不是红数」)。
  // 所以票数一结算就**自动补排一次**(仅此一次),之后照旧冻结(2026-09-16 用户:「跳动很频繁」)。
  // ⚠ 用户已经动过手就**跳过**:在读到一半时整页重排等于把人顶走 —— 那种情况下
  //   「有新贴纸 · 重新排序」本来就亮着,交给他自己点。
  const resortedRef = useRef(false);
  const touchedRef = useRef(false);
  useEffect(() => {
    const touch = () => {
      touchedRef.current = true;
    };
    // capture:滚动可能发生在任意滚动容器里,不 capture 收不到
    window.addEventListener("scroll", touch, { capture: true, passive: true });
    window.addEventListener("pointerdown", touch, { passive: true });
    window.addEventListener("keydown", touch);
    return () => {
      window.removeEventListener("scroll", touch, { capture: true });
      window.removeEventListener("pointerdown", touch);
      window.removeEventListener("keydown", touch);
    };
  }, []);
  useEffect(() => {
    if (resortedRef.current || !votesSettled) return;
    resortedRef.current = true;
    if (touchedRef.current) return;
    setSortTick((count) => count + 1);
  }, [votesSettled]);
  // 我的贴纸一变就上报整份(服务端据此校正)。
  // ⚠ **只在用户动过手之后**才上报:载入时把空榜报上去,会把「服务端上属于我的那些票」误清掉 ——
  //   换设备 / 清过缓存时本地本来就是空的,而那不是「我撤票了」,只是「这台机器还没数据」。
  const actedRef = useRef(false);
  /** 本次手势**是不是一次拖**(而不是点)。
   *  ⚠ 浏览器在 `pointerup` 之后仍会补派发一次 `click`,所以「我贴的那一枚」上
   *    「单击=收回」与「拖动=挪位置」必须靠它区分,否则拖完顺手把贴纸收走了。
   *  ⚠ 它只回答「刚刚那一次指针手势是不是拖」,所以**只有指针来的 click 才该问它** ——
   *    键盘 / `element.click()` 不经过 `pointerdown`,问它等于让上一次拖拽把后来的一次收回吞掉
   *    (判据见 `takeBackByTap`)。 */
  const movedRef = useRef(false);
  /** **当前正在进行的拖拽手势**(同一时刻最多一个)。
   *  ⚠ 监听器是**同步**挂在 `window` 上的(`beginDrag` 里挂),所以旧实现那层「`useEffect`
   *    cleanup 会先摘掉上一套监听」的保护没有了,两种收尾都得自己管:
   *    ① 指针抬起 / 取消 —— 必须按 `pointerId` 过滤,否则两指的 `pointerup` 会各跑一遍
   *       自己的 `onUp`,**一次松手结算两次落点**;
   *    ② 组件卸载 —— 手势进行到一半就换页时,监听器会永久留在 `window` 上,
   *       而 `finishRef` 还指着已卸载那棵树的闭包(它仍会写 localStorage)。 */
  const gestureRef = useRef<{ pointerId: number; end: () => void } | null>(null);
  useEffect(() => () => gestureRef.current?.end(), []);
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
  // 快照存**票数内容**(签名)而不是 `votes` 的对象引用:
  // ⚠ 每次重拉票数都会得到新对象,数字一模一样也会被当成「有新贴纸」而白亮一次
  //   (用户 2026-09-22:只在**数量变化**时才需要提示重排)。
  const orderKey = useMemo(() => crowdSignature(crowd), [crowd]);
  const orderRef = useRef(orderKey);
  const sorted = useMemo(() => {
    orderRef.current = orderKey;
    return sortByCounts(candidates, crowd, mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 故意不依赖 crowd / orderKey,见上面的注释
  }, [candidates, mode, sortTick]);
  const orderStale = orderRef.current !== orderKey;
  // 「只看我贴过」**只在渲染时过滤**,不并进 `candidates`:
  // ⚠ 并进去会让 `sorted` 跟着 `board` 重算,而重算会顺手把 `orderRef` 刷成最新票数 ——
  //   「有新贴纸 · 重新排序」的提醒就永远亮不起来(顺序冻结机制见上面那段)。
  const visible = useMemo(
    () => (onlyMine ? sorted.filter((film) => (board.get(film.key)?.length ?? 0) > 0) : sorted),
    [sorted, onlyMine, board],
  );
  // 我自己那一份 —— 只用来控制「能不能贴 / 还能贴几枚」
  const tallies = useMemo(
    () => new Map(sorted.map((film) => [film.key, tallyOf(film.key, watched.has(film.key), board)])),
    [sorted, watched, board],
  );
  // 每一部的**全体票数**(服务端聚合)。⚠ 它**已经含我自己那一票**(上报成功后),
  //   所以不能再拿它跟本地贴纸相加 —— 会把我算两次。
  const filmCounts = useMemo(
    () =>
      new Map(sorted.map((film) => [film.key, crowd.get(film.key) ?? EMPTY_COUNTS] as const)),
    [sorted, crowd],
  );
  const totals = useMemo(() => {
    // 「我的」那份:只回答「标记了几部 / 贴了几枚 / 还能贴几枚」(hero 里那行小字)
    let marked = 0;
    let placed = 0;
    let quota = 0;
    for (const tally of tallies.values()) {
      if (tally.marked) marked++;
      placed += tally.total;
      quota += tally.quota;
    }
    // 「全站」那份:hero 的大字。`total` 还兼作「榜是不是空的」的判据。
    // ⚠ 评分**不是**看全站 —— 评分是**每部各自的**(见卡片里的 `filmScore`)。
    let red = 0;
    let black = 0;
    for (const counts of filmCounts.values()) {
      red += counts.red;
      black += counts.black;
    }
    return { marked, placed, quota, red, black, total: red + black };
  }, [tallies, filmCounts]);

  // 落点处理要按 key 反查影片(提示里要片名、贴纸要挂到它上面),先按当前榜单建索引
  const filmByKey = useMemo(
    () => new Map(sorted.map((film) => [film.key, film])),
    [sorted],
  );

  // ⚠ 下面几个回调**必须是稳定引用**(`useCallback([])` / 依赖同样稳定的东西),否则 `RbCard`
  //   的 `memo` 全废 —— 而 memo 正是「贴一枚只重渲染那一张」的前提,也是本轮修卡顿的关键
  //   (PLAN-20260922145815)。它们又要读**最新**状态(board / watched / tallies / filmByKey),
  //   而卡片与 window 监听拿到的只是创建那一刻的闭包 —— 所以统一从这个 ref 里取,每次渲染刷新一次。
  const latest = useRef({ board, watched, tallies, filmByKey });
  latest.current = { board, watched, tallies, filmByKey };

  const commitBoard = useCallback((next: StickerBoard) => {
    setBoard(next);
    // 用户动过手了 —— 从这里开始才允许把「我的票」上报给服务端(见上面 actedRef 的说明)。
    actedRef.current = true;
    saveStickers(next);
  }, []);

  // 刚贴下的那一枚(见 `RbCard` 里的动效说明)。⚠ 必须声明在 `place` **之前** ——
  // `place` 的依赖数组在渲染期求值,放到后面会撞上 TDZ。
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const freshTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const markFresh = useCallback((filmKey: string) => {
    setFreshKey(filmKey);
    clearTimeout(freshTimerRef.current);
    freshTimerRef.current = setTimeout(() => setFreshKey(null), FRESH_MS);
  }, []);
  useEffect(() => () => clearTimeout(freshTimerRef.current), []);

  /** 收回暂存区的**唯一实现** —— 「拖出画布」与「单击那枚贴纸」是同一个出口,
   *  文案与落库口径只此一处(§5 口径单一来源)。 */
  const takeBack = useCallback(
    (filmKey: string, stickerId: string) => {
      const { board, filmByKey } = latest.current;
      if (!board.get(filmKey)?.length) return;
      commitBoard(takeSticker(board, filmKey, stickerId));
      ToastQueue.neutral(`《${filmByKey.get(filmKey)?.zh ?? "这部"}》的贴纸收回暂存区了。`, {
        timeout: 3000,
      });
    },
    [commitBoard],
  );

  /** 卡片上那枚贴纸的**单击**入口。
   *  ⚠ 必须吃掉「拖完之后浏览器补的那一次 click」:否则拖一下微调位置会顺手把贴纸收走 ——
   *    `movedRef` 在 `pointermove` 越过阈值那一刻置位,下一次 `pointerdown` 才复位。
   *  ⚠ 但**只吞指针来的那一次**(`detail > 0`):键盘 `Enter` / 空格与 `element.click()`
   *    的 `event.detail` 恒为 0,它们不经过 `pointerdown`、也就谈不上「刚刚那次是拖」——
   *    拿 `movedRef` 一刀切的话,「拖一次 → 再按回车收回」会被静默吞掉(2026-09-23 review 发现)。 */
  const takeBackByTap = useCallback(
    (filmKey: string, stickerId: string, detail: number) => {
      if (detail > 0 && movedRef.current) return;
      takeBack(filmKey, stickerId);
    },
    [takeBack],
  );

  /** 标记 / 取消标记。
   *  ⚠ 取消时要把**这一部自己的贴纸全部收回**(用户口径):画布上的那枚与暂存区里的选择一起清掉 ——
   *    不这么做的后果是「没标记却贴着一张纸」,谁看都觉得是 bug。 */
  const toggleWatched = useCallback(
    (film: FilmNode) => {
      const { watched, board } = latest.current;
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
    },
    [commitBoard],
  );

  /** 贴一枚:点一下 → 落点随机;从暂存区拖进来 → 落在松手那一点 */
  const place = useCallback(
    (filmKey: string, type: StickerType, spot?: { posX: number; posY: number }) => {
      const { board, tallies, filmByKey } = latest.current;
      const name = filmByKey.get(filmKey)?.zh ?? "这部";
      const tally = tallies.get(filmKey);
      if (!tally?.marked) {
        ToastQueue.neutral(`先给《${name}》标一下「看过」，就能贴了。`, { timeout: 4000 });
        return;
      }
      if (!tally.canPlace) {
        ToastQueue.neutral(`《${name}》已经贴了一枚，点它一下（或拖到画布外）就能收回。`, {
          timeout: 4000,
        });
        return;
      }
      commitBoard(placeSticker(board, filmKey, makeSticker(type, spot)));
      markFresh(filmKey);
    },
    [commitBoard, markFresh],
  );

  // ⚠ 落点处理要用**最新**的 board,而 window 监听只在开始拖拽时挂一次 ——
  //   所以把处理函数放进 ref,每次渲染更新,监听器里读 ref.current。
  const finishRef = useRef<(drag: RbDrag, canvas: HTMLElement | null, x: number, y: number) => void>(
    () => {},
  );
  finishRef.current = (meta, canvas, x, y) => {
    const key = canvas?.dataset.rbCanvas ?? null;

    // ① 落点**不是这枚贴纸自己的张贴区** → 出界。
    //    ⚠ 「出界」从「不在任何画布上」扩到「不在**本片**画布上」(2026-09-23 用户:
    //      「贴纸张贴区应该是电影之间独立的」)—— 旧口径会把《A》的票**直接改记到《B》头上**
    //      (`moveSticker` 的跨片分支,已删)。所以别片的画布与页面空白是同一类:都算出去。
    if (key !== meta.srcKey || !canvas) {
      // 已经贴着的那一枚 → 出界就是收回(用户口径:「贴纸拖到外面就需要取消」),
      //   与「单击那枚贴纸」共用 `takeBack`(文案与落库口径只此一处)
      if (meta.fromId) takeBack(meta.srcKey, meta.fromId);
      else if (key) {
        // 从暂存区拖出来、却落在别片的画布上 → 什么都不做(它本来就在暂存区),但要讲清为什么
        const name = filmByKey.get(meta.srcKey)?.zh ?? "这部";
        ToastQueue.neutral(`这枚是《${name}》的贴纸，只能贴到《${name}》自己的张贴区里。`, {
          timeout: 3500,
        });
      }
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const posX = (x - rect.left) / rect.width;
    const posY = (y - rect.top) / rect.height;

    // ② 已经贴着的那一枚 → 在**本片画布内**挪位置
    if (meta.fromId) {
      commitBoard(moveSticker(board, meta.srcKey, meta.fromId, posX, posY));
      return;
    }

    // ③ 从暂存区拖进来 → 落在松手那一点
    place(meta.srcKey, meta.type, { posX, posY });
  };

  /** 开始一次拖拽。
   *  ⚠ 监听器在 pointerdown 里**同步挂上**(不再经 `drag` state + `useEffect`):后者要等这次
   *    `setDrag` 渲染提交、副作用跑完才生效,起手那几帧的 `pointermove` 会被丢掉 ——
   *    表现一是「拖起来慢半拍」,二是**松手时被判成一次「单击」,那枚贴纸被收回**(`takeBackByTap`)。
   *  ⚠ 顺带把 `drag` state 一起去掉了:它只被那个 effect 用、JSX 里根本没用,而那次 `setState`
   *    换来的只是「父组件跑一遍 + 300 次 `memo` 浅比较」—— 卡片**不会**重渲染(见 `RbCard` 的
   *    memo 说明;`placed` / `counts` / `marked` / `canPlace` / `fresh` 在拖拽起手时都没变),
   *    所以起手那一拍纯属白做。
   *  ⚠ `pointermove` 只记**最后一个点**,ghost 位移与落点命中测试合并到一帧一次(rAF):
   *    每个 `pointermove` 各做一次 `elementFromPoint` 在高刷鼠标 + 近 300 张卡上拖不动指针。
   *  ⚠ 这里**不 preventDefault**:暂存区那两枚贴纸既要能拖、也要能点(点一下随机贴),
   *    在 pointerdown 上拦掉默认行为会把 click 一起吃掉。
   *  ⚠ **同一时刻只允许一个手势**(`gestureRef`):两指各按住一张卡的贴纸时,两套监听都在
   *    `window` 上,而 `pointerup` 会发给**两套** `onUp` —— 一次松手结算两次落点
   *    (第二套用的是第一根手指的坐标)。第二个指针按下时直接忽略,与旧实现「任意时刻只有一套
   *    监听」等价;顺带在卸载时跑一次收尾(见 `gestureRef` 的说明)。 */
  const beginDrag = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      type: StickerType,
      srcKey: string,
      fromId: string | null,
    ) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      // 已经有手势在跑 → 第二个指针一律忽略。⚠ 必须**在复位 `movedRef` 之前**返回:
      // 那一位属于正在进行的那次手势,动它会让「拖完补发的那次 click」失去抑制。
      if (gestureRef.current) return;
      const pointerId = event.pointerId;
      // 本次手势还算不算「点」——只有 `pointermove` 越过阈值才会翻成 true,见 `takeBackByTap`
      movedRef.current = false;
      const startX = event.clientX;
      const startY = event.clientY;
      const slop = event.pointerType === "touch" ? DRAG_SLOP_TOUCH : DRAG_SLOP_MOUSE;
      const meta: RbDrag = { type, srcKey, fromId };

      // ghost 只在**真的开始移动**之后才创建:「点一下贴纸」是合法操作(随机贴),
      //   在 pointerdown 就造浮标会让每次点击都闪一下。
      let ghost: HTMLElement | null = null;
      // ⚠ 落点高亮**直接改 DOM 属性**而不走 state:榜单有近 300 张卡,
      //   每跨一张卡就 setState 会整页重渲染一次,贴纸立刻跟不上指针。
      let hoverCard: HTMLElement | null = null;
      let moved = false;
      let frame = 0;
      let lastX = startX;
      let lastY = startY;

      const setHover = (card: HTMLElement | null) => {
        if (card === hoverCard) return;
        hoverCard?.removeAttribute("data-rb-hover");
        card?.setAttribute("data-rb-hover", "");
        hoverCard = card;
      };
      /** 一帧只做一次:浮标跟上指针 + 重新判定落点 */
      const flush = () => {
        frame = 0;
        if (!ghost) return;
        ghost.style.transform = `translate3d(${lastX}px, ${lastY}px, 0) ${GHOST_TILT}`;
        // ⚠ 只有**本片**卡片能亮成落点:张贴区按片独立,给别片亮灯等于承诺一个不会兑现的落点
        const card = cardAt(lastX, lastY);
        setHover(card?.dataset.filmKey === srcKey ? card : null);
      };
      const onMove = (event: PointerEvent) => {
        // 只认发起这次手势的那根手指:另一指的移动不该驱动这个浮标 / 命中测试
        if (event.pointerId !== pointerId) return;
        // ⚠ **丢了 `pointerup` 的兜底**(起因见 `gestureRef` 的说明):鼠标在浏览器窗口外松手时,
        //   抬手那一刻可能根本没送到页面上,`end()` 就永远不会跑 —— `gestureRef` 一直占着,
        //   之后**每一次** `beginDrag` 都在第一行被挡掉,ghost 还粘在鼠标上跟着跑,只有换页才能恢复。
        //   旧实现(监听挂在 `useEffect([drag])` 上)没有这个问题:下一次 `pointerdown` 会顶掉旧监听,
        //   同步挂之后这层自愈没有了,只能自己判「按键已经松开却还在收 move」。
        //   ⚠ 这里**只收尾、不结算**:这个事件可能已经是鼠标**重新进入窗口**时的那一帧
        //   (窗口外期间浏览器不派发 move),拿它的坐标当「松手点」会把贴纸丢到一个用户没选过的位置,
        //   甚至判成出界而**静默收回** —— 保持原样是这里唯一不会误伤的选择。
        //   触屏不走这条:手指抬起后那个 pointer 就不存在了,不会再送 move 过来。
        if (event.pointerType !== "touch" && event.buttons === 0) {
          end();
          return;
        }
        if (!moved) {
          if (
            Math.abs(event.clientX - startX) <= slop &&
            Math.abs(event.clientY - startY) <= slop
          ) {
            return;
          }
          moved = true;
          // 越线即定案「这是一次拖」:后面的 click 会被 `takeBackByTap` 吃掉
          movedRef.current = true;
          event.preventDefault();
          ghost = document.createElement("span");
          ghost.className = `rb-ghost rb-ghost--${type}`;
          // ⚠ 就地摆正,**不能**等下面那一帧 rAF:新元素没有 transform 就挂在 (0,0),
          //   会先在视口左上角闪一帧。后面才开始按帧合并。
          ghost.style.transform = `translate3d(${event.clientX}px, ${event.clientY}px, 0) ${GHOST_TILT}`;
          document.body.appendChild(ghost);
        }
        lastX = event.clientX;
        lastY = event.clientY;
        if (!frame) frame = requestAnimationFrame(flush);
      };
      const onUp = (event: PointerEvent) => {
        // ⚠ 另一指的抬起 / 取消**不能**结束这次手势:否则会拿它的坐标结算一次落点
        //   (`gestureRef` 只让第一个指针进来,所以这里挡的就是那根后来的手指)。
        if (event.pointerId !== pointerId) return;
        end();
        // 没移动 = 一次单击(交给元素自己的 onClick),不要误当成一次拖动
        if (moved) {
          finishRef.current(meta, canvasAt(event.clientX, event.clientY), event.clientX, event.clientY);
        }
      };
      /** 收尾:摘监听、撤浮标与高亮、把手势单例让出来。
       *  **幂等** —— `onUp` 与卸载(见 `gestureRef` 的说明)都可能调它。 */
      const end = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        ghost?.remove();
        ghost = null;
        setHover(null);
        if (gestureRef.current?.pointerId === pointerId) gestureRef.current = null;
      };
      gestureRef.current = { pointerId, end };
      window.addEventListener("pointermove", onMove, { passive: false });
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [],
  );

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
          {/* 大字是**全站**的:榜本来就看大家贴了什么(改版前这三格全是我的) */}
          <span className="rb-global">
            <strong className="rb-global-num">{totals.total}</strong>
            <span className="rb-global-label">全站贴纸</span>
            <span className="rb-global-split">
              红 {totals.red} · 黑 {totals.black}
            </span>
          </span>
          {/* 我自己那份收成一行小字:它只回答「我还能不能贴」 */}
          <p className="rb-mine">
            我的：标记看过 {totals.marked} · 已贴 {totals.placed} · 还能贴 {totals.quota}
          </p>
        </div>
      </header>

      <div className="rb-controls">
        <QuerySearchField
          label="搜索影片或场次编号"
          placeholder="片名 / 场次 code，如 0412"
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
        {/* 筛选是**另一个视野**,不是排序的第四档 —— 所以留在排序组外面 */}
        <button
          type="button"
          className="rb-sort-btn"
          aria-pressed={onlyMine}
          onClick={() => update({ only: onlyMine ? null : "mine" }, true)}
        >
          只看我贴过
        </button>
        {/* 出图入口与筛选同排:它是「把这页拿出去给朋友看」,既不是排序也不是筛选 */}
        <button
          ref={shareBtnRef}
          type="button"
          className="rb-share-btn"
          onClick={() => setShareOpen(true)}
        >
          生成分享图
        </button>
      </div>

      {/* 空榜引导。⚠ 条件**只能**看全站票数(`totals.total`),**不能**掺「我标记了几片」
          (`totals.marked`):这条就挂在**栅格上方**,一收一放会把整页内容顶上去 53px ——
          用户点一下「标记看过」,看到的却是「整个页面闪了一下」(2026-09-23 报的)。
          而且它本来就是同一个口径的事:文案说的是「**榜**还是空的」,榜 = 全站票数;
          `marked` 是本地的「我看过」状态,与榜无关 —— 混进来是口径错误,不只是性能问题。 */}
      {totals.total === 0 && (
        <p className="rb-hint" role="status">
          榜还是空的。在卡片上点「标记看过」，再挑一枚红或黑贴上去 —— 这是你自己的榜。
        </p>
      )}

      {visible.length === 0 ? (
        <div className="empty-state">
          {/* 「只看我贴过」的空态与「搜不到」不是一回事:一个是我还没贴,一个是搜错了 */}
          <h2>{onlyMine ? "你还没有贴过贴纸" : "没有符合条件的影片"}</h2>
          <p>
            {onlyMine
              ? "取消「只看我贴过」，或先在卡片上标记「看过」再贴一枚。"
              : "试试其他片名，或换一个场次编号。"}
          </p>
        </div>
      ) : (
        <div className="rb-grid">
          {visible.map((film) => {
            const tally = tallies.get(film.key)!;
            return (
              <RbCard
                key={film.key}
                film={film}
                marked={tally.marked}
                canPlace={tally.canPlace}
                /* ⚠ 直接传 `board.get(...)` 的结果(可能 undefined),不要 `?? []` —— 那会每次造新数组,memo 失效 */
                placed={board.get(film.key)}
                counts={filmCounts.get(film.key)!}
                fresh={freshKey === film.key}
                onToggleWatched={toggleWatched}
                onPlace={place}
                onBeginDrag={beginDrag}
                onTakeBack={takeBackByTap}
              />
            );
          })}
        </div>
      )}

      {shareOpen && (
        <RedBlackShareDialog
          films={films}
          crowd={crowd}
          board={board}
          site={{ total: totals.total, red: totals.red, black: totals.black }}
          mine={{ marked: totals.marked, placed: totals.placed, quota: totals.quota }}
          onDismiss={() => setShareOpen(false)}
        />
      )}
    </section>
  );
}

/** 榜单里的**一张卡**。
 *
 *  ⚠ 这里 `memo` + 三个稳定回调是**性能的前提**(2026-09-22,PLAN-20260922145815):
 *    榜单有近 300 张卡,不 memo 的话「贴一枚贴纸」会让 299 张卡全部重算重渲染 ——
 *    那才是「贴一下卡一下」的主因,比「一张卡画了几枚贴纸」重要得多。
 *    所以传进来的必须是**稳定引用或值**:回调一律 `useCallback`,我贴的贴纸直接取
 *    `board.get(key)`(不要 `?? []`),没有票的影片共用 `EMPTY_COUNTS`。
 *
 *  ✅ **实测**(2026-09-23 用户问「只重新渲染单独那个电影可以吗」,299 张卡挂载):
 *    点「标记看过」→ 重渲染 **1 张**;点「贴一枚」→ 重渲染 **1 张**;2.4s 后「刚贴」描边撤掉
 *    那一拍 → 也只动**同一张**。口径:临时的 `data-rb-renders` 计数器 + `dispatchEvent("click")`
 *    —— ⚠ 用 `.click()` 量会凭空多出 6 张:它先把按钮滚进视口,那次滚动让预取边界上的卡触发
 *    `IntersectionObserver`,混进了计数(踩过)。 */
const RbCard = memo(function RbCard({
  film,
  marked,
  canPlace,
  placed,
  counts,
  fresh,
  onToggleWatched,
  onPlace,
  onBeginDrag,
  onTakeBack,
}: RbCardProps) {
  // 视口按需渲染:屏幕外的卡**一枚贴纸都不画**(见 `useInView` 与 PLAN-20260922145815)。
  // ⚠ 贴纸是绝对定位,稍后补画不触发兄弟节点回流 —— 所以「滚到才画」不会引起版面跳动。
  const cardRef = useRef<HTMLElement | null>(null);
  const inView = useInView(cardRef);
  // 「我贴的那一枚」的 DOM 引用 —— 它是**唯一**能做动效的贴纸:群点是 canvas 上画出来的像素,
  // 没有独立元素(何况「别人的贴纸」本来也不该有个体身份,2026-09-22 拉平口径)
  const freshRef = useRef<HTMLButtonElement | null>(null);
  const mine = countsOf(placed);
  // 「别人的贴纸」= 全体票数 − 我自己那几枚(口径在 `redblack.ts::othersOf`,分享图同用)
  const others = othersOf(counts, mine);
  // 这一部**自己的**评分(红票占比折算 0–10);还没有人贴过 → null(显示成「—」)
  const filmScore = scoreOf(counts);
  const myStickers = placed ?? EMPTY_STICKERS;
  // 「放大看全部」画的是**全部**(群点 + 我贴的那一枚),不是卡片上那份「别人的」——
  // 点进来看全部却少了自己那一枚,数字会跟卡片对不上。
  // ⚠ 相加不会重复计数:服务端那份在**上报落地后已含我**,此时 `others` 已经把我减掉;
  //   上报还没落地时 `others` 被夹到 0,加回来正好是我这一枚 —— 两个方向都对。
  const all: StickerCounts = {
    total: others.total + mine.total,
    red: others.red + mine.red,
    black: others.black + mine.black,
  };
  const [zoomOpen, setZoomOpen] = useState(false);
  const zoomBtnRef = useRef<HTMLButtonElement | null>(null);
  const zoomWasOpenRef = useRef(false);
  // 焦点归还(§5 硬约束):必须在弹层**真正卸载之后**再夺回焦点 ——
  // ⚠ S2 的 `DialogContainer` 自己也会 restoreFocus,而 WebKit 上点按钮**不会**让按钮获得焦点,
  //   于是它记下的「原焦点」是 body:在 `onDismiss` 里直接 `focus()` 会被它的 cleanup 覆盖掉
  //   (实测 iOS WebKit 上焦点落到 body,Chromium 上因为按钮本来就聚焦所以看不出问题)。
  //   放到 `useEffect`(跑在所有 layout effect 之后)才稳。
  useEffect(() => {
    if (zoomWasOpenRef.current && !zoomOpen) zoomBtnRef.current?.focus();
    zoomWasOpenRef.current = zoomOpen;
  }, [zoomOpen]);

  // 刚贴下的那一枚:**闪一下描边**告诉用户它落在哪。
  // 为什么需要它:点红 / 黑贴下去的那一枚会被丢进一片点里(压测里最多 160 枚),原来**没有任何线索**
  // 指出它在哪;而暂存区那两个按钮随即变淡,连「刚才那一下成功了」都看不出来。
  // ⚠ 照 `ScheduleGantt.tsx::flashScreenings` 的既有手法:只闪**描边**、不动 opacity / 尺寸 ——
  //   动 body 会让人读成「这枚贴纸自己在闪」而不是「它被放到了这里」;而且**有界**(3 次就停),
  //   不做 infinite(无限动画会一直占着合成层持续重绘,正好抵消本轮省下来的渲染)。
  useEffect(() => {
    const node = freshRef.current;
    if (!fresh || !node) return;
    // 动效敏感:只留 CSS 里那条静态描边,不做起伏
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // ⚠ WAAPI 关键帧**不收 `var()`**:`.rb-dot[data-rb-fresh]` 已经把 outline 解析成具体颜色,
    //   从这里读回来,亮 / 暗主题各取各的
    const ring = getComputedStyle(node).outlineColor;
    node.animate(
      [{ outlineColor: "transparent" }, { outlineColor: ring }, { outlineColor: "transparent" }],
      { duration: FRESH_BLINK_MS, iterations: FRESH_BLINKS },
    );
  }, [fresh]);

  return (
    <article
      ref={cardRef}
      className="rb-card"
      data-film-key={film.key}
      data-rb-marked={marked || undefined}
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
            aria-pressed={marked}
            aria-label={`${marked ? "取消标记" : "标记"}《${film.zh}》看过`}
            onClick={() => onToggleWatched(film)}
          >
            {marked ? "看过 ✓" : "标记看过"}
          </button>
          {counts.red > 0 && <span className="rb-chip rb-chip--red">红 {counts.red}</span>}
          {counts.black > 0 && <span className="rb-chip rb-chip--black">黑 {counts.black}</span>}
          {/* 一枚都没有时不出现:点开只会看到一块空画布 */}
          {all.total > 0 && (
            <button
              ref={zoomBtnRef}
              type="button"
              className="rb-zoom"
              aria-label={`放大查看《${film.zh}》的全部 ${all.total} 枚贴纸`}
              onClick={() => setZoomOpen(true)}
            >
              看全部
            </button>
          )}
        </p>
        {/* 暂存区(海报下方那两枚):点一下 → 随机贴到画布;拖到画布 → 落在松手那一点。
            ⚠ 这里**不写状态文案**(2026-09-16 用户:「太占空间」):
            按钮亮着就说明能贴、暗了就是贴过了 —— 靠形态表达,不靠解释。 */}
        <div className="rb-tray" aria-label={`《${film.zh}》的贴纸暂存区`}>
          <button
            type="button"
            className="rb-src rb-src--red"
            data-rb-spent={!canPlace || undefined}
            aria-label={`给《${film.zh}》贴红贴纸（点一下随机贴，也可以拖到右边画布上）`}
            onClick={() => onPlace(film.key, "red")}
            onPointerDown={(event) => onBeginDrag(event, "red", film.key, null)}
          >
            红
          </button>
          <button
            type="button"
            className="rb-src rb-src--black"
            data-rb-spent={!canPlace || undefined}
            aria-label={`给《${film.zh}》贴黑贴纸（点一下随机贴，也可以拖到右边画布上）`}
            onClick={() => onPlace(film.key, "black")}
            onPointerDown={(event) => onBeginDrag(event, "black", film.key, null)}
          >
            黑
          </button>
        </div>
      </div>

      <div
        className="rb-canvas"
        data-rb-canvas={film.key}
        /* 机读契约:E2E 靠这三个数断言「画布上画了什么」。
           ⚠ 属性缺席 = **一枚都没画**(屏幕外的卡不画);不要把它写成 0,那与「票数为 0」混了。 */
        data-rb-crowd={inView ? others.total : undefined}
        data-rb-crowd-red={inView ? others.red : undefined}
        data-rb-crowd-black={inView ? others.black : undefined}
      >
        {/* 别人的贴纸:整层交给 canvas(票数几枚就画几枚,不再有每卡上限)。
            只读、不挂 pointerdown —— 位置由 (影片 key, 序号) 确定性推导,
            用随机坐标的话每次重排这些点都会换地方,看着像在跳。 */}
        <StickerCanvas filmKey={film.key} counts={others} inView={inView} />
        {myStickers.map((sticker) => (
          // ⚠ 必须是 `<button>` 而不是 `<span role="img">`:它现在**可单击**(收回),把点击处理
          //   挂在非交互语义的元素上是 a11y 缺陷;顺带让键盘也能收回(Enter / Space 原生可用)
          <button
            key={sticker.id}
            ref={freshRef}
            type="button"
            className={`rb-dot rb-dot--${sticker.type}`}
            data-rb-fresh={fresh || undefined}
            style={
              {
                left: `${sticker.posX * 100}%`,
                top: `${sticker.posY * 100}%`,
                "--rb-tilt": `${tiltOf(sticker.id)}deg`,
              } as CSSProperties
            }
            aria-label={`${sticker.type === "red" ? "红" : "黑"}贴纸；单击收回暂存区，拖动可在《${film.zh}》自己的张贴区里挪位置，拖出这张画布也是收回`}
            onPointerDown={(event) => onBeginDrag(event, sticker.type, film.key, sticker.id)}
            onClick={(event) => onTakeBack(film.key, sticker.id, event.detail)}
          />
        ))}
        {myStickers.length === 0 && others.total === 0 && (
          <span className="rb-canvas-hint">
            {marked ? "点左边的红 / 黑，或把贴纸拖进来" : "标记「看过」后就能贴"}
          </span>
        )}
      </div>

      {zoomOpen && (
        // ⚠ `mine` 必须传:弹层里我那一枚是**独立的只读 DOM 元素**(与卡片同一组成,见该组件),
        //   不传的话它只会以「别人的点」的身份出现,既没有那圈白边、也不是它的真实位置。
        <StickerZoomDialog
          film={film}
          counts={all}
          mine={myStickers[0]}
          onDismiss={() => setZoomOpen(false)}
        />
      )}
    </article>
  );
});

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
