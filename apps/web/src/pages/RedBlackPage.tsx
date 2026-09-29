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
  lazy,
  memo,
  Suspense,
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
import { StickerCanvas } from "../components/StickerCanvas";
import type { FilmNode } from "../app/model";
import { searchFilm } from "../app/model";
import { useQuery } from "../app/hooks";
import { useCatalog } from "../app/store";
import {
  boardFilms,
  countsOf,
  countsSignature,
  crowdOf,
  crowdSignature,
  loadStickers,
  loadWatched,
  LS_REDBLACK,
  LS_REDBLACK_WATCHED,
  makeSticker,
  moveSticker,
  othersOf,
  placeSticker,
  purgeDemoLeavings,
  reconcile,
  retintSticker,
  saveStickers,
  saveWatched,
  scheduleSaveStickers,
  scoreOf,
  sortByCounts,
  takeSticker,
  tallyOf,
  tiltOf,
  votesOf,
  votesSignature,
  type CrowdCounts,
  type SortMode,
  type Sticker,
  type StickerBoard,
  type StickerCounts,
  type StickerType,
} from "../redblack";
import {
  adoptSyncedVotes,
  loadFilmVotes,
  onFilmVotesChange,
  onFilmVotesPingFailure,
  peekFilmVotes,
  peekSyncedVotes,
  scheduleFilmVotesPing,
  type FilmVoteCounts,
} from "../film-votes";
import { useInView } from "../use-in-view";
import "./redblack-parity.css";

/** 两个弹层**按需加载**(2026-09-28,PLAN-20260928003736)。
 *
 * 为什么:`RedBlackShareDialog` 一条链上带着 `redblack-poster.ts`(约 9KB gz)+ 自己(约 3KB gz),
 * 而进红黑榜的人多数不会点「生成分享图」—— 同步 import 等于让**每个人**先下载它再进页面;
 * 「放大看全部」同理(约 2.3KB gz)。两者都是**点了才挂**(见 JSX 里的 `shareOpen && …` / `zoomOpen && …`),
 * 所以懒加载只是把那次网络往返挪到点击那一刻;再点第二次时模块已在缓存里,零成本。
 * ⚠ 两个组件都是**具名导出**,而 `lazy` 要的是 `{ default }` —— 所以这里包一层,不动组件文件。
 * ⚠ **不给 loading 占位**:同源、体积小,加载是毫秒级;给个 spinner 反而闪一下更难读。 */
const RedBlackShareDialog = lazy(() =>
  import("../components/RedBlackShareDialog").then((m) => ({ default: m.RedBlackShareDialog })),
);
const StickerZoomDialog = lazy(() =>
  import("../components/StickerZoomDialog").then((m) => ({ default: m.StickerZoomDialog })),
);

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
  /** 源片那块画布 —— 落点判定与预览都靠它,**在 `pointerdown` 里取一次**。
   *  ⚠ 原来每帧都拿 `document.elementFromPoint` 做全页命中测试(近 300 张卡),
   *    而这里要回答的只有「是不是**源片自己**那块画布」—— 一个矩形比较就够
   *    (2026-09-28,PLAN-20260928102019 ①)。取不到时按「整场都算出界」处理。 */
  canvas: HTMLElement | null;
}

/** 方向键每次微调落点的比例(相对画布);按住 Shift 走大步(2026-09-28,PLAN-20260928102019 ⑫)。
 *  贴纸是 `<button>`:键盘能「收回」却一直挪不动位置 —— 这是没有指针时的唯一出口。 */
const NUDGE_STEP = 0.02;
const NUDGE_STEP_LARGE = 0.08;
/** 方向键 → 位移(单位是「步」)。不在表里的按键原样放行(不做任何事,也不吃默认行为) */
const NUDGE_KEYS: Record<string, { dx: number; dy: number }> = {
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
};

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
 *  于是「想点一下收回」会变成「挪了个位置」—— 所以触屏放宽到 10px。
 *  ⚠ 鼠标这一侧 2026-09-28 由 4px 放宽到 8px(PLAN-20260928120415):4px 比系统的双击容差还小,
 *    握着鼠标想「点一下收回」时那点自然位移会先被判成拖 —— 收回没发生、贴纸只挪了一丁点,
 *    用户读作「点了没反应」。
 *  ⚠ 再往上放宽要小心:`e2e/react/redblack.spec.ts` 的「跨片拖拽」用例,从起手到第一个落点的
 *    位移正是「贴纸位置 → 画布中心」,而贴纸是**随机落点**;它压在画布中心附近时,这段位移本身
 *    就只有几像素 —— 阈值一旦超过它,手势不算拖、卡片不亮,那条用例会开始抛硬币。改阈值请连它一起改。 */
const DRAG_SLOP_MOUSE = 8;
const DRAG_SLOP_TOUCH = 10;

