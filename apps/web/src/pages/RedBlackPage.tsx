// 电影红黑榜(2026-09-16,PLAN-20260916102339)
//
// ⚠ 2026-10-14(PLAN-20261014190000):**投票入口换成了「快速投票」滑动卡片**。
//   · 控制栏上的「快速投票」→ 一张一张划:左滑 = 黑、右滑 = 红、上滑 = **跳过**(不写任何状态);
//   · 候选来自**我的行程**(`quick-vote.ts::quickVoteOrder`),行程为空时用热门榜 TOP50 兜底;
//     **划过一遍的片(投过 / 跳过过)不再进队列**(2026-10-14 修订 5,「跳过」那本本地账在
//     `biff.redblack.skipped.v1`)—— 改票的入口因此挪到**榜单上那一枚**;
//   · 贴纸的**落点与皮肤都在投票那一刻随机**(`redblack.ts::voteSticker`)—— 用户不再拖、也不再挑款。
//   随之删掉的正是原来那一整套「贴纸操作」:标记看过、暂存区、拖拽微调、双击收回、方向键微调、换肤轮盘。
//
//   本页保留的是**看结果**那一半:榜单栅格、卡片上的画布与群点、评分角标、hero 总览、分享图、讨论区。
//
// 卡片布局(未变):**左**边是海报与影片信息,**右**边一大片留白就是贴纸画布;
//   · 一部片**只有一枚**(2026-09-16 用户:「标记看过只能选一个贴纸」)—— 红 / 黑 / 没看过 是同一个
//     名额的三种取舍,不是可以并存的三样东西;
//   · 刚贴下的那一枚仍会**闪一下描边**(票多时否则根本找不着),闪完仍留一圈**常驻纸白边**
//     (见 `redblack-parity.css` 的 `.rb-dot`);
//   · ⚠ 但「我贴的那一枚」现在是**只读**的:它仍然单独画、仍然有上面那两圈描边,
//     却不再挂指针、不接键盘、也没有任何浮层 —— 「取消贴贴纸所有行为」就落在这里。

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
} from "react";
import { ToastQueue } from "../components/spectrum";
import { QuerySearchField } from "../components/QuerySearchField";
import { QuickVoteDeck } from "../components/QuickVoteDeck";
import { StickerCanvas } from "../components/StickerCanvas";
import { StickerFace } from "../components/StickerFace";

import type { FilmNode } from "../app/model";
import { useQuery } from "../app/hooks";
import { useCatalog, useStore } from "../app/store";
import {
  boardFilms,
  countsOf,
  countsSignature,
  crowdOf,
  crowdSignature,
  loadSkipped,
  loadStickers,
  LS_REDBLACK,
  othersOf,
  othersSkins,
  priorOf,
  purgeDemoLeavings,
  reconcile,
  retintSticker,
  saveSkipped,
  saveStickers,
  scoreOf,
  searchBoardFilm,
  setFilmVote,
  setStickerComment,
  skinsSignature,
  sortByVotes,
  takeSticker,
  tiltOf,
  voteInputsOf,
  votesSignature,
  type CrowdCounts,
  type SkinCrowdCounts,
  type SortMode,
  type Sticker,
  type StickerBoard,
  type StickerCounts,
  type StickerType,
  type SyncedStickerFace,
} from "../redblack";
import {
  adoptSyncedVotes,
  loadFilmVotes,
  onFilmVotesChange,
  onFilmVotesPingFailure,
  peekFilmSkins,
  peekFilmVotes,
  peekSyncedFaces,
  peekSyncedVotes,
  resumePendingFilmVotes,
  scheduleFilmVotesPing,
  type FilmSkinCounts,
  type FilmVoteCounts,
} from "../film-votes";
// 快速投票的候选兜底：我的行程为空时改用热门榜（同一份 `buildHotRows`，见 `deckQueue`）
import { buildHotRows } from "../hot-board";
import { loadWantCounts, onWantCountsChange, peekWantCounts } from "../want-counts";
import { quickVoteOrder } from "../quick-vote";
import { store } from "../state";
import { resolveSkin } from "../sticker-skin";
import { useInView } from "../use-in-view";
import "./redblack-parity.css";

/** 两个弹层**按需加载**(2026-09-28,PLAN-20260928003736)。
 *
 * 为什么:`RedBlackShareDialog` 一条链上带着 `redblack-poster.ts`(约 9KB gz)+ 自己(约 3KB gz),
 * 而进红黑榜的人多数不会点「生成分享图」—— 同步 import 等于让**每个人**先下载它再进页面;
 * 讨论区同理。两者都是**点了才挂**(见 JSX 里的 `shareOpen && …` / `talkOpen && …`),
 * 所以懒加载只是把那次网络往返挪到点击那一刻;再点第二次时模块已在缓存里,零成本。
 * ⚠ 两个组件都是**具名导出**,而 `lazy` 要的是 `{ default }` —— 所以这里包一层,不动组件文件。
 * ⚠ **不给 loading 占位**:同源、体积小,加载是毫秒级;给个 spinner 反而闪一下更难读。 */
const RedBlackShareDialog = lazy(() =>
  import("../components/RedBlackShareDialog").then((m) => ({ default: m.RedBlackShareDialog })),
);
const LazyFilmCommentsDialog = lazy(() =>
  import("../components/FilmCommentsDialog").then((m) => ({ default: m.FilmCommentsDialog })),
);
/** 讨论区**总览**弹层（2026-10-07，PLAN-20261007231522）—— 与上面两个同一套懒加载理由。 */
const LazyDiscussionBoardDialog = lazy(() =>
  import("../components/DiscussionBoardDialog").then((m) => ({ default: m.DiscussionBoardDialog })),
);

/** 榜单档位（2026-10-12 起**只留两榜**，PLAN-20261011235624）。
 *  ⚠ 「总数」已撤：两榜都按**评分**排（红榜从高到低 / 黑榜从低到高），而评分口径下
 *    `red/total` 与 `black/total` 互为倒数 —— 再留一个按票数排的第三档，只会与红榜逐字重复。 */
const SORTS: Array<[SortMode, string]> = [
  ["red", "红榜"],
  ["black", "黑榜"],
];

/** 「兜底候选还没准备好」时给 `QuickVoteDeck` 的那一份**空队列**。
 *
 *  ⚠ 必须是**模块级常量**、不能写成 `[]` 字面量：那个 prop 是 `QuickVoteDeck` 重置这一轮的
 *    依赖（`useEffect(..., [queue])`），每次渲染换一个新数组 = 每次渲染都把卡片重开一遍。
 *  ⚠ 与 `EMPTY_COUNTS` / `EMPTY_STICKERS` 同一个手法（本文件下方还有几个同类的空值常量）。 */
const EMPTY_DECK: readonly FilmNode[] = [];

/** 没有票的影片共用这一个常量:
 *  ⚠ 必须共用(`?? { total: 0, red: 0, black: 0 }` 会每次造新对象)—— 卡片是 `memo` 的,
 *    prop 引用一变就白重渲染一次,299 张卡一起白渲染正是本轮要修的那个卡顿(PLAN-20260922145815)。 */
const EMPTY_COUNTS: StickerCounts = { total: 0, red: 0, black: 0 };
const EMPTY_STICKERS: readonly Sticker[] = [];

/** 讨论区总览里点一行 → 定位到那张卡时，描边闪多久 / 闪几次(ms)。
 *  ⚠ 与 `ScheduleGantt.tsx::flashScreenings` **同拍**(1000 × 3)：两处表达的是同一件事
 *    「这一格 / 这张卡被定位到了」，时长不一致会读成两种不同的反馈。 */
const LOCATE_BLINK_MS = 1000;
const LOCATE_BLINKS = 3;

/** 正在闪的那些卡 —— 连点同一行时先取消上一次，避免两条动画叠在一起把描边闪成常亮。 */
const locateAnimations = new WeakMap<HTMLElement, Animation>();

/** 给一张卡**闪一次描边**，告诉用户「跳到这里了」。
 *
 *  ⚠ 只闪 `outline`，绝不动 opacity / 尺寸 —— 动 body 会被读成「这张卡自己在闪」，
 *    而不是「它被定位到了」（`PLAN-20260917095517` 在排片表格子上记过同一条代价）。
 *  ⚠ 颜色取**计算后的** `outline-color`：WAAPI 关键帧不收 `var()`，而 `.rb-card-located`
 *    已经把 outline 解析成具体颜色 —— 亮 / 暗主题各取各的，这里再写一份品牌色就会写死。
 *  ⚠ 动效敏感时留一圈**静态**描边（而不是整段跳过）：定位结果本身是信息，不该被省掉。 */
function flashCard(node: HTMLElement): void {
  locateAnimations.get(node)?.cancel();
  node.classList.add("rb-card-located");
  const ring = getComputedStyle(node).outlineColor;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const animation = node.animate(
    reduced
      ? [{ outlineColor: ring }, { outlineColor: ring }]
      : [{ outlineColor: "transparent" }, { outlineColor: ring }, { outlineColor: "transparent" }],
    { duration: LOCATE_BLINK_MS, iterations: LOCATE_BLINKS },
  );
  locateAnimations.set(node, animation);
  void animation.finished.then(() => node.classList.remove("rb-card-located"), () => {});
}