interface RbCardProps {
  film: FilmNode;
  /** 是否标记过「看过」;`canPlace` = 标记过且这一部还没贴 */
  marked: boolean;
  canPlace: boolean;
  /** 我贴的那几枚。⚠ 直接传 `board.get(key)`,**不要** `?? []` —— 那会每次造个新数组,`memo` 失效 */
  placed: readonly Sticker[] | undefined;
  /** 这一部的**全站**票数,但已按本地视角修正 —— **恒含我自己那一枚**(口径见 `reconcile`)。
   *  ⚠ 不要直接传服务端那份原始 counts:那样在「我刚收回、服务端还没撤」的窗口里,
   *    卡片内的 `othersOf` 会把我那一票当成别人的票画出来(用户 2026-09-23 报的「仍残留」)。 */
  counts: StickerCounts;
  /** 这一部是不是「刚贴下那一枚」的持有者 —— 只有它**多一圈会起伏的亮描边**;
   *  ⚠ 与「常驻纸白边」是两回事:后者在 `.rb-dot` 上恒有,不靠这个 prop(见 CSS 里的说明) */
  fresh: boolean;
  /** 回调都必须是**稳定引用**(见 `RedBlackPage` 里 `latest` 那段注释) */
  onToggleWatched: (film: FilmNode) => void;
  /** 暂存区那两枚按钮的**单击**入口 → 「贴一枚」(落在随机位置)。
   *  ⚠ 它不是 `place` 本身:得先吃掉「在按钮上拖了一小段又被补发的那次 click」,见 `placeByTap`。
   *  `detail` 同样直接透传 `MouseEvent.detail`(键盘 / `element.click()` 恒为 0)。 */
  onPlaceByTap: (filmKey: string, type: StickerType, detail: number) => void;
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
  /** 方向键微调「我贴的那一枚」的落点(比例增量,见 `NUDGE_KEYS`) */
  onNudge: (filmKey: string, sticker: Sticker, dx: number, dy: number) => void;
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
  /** 「我的票」的内容签名 —— **与坐标无关**(见 `redblack.ts::votesSignature`)。
   *  拖动微调位置会换掉 `board` 的引用,而票一枚都没变。拿它当依赖,下游就不会为「挪了个位置」
   *  白干活:① 上报 effect 不再被拖动触发(原来拖一下 = 一次全量 POST + 成功后一次重拉);
   *  ② 「我的票」/ 修正票数 / 配额头寸也不再重算一遍(2026-09-28,PLAN-20260928102019 ②③)。 */
  const votesKey = useMemo(() => votesSignature(board), [board]);
  // 多标签页同步(2026-09-28,PLAN-20260928102019 ⑨):board / watched 存在 localStorage 里,
  // 而页面载入后只认内存中那一份 —— 另一个标签页贴的贴纸这边一直看不到,得刷新才发现。
  // ⚠ **不碰 `actedRef`**:别的标签页的票不是「我在这个标签页动过手」,顺手去上报等于把
  //   「这边看到的票」当成用户的新意图推上去。只重读,不上报。
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== null && event.key !== LS_REDBLACK && event.key !== LS_REDBLACK_WATCHED) {
        return;
      }
      setBoard(loadStickers());
      setWatched(loadWatched());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  // 上报失败**说一次**(2026-09-28,PLAN-20260928102019 ⑩):过去是彻底静默 —— 断网 / 被限流时
  // 用户以为榜上记了。⚠ 只在「连续失败的第 1 次」弹;成功(streak 归 0)后复位,下次再失败才再说。
  const pingFailedRef = useRef(false);
  useEffect(
    () =>
      onFilmVotesPingFailure((streak) => {
        if (streak === 0) {
          pingFailedRef.current = false;
          return;
        }
        if (pingFailedRef.current) return;
        pingFailedRef.current = true;
        ToastQueue.negative("贴纸没能同步到榜上，请检查网络后重试。", { timeout: 5000 });
      }),
    [],
  );
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
  // 拉一次 → 我贴 / 收之后 1200ms 防抖上报 → 上报成功后再拉一次。
  // ⚠ 数字**不再**等这一秒(2026-09-23):页面拿 `reconcile` 把「我这一票」当场算进去 / 减出来,
  //   所以贴一枚立刻 +1、收回立刻 −1;那一秒只是把本地视角换成服务端确认过的真值,画面不跳。
  const [votes, setVotes] = useState<FilmVoteCounts>(() => peekFilmVotes());
  // 「服务端那份 counts 里属于我的那部分」(见 `film-votes.ts::synced`)。卡片 / hero / 分享图
  // 扣减它来得到「以本地视角修正过的全站票数」(`redblack.ts::reconcile`)。
  //
  // ⚠ 基准必须在**首帧**就正确,所以在惰性初值里认领(幂等,严格模式双调用无副作用):
  //   ① 同一台设备早先贴的那些票,服务端那份 counts **本来就含它们**(历史上报已落地)——
  //      不认领的话首屏会把我自己贴的几枚当成「别人的票」在画布上多画一遍;
  //   ② 模块里的 `synced` 还会留着**上一次进入本页**的快照,拿它渲染会在换页往返时闪一下。
  // ⚠ 与「载入时本地为空」(换设备 / 清过缓存,不是「我撤票了」)并不矛盾:那份快照此时也是空的,
  //   服务端若真含我,我也只是**没在本地认领**它 —— 与改前行为逐字一致。
  const [syncedVotes, setSyncedVotes] = useState<FilmVoteCounts>(() => {
    adoptSyncedVotes(votesOf(boot.board));
    return peekSyncedVotes();
  });
  // 票数**结算**了没有(成功、失败、空表都算结算)—— 首屏那次排序发生在它之前,见下面的补排
  const [votesSettled, setVotesSettled] = useState(false);
  useEffect(() => {
    void loadFilmVotes().then((next) => {
      setVotes(next);
      setSyncedVotes(peekSyncedVotes());
      setVotesSettled(true);
    });
    return onFilmVotesChange(() => {
      setVotes(peekFilmVotes());
      setSyncedVotes(peekSyncedVotes());
    });
  }, []);
  const crowd: CrowdCounts = useMemo(() => crowdOf(votes), [votes]);
  /** 服务端已确认含我的那份票,与 `crowd` 同形状(每片恒 1 枚) */
  const syncedCrowd: CrowdCounts = useMemo(() => crowdOf(syncedVotes), [syncedVotes]);
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
    // ⚠ 依赖是**票签名**而不是 `board`:拖动只挪坐标、票一枚没变,不该触发一次全量上报
    //   (原来拖一下就发一次 POST + 成功后一次重拉,见 PLAN-20260928102019 ②)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 故意不依赖 board,见上一行
  }, [votesKey]);

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
    // ⚠ 依赖票签名而不是 `board`:过滤只看「有没有票」,拖动位置不该让它重算
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 同上
    [sorted, onlyMine, votesKey],
  );
  // 我自己那一份 —— 只用来控制「能不能贴 / 还能贴几枚」
  const tallies = useMemo(
    () => new Map(sorted.map((film) => [film.key, tallyOf(film.key, watched.has(film.key), board)])),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `tallyOf` 只读票(条数与颜色),与坐标无关
    [sorted, watched, votesKey],
  );
  // 「以本地视角修正过的全站票数」——卡片 / hero / 分享图共用这一份(`redblack.ts::reconcile`)。
  // ⚠ 换基准的理由就是那条用户反馈(「收回贴纸之后 贴纸仍残留」):服务端要等防抖上报 + 重拉
  //   才不含我这一票,那段时间里「全站 − 我的」会把撤下的那一票错认成别人的票。
  // ⚠ 覆盖 `crowd ∪ board` 的**全部** key,而不是只有榜单上那几部:搜索过滤后 `sorted` 会变小,
  //   而分享图拿的是**整份**影片库的数字(它自己再筛)——只算 `sorted` 会让没命中搜索的片在图上变 0 票。
  // ⚠ 值没变就**沿用旧对象**:`RbCard` 是 `memo` 的,每次重算都造新对象会让近 300 张卡白渲染一遍
  //   (PLAN-20260922145815 的性能前提;与 `EMPTY_COUNTS` 同一个手法)。
  const filmCountCache = useRef(new Map<string, StickerCounts>());
  const reconciledCrowd: CrowdCounts = useMemo(() => {
    const cache = filmCountCache.current;
    const next = new Map<string, StickerCounts>();
    for (const key of new Set([...crowd.keys(), ...board.keys()])) {
      const value = reconcile(
        crowd.get(key) ?? EMPTY_COUNTS,
        syncedCrowd.get(key) ?? EMPTY_COUNTS,
        countsOf(board.get(key)),
      );
      const prev = cache.get(key);
      next.set(key, prev && countsSignature(prev) === countsSignature(value) ? prev : value);
    }
    filmCountCache.current = next;
    return next;
    // ⚠ 依赖票签名而不是 `board`:上面只读票(`board.keys()` 与 `countsOf`)——
    //   拖动位置会让 `board` 换引用,但这一份修正票数一个数字都不变
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 同上
  }, [crowd, syncedCrowd, votesKey]);
  /** 卡片要的那几部 —— 只从上面那份里取(口径单一来源,不在这里再算一遍) */
  const filmCounts = useMemo(
    () =>
      new Map(
        sorted.map((film) => [film.key, reconciledCrowd.get(film.key) ?? EMPTY_COUNTS] as const),
      ),
    [sorted, reconciledCrowd],
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

  /** 上一步**可撤销**的动作(见 `undoLast`):存的是「撤销后该回到的那份 board」。
   *  ⚠ 只留最近一条 —— 撤销是「手滑了」的补丁,不是编辑历史:允许退回到一个早已被后续操作
   *    覆盖的状态只会让人看不懂(2026-09-28,PLAN-20260928102019 ⑦)。 */
  const undoRef = useRef<StickerBoard | null>(null);

  const commitBoard = useCallback((next: StickerBoard, deferred = false) => {
    // 新的动作让上一步的「撤销」失效(调用方若想要撤销,在**这之后**再把目标塞回 `undoRef`)
    undoRef.current = null;
    setBoard(next);
    // 用户动过手了 —— 从这里开始才允许把「我的票」上报给服务端(见上面 actedRef 的说明)。
    actedRef.current = true;
    // ⚠ 只有**拖动**那条路走延后写盘(见 `redblack.ts::scheduleSaveStickers` 的说明):
    //   贴 / 收 / 换色是语义操作,崩溃时丢不起
    if (deferred) scheduleSaveStickers(next);
    else saveStickers(next);
  }, []);

  /** 撤销上一步(Toast 上的「撤销」按钮 → 这儿)。
   *  ⚠ 恢复的是**当时那一份 board**(含那一枚原 id / 颜色 / 坐标),不是「重新贴一枚」——
   *    重贴会换随机落点,那不叫撤销。 */
  const undoLast = useCallback(() => {
    const target = undoRef.current;
    if (!target) return;
    undoRef.current = null;
    commitBoard(target);
  }, [commitBoard]);

  // 刚贴下的那一枚(见 `RbCard` 里的动效说明)。⚠ 必须声明在 `place` **之前** ——
  // `place` 的依赖数组在渲染期求值,放到后面会撞上 TDZ。
  // ⚠ 是 **Set** 而不是单个 key(2026-09-28):连着给两部贴时,原来后一部会把前一部的高亮顶掉。
  const [freshKeys, setFreshKeys] = useState<ReadonlySet<string>>(() => new Set());
  const freshTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const markFresh = useCallback((filmKey: string) => {
    setFreshKeys((prev) => new Set(prev).add(filmKey));
    // ⚠ 计时器**共享**:每贴一枚就重置一次,于是先后贴的几枚几乎同时灭掉 —— 这比「每枚各带
    //   一个计时器」简单,而描边本来就只回答「刚才那一下落在哪」。
    clearTimeout(freshTimerRef.current);
    freshTimerRef.current = setTimeout(() => setFreshKeys(new Set()), FRESH_MS);
  }, []);
  useEffect(() => () => clearTimeout(freshTimerRef.current), []);

  /** 收回暂存区的**唯一实现** —— 「拖出画布」与「单击那枚贴纸」是同一个出口,
   *  文案与落库口径只此一处(§5 口径单一来源)。 */
  const takeBack = useCallback(
    (filmKey: string, stickerId: string) => {
      const { board, filmByKey } = latest.current;
      const list = board.get(filmKey);
      if (!list?.some((sticker) => sticker.id === stickerId)) return;
      const name = filmByKey.get(filmKey)?.zh ?? "这部";
      commitBoard(takeSticker(board, filmKey, stickerId));
      // 收回是**丢信息**的动作(那一枚连位置一起没了),而误触它的代价很高(要重贴、位置也会变),
      // 所以给它一个撤销出口(2026-09-28,PLAN-20260928102019 ⑦)。
      // ⚠ 必须在 `commitBoard` **之后**设 —— 它会把上一步的撤销目标清掉
      undoRef.current = board;
      // ⚠ 不写 `timeout`:带「撤销」的提示走 `toast.ts` 自己的收口定时器,时长只在那一处定义
      //   (S2 在 action 场景会**忽略**调用方的 timeout,写了也是误导;PLAN-20260928120415)。
      ToastQueue.neutral(`《${name}》的贴纸收回暂存区了。`, {
        actionLabel: "撤销",
        onAction: undoLast,
      });
    },
    [commitBoard, undoLast],
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

  /** 方向键微调落点(2026-09-28,PLAN-20260928102019 ⑫):贴纸是 `<button>`(键盘能收回),
   *  但一直**挪不了位置** —— 没有指针时,方向键是唯一的出口。
   *  ⚠ 走延后写盘:与指针拖动同一条路(都是装饰性写入,见 `redblack.ts::scheduleSaveStickers`)。 */
  const nudge = useCallback(
    (filmKey: string, sticker: Sticker, dx: number, dy: number) => {
      const { board } = latest.current;
      commitBoard(
        moveSticker(board, filmKey, sticker.id, sticker.posX + dx, sticker.posY + dy),
        true,
      );
    },
    [commitBoard],
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
      // ⚠ 这一支已经是**防御性**的(2026-09-29,PLAN-20260929172651 §4):未标记时红 / 黑按钮是
      //   真 `disabled`,指针与拖动两条入口都到不了这里。留着它是因为 `place` 是**纯逻辑出口**,
      //   将来多一条调用路径(快捷键 / 键盘直达)时不该静默什么都不做。
      if (!tally?.marked) {
        ToastQueue.neutral(`先给《${name}》标一下「看过」，就能贴了。`, { timeout: 4000 });
        return;
      }
      // ⚠ 已经贴过这一部:点**另一色** = **原地换色**(保留位置与 id),点**同色**才是「什么也没发生」。
      //   这是 2026-09-28 新增的出口 —— 过去贴错颜色只能「先单击收回、再从暂存区重贴」,
      //   而重贴会换一个随机落点,等于顺手把位置也丢了(PLAN-20260928102019 ⑧)。
      if (!tally.canPlace) {
        const existing = board.get(filmKey)?.[0];
        if (existing && existing.type !== type) {
          commitBoard(retintSticker(board, filmKey, existing.id, type));
          // 换色同样是「改掉已有信息」,给它撤销(撤销 = 换回原来那一色)
          undoRef.current = board;
          markFresh(filmKey);
          // ⚠ 同 `takeBack`:带「撤销」的提示不写 `timeout`,时长只在 `toast.ts` 一处定义
          ToastQueue.neutral(`《${name}》的贴纸换成${type === "red" ? "红" : "黑"}色了。`, {
            actionLabel: "撤销",
            onAction: undoLast,
          });
          return;
        }
        ToastQueue.neutral(`《${name}》已经贴了一枚，点它一下（或拖到画布外）就能收回。`, {
          timeout: 4000,
        });
        return;
      }
      commitBoard(placeSticker(board, filmKey, makeSticker(type, spot)));
      markFresh(filmKey);
    },
    [commitBoard, markFresh, undoLast],
  );

  /** 暂存区那两枚按钮的**单击**入口(与 `takeBackByTap` 对称,但出口是「贴一枚」而不是「收回」)。
   *  它要保证的是:**在按钮上拖了一小段、松手仍在按钮里**的那次手势不会被读成「贴一枚」——
   *  那次拖动本身什么也不做(出界、且没落在任何画布上),用户以为自己只是拖了一下。
   *  ⚠ 实测口径(2026-09-28,PLAN-20260928120415):当前 `beginDrag::onMove` 在越线那一刻的
   *    `preventDefault()` **已经**能把后面那次补发的 `click` 压掉 —— 在桌面 Chromium / 移动
   *    Chromium / 移动 WebKit 上,摘掉这道守卫用例仍然绿。所以这里是**不依赖那行副作用的保险**:
   *    ① 跨引擎(补发 click 是浏览器各自实现);
   *    ② 将来若有人删掉那行 `preventDefault`,行为靠这里守住而不是靠运气。
   *  ⚠ 同 `takeBackByTap`,只吞**指针来的**那一次(`detail > 0`):键盘 `Enter` / 空格与
   *    `element.click()` 的 `detail` 恒为 0、不走 `pointerdown`,否则「拖一次 → 再按回车贴」会被吞。 */
  const placeByTap = useCallback(
    (filmKey: string, type: StickerType, detail: number) => {
      if (detail > 0 && movedRef.current) return;
      place(filmKey, type);
    },
    [place],
  );

  // ⚠ 落点处理要用**最新**的 board,而 window 监听只在开始拖拽时挂一次 ——
  //   所以把处理函数放进 ref,每次渲染更新,监听器里读 ref.current。
  const finishRef = useRef<(drag: RbDrag, x: number, y: number) => void>(() => {});
  finishRef.current = (meta, x, y) => {
    // 落点算不算本片张贴区 —— 与拖拽中的高亮 /「会被收回」提示 / 落点预览**同一个判据**
    // (`spotInsideSrc` + 源片画布的 rect,见 PLAN-20260928102019 ①)
    const rect = meta.canvas?.getBoundingClientRect() ?? null;

    // ① 出界。⚠ 旧口径是「不落在**任何**画布上」才算出去 —— 那会把《A》的票
    //    **直接改记到《B》头上**(`moveSticker` 的跨片分支,已删);现在别片的画布与页面空白同一类。
    if (!spotInsideSrc(rect, x, y)) {
      // 已经贴着的那一枚 → 出界就是收回(用户口径:「贴纸拖到外面就需要取消」),
      //   与「单击那枚贴纸」共用 `takeBack`(文案与落库口径只此一处)
      if (meta.fromId) takeBack(meta.srcKey, meta.fromId);
      else if (canvasAt(x, y)) {
        // 从暂存区拖出来、却落在别片的画布上 → 什么都不做(它本来就在暂存区),但要讲清为什么。
        // ⚠ 这里查一次 `elementFromPoint` **只为分辨「别片的画布」与「页面空白」**:前者要解释,
        //   后者不用 —— 这是全链路上唯一还需要它的地方(只在松手时走一次)。
        const name = filmByKey.get(meta.srcKey)?.zh ?? "这部";
        ToastQueue.neutral(`这枚是《${name}》的贴纸，只能贴到《${name}》自己的张贴区里。`, {
          timeout: 3500,
        });
      }
      return;
    }

    // ⚠ 到这儿 `rect` 必然有效 —— `spotInsideSrc` 对空 rect 恒返回 false
    if (!rect) return;
    const posX = (x - rect.left) / rect.width;
    const posY = (y - rect.top) / rect.height;

    // ② 已经贴着的那一枚 → 在**本片画布内**挪位置
    // ⚠ 拖动走**延后写盘**(deferred):位置只是装饰,崩溃丢掉它的代价是「下次再拖一遍」
    if (meta.fromId) {
      commitBoard(moveSticker(board, meta.srcKey, meta.fromId, posX, posY), true);
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
      // 源片那张卡、它的暂存区、以及它那块画布 —— 出界提示要把「它要回到哪儿」点亮(见 `setOut`),
      // 落点判定与预览都用画布。
      // ⚠ 都在 pointerdown 里**就地**取:`currentTarget` 出了处理函数就可能被 React 回收,
      //   而之后整场拖拽都只用这几个引用,不每帧再查一次 DOM。
      const srcCard = event.currentTarget.closest<HTMLElement>("[data-film-key]");
      const srcTray = srcCard?.querySelector<HTMLElement>(".rb-tray") ?? null;
      /** 源片那块画布 —— 落点判定与预览的唯一依据(见 `RbDrag::canvas`) */
      const srcCanvas = srcCard?.querySelector<HTMLElement>("[data-rb-canvas]") ?? null;
      const meta: RbDrag = { type, srcKey, fromId, canvas: srcCanvas };

      // ghost 只在**真的开始移动**之后才创建:「点一下贴纸」是合法操作(随机贴),
      //   在 pointerdown 就造浮标会让每次点击都闪一下。
      let ghost: HTMLElement | null = null;
      /** 浮标下面那枚短标签(出界时才说话,见 `setOut`) */
      let hint: HTMLElement | null = null;
      /** 落点预览:画在**真实落点**上的半透明轮廓 —— 与跟着指针的浮标是两回事,
       *  ghost 正好压在指针底下,看不清这枚贴下去会与已有群点差多远(2026-09-28,⑪)。 */
      let preview: HTMLElement | null = null;
      // ⚠ 落点高亮**直接改 DOM 属性**而不走 state:榜单有近 300 张卡,
      //   每跨一张卡就 setState 会整页重渲染一次,贴纸立刻跟不上指针。
      let hoverCard: HTMLElement | null = null;
      /** 当前算不算「出界」(松手会被收回 / 取消) */
      let out = false;
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
      /** 出界(松手会收回 / 取消)的**三处提示**,只在状态**变**的时候写 DOM ——
       *  它每帧被 `flush` 调一次,而页面上有近 300 张卡,白写属性也是开销。
       *  ① 浮标换装(`rb-ghost--out`:半透明 + **去饱和**,读作「这枚现在不是活的」);
       *  ② 浮标下面那枚短标签,说清**松开会发生什么**;
       *  ③ 把**真的会回去的地方**(本片暂存区)点亮。
       *  ⚠ ③ 只走「已经贴着的那一枚」这条路:`fromId === null`(从暂存区拖出来的那枚)松手是
       *    「什么也不做」,给它的暂存区亮灯会读成「它会回到这儿」—— 可它本来就在那儿。 */
      const setOut = (next: boolean) => {
        if (next === out) return;
        out = next;
        ghost?.classList.toggle("rb-ghost--out", next);
        if (hint) hint.textContent = next ? (fromId ? "松开 · 收回暂存区" : "松开 · 取消") : "";
        if (fromId) {
          if (next) srcTray?.setAttribute("data-rb-target", "");
          else srcTray?.removeAttribute("data-rb-target");
        }
      };
      /** 落点预览跟着指针走(只在**算落点**时显形)。
       *  ⚠ 位置口径与落库那两行(`finishRef`)逐字一致 —— 画布内的相对比例 × 画布尺寸,
       *    否则「预览看着在画布中间、松手却偏了」就是必然。
       *  ⚠ 写的是 **`transform` 而不是 `left` / `top`**:后者是布局属性,每帧写等于每帧把这张卡
       *    拖进一次 layout 重算 —— 正好抵消掉「不再每帧做全页命中测试」省下来的那点开销。 */
      const setPreview = (
        spot: { x: number; y: number; width: number; height: number } | null,
      ) => {
        if (!preview) return;
        if (!spot) {
          if (preview.style.display !== "none") preview.style.display = "none";
          return;
        }
        const ratio = (value: number) => Math.min(1, Math.max(0, value));
        preview.style.transform = `translate3d(${ratio(spot.x) * spot.width}px, ${ratio(spot.y) * spot.height}px, 0)`;
        if (preview.style.display === "none") preview.style.display = "";
      };
      /** 一帧只做一次:浮标跟上指针 + 重新判定落点 + 同步预览 */
      const flush = () => {
        frame = 0;
        if (!ghost) return;
        ghost.style.transform = `translate3d(${lastX}px, ${lastY}px, 0) ${GHOST_TILT}`;
        // ⚠ 高亮 / 出界提示 / 预览共用**同一个**判据(`spotInsideSrc` + 源片画布的 rect):
        //   亮起的就是真能放下的地方,反过来灭灯 = 松手会收回。张贴区按片独立,
        //   给别片亮灯等于承诺一个不会兑现的落点(见 PLAN-20260923101147)。
        // ⚠ 这里只量**源片那一块**画布 —— 原来每帧一次 `elementFromPoint` 全页命中测试
        //   在近 300 张卡的页面上是拖不动指针的主因之一(2026-09-28,PLAN-20260928102019 ①)。
        const rect = srcCanvas?.getBoundingClientRect() ?? null;
        const own = spotInsideSrc(rect, lastX, lastY);
        setHover(own ? srcCard : null);
        setOut(!own);
        setPreview(
          own && rect
            ? {
                x: (lastX - rect.left) / rect.width,
                y: (lastY - rect.top) / rect.height,
                width: rect.width,
                height: rect.height,
              }
            : null,
        );
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
          // 出界那枚短标签**挂在浮标内部**:位移自动跟着浮标的 transform 走(不用每帧同步
          // 第二个元素),随浮标一起 `remove()`(不留残件),而浮标本身 `pointer-events: none`,
          // 所以它也不会挡住落点命中测试。
          hint = document.createElement("span");
          hint.className = "rb-drag-hint";
          ghost.appendChild(hint);
          // ⚠ 就地摆正,**不能**等下面那一帧 rAF:新元素没有 transform 就挂在 (0,0),
          //   会先在视口左上角闪一帧。后面才开始按帧合并。
          ghost.style.transform = `translate3d(${event.clientX}px, ${event.clientY}px, 0) ${GHOST_TILT}`;
          document.body.appendChild(ghost);
          // 落点预览与浮标**同拍**创建(它的位置由 `flush` 每帧同步)。
          // ⚠ 它挂在**源片画布内**:位置就是最终落点的相对比例,且天然被画布的
          //   `overflow: hidden` 裁掉,不会漫到隔壁卡
          preview = document.createElement("span");
          preview.className = `rb-preview rb-preview--${type}`;
          // ⚠ 先藏起来:它此刻还在 (0,0),直接可见会在画布左上角闪一帧
          //   (ghost 那条走的是「就地摆正 transform」,这里藏一帧更省事、也少一次写)
          preview.style.display = "none";
          srcCanvas?.appendChild(preview);
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
        if (moved) finishRef.current(meta, event.clientX, event.clientY);
      };
      /** 收尾:摘监听、撤浮标与高亮、把手势单例让出来。
       *  **幂等** —— `onUp` 与卸载(见 `gestureRef` 的说明)都可能调它。 */
      const end = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        // ⚠ 先复位提示、再扔浮标:暂存区那盏灯 `data-rb-target` 挂在**卡片**上,
        //   浮标一 `remove()` 就没人管它了 —— 漏掉这一句会在卡片上留一盏永远亮着的灯
        //   (卸载路径也走这里,所以顺手覆盖了「拖到一半换页」)。
        setOut(false);
        ghost?.remove();
        ghost = null;
        hint = null;
        // ⚠ 预览挂在**画布**里(不是 body):漏掉这一句会在卡片上留一枚永远不动的轮廓
        preview?.remove();
        preview = null;
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
            一部电影一枚贴纸：标记「看过」，再点红或黑。
            {/* 完整规则收进 `?`(2026-09-29,PLAN-20260929172651 §1):正文只留一句话,把版面让出来。
                ⚠ 展开走**纯 CSS** 的 `:hover` + `:focus-within`,不引 JS 状态 —— `:focus-within` 让触屏
                也「点一下 `?`」就能看,键盘 Tab 进来同样展开;`aria-describedby` 让读屏也拿得到全文
                (所以 CSS 里**不能**用 `visibility: hidden` / `display: none`,那会把内容从无障碍树里摘掉)。 */}
            <span className="rb-rule">
              <button type="button" className="rb-rule-btn" aria-describedby="rb-rule-full">
                ?
              </button>
              <span className="rb-rule-pop" id="rb-rule-full">
                在卡片上点「标记看过」解锁它，再挑一枚红或黑贴上去；贴纸落在右边那块空地上，可以拖动微调位置，
                单击它、或拖出那块空地都是收回。一部片只有一枚，红黑是同一个名额的两种取舍。大家的票一起排榜。
              </span>
            </span>
          </p>
        </div>
        <div className="rb-totals" aria-live="polite">
          {/* 全站那份:榜本来就看大家贴了什么 —— 给它一个**卡片**(用户 2026-09-29:「建议通过卡片化或
              微缩标签(Badge)样式将其整理,区分『全局数据』与『个人数据』」),不再只靠字号与 opacity 区分。
              大字仍是**全站总票数**(改版前这三格全是我的)。 */}
          <div className="rb-stat-card">
            <span className="rb-stat-head">全站</span>
            {/* ⚠ `.rb-global` 这一层保留:它承载 `redblack-poster.ts` 之外唯一的「全站数字」口径,
                样式改版不该顺手改结构(颜色 / 字号仍由既有的 `.rb-global-*` 管) */}
            <span className="rb-global">
              <strong className="rb-global-num">{totals.total}</strong>
              <span className="rb-global-label">枚贴纸</span>
            </span>
            <span className="rb-global-split">
              红 {totals.red} · 黑 {totals.black}
            </span>
          </div>
          {/* 我自己那份:Badge 组 —— 它只回答「我还能不能贴」,不是榜单主角 */}
          <div className="rb-badges">
            <span className="rb-badge">
              标记看过 <strong>{totals.marked}</strong>
            </span>
            <span className="rb-badge">
              已贴 <strong>{totals.placed}</strong>
            </span>
            {/* ⚠ `data-rb-empty` = **存在即真**(只有配额见底时才写):`CSS` 靠它决定要不要把
                这枚 Badge 顶出来,值本身不参与判断 */}
            <span
              className="rb-badge rb-badge--quota"
              data-rb-empty={totals.quota === 0 || undefined}
            >
              还能贴 <strong>{totals.quota}</strong>
            </span>
          </div>
        </div>
      </header>

      <div className="rb-controls">
        {/* ⚠ 文案按用户 2026-09-29 的建议收短(`label` 是同一句话的长版本,留给读屏) */}
        <QuerySearchField label="搜索影片或场次编号" placeholder="搜索影片 / 场次编号" />
        {/* 排序:三档互斥 → **一个**分段控件(Segmented Control),不再是三个各自带边框的胶囊。
            ⚠ `role=group` + `aria-pressed` 一个都不能少:分段控件只是视觉形态,语义上它仍是
              「一组互斥选项」(用户 2026-09-29:「筛选切换(总数、红榜、黑榜)保持统一的分段控件样式」)。 */}
        <div className="rb-seg" role="group" aria-label="榜单排序">
          {SORTS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="rb-seg-btn"
              aria-pressed={mode === value}
              onClick={() => update({ sort: value === "total" ? null : value }, true)}
            >
              {label}
            </button>
          ))}
        </div>
        {/* 筛选是**另一个视野**,不是排序的第四档 —— 所以留在排序组外面 */}
        <button
          type="button"
          className="rb-filter"
          aria-pressed={onlyMine}
          onClick={() => update({ only: onlyMine ? null : "mine" }, true)}
        >
          只看我贴过
        </button>
        {/* 「重新排序」:顺序被冻住之后,重排要由用户主动触发(贴纸变化不自动重排,见页面注释)。
            ⚠ 类名与 `data-rb-stale` **不许动**:E2E 按 `.rb-resort` + 该属性断言(spec:1034 / 1065 / 1248)。
              它从「虚线胶囊」降成**弱按钮**(纯文字 + hover 才有底色):它是维护性动作,不该与筛选同权。 */}
        <button
          type="button"
          className="rb-resort"
          data-rb-stale={orderStale || undefined}
          aria-label="按当前的贴纸数量重新排序"
          onClick={() => setSortTick((count) => count + 1)}
        >
          {orderStale ? "有新贴纸 · 重新排序" : "重新排序"}
        </button>
        {/* 出图是这一排里唯一的主操作 —— 给品牌色实底。
            ⚠ 改版前它用 `--selected` / `--selected-line`(= #388452 绿),用户读成「绿色胶囊」,
              而绿色与红黑榜的红黑语义毫无关系(2026-09-29,PLAN-20260929172651 §2)。 */}
        <button
          ref={shareBtnRef}
          type="button"
          className="rb-share-btn"
          onClick={() => setShareOpen(true)}
        >
          生成分享图
        </button>
        {/* 说明文字**独占一行**(CSS 里靠 `flex-basis: 100%` 换行):
            原来它贴在「重新排序」右侧,两者视觉上连成一个组,被读成「一个奇怪的胶囊按钮」——
            而它根本不是按钮(用户 2026-09-29)。 */}
        <p className="rb-sort-hint">
          {mode === "total" ? "按贴纸总数" : mode === "red" ? "按红贴纸数" : "按黑贴纸数"}
          从高到低；贴纸变化不会打乱当前顺序
        </p>
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
                fresh={freshKeys.has(film.key)}
                onToggleWatched={toggleWatched}
                onPlaceByTap={placeByTap}
                onBeginDrag={beginDrag}
                onTakeBack={takeBackByTap}
                onNudge={nudge}
              />
            );
          })}
        </div>
      )}

      {shareOpen && (
        // ⚠ `Suspense` 写在条件**内部**:`shareOpen` 为假时连它都不挂,不多包一层没有内容的边界
        <Suspense fallback={null}>
          <RedBlackShareDialog
            films={films}
            /* ⚠ 传**修正过**的那份(与卡片 / hero 同源):否则「我贴了一枚还没上报」时,
               图上会把别人的票少画一枚,与卡片当场对不上。
               ⚠ 给它的是 `reconciledCrowd`(全量)而不是 `filmCounts`(只有当前榜单那几部)——
               搜索过滤后 `sorted` 会变小,而分享图要画的是**整份**影片库 */
            crowd={reconciledCrowd}
            board={board}
            site={{ total: totals.total, red: totals.red, black: totals.black }}
            mine={{ marked: totals.marked, placed: totals.placed, quota: totals.quota }}
            onDismiss={() => setShareOpen(false)}
          />
        </Suspense>
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
  onPlaceByTap,
  onBeginDrag,
  onTakeBack,
  onNudge,
}: RbCardProps) {
  // 视口按需渲染:屏幕外的卡**一枚贴纸都不画**(见 `useInView` 与 PLAN-20260922145815)。
  // ⚠ 贴纸是绝对定位,稍后补画不触发兄弟节点回流 —— 所以「滚到才画」不会引起版面跳动。
  const cardRef = useRef<HTMLElement | null>(null);
  const inView = useInView(cardRef);
  // 「我贴的那一枚」的 DOM 引用 —— 它是**唯一**能做动效的贴纸:群点是 canvas 上画出来的像素,
  // 没有独立元素(何况「别人的贴纸」本来也不该有个体身份,2026-09-22 拉平口径)
  const freshRef = useRef<HTMLButtonElement | null>(null);
  const mine = countsOf(placed);
  // 「别人的贴纸」= 修正过的全站票数 − 我自己那几枚(口径在 `redblack.ts::othersOf`,分享图同用)。
  // ⚠ 传进来的 `counts` 已由页面 `reconcile`(扣掉「服务端已确认含我」的那份、加回我当前的票),
  //   所以这里减掉 `mine` 得到的正是「服务端 counts − 服务端那份里的我」—— 撤票那一拍就少一枚。
  const others = othersOf(counts, mine);
  // 这一部**自己的**评分(红票占比折算 0–10);还没有人贴过 → null(显示成「—」)
  const filmScore = scoreOf(counts);
  const myStickers = placed ?? EMPTY_STICKERS;
  // 暂存区里哪一枚算「已用掉」(2026-09-28,PLAN-20260928102019 ⑧):淡掉的只有**当前已贴的那一色**,
  // 另一色**保持正常** —— 点它就是原地换色,那是一个真能用的动作,不该被读成「不能点」。
  const placedType = myStickers[0]?.type;
  const redSpent = !canPlace && placedType === "red";
  const blackSpent = !canPlace && placedType === "black";
  // 「放大看全部」画的是**全部**(群点 + 我贴的那一枚),不是卡片上那份「别人的」——
  // 点进来看全部却少了自己那一枚,数字会跟卡片对不上。
  // ⚠ 相加不会重复计数:页面给的 `counts` 已按本地视角修正(`reconcile`)**恒含我这一枚**,
  //   而 `others` 就是它减掉 `mine` —— 加回来正好是那份全站数,上报前后都不多不少。
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
          /* `decoding="async"`:解码挪到后台线程。榜单一次有上百张海报,同步解码会在主线程上
             一顿一顿地抢滚动 —— 这个属性只影响解码时机,不改变任何布局或优先级 */
          <img className="rb-poster" src={film.poster} loading="lazy" decoding="async" alt="" />
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
          {/* 一枚都没有时不出现:点开只会看到一块空画布。
              ⚠ 文案带上枚数:原来只写「看全部」,用户 2026-09-29 反馈「建议明确其功能
              (是『查看全部贴纸分布』还是『查看该影片完整详情』)」—— 它开的是**贴纸分布**弹层,
              写上枚数就不再歧义。动的是可见文案;`aria-label` 早就写全了,E2E 也按它定位。 */}
          {all.total > 0 && (
            <button
              ref={zoomBtnRef}
              type="button"
              className="rb-zoom"
              aria-label={`放大查看《${film.zh}》的全部 ${all.total} 枚贴纸`}
              onClick={() => setZoomOpen(true)}
            >
              看全部 {all.total} 枚
            </button>
          )}
        </p>
        {/* 暂存区(海报下方那两枚):点一下 → 随机贴到画布;拖到画布 → 落在松手那一点。
            ⚠ 这里**不写状态文案**(2026-09-16 用户:「太占空间」):
            按钮亮着就说明能贴、暗了就是贴过了 —— 靠形态表达,不靠解释。 */}
        {/* ⚠ 未标记「看过」时是**真 `disabled`**(2026-09-29,PLAN-20260929172651 §4,用户要求):
            过去只有 CSS 置灰、按钮**仍能点**,点了才弹「先标记看过」—— 用户要的是
            「查看 → 标记看过 → 选红黑」这条**单向流**,不要一个「看着能点、点了被拒」的假出口。
            ⚠ 这**只推翻** 2026-09-28 决策(PLAN-20260928102019 ⑫)里「未标记也留点击出口」那一半:
            「**已贴之后**点另一色 = 原地换色」与它的撤销出口**原样保留**(见 `place` 的 `canPlace` 分支),
            那才是那条决策真正要保的东西 —— 所以判据是 `!marked`,**不是** `spent`。
            ⚠ 真 `disabled` 会一并掐掉 `onPointerDown`:未标记时本来也不该能拖。
            ⚠ 提示改挂**暂存区容器**的 `title`:`disabled` 的按钮在浏览器里不弹 `title`,
              挂容器才能让 hover 那一片仍然说得出「为什么点不动」。 */}
        <div
          className="rb-tray"
          aria-label={`《${film.zh}》的贴纸暂存区`}
          title={marked ? undefined : "先点「标记看过」，就能贴了"}
        >
          <button
            type="button"
            className="rb-src rb-src--red"
            data-rb-spent={redSpent || undefined}
            aria-disabled={redSpent || undefined}
            disabled={!marked}
            title={placedType === "black" ? "点一下把贴纸换成红色（位置不变）" : undefined}
            aria-label={`给《${film.zh}》贴红贴纸（点一下随机贴，也可以拖到右边画布上）`}
            onClick={(event) => onPlaceByTap(film.key, "red", event.detail)}
            onPointerDown={(event) => onBeginDrag(event, "red", film.key, null)}
          >
            红
          </button>
          <button
            type="button"
            className="rb-src rb-src--black"
            data-rb-spent={blackSpent || undefined}
            aria-disabled={blackSpent || undefined}
            disabled={!marked}
            title={placedType === "red" ? "点一下把贴纸换成黑色（位置不变）" : undefined}
            aria-label={`给《${film.zh}》贴黑贴纸（点一下随机贴，也可以拖到右边画布上）`}
            onClick={(event) => onPlaceByTap(film.key, "black", event.detail)}
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
            aria-label={`${sticker.type === "red" ? "红" : "黑"}贴纸；单击收回暂存区，拖动或按方向键可在《${film.zh}》自己的张贴区里挪位置，拖出这张画布也是收回`}
            onPointerDown={(event) => onBeginDrag(event, sticker.type, film.key, sticker.id)}
            onClick={(event) => onTakeBack(film.key, sticker.id, event.detail)}
            onKeyDown={(event) => {
              const delta = NUDGE_KEYS[event.key];
              if (!delta) return;
              // ⚠ 必须吃掉默认行为:方向键在这张页面上是「滚动」
              event.preventDefault();
              const step = event.shiftKey ? NUDGE_STEP_LARGE : NUDGE_STEP;
              onNudge(film.key, sticker, delta.dx * step, delta.dy * step);
            }}
          />
        ))}
        {/* 没有票时的引导。⚠ **未标记**那一档默认不显形(2026-09-29,PLAN-20260929172651 §3):
            用户反馈「未标记看过的卡片右侧空白区域**重复出现了大量灰色的**『标记「看过」后就能贴』字样,
            显得画面略为繁复」—— 现在它只在卡片 hover / `:focus-within` 时淡入(触屏 `hover: none` 下常显),
            由 CSS 的 `.rb-canvas-hint` 管,JS 这边一个字都不用改。
            ⚠ 节点**仍然渲染**,不要顺手加条件:除了「已标记」那档本来就有用之外,
              E2E 也按 `toHaveCount` 数它(`spec:595` 数的正是「未标记但空」这一档)。
            文案顺势收短。 */}
        {myStickers.length === 0 && others.total === 0 && (
          <span className="rb-canvas-hint">
            {marked ? "点左边的红 / 黑，或把贴纸拖进来" : "标记「看过」即可贴"}
          </span>
        )}
      </div>

      {zoomOpen && (
        // ⚠ `mine` 必须传:弹层里我那一枚是**独立的只读 DOM 元素**(与卡片同一组成,见该组件),
        //   不传的话它只会以「别人的点」的身份出现,既没有那圈白边、也不是它的真实位置。
        <Suspense fallback={null}>
          <StickerZoomDialog
            film={film}
            counts={all}
            mine={myStickers[0]}
            onDismiss={() => setZoomOpen(false)}
          />
        </Suspense>
      )}
    </article>
  );
});

/** 指针落点所在的**画布** —— 只用来**分辨「别片的画布」与「页面空白」**(见 `finishRef` 的出界分支)。
 *  ⚠ 它**不再是**落点判据(那是 `spotInsideSrc`):每帧做一次全页命中测试,在近 300 张卡的页面上
 *    太贵,而判据要回答的问题本来只需要**源片那一块**画布(2026-09-28,PLAN-20260928102019 ①)。
 *  ⚠ ghost 是 `pointer-events: none`,不会挡住命中测试。 */
function canvasAt(x: number, y: number): HTMLElement | null {
  const hit = document.elementFromPoint(x, y);
  return hit instanceof HTMLElement ? hit.closest<HTMLElement>("[data-rb-canvas]") : null;
}

/** 落点**在不在**这一部的张贴区里 —— 唯一的落点判据(2026-09-28 起改用矩形比较)。
 *
 *  ⚠ 它替代了原来的 `ownCanvasAt(...)`(那个是 `elementFromPoint` + `closest` 的全页命中测试):
 *    要回答的只有「是不是**源片自己**那块画布」,一个矩形比较就够 —— 而它在 `beginDrag::flush`
 *    里是**每帧**调一次,那才是这笔开销的关键。
 *  ⚠ **四处**共用它:拖拽中的高亮 /「会被收回」提示 / 落点预览 / 松手结算,所以「可张贴区」
 *    与「会被收回」的边界不会两处各写一份、各说各话(2026-09-23 之前正是两处:高亮按**卡片**判、
 *    结算按**画布**判 —— 拖到卡片左侧信息列时卡片亮着灯,松手却是收回)。
 *  ⚠ 别片的画布与页面空白是同一类:都算出界(张贴区按片独立,见 `PLAN-20260923101147`)。 */
function spotInsideSrc(rect: DOMRect | null, x: number, y: number): boolean {
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