/** 「刚贴的那一枚」高亮多久(ms)。
 *  ⚠ 三个数必须**同拍**:`FRESH_MS` = `FRESH_BLINK_MS × FRESH_BLINKS`,否则会出现
 *    「闪完了描边还亮着」或「还在闪就被撤掉」的半截状态(`redblack-parity.css` 的
 *    `.rb-dot[data-rb-fresh]` 提供常驻描边,WAAPI 只负责让它明暗起伏)。
 *  取 2400ms:约等于「上报防抖 1200ms + 一次重拉 + 一拍」—— 用户贴完抬手,动效刚好收尾。 */
const FRESH_MS = 2400;
const FRESH_BLINK_MS = 800;
const FRESH_BLINKS = 3;

/** 落地动效时长(ms)。
 *  ⚠ 380ms 取的是「拟物/实体感」那一档(300–500ms)—— 比常规微交互(150–250ms)长,
 *    因为这里要读的是**重量**:从 120px 高处落下来再回弹,太快就没有「戳下去」的手感。
 *  ⚠ 只动 `.rb-dot__face`(**不**动外层那枚 `<button>`)—— 见落地 effect 里的说明。 */
const LAND_MS = 380;
/** 落地时额外的随机自转(±度):模仿「捏着贴纸随手按下去」,而不是机械对齐。
 *  ⚠ 它只是**动效的起点**,落定后那一枚的歪斜仍是 `tiltOf(id)` 推出来的确定值 ——
 *    随机数不进任何持久化状态,刷新后贴纸不会「换个角度」。 */
const LAND_SPIN = 12;

/* ⚠ 2026-10-14(PLAN-20261014190000):`PRESS_MS` / `WHEEL_GRACE_MS`(换款轮盘)、
 *   `DRAG_SLOP_MOUSE` / `DRAG_SLOP_TOUCH`(拖拽阈值)、`MARK_NUDGE_MS`(点未解锁贴纸时的脉冲)
 *   随「贴纸操作」一起删掉了。它们的 E2E 判据也一并撤掉 —— 手势那条路现在只剩快速投票里的
 *   三个方向,阈值口径在 `quick-vote.ts::SWIPE_RATIO` 一处。 */

interface RbCardProps {
  film: FilmNode;
  /** 我贴的那一枚（**只读展示**）。⚠ 直接传 `board.get(key)`,**不要** `?? []` ——
   *  那会每次造个新数组,`memo` 失效 */
  placed: readonly Sticker[] | undefined;
  /** 这一部的**全站**票数,但已按本地视角修正 —— **恒含我自己那一枚**(口径见 `reconcile`)。
   *  ⚠ 不要直接传服务端那份原始 counts:那样在「我刚收回、服务端还没撤」的窗口里,
   *    卡片内的 `othersOf` 会把我那一票当成别人的票画出来(用户 2026-09-23 报的「仍残留」)。 */
  counts: StickerCounts;
  /** 评分先验（全站红占比）—— 海报右上角那个加权分要用它（`redblack.ts::scoreOf`）。
   *  ⚠ 与页面 / 分享图**共用页面那一个数**：各算一份会让同一屏里的两处评分对不上。 */
  priorRate: number;
  /** 这一部**按款**的票数（服务端聚合，2026-09-29）。稀疏：没有款数据的片是 `undefined`。
   *  ⚠ 与 `counts` 不同，它**原样来自服务端**（**含我自己那一枚** —— 服务端不知道谁是「我」），
   *    所以用之前必须在卡片内 `othersSkins` 扣掉；页面那层不替它做 `reconcile`。
   *  ⚠ 扣减基准是 `syncedFace`（**服务端已确认**的我那一枚），**不是** `placed` —— 见它的说明。 */
  skins?: SkinCrowdCounts;
  /** **服务端已确认**的我那一枚（色 + 款）—— `othersSkins` 从 `skins` 里扣的基准（2026-10-05）。
   *  ⚠ 不能用 `placed`（本地当前那枚）：换款到上报落地之间本地已经是新款、而服务端聚合里还是
   *    旧款，拿本地款去扣会从**别人的**桶里扣掉一枚（用户 2026-10-05 报的「把别人的皮肤也换了」）。 */
  syncedFace?: SyncedStickerFace;
  /** 这一部是不是「刚贴下那一枚」的持有者 —— 只有它**多一圈会起伏的亮描边**;
   *  ⚠ 与「常驻纸白边」是两回事:后者在 `.rb-dot` 上恒有,不靠这个 prop(见 CSS 里的说明) */
  fresh: boolean;
  /** 保存这一部的评语（讨论区弹层里那个表单）。空串 = 清掉。
   *  ⚠ 必须是**稳定引用**（`memo` 的前提）——它是 `useCallback([commitBoard])`,满足。
   *  ⚠ 这是卡片上**唯一**还能改数据的入口：那一枚贴纸本身已经只读了（2026-10-14）。 */
  onSaveComment: (filmKey: string, comment: string) => void;
}

/** 「榜单」页外壳（`pages/BoardPage.tsx`）传进来的开关（2026-10-14，`PLAN-20261014150805`）。
 *  档位（红 / 黑）由**外壳的 tab**决定，页面自己的分段控件就下岗 ——
 *  否则同一屏里会出现两个「红榜 / 黑榜」入口，而它们其实是同一件事。 */
interface RedBlackPageProps {
  hideSortBar?: boolean;
}

export function RedBlackPage({ hideSortBar = false }: RedBlackPageProps) {
  // ⚠ `filmByKey` 用**目录那份全量映射**（别名避让下面那份「当前榜单」的局部同名映射）——
  //   讨论区总览列的是全站评语，片名反查不能跟着页面的搜索词一起缩水。
  const { films, filmByKey: allFilmByKey } = useCatalog();
  // ⚠ `films` **不依赖选片**（见 `app/store.tsx` 里那条注释），所以「行程变了」这件事只能从
  //   这一份修订号上读到 —— 快速投票的候选队列正依赖它。
  const storeRevision = useStore();
  const { params, update } = useQuery();
  const query = params.get("q") ?? "";
  // ⚠ 老的 `?sort=total`（总数榜已撤）与任何非法值都落回**红榜** —— 不报错、不给空页（2026-10-12）
  const mode: SortMode = params.get("sort") === "black" ? "black" : "red";
  // 「只看我贴过」——**独立参数**(与 `sort` 正交:排序是给全站排名次,筛选是换一个视野)。
  // 塞进 `sort` 会与「顺序冻结 / 重新排序」那套机制纠缠,得不偿失。
  const onlyMine = params.get("only") === "mine";

  // 榜单**从空榜开始**:贴纸只来自用户自己(用户 2026-09-16:「正式环境不应该是空的让用户自己贴的吗」)。
  // ⚠ 早先版本会在这里自动铺一份示例,那段逻辑已删;`purgeDemoLeavings` 负责把**已经铺出去**
  //   的那份数据收干净 —— 老用户本机存着示例,光删代码他们还是会一直顶着一堆没贴过的贴纸。
  const [boot] = useState(() => purgeDemoLeavings());
  const [board, setBoard] = useState<StickerBoard>(boot.board);
  /** 「我的票」的内容签名 —— **与坐标无关**(见 `redblack.ts::votesSignature`)。
   *  它是上报 effect 的依赖：签名没变就不发。
   *  ⚠ 2026-10-14 修订:上滑不再写任何状态,所以签名里也只有红黑票（只有一个参数）。 */
  const votesKey = useMemo(() => votesSignature(board), [board]);
  /** 首帧「认领」用的那一份（见下面 `syncedVotes` 惰性初值那段）。
   *  ⚠ 两个 `useState` 都要用它，所以**算一次**：各算一遍虽然等价，但那是同一个东西写两遍。 */
  const bootVotes = useMemo(() => voteInputsOf(boot.board), [boot]);
  // 多标签页同步(2026-09-28,PLAN-20260928102019 ⑨):board 存在 localStorage 里,
  // 而页面载入后只认内存中那一份 —— 另一个标签页投的票这边一直看不到,得刷新才发现。
  // ⚠ **不碰 `actedRef`**:别的标签页的票不是「我在这个标签页动过手」,顺手去上报等于把
  //   「这边看到的票」当成用户的新意图推上去。只重读,不上报。
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== null && event.key !== LS_REDBLACK) return;
      setBoard(loadStickers());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  // 上报失败**说一次**(2026-09-28,PLAN-20260928102019 ⑩):过去是彻底静默 —— 断网 / 被限流时
  // 用户以为榜上记了。⚠ 只在「连续失败的第 1 次」弹;成功(streak 归 0)后复位,下次再失败才再说。
  const pingFailedRef = useRef(false);
  useEffect(
    () =>
      onFilmVotesPingFailure((streak, kind) => {
        if (streak === 0) {
          pingFailedRef.current = false;
          return;
        }
        if (pingFailedRef.current) return;
        pingFailedRef.current = true;
        // ⚠ 两种失败**分开说**（2026-09-30）:服务端**拒绝了**这份载荷时叫用户「检查网络」
        //   是把人往错的方向带 —— 那次 422 事故里每一次上报都被拒,而提示一直在说网络,
        //   于是没人会往「载荷 / 版本对不上」上想。`rejected` 的措辞要留一句「一直这样请告诉我们」:
        //   那才是用户能把线索交回来的出口。
        // ⚠ `offline` 那句 2026-10-05 改了措辞（PLAN-20261005182415 §A）：现在客户端会**自己**
        //   退避重试、并把待发的那一份落盘，所以不该再叫用户「重试」—— 他要做的事只有一件：
        //   别把页面关掉就走（关掉也没关系，下次开页面会补）。
        ToastQueue.negative(
          kind === "rejected"
            ? "贴纸没能同步到榜上：服务端拒绝了这次上报。稍后再试一次；一直这样请告诉我们。"
            : "贴纸没能同步到榜上：网络不通，正在自动重试，恢复后会自动补上。",
          { timeout: 5000 },
        );
      }),
    [],
  );
  // 「生成分享图」弹层。⚠ 焦点归还必须在弹层**真正卸载之后**再做(S2 `DialogContainer`
  // 自己也会 restoreFocus,而 WebKit 上点按钮不会让按钮获得焦点、它记下的原焦点是 body)——
  // 所以放 `useEffect` 而不是写在 onDismiss 里,与卡片上的讨论区同一个手法。
  const [shareOpen, setShareOpen] = useState(false);
  const shareBtnRef = useRef<HTMLButtonElement | null>(null);
  const shareWasOpenRef = useRef(false);
  useEffect(() => {
    if (shareWasOpenRef.current && !shareOpen) shareBtnRef.current?.focus();
    shareWasOpenRef.current = shareOpen;
  }, [shareOpen]);

  /* 快速投票的开关（2026-10-14，PLAN-20261014190000 修订 2）。
   *
   * ⚠ **开关住在 URL 上**（`?vote=1`），不在本页的 `useState` 里 —— 因为那枚入口按钮
   *   搬到了**页头**（`BoardPage` 的 `热门榜 / 红榜 / 黑榜` 那一排旁边），
   *   而本页在「热门榜」这个 tab 下**根本没挂载**：用 state 的话，从热门榜点进去
   *   会先切到红榜、本页刚挂载、state 是初始的 `false` —— 卡片永远弹不出来。
   *   走 URL 则「切 tab」与「开卡片」是同一个动作的两半，谁先挂载都不影响结果。
   *
   * ⚠ 焦点归还也一并交给 `BoardPage`（按钮在它那里，只有它知道该还给谁）——
   *   本页不复刻一份，否则「还焦点」会变成两处口径。 */
  const deckOpen = params.get("vote") === "1";
  const closeDeck = useCallback(() => update({ vote: null }), [update]);

  // 全体票数(服务端聚合,见 `film-votes.ts`)。节奏与「想看人数」完全一致:
  // 拉一次 → 我贴 / 收之后 1200ms 防抖上报 → 上报成功后再拉一次。
  // ⚠ 数字**不再**等这一秒(2026-09-23):页面拿 `reconcile` 把「我这一票」当场算进去 / 减出来,
  //   所以贴一枚立刻 +1、收回立刻 −1;那一秒只是把本地视角换成服务端确认过的真值,画面不跳。
  const [votes, setVotes] = useState<FilmVoteCounts>(() => peekFilmVotes());
  /** 服务端回的**按款**分布（2026-09-29）。只用来画群点 —— 它与 `votes` 在同一个响应体里到达，
   *  所以必须**同一拍**换：分批换会让群点短暂画在「新数字 + 旧分布」上（多一枚或少一枚）。 */
  const [filmSkins, setFilmSkins] = useState<FilmSkinCounts>(() => peekFilmSkins());
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
    adoptSyncedVotes(bootVotes);
    return peekSyncedVotes();
  });
  // 「服务端那份快照里**我那一枚长什么样**」（色 + 款）—— 与 `syncedVotes` 是同一份快照的另一半，
  // 必须在同一刻切换：它回答「从哪个桶扣」（见 `redblack.ts::SyncedStickerFace`）。
  // ⚠ 扣「别人的按款分布」时**只能**用它，不能用本地当前那枚 —— 换款到上报落地之间两者不同拍，
  //   拿本地款去扣会从**别人的**桶里扣掉一枚（用户 2026-10-05 报的那个 bug）。
  const [syncedFaces, setSyncedFaces] = useState<Readonly<Record<string, SyncedStickerFace>>>(() => {
    adoptSyncedVotes(bootVotes);
    return peekSyncedFaces();
  });
  // 票数**结算**了没有(成功、失败、空表都算结算)—— 首屏那次排序发生在它之前,见下面的补排
  const [votesSettled, setVotesSettled] = useState(false);
  useEffect(() => {
    void loadFilmVotes().then((next) => {
      setVotes(next);
      setFilmSkins(peekFilmSkins());
      setSyncedVotes(peekSyncedVotes());
      setSyncedFaces(peekSyncedFaces());
      setVotesSettled(true);
      // 上一次没发成功的那一份**补发**（2026-10-05，PLAN-20261005182415 §A）：关页 / 切后台 /
      // 崩溃时那次上报只活在定时器闭包里，盘上留着这一份就是为了在这儿补上。
      // ⚠ 放在**读结算之后**：先让首屏拿到当前那份（可能已经含我），再补发 —— 反过来，
      //   补发成功那次 `applyVotes` 的结果会被上面这几行 `set*` 用更旧的快照盖回去
      //   （差值很小，但「刚贴的那枚又变回去」最刺眼）。
      // ⚠ 没有 pending 时它是**空操作**（本地为空 ≠ 我撤票了，见 `resumePendingFilmVotes`）。
      resumePendingFilmVotes();
    });
    return onFilmVotesChange(() => {
      setVotes(peekFilmVotes());
      setFilmSkins(peekFilmSkins());
      setSyncedVotes(peekSyncedVotes());
      setSyncedFaces(peekSyncedFaces());
    });
  }, []);
  const crowd: CrowdCounts = useMemo(() => crowdOf(votes), [votes]);
  /** 评分先验 = **全站红占比**（`redblack.ts::priorOf`），加权分公式里的 `C`。
   *  ⚠ 页面卡片与分享图**共用这一份**（分享图由 `RedBlackShareDialog` 显式传入，不自己再算）——
   *    各算一份的话，同一屏里卡片角标与分享图行会因为基准不同而差一位小数。 */
  const priorRate = useMemo(() => priorOf(crowd), [crowd]);
  /** 服务端已确认含我的那份票,与 `crowd` 同形状(每片恒 1 枚) */
  const syncedCrowd: CrowdCounts = useMemo(() => crowdOf(syncedVotes), [syncedVotes]);
  /** 重排触发器 —— 每 +1 就重排一次(见下面 `sorted` 的依赖)。
   *  声明在这里而不是紧跟 `sorted`,是因为「票数落定后自动补排一次」也要用它。 */
  const [sortTick, setSortTick] = useState(0);
  // 票数是**异步**到的,而榜单在它到达之前就排过一次序了 —— 那一次把每部都判成 0 分(并列),
  // 稳定排序于是原样返回 `boardFilms(films)`,也就是**影片库目录序**(2026-10-14 起合集卡换成
  // 了它的成员片,成员片本身仍在目录序里 —— 见 `PLAN-20261014112444`)。结果就是默认档写着
  // 「按红贴纸数（多在前）」,首屏给的却是目录序(用户 2026-09-22:「好像既不是总数 也不是红数」)。
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
  // ⚠ 2026-10-14:伴随拖拽一起删掉的还有 `movedRef`(「刚才那一下是不是拖」)与
  //   `gestureRef`(拖拽手势单例) —— 而**上报 effect 保留了下来**,理由没变:
  //   它依赖的是**票签名**而不是 `board`,所以「只是挪了个位置」不该触发一次全量上报。
  useEffect(() => {
    if (!actedRef.current) return;
    scheduleFilmVotesPing(voteInputsOf(board));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 故意不依赖 board,见上一行
  }, [votesKey]);

  // ⚠ 搜索走 `redblack.ts::searchBoardFilm`(不是 `app/model.ts::searchFilm` 直接上):
  //   榜单上的合集已被 `boardFilms` 拆成成员片,而成员片自己 `shows` 为空 ——
  //   不认「所属合集场次」的话,「搜 062」会一张都不剩(见 `PLAN-20261014112444`)。
  const candidates = useMemo(
    () => boardFilms(films).filter((film) => searchBoardFilm(film, query)),
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
    return sortByVotes(candidates, crowd, mode, priorRate);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 故意不依赖 crowd / orderKey / priorRate,见上面的注释
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

  /* ---------------- 讨论区**总览**（2026-10-07，PLAN-20261007231522） ----------------
   * 卡片右上角那枚「讨论区」只回答「**这一部**」；总览回答「**全站**」。
   * 两者共用同一个读接口，差别只在**带不带 `filmKey`** —— 口径见 `DiscussionBoardDialog` 文件头。 */
  const [boardOpen, setBoardOpen] = useState(false);
  const boardBtnRef = useRef<HTMLButtonElement | null>(null);
  const boardWasOpenRef = useRef(false);
  // 焦点归还(§5 硬约束):与卡片讨论区 / 分享图同一手法 —— 必须在弹层**真正卸载之后**
  // 再夺回焦点(原因见下面 `talkWasOpenRef` 那段:WebKit 上点按钮不会让它获得焦点)。
  useEffect(() => {
    if (boardWasOpenRef.current && !boardOpen) boardBtnRef.current?.focus();
    boardWasOpenRef.current = boardOpen;
  }, [boardOpen]);

  /** 总览里「能跳过去」的片子 —— 判据与榜单**同一处**(`boardFilms`:合集拆成成员片)。
   *  ⚠ 评语可能属于一届里已经没有排期的目录片 / 旧届残留:那些行只能读、不能跳,
   *    否则会把用户滚到一张根本不存在的卡上。 */
  const boardKeys = useMemo(() => new Set(boardFilms(films).map((film) => film.key)), [films]);

  /** 待定位的片子。⚠ 用 **ref** 而不是 state:它是「一次性意图」,不该参与渲染;
   *  真正驱动重试的是下面那个 `locateTick`(见 `jumpToFilm` 的说明)。 */
  const jumpTargetRef = useRef<string | null>(null);
  const [locateTick, setLocateTick] = useState(0);
  const pageRef = useRef<HTMLElement | null>(null);

  /** 总览里点一行 → 关弹层 + 记下目标。
   *  ⚠ 目标可能正被 `q` / `only=mine` **藏着**,而那两个过滤恰恰会让定位失败 ——
   *    所以先清掉它们,再由下面那个 effect 落地(不在同一拍查 DOM:那一刻 React 还没提交,
   *    查到的仍是过滤后的列表)。
   *  ⚠ `locateTick` 只为保证「过滤本来就没开」时 effect 也一定跑一次(那是唯一由点击驱动的一轮)。 */
  const jumpToFilm = useCallback(
    (filmKey: string) => {
      setBoardOpen(false);
      jumpTargetRef.current = filmKey;
      if (query || onlyMine) update({ q: null, only: null }, true);
      setLocateTick((count) => count + 1);
    },
    [query, onlyMine, update],
  );

  /** 落地:滚进视口 + 闪描边。
   *  ⚠ 查不到就**不**清 ref:清过滤那一拍可能还没提交,下一次提交(`visible` 换了引用)
   *    会再跑一遍这里 —— 这一层重试正是「点了却没滚过去」那个 bug 的修法。
   *    真的不在榜上(过滤已清干净还查不到,`boardKeys` 本该先挡住)才放弃,免得这个 ref
   *    挂到下一次随便什么重排上,把页面莫名其妙滚走。 */
  useEffect(() => {
    const target = jumpTargetRef.current;
    if (!target) return;
    const node = pageRef.current?.querySelector<HTMLElement>(
      `[data-film-key="${CSS.escape(target)}"]`,
    );
    if (!node) {
      if (!query && !onlyMine) jumpTargetRef.current = null;
      return;
    }
    jumpTargetRef.current = null;
    node.scrollIntoView({
      block: "center",
      // 动效敏感:瞬移而不是平滑滚动(`prefers-reduced-motion` 管不到 `scrollIntoView`)
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
    flashCard(node);
  }, [locateTick, visible, query, onlyMine]);
  /* ⚠ 2026-10-14:原来这里有一份 `tallies`（`tallyOf(key, watched.has(key), board)`），
   *   回答「这部标记过没有 / 还能贴几枚」。两道闸门都撤了（「标记看过」删掉、一部一枚的
   *   配额在快速投票里由「候选 = 我的行程」取代），所以整张表连同 `watched` 一起删掉 ——
   *   卡片现在只看 `board.get(key)` 那一枚本身。 */
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
  /** 卡片要的**按款**分布（2026-09-29）。与 `reconciledCrowd` 同一手法：值没变就**沿用旧对象**。
   *
   *  ⚠ 这里**不做**「减服务端确认的那份、加我当前的」那套 —— 按款分布只用来决定
   *    「别人的贴纸长什么样」，而我贴的那一枚是**单独画的 DOM**、根本不进群点。
   *    扣我自己的动作在 `RbCard` 里做（`othersSkins`），基准是下面那份 `syncedFaceByKey`。
   *  ⚠ 稀疏：没有款数据的片**不进这张表**（`get` 得到 `undefined`），卡片那边正好走
   *    「按 id 兜底」那条分支 —— 与老接口 / 还没拉到时的行为一致。 */
  const filmSkinCache = useRef(new Map<string, SkinCrowdCounts>());
  const filmSkinsByKey = useMemo(() => {
    const cache = filmSkinCache.current;
    const next = new Map<string, SkinCrowdCounts>();
    for (const [key, value] of Object.entries(filmSkins)) {
      const prev = cache.get(key);
      next.set(key, prev && skinsSignature(prev) === skinsSignature(value) ? prev : value);
    }
    filmSkinCache.current = next;
    return next;
  }, [filmSkins]);
  /** 卡片 / 分享图扣「按款分布」时的基准：**服务端已确认的我那一枚**（色 + 款，2026-10-05）。
   *  ⚠ 与 `filmSkinsByKey` 同一手法：值没变就**沿用旧对象** —— `RbCard` 是 `memo` 的，
   *    每次上报成功都造一批新对象会让近 300 张卡白渲染一遍。 */
  const syncedFaceCache = useRef(new Map<string, SyncedStickerFace>());
  const syncedFaceByKey = useMemo(() => {
    const cache = syncedFaceCache.current;
    const next = new Map<string, SyncedStickerFace>();
    for (const [key, face] of Object.entries(syncedFaces)) {
      const prev = cache.get(key);
      next.set(key, prev && prev.type === face.type && prev.skin === face.skin ? prev : face);
    }
    syncedFaceCache.current = next;
    return next;
  }, [syncedFaces]);
  const totals = useMemo(() => {
    // 「我的」那份:hero 里那行小字。⚠ 2026-10-14 两轮修订之后只剩「已贴几枚」——
    //   「标记看过几部 / 还能贴几枚」随那道闸门撤掉，「没看过几部」随上滑改纯跳过撤掉
    //   （一部片对一个人只剩红 / 黑两态，没有第三种可数）。
    // ⚠ 数的是 `board` 的**全量**（我这一份本来就只有我），不是榜单上那几部：
    //   它是「我的全局」小字，输一个场次编号就跟着缩水是错的（用户 2026-10-12 报过同一根因）。
    let placed = 0;
    for (const list of board.values()) placed += list.length;
    // 「全站」那份:hero 的大字。`total` 还兼作「榜是不是空的」的判据。
    // ⚠ 评分**不是**看全站 —— 评分是**每部各自的**(见卡片里的 `filmScore`)。
    // ⚠ 累加的是 `boardKeys`(整份榜单)而**不是** `filmCounts`(只有当前搜索命中的那几部):
    //   `filmCounts` 派生自 `sorted`,输一个场次编号就会让这里的「全站」跟着缩水
    //   (用户 2026-10-12 报的正是「424 枚贴纸 红 289 · 黑 135」一搜就变)。
    //   与分享图用全量 `reconciledCrowd` 是同一条口径 —— 搜索只该缩减栅格,不动总览。
    let red = 0;
    let black = 0;
    for (const key of boardKeys) {
      const counts = reconciledCrowd.get(key);
      if (!counts) continue;
      red += counts.red;
      black += counts.black;
    }
    return { placed, red, black, total: red + black };
  }, [board, boardKeys, reconciledCrowd]);

  // 落点处理要按 key 反查影片(提示里要片名、贴纸要挂到它上面),先按当前榜单建索引
  const filmByKey = useMemo(
    () => new Map(sorted.map((film) => [film.key, film])),
    [sorted],
  );

  // ⚠ `saveComment` 这个回调**必须是稳定引用**,否则 `RbCard` 的 `memo` 全废 —— 而 memo 正是
  //   「投一票只重渲染那一张」的前提(PLAN-20260922145815)。它要读**最新**的 board,
  //   而卡片拿到的是创建那一刻的闭包 —— 所以走这个 ref,每次渲染刷新一次。
  const latest = useRef({ board, filmByKey });
  latest.current = { board, filmByKey };

  /** 一次落定 = 写盘 + 打开上报闸门。
   *  ⚠ 2026-10-14:**不再有撤销**。撤销原本挂在「收回 / 换色 / 换款」三个动作上,
   *    而那三个都随贴纸操作一起删了 —— 改主意的入口现在是**快速投票里再划一次**
   *    (改票是幂等的原地换色,不是叠一枚新的,所以不需要「撤销」这条回头路)。 */
  const commitBoard = useCallback((next: StickerBoard) => {
    setBoard(next);
    // 用户动过手了 —— 从这里开始才允许把「我的状态」上报给服务端(见上面 actedRef 的说明)。
    actedRef.current = true;
    // ⚠ 一律**立即**写盘:延后写盘那套(`redblack.ts::scheduleSaveStickers`)唯一的用途是
    //   「拖动只是挪个位置、可以晚一拍落盘」,而拖动已经删了 —— 现在每一次写入都是语义操作。
    saveStickers(next);
  }, []);

  /** 「大家说」里保存 / 清空评语（空串 = 清掉）。
   *  ⚠ 它只改**本地那一份**：评语随票在 1200ms 防抖后**同一次整份替换**里上报
   *    （见 `film-votes.ts` 与 `redblack.ts::votesOf`），所以这里不需要第二条上报路径 ——
   *    而 `votesSignature` 把评语串进了签名，改评语才会真的触发那次上报（否则永远上不去）。 */
  const saveComment = useCallback(
    (filmKey: string, comment: string) => {
      commitBoard(setStickerComment(latest.current.board, filmKey, comment));
    },
    [commitBoard],
  );

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

  /* ---------------- 快速投票（2026-10-14，PLAN-20261014190000） ----------------
   * 上面删掉的那几个回调（`nudge` / `toggleWatched` / `reskin` / `place` / `placeByTap` /
   * `takeBack` / `takeBackByTap` / `finishRef` / `beginDrag`）合起来就是原来那套「贴纸操作」。
   * 现在只剩**两个**改数据的入口：`vote`（滑一下 / 点一颗按钮）与 `restoreVote`（撤销）——
   * 两者都落在 `redblack.ts` 那几个**不可变**变更原语上。 */

  /** 「我」在这部片上的当前票 —— 卡片角标、撤销栈、总结页三处共用这一个口径。
   *  ⚠ 返回 `undefined` **就是「未决定」**：它不是一个要存的状态，而是「`board` 里没有这个 key」
   *    （2026-10-14 修订：上滑改纯跳过，第三态整个撤掉了）。 */
  const voteOf = useCallback(
    (key: string): StickerType | undefined => board.get(key)?.[0]?.type,
    [board],
  );

  /** 一次表态。⚠ **幂等**交给 `setFilmVote`：内容没变时它把**同一个引用**还回来 ——
   *  所以「投了红再投红」既不会写盘、也不会触发一次无意义的上报，调用方不必自己比对。
   *  ⚠ 三件事**同一拍**做掉：改内存、写盘、让上报 effect 看见签名变化。
   *    落定必须是「一按就生效」，不能等一次异步往返（与既有的「本地视角当场 +1」同一条口径）。
   *  ⚠ 这里**不再弹 Toast**（规格明确要求「避免频繁 Toast」）：卡片飞出去本身就是回声。 */
  const vote = useCallback(
    (key: string, intent: StickerType) => {
      const next = setFilmVote(latest.current.board, key, intent);
      if (next !== latest.current.board) commitBoard(next);
      markFresh(key);
    },
    [commitBoard, markFresh],
  );

  /** 撤销一次表态：把这一部恢复到 `before`（`undefined` = 把那枚贴纸撤掉）。
   *  ⚠ 用「原地改色 / 撤掉那一枚」两个**既有**原语拼出来，不新增第三态 ——
   *    撤销要恢复的是「当时那一张票」，**不是**「当时那个落点」（落点本来就是投票那一刻随机的，
   *    连用户都没见过，谈不上恢复）。 */
  const restoreVote = useCallback(
    (key: string, before: StickerType | undefined) => {
      const current = latest.current.board.get(key)?.[0];
      if (!current) return;
      commitBoard(
        before
          ? retintSticker(latest.current.board, key, current.id, before)
          : takeSticker(latest.current.board, key, current.id),
      );
    },
    [commitBoard],
  );

  /** 「快速投票里跳过过」的本地账（2026-10-14，`PLAN-20261014190000` 修订 5）。
   *  跳过**不写任何红黑状态**（既有口径），但要把「我翻过这一张」记下来 —— 否则下次打开
   *  快速投票又从它开始，用户会觉得「划了等于没划」。
   *  ⚠ **匿名也记**：它就是 localStorage；登录后随 `biff.*` 一起同步（与 board 同一个处置）。 */
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => loadSkipped());
  /** ⚠ 两个写盘回调读的是 `skippedRef` 而不是 state：它们会被存进 `QuickVoteDeck` 的 props，
   *  依赖 state 的话每次跳过都换一次引用（白重渲染），而这里的写入本来就是「一次一张」。 */
  const skippedRef = useRef(skipped);
  skippedRef.current = skipped;
  const markSkipped = useCallback((key: string) => {
    if (skippedRef.current.has(key)) return;
    const next = new Set(skippedRef.current);
    next.add(key);
    saveSkipped(next);
    setSkipped(next);
  }, []);
  const unmarkSkipped = useCallback((key: string) => {
    if (!skippedRef.current.has(key)) return;
    const next = new Set(skippedRef.current);
    next.delete(key);
    saveSkipped(next);
    setSkipped(next);
  }, []);
  /** 「这一部**已经处理过**没有」= 投过红 / 黑（`board` 里有那一枚）**或**跳过过。
   *  ⚠ 由 `QuickVoteDeck` 在**一轮开始时**读一次（划的过程中不再过滤）—— 否则刚划掉的那一张
   *    会让后面所有卡的索引整体前移（用户报的 5/50 → 1/50）。
   *  ⚠ `board` 与「跳过」都走 ref：这个回调会在**渲染期**被调用（卡片用它算初始队列），
   *    必须拿到当前那一份，而不是创建闭包那一刻的。 */
  const handledOf = useCallback(
    (key: string) => latest.current.board.has(key) || skippedRef.current.has(key),
    [],
  );

  /** 候选队列 ①：**我的行程**（🎫 是否已投过由 `handledOf` 在卡片里过滤，这里不管）。
   *  ⚠ 依赖 `storeRevision`：`films` 与选片无关（它是目录 + 豆瓣映射的函数），
   *    所以「我加了一部片到行程」不会换掉 `films` 的引用 —— 不跟这个修订号就永远不重算。 */
  const agendaQueue = useMemo(
    () => quickVoteOrder(films, new Set(store.picks.keys())),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- storeRevision 就是 picks 的「变了没有」
    [films, storeRevision],
  );
  /** 候选队列 ② 的数据源：热门榜那份「想看人数」。 */
  const [wants, setWants] = useState(() => peekWantCounts());
  useEffect(() => {
    // ⚠ 只在**真的要弹兜底卡片**时才去拉：那是另一条接口。
    //   两个条件都不能少 —— 行程里有片的人不该为它付一次请求；行程为空但**没打开卡片**的人
    //   也不该（那时他只是在看红 / 黑榜，兜底候选根本不会出现）。
    if (agendaQueue.length || !deckOpen) return undefined;
    void loadWantCounts();
    return onWantCountsChange(() => setWants(peekWantCounts()));
  }, [agendaQueue.length, deckOpen]);
  /** 候选队列 ②（用户 2026-10-14）：「如果行程没有**主动点击**就改成 TOP50 给用户进行滑动吧」。
   *  ⚠ 这一支只在**行程为空**且用户主动点了「快速投票」时才走到（落地自动弹出的那条路
   *    要求行程非空，见 `BoardPage`）—— 所以「兜底」不会伪装成默认候选。
   *  ⚠ 用的是 `buildHotRows`（热门榜面板**同一支**），不是在红黑榜里再写一遍按想看人数排序 ——
   *    两处口径分叉的症状是「热门榜第一和兜底第一不是同一部」，而那种错没人会立刻看出来。
   *  ⚠ 组件那边会显示一句「行程还是空的」：兜底候选必须**说得出自己是兜底**。
   *
   *  ⚠⚠ **`crowd` / `priorRate` 不能进这个 useMemo 的依赖**（2026-10-14 修订 5 修的 bug）：
   *    它们只进 `buildHotRows` 的**展示列**（红 / 黑 / 评分），而 TOP50 的**顺序**由 `want` 决定
   *    （`buildHotRows` 末尾 `sort(compareByWant)`）—— 而这里只取 `row.key`。
   *    放进依赖的代价：每投一票 → 1200ms 上报成功 → `onFilmVotesChange` → `setVotes(新对象)`
   *    → `crowd` 换引用 → 本 useMemo **重算成新数组** → `QuickVoteDeck` 判成「候选换了」
   *    → 卡片退回第 1 张（用户报的「划了五部又从 5/50 变成 1/50」）。
   *    改用 ref 读最新值喂给 `buildHotRows`：那两个数字**不会**因此在界面上变旧 ——
   *    卡片上的红黑数走的是 `countsOf`（另一条实时的路），这里算出来的那两个数**根本没人读**。 */
  const crowdRef = useRef(crowd);
  crowdRef.current = crowd;
  const priorRateRef = useRef(priorRate);
  priorRateRef.current = priorRate;
  const deck = useMemo(() => {
    if (agendaQueue.length) return { films: agendaQueue, fromAgenda: true };
    // ⚠ 「想看人数」还没到 → **先不造候选**，而不是拿一份 want 全为 0 的榜单硬排：
    //   那样排出来的顺序与数据到了之后**完全不同**，而队列一换 `QuickVoteDeck` 就会重开这一轮 ——
    //   用户划到第 6 张时数据到了，会被当场甩回第 1 张（正是规格里那句「不要闪烁 / 布局跳动」）。
    //   等它到了再给，队列于是**只出现一次**、也只会被排一次序。
    if (!Object.keys(wants).length) return { films: EMPTY_DECK, fromAgenda: false };
    const byKey = new Map(films.map((film) => [film.key, film]));
    const fallback: FilmNode[] = [];
    for (const row of buildHotRows(films, wants, crowdRef.current, priorRateRef.current).slice(0, 50)) {
      const film = byKey.get(row.key);
      if (film) fallback.push(film);
    }
    return { films: fallback, fromAgenda: false };
  }, [agendaQueue, films, wants]);

  return (
    <section className="rb-page" aria-label="榜单" ref={pageRef}>
      <header className="rb-hero">
        <div className="rb-hero-text">
          <p className="rb-eyebrow">划过就投</p>
          <h1>榜单</h1>
          <p className="rb-lede">
            一部电影一枚贴纸：左滑投黑，右滑投红。
            {/* 完整规则收进 `?`(2026-09-29,PLAN-20260929172651 §1):正文只留一句话,把版面让出来。
                ⚠ 展开走**纯 CSS** 的 `:hover` + `:focus-within`,不引 JS 状态 —— `:focus-within` 让触屏
                也「点一下 `?`」就能看,键盘 Tab 进来同样展开;`aria-describedby` 让读屏也拿得到全文
                (所以 CSS 里**不能**用 `visibility: hidden` / `display: none`,那会把内容从无障碍树里摘掉)。 */}
            <span className="rb-rule">
              <button type="button" className="rb-rule-btn" aria-describedby="rb-rule-full">
                ?
              </button>
              <span className="rb-rule-pop" id="rb-rule-full">
                点「快速投票」，一张一张划：左滑投黑、右滑投红、上滑「没看过」。候选就是「我的行程」里的片，
                已经投过的也会再出现一次 —— 想改主意，再划一次就行。贴纸落在右边那块空地上，位置和款式都是随机的。
                一部片只有一枚，红黑是同一个名额的两种取舍。大家的票一起排榜。
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
          {/* 我自己那份:Badge 组。⚠ 2026-10-14 修订后只剩**一枚** ——
              「标记看过 / 还能贴」随那道闸门一起没了，「没看过」也随上滑改纯跳过而撤掉
              （它不再是一个状态，见 `redblack.ts` 文件头那条修订）。 */}
          <div className="rb-badges">
            <span className="rb-badge">
              已贴 <strong>{totals.placed}</strong>
            </span>
          </div>
        </div>
      </header>

      <div className="rb-controls">
        {/* ⚠ 文案按用户 2026-09-29 的建议收短(`label` 是同一句话的长版本,留给读屏) */}
        <QuerySearchField label="搜索影片或场次编号" placeholder="搜索影片 / 场次编号" />
        {/* 排序:两档互斥（2026-10-12 撤了「总数」）→ **一个**分段控件(Segmented Control),
            不再是几个各自带边框的胶囊。
            ⚠ `role=group` + `aria-pressed` 一个都不能少:分段控件只是视觉形态,语义上它仍是
              「一组互斥选项」(用户 2026-09-29:「筛选切换(总数、红榜、黑榜)保持统一的分段控件样式」)。 */}
        {!hideSortBar && (
          <div className="rb-seg" role="group" aria-label="榜单排序">
            {SORTS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className="rb-seg-btn"
                aria-pressed={mode === value}
                onClick={() => update({ sort: value === "red" ? null : value }, true)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
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
        {/* 讨论区**总入口**(2026-10-07,PLAN-20261007231522)—— 卡片上那枚只回答「这一部」,
            想看全站谁给哪部写了什么,必须有一个跨片的入口。
            ⚠ 文案与卡片上那枚**刻意不同**(「讨论区总览」vs「讨论区」):两处语义不同
              (全站 / 单部),读屏与 E2E 也才分得开。
            ⚠ 它是**弱按钮**,不给品牌色实底 —— 这一排里只有「生成分享图」是主操作。 */}
        <button
          ref={boardBtnRef}
          type="button"
          className="rb-board-btn"
          aria-label="打开讨论区总览"
          onClick={() => setBoardOpen(true)}
        >
          讨论区总览
        </button>
        {/* ⚠ 2026-10-14(PLAN-20261014190000 修订 2):「快速投票」的入口**搬到页头**去了
            (`BoardPage` 的 `热门榜 / 红榜 / 黑榜` 那一排) —— 用户要的是「和那三个并排」,
            而它们不在本页里。这里于是只剩「看结果」那一排动作。
            出图曾经是这一排里唯一的主操作;现在整页的主操作在页头上，这里它仍是这一排里
            最重的一枚（`--brand` 实底）。 */}
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
            而它根本不是按钮(用户 2026-09-29)。
            ⚠ 2026-10-14 起排序是**按该榜自己的贴纸数降序**(`redblack.ts::sortByVotes`):所以会出现
              「5.0 分的片排在 6.0 分的片前面」—— 那句话必须把「按数量、同数量才比评分」说清,否则文案骗人。
              ⚠ 措辞与分享图上那两句(`redblack-poster.ts::BOARDS.…hint`)**同字**,改一起改。 */}
        <p className="rb-sort-hint">
          {mode === "red" ? "按红贴纸数（多在前）· 同数量比评分" : "按黑贴纸数（多在前）· 同数量比评分"}
          ；评分 = 红票占比按全站平均加权（票少的会向平均收缩）；贴纸变化不会打乱当前顺序
        </p>
        {/* ⚠ 2026-10-14:「长按换一款皮肤」那句提示随换肤轮盘一起删了 ——
            皮肤不再是用户的选择（投票那一刻随机摇一款，见 `redblack.ts::voteSticker`），
            留着一句教人长按的话只会让人按了半天什么也不发生。 */}
      </div>

      {/* 空榜引导。⚠ 条件**只能**看全站票数(`totals.total`),**不能**掺「我贴了几枚」:
          这条就挂在**栅格上方**,一收一放会把整页内容顶上去 53px ——
          用户投一票,看到的却是「整个页面闪了一下」(2026-09-23 报的)。
          而且它本来就是同一个口径的事:文案说的是「**榜**还是空的」,榜 = 全站票数。 */}
      {totals.total === 0 && (
        <p className="rb-hint" role="status">
          榜还是空的。点「快速投票」，一张一张划过去 —— 这是你自己的榜。
        </p>
      )}

      {visible.length === 0 ? (
        <div className="empty-state">
          {/* 「只看我贴过」的空态与「搜不到」不是一回事:一个是我还没投,一个是搜错了 */}
          <h2>{onlyMine ? "你还没有贴过贴纸" : "没有符合条件的影片"}</h2>
          <p>
            {onlyMine
              ? "取消「只看我贴过」，或点「快速投票」投一枚。"
              : "试试其他片名，或换一个场次编号。"}
          </p>
        </div>
      ) : (
        <div className="rb-grid">
          {visible.map((film) => (
            <RbCard
              key={film.key}
              film={film}
              /* ⚠ 直接传 `board.get(...)` 的结果(可能 undefined),不要 `?? []` —— 那会每次造新数组,memo 失效 */
              placed={board.get(film.key)}
              counts={filmCounts.get(film.key)!}
              priorRate={priorRate}
              skins={filmSkinsByKey.get(film.key)}
              syncedFace={syncedFaceByKey.get(film.key)}
              fresh={freshKeys.has(film.key)}
              onSaveComment={saveComment}
            />
          ))}
        </div>
      )}

      {deckOpen && (
        <QuickVoteDeck
          queue={deck.films}
          fromAgenda={deck.fromAgenda}
          voteOf={voteOf}
          handledOf={handledOf}
          countsOf={(key) => filmCounts.get(key) ?? EMPTY_COUNTS}
          onVote={vote}
          onRestore={restoreVote}
          onSkip={markSkipped}
          onUnskip={unmarkSkipped}
          onDismiss={closeDeck}
        />
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
            /* ⚠ 给**全量**按款分布(不是只有当前榜单那几部):分享图要画整份影片库,
               与上面 `crowd` 给 `reconciledCrowd` 而不是 `filmCounts` 是同一条理由。
               ⚠ 它是**服务端原样那份**(含我)—— 海报那边自己 `othersSkins` 扣掉。 */
            skins={filmSkins}
            /* ⚠ 扣减基准与卡片**同一份**（`syncedFaceByKey`）：服务端已确认的我那一枚（色 + 款）。
               传本地 board 的话，换款还没上报落地时海报也会扣错桶（与卡片是同一次修复）。 */
            syncedFaces={syncedFaceByKey}
            board={board}
            site={{ total: totals.total, red: totals.red, black: totals.black }}
            /* 评分先验与页面卡片**同一个数**：分享图上每一行的评分必须与卡片角标逐字一致 */
            priorRate={priorRate}
            /* ⚠ 2026-10-14 两轮修订:`marked` / `quota` 随「标记看过」那道闸门一起去掉了,
               `unseen` 随上滑改纯跳过也撤掉了 —— 现在只剩「已贴 N 枚」这一项
               (海报上那行小字见 `redblack-poster.ts`) */
            mine={{ placed: totals.placed }}
            onDismiss={() => setShareOpen(false)}
          />
        </Suspense>
      )}

      {boardOpen && (
        // ⚠ `Suspense` 写在条件**内部**:不打开时连边界都不挂,不多包一层没有内容的边界
        <Suspense fallback={null}>
          <LazyDiscussionBoardDialog
            /* ⚠ 给**全量**片名映射(不是榜单当前过滤后那份):总览列的是全站评语 */
            filmByKey={allFilmByKey}
            /* 只有榜单上真有卡的片子才可跳(评语可能属于没有排期的目录片 / 旧届残留) */
            boardKeys={boardKeys}
            onJump={jumpToFilm}
            onDismiss={() => setBoardOpen(false)}
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
  placed,
  counts,
  priorRate,
  skins,
  syncedFace,
  fresh,
  onSaveComment,
}: RbCardProps) {
  // 视口按需渲染:屏幕外的卡**一枚贴纸都不画**(见 `useInView` 与 PLAN-20260922145815)。
  // ⚠ 贴纸是绝对定位,稍后补画不触发兄弟节点回流 —— 所以「滚到才画」不会引起版面跳动。
  const cardRef = useRef<HTMLElement | null>(null);
  const inView = useInView(cardRef);
  // 「我贴的那一枚」的 DOM 引用 —— 它是**唯一**能做动效的贴纸:群点是 canvas 上画出来的像素,
  // 没有独立元素(何况「别人的贴纸」本来也不该有个体身份,2026-09-22 拉平口径)
  // ⚠ 2026-10-14 起它**只读**了（不挂指针、不接键盘、没有换款轮盘），
  //   剩下这两个用途照旧：闪一下描边、以及那记落地动效。
  const freshRef = useRef<HTMLElement | null>(null);
  const mine = countsOf(placed);
  // 「别人的贴纸」= 修正过的全站票数 − 我自己那几枚(口径在 `redblack.ts::othersOf`,分享图同用)。
  // ⚠ 传进来的 `counts` 已由页面 `reconcile`(扣掉「服务端已确认含我」的那份、加回我当前的票),
  //   所以这里减掉 `mine` 得到的正是「服务端 counts − 服务端那份里的我」—— 撤票那一拍就少一枚。
  const others = othersOf(counts, mine);
  // 这一部**自己的**评分(加权红占比折算 0–10);还没有人贴过 → null(显示成「—」)
  const filmScore = scoreOf(counts, priorRate);

  const myStickers = placed ?? EMPTY_STICKERS;
  // 「别人的贴纸**各是什么款**」= 服务端按款分布 − **服务端已确认的**我那一枚
  // （口径在 `redblack.ts::othersSkins`）。
  // ⚠ 必须跟着 `othersOf` 一起扣，而且基准必须同样是「服务端那份里的我」（`syncedFace`）：
  //   改前这里传的是本地当前那枚（`myStickers`）—— 换款到上报落地之间服务端聚合里还是旧款，
  //   于是旧款桶没被扣、新款桶被白扣，群点看起来就像「别人的皮肤也换了」（2026-10-05 用户报的）。
  // ⚠ 没有分布数据时 `othersSkins` 原样返回 `undefined` → 画布走「按 id 兜底」那条正常分支。
  const crowdSkins = othersSkins(skins, syncedFace);

  // 讨论区顶上那行「红 N · 黑 N」画的是**全部**(群点 + 我贴的那一枚),不是卡片上那份「别人的」——
  // 打开讨论区却少了自己那一票,那行数字会跟卡片当场对不上。
  // ⚠ 相加不会重复计数:页面给的 `counts` 已按本地视角修正(`reconcile`)**恒含我这一枚**,
  //   而 `others` 就是它减掉 `mine` —— 加回来正好是那份全站数,上报前后都不多不少。
  const all: StickerCounts = {
    total: others.total + mine.total,
    red: others.red + mine.red,
    black: others.black + mine.black,
  };
  const [talkOpen, setTalkOpen] = useState(false);
  const talkBtnRef = useRef<HTMLButtonElement | null>(null);
  const talkWasOpenRef = useRef(false);
  // 焦点归还(§5 硬约束):必须在弹层**真正卸载之后**再夺回焦点 ——
  // ⚠ S2 的 `DialogContainer` 自己也会 restoreFocus,而 WebKit 上点按钮**不会**让按钮获得焦点,
  //   于是它记下的「原焦点」是 body:在 `onDismiss` 里直接 `focus()` 会被它的 cleanup 覆盖掉
  //   (实测 iOS WebKit 上焦点落到 body,Chromium 上因为按钮本来就聚焦所以看不出问题)。
  //   放到 `useEffect`(跑在所有 layout effect 之后)才稳。
  useEffect(() => {
    if (talkWasOpenRef.current && !talkOpen) talkBtnRef.current?.focus();
    talkWasOpenRef.current = talkOpen;
  }, [talkOpen]);

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

  // 落地动效:刚贴下的那一枚**从上方带弹簧落下来**(2026-09-29,PLAN-20260929195500)。
  // 用户要的是「贴上去的瞬间有爽快感」:从高处落下 → 过冲约 8% → 回弹 → 落定,落定时还带一点自转。
  //
  // ⚠ **动的是 `.rb-dot__face`,不是外层那枚 `<button>`** —— 这一条是硬约束,不是偏好:
  //   外层的盒子就是**命中区与落库坐标的基准**(拖拽起手、`elementFromPoint` 判落点、
  //   E2E 量 `boundingBox()` 都读它)。让它飞 380ms 等于这期间「贴纸在哪」与「点在哪儿」
  //   是两个答案 —— 拖动会抖、单测会飘,而且用户点的是**空位**。
  //   动的只有那张「画」,槽位始终在原地等它落进来。
  // ⚠ 一枚只落一次:拖动会换 `posX/posY`(→ `myStickers` 是新数组 → 本 effect 会再跑),
  //   不拦就会「每拖动一帧重新落一次」。用 id 记账,不引入任何持久状态。
  const landedRef = useRef<string | null>(null);
  useEffect(() => {
    const sticker = myStickers[0];
    // ⚠ 取面而不是按钮:见上。`querySelector` 每枚只跑一次(由 `landedRef` 拦住)
    const face = freshRef.current?.querySelector(".rb-dot__face");
    if (!fresh || !sticker || !face) return;
    if (landedRef.current === sticker.id) return;
    landedRef.current = sticker.id;
    // 动效敏感:不做任何过渡,贴纸直接以终态出现(CSS 里也没有别的位移,天然就是终态)
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const spin = (Math.random() * 2 - 1) * LAND_SPIN;
    face.animate(
      [
        { transform: `translateY(-120px) rotate(${spin}deg) scale(0.86)`, easing: "cubic-bezier(0.2, 0.86, 0.3, 1)" },
        { transform: `translateY(6px) rotate(${spin * 0.2}deg) scale(1.06)`, offset: 0.62, easing: "ease-out" },
        { transform: `translateY(-2px) rotate(0deg) scale(0.98)`, offset: 0.84, easing: "ease-in-out" },
        { transform: "translateY(0) rotate(0deg) scale(1)" },
      ],
      { duration: LAND_MS },
    );
  }, [fresh, myStickers]);

  // ⚠ 2026-10-14:随「标记看过」一起去掉的还有 `data-rb-marked` 这个机读属性 ——
  //   它原本是 E2E 断言「这张卡解锁了没有」的抓手,而那道闸门已经不存在了。
  //   「我的状态」现在的机读出口在快速投票那张卡上（`data-qv-state`）。
  return (
    <article ref={cardRef} className="rb-card" data-film-key={film.key}>
      <div className="rb-card-info">
        {/* 海报 + **右上角评分角标**(2026-09-30,用户:「能收起就收起,比如打分就可以放到海报右上角」)。
            ⚠ 角标只写数字、不写「评分」两个字 —— 名字交给 `title` 与 `aria-label`,
              它们是同一句话的两种呈现(看得见的越短越好,读屏的仍然完整)。
            ⚠ 包一层 `.rb-poster-box` 才能让角标定位到海报的角上(海报本身是 `<img>`,不能有子节点)。 */}
        <div className="rb-poster-box">
          {film.poster ? (
            /* `decoding="async"`:解码挪到后台线程。榜单一次有上百张海报,同步解码会在主线程上
               一顿一顿地抢滚动 —— 这个属性只影响解码时机,不改变任何布局或优先级 */
            <img className="rb-poster" src={film.poster} loading="lazy" decoding="async" alt="" />
          ) : (
            <span className="rb-poster rb-poster--none" aria-hidden="true">
              {film.zh.slice(0, 1)}
            </span>
          )}
          <span
            className="rb-poster-score"
            title="红黑榜评分：红票占比按全站平均加权（票少会向平均收缩），折算成 0–10 分；还没有人贴时是「—」"
            aria-label={`评分 ${filmScore === null ? "还没有" : filmScore.toFixed(1)}`}
          >
            {filmScore === null ? "—" : filmScore.toFixed(1)}
          </span>
          {/* ⚠ 2026-10-14:「标记看过」那枚海报左下角标**已删**（PLAN-20261014190000）。
              它原来是投票的**前置闸门**（标记过才允许贴红黑），而现在的入口是快速投票 ——
              投票不再需要先声明「看过」，上滑那句「没看过」本身就是一次表态。
              留着它只会让用户先点一下、再去找别的入口。 */}
        </div>
        <h2 className="rb-title">{film.zh}</h2>
        {film.en && film.en !== film.zh && <p className="rb-en">{film.en}</p>}
        <p className="rb-chips">
          {/* 红黑**合成一颗**(2026-09-30,用户:「把『红 166』『黑 73』合成一颗」)。
              ⚠ 0 的那一侧不出现(原来两颗也是各自这样判的):「红 166 · 黑 73」/「红 3」/「黑 2」;
                两颗都是 0 时整颗不渲染。
              ⚠ 里面是**三个 span 而不是一个字符串**:红 / 黑各自的颜色线索必须留着
                (原来是两颗各带配色的胶囊,合成一颗不该把这条线索丢掉)。
              ⚠ 分隔符的文本就是 `{" · "}` —— 一个字符都不多不少:`textContent` 会拼成
                「红 166 · 黑 73」,而 E2E 是**逐字**比对它的(换行与缩进都会算进去,所以
                这几个 span 写在同一行、不加任何额外空白)。 */}
          {(counts.red > 0 || counts.black > 0) && (
            <span className="rb-chip rb-chip--tally">
              {counts.red > 0 && <span className="rb-tally__red">红 {counts.red}</span>}
              {counts.red > 0 && counts.black > 0 && <span className="rb-tally__sep">{" · "}</span>}
              {counts.black > 0 && <span className="rb-tally__black">黑 {counts.black}</span>}
            </span>
          )}
        </p>
        {/* ⚠ 2026-10-14:这一整块**暂存区**（`.rb-tray` + 红/黑两枚 `.rb-src` + 那层
            `.rb-tray-lock` 拦截层）**已删**（PLAN-20261014190000，用户:「取消贴贴纸所有行为」）。
            它原来承担的是「挑一枚贴纸、点一下随机贴、或者拖到画布上」—— 三件事现在全归快速投票：
            投票那一刻落点与皮肤都随机，用户不再挑选、也不再搬运。
            ⚠ 于是「未标记时是真 disabled、并用拦截层解释为什么点不动」那套（2026-09-29 / 2026-10-07
              两次修订）也一并作废：按钮没了，就没有「点了没反应」可言。 */}
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
        <StickerCanvas filmKey={film.key} counts={others} skins={crowdSkins} inView={inView} />
        {myStickers.map((sticker) => {
          // 这一枚用哪款：存了就用存的，没存就按 id 兜底（老贴纸 / 刚迁移过来）。
          // ⚠ 解析只有这一处（`resolveSkin` 内含白名单），不要在这里自己写 `sticker.skin ?? …`。
          const skin = resolveSkin(sticker.id, sticker.skin);
          return (
            /* ⚠ 2026-10-14:**它只是画**，不再是一根手柄（PLAN-20261014190000，用户:「取消贴贴纸所有行为」）。
               改前它是一个 `<button>`：双击收回、长按开换款轮盘、拖动挪位置、方向键微调 ——
               四件事现在全都不存在了，所以退回 `<span>`：没有指针、没有键盘、没有浮层，
               也就不存在「碰它什么都不发生」这种半截状态。
               ⚠ 但仍然**单独画**（不进 canvas 那层群点）：落点、角度、皮肤都是我自己的，
                 而它身上那两圈描边（刚贴下闪一下 + 常驻纸白边）正是用来在一片密集群点里认出它。
               ⚠ 不给 `aria-hidden`：读屏应当知道「我在这里贴了一枚红贴纸」，只是它不可交互 ——
                 所以是 `role="img"` + 一句 `aria-label`，而不是一个能聚焦的按钮。 */
            <span
              key={sticker.id}
              ref={freshRef}
              role="img"
              className={`rb-dot rb-dot--${sticker.type}`}
              data-rb-fresh={fresh || undefined}
              style={
                {
                  left: `${sticker.posX * 100}%`,
                  top: `${sticker.posY * 100}%`,
                  "--rb-tilt": `${tiltOf(sticker.id)}deg`,
                } as CSSProperties
              }
              aria-label={`我贴的${sticker.type === "red" ? "红" : "黑"}贴纸`}
            >
              <StickerFace skin={skin} />
            </span>
          );
        })}
        {/* 没有票时的引导。
            ⚠ 2026-10-14:原来它按 `marked` 分两句话(「点左边的红 / 黑，或把贴纸拖进来」vs
              「标记「看过」即可贴」)—— 两档现在合成**一句**,因为改数据的入口只剩快速投票一处,
              而这句话要说的就是「去哪儿投」。
            ⚠ 节点**仍然渲染**、条件**仍然只看票数**,不要顺手加条件:它挂在画布中央,
              一收一放会让卡片内容跳一下(与 hero 那条空榜引导同一个理由)。
              样式(何时淡入)由 CSS 的 `.rb-canvas-hint` 管,JS 这边一个字都不用改。 */}
        {myStickers.length === 0 && others.total === 0 && (
          <span className="rb-canvas-hint">点「快速投票」投一枚</span>
        )}
      </div>

      {talkOpen && (
        // ⚠ `Suspense` 写在条件**内部**:不打开时连边界都不挂,不多包一层没有内容的边界
        <Suspense fallback={null}>
          <LazyFilmCommentsDialog
            film={film}
            /* ⚠ 给**这一部的全体票数**(`all`,已按本地视角修正过):讨论区顶上那行
               「红 N · 黑 N」必须与卡片上那两个数字**同源**,否则刚贴一枚还没上报时两处会打架。 */
            counts={all}
            /* ⚠ `mine` 只用来**预填文本框**:列表里认不出自己那条(服务端不回身份),
               本地是唯一知道「我写了什么」的地方;没贴过就是 `undefined`(不能评)。 */
            mine={myStickers[0]}
            onSaveComment={onSaveComment}
            onDismiss={() => setTalkOpen(false)}
          />
        </Suspense>
      )}

      {/* 讨论区入口 —— ⚠ **挂在卡片上,不挂在信息列里**(2026-09-30,用户:
          「讨论区放卡片右上角,这样贴贴纸的区域就大一点了」)。
          它原本与信息列里那串数字胶囊挤同一行,而那一行要 146px —— 信息列因此定在 158px,
          信息列的宽**就是**画布的宽。搬到角上之后列宽收到 128px,画布于是宽了 30px。
          ⚠ **恒显**(2026-09-29):0 票的片也有讨论区 ——「还没人评过」本身就是信息,
            而且第一句评语要有个入口。
          ⚠ 位置写在 `.rb-talk` 里(绝对定位到卡片右上角,压在画布角上,所以那一小块是点击死区);
            焦点归还靠 `talkBtnRef`,它搬到哪儿都跟着。 */}
      <button
        ref={talkBtnRef}
        type="button"
        className="rb-talk"
        aria-label={`打开《${film.zh}》的讨论区`}
        onClick={() => setTalkOpen(true)}
      >
        讨论区
      </button>
    </article>
  );
});

/* ⚠ 2026-10-14:原来这里还有 `canvasAt()` 与 `spotInsideSrc()`（拖拽的落点判据）——
 *   它们唯一的调用点是 `beginDrag::flush` 与 `finishRef`，而那两位已经随「贴贴纸」一起删了。
 *   现在**唯一**的手势判据是 `quick-vote.ts::resolveSwipe`（三个方向、一处阈值），
 *   所以这里不再留任何「落点算不算数」的工具函数。 */
