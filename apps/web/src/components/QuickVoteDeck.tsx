/**
 * 快速投票 —— 红黑榜的**投票入口**（2026-10-14，PLAN-20261014190000；同日修订 2）。
 *
 * 一张大海报 + 三个方向的滑动：**左滑 = 黑榜、右滑 = 红榜、上滑 = 跳过**。
 * 取代了原来那套「先标记看过 → 点暂存区的红 / 黑 → 把贴纸拖到画布上 → 用轮盘换肤」。
 *
 * ⚠ 判定与顺序**不在这里**：`quick-vote.ts` 是纯逻辑（方向判定 / 候选排序 / 三态命名），
 *   本文件只负责把已经定好的意图**演出来**并叫一次 `onVote`。
 *   这样「左滑到底算黑还是算跳过」这种口径只有一份实现，且有一条不依赖浏览器的回归测试。
 *
 * ⚠ **上滑不写任何状态**（2026-10-14 修订）：`axisVote("up")` 返回 `null`，本文件对它
 *   连 `onVote` 都不调 —— 只把卡片送走、把这一张记进撤销栈。用户口径「跳过不应覆盖原有评价」。
 *   ⚠ 修订 5：跳过**会**被记一笔「我翻过这一张」（`onSkip`，落 localStorage）——
 *     那**不是**一个投票状态（红 / 黑那本账一个字都不动），只是让这一张下次不再出现在队列里。
 *     撤销一步是跳过时要把这一笔撤掉（`onUnskip`），否则「撤回了却再也不出现」。
 *
 * ⚠ **一轮开始时**就按 `handledOf` 去掉已经处理过的片（投过 / 跳过过，修订 5）——
 *   划的过程中**不再**过滤：刚划掉的那一张若当场消失，后面所有卡的索引会整体前移。
 *   「候选换了没有」的判据是 `deckSignature`（key 序列）而**不是**数组引用 —— 上游每次
 *   重算 `useMemo` 都会造一个新数组（票数刷新就是其中之一），拿引用当判据会让用户划到一半
 *   被甩回第 1 张（2026-10-14 用户报的「5/50 → 1/50」）。
 *
 * ⚠ **2026-10-15（`PLAN-20261015005652`，用户四条）**：
 *  ① **不叫「喜欢 / 不喜欢」**：这一屏是红黑榜的投票入口，所以图例与那三枚按钮一律用
 *     「黑榜 / 红榜」（用户：「不能叫喜欢/不喜欢 应该叫红黑吧 因为是红黑榜的」）；
 *  ② **默认候选 = 全站有过票的影片**（`DeckSource = "voted"`），用户有行程时给一枚
 *     「换成我的行程」的切换（用户：「默认直接所有有过票的都作为滑动的片单…如果用户有片单
 *     你可以提示他 切换成自己的行程片单」）；
 *  ③ **「跳过」那两个字挪到海报下面**（常驻图例那一行，`data-qv-skip-live`）——
 *     它原来压在卡片顶部，而卡片整张会往上飞出屏幕，那两个字的提示当场就没了
 *     （用户：「往上滑就看不到跳过那两个字了」）。那一行不跟手飞走，所以它在；
 *  ④ **总结页给一条「去搜索」的出口**：划完还没看到自己看过的那部（多半是冷门片不在候选里）时，
 *     提示可以用片名 / 场次编号搜，并给一枚按钮关掉卡片、把焦点送到页面上的搜索框。
 *
 * ⚠ a11y 不自造：`role=dialog` / aria-modal / focus trap / Esc 由 S2 的 `Dialog` 提供（§5）。
 *   滑动**只是快捷方式**：下面那排按钮与方向键走的是同一条 `commit`，所以不存在「只有能手滑才能用」。
 *   ⚠ **输入框聚焦时不接键盘**（`isTypingTarget`）：这条卡片是弹层，弹层里将来可能长出输入框
 *     （评语），而现在它就挂在全局 `window` 上 —— 不筛的话在输入框里按左方向键会「投一票」。
 *
 * ⚠ 两端动效**刻意不同**（用户明确要求）：左滑是**碎片飞散**（12 块海报各飞各的），
 *   右滑是**盖章 + 整卡右滑**（红环从中心扩散）。上滑是**最朴素的一种**（整卡上移淡出）——
 *   它不改变任何状态，最不该抢戏。三者都读 `prefers-reduced-motion`。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FilmNode } from "../app/model";
import {
  axisVote,
  deckSignature,
  deckSourceLabel,
  deckStateOf,
  pendingQueue,
  resolveSwipe,
  showCodesOf,
  swipeProgress,
  voteStateLabel,
  type DeckSource,
  type SwipeAxis,
} from "../quick-vote";
import type { StickerType } from "../redblack";
import { Button, ButtonGroup, Content, Dialog, DialogContainer, Heading } from "./spectrum";
import "./quick-vote.css";

/** 落定动画时长（毫秒）。⚠ 与 `quick-vote.css` 里那几段 keyframes 的 `animation-duration` **必须一致** ——
 *  这里超时推进卡片、那里负责播完，差太多会出现「动画没播完卡就没了」或「卡停在原地等」。
 *  ⚠ 规格给的是 250–350ms，取中值 300：再短读不出方向，再长会觉得卡片「粘手」。 */
const LEAVE_MS = 300;
/** 动效敏感时的时长：只做一次淡出，快得多 */
const LEAVE_MS_REDUCED = 160;
/** 碎片网格 4 × 3 = 12 块。再少看不出「碎」，再多在手机上掉帧。 */
const SHARD_COLS = 4;
const SHARD_ROWS = 3;
const SHARD_COUNT = SHARD_COLS * SHARD_ROWS;
/** 牌堆里**后面**最多露出几张。取 2：再多在手机上一张也看不清，只是更长的影子。 */
const STACK_DEPTH = 2;

/** 动效敏感 —— 仓库既有的读法（`RedBlackPage` / `ScheduleGantt` 都是就地读，没有共享 hook）。
 *  ⚠ 在**要开始播那段动画**的那一刻现读，而不是挂载时存一份：系统设置可以在页面开着时被改。 */
function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** 触觉反馈。⚠ 只在设备**支持**时才响，而且它只是**加强**、不是唯一反馈：
 *  这一下同时还有「卡片飞出去 + 标记高亮 + 计数变化」，任何一条单独都够用。 */
function buzz(ms: number): void {
  if (typeof navigator === "undefined") return;
  const vibrate = navigator.vibrate?.bind(navigator);
  if (!vibrate) return;
  try {
    vibrate(ms);
  } catch {
    /* 有的浏览器在没有用户手势时直接抛 —— 触觉是加分项，不许它把投票打断 */
  }
}

/** 焦点在可输入元素里吗 —— 决定要不要吃掉方向键 / 空格。
 *  ⚠ 判据是 **`document.activeElement` 而不是事件 `target`**：键盘事件的 target 是**聚焦元素本身**，
 *    两者在正常情况下一致；但 `activeElement` 在**影子 DOM** 里也是对的（`target` 会是宿主），
 *    而将来弹层里长出 `slot` / 自定义元素时，宿主那一层读不到 `isContentEditable`。 */
function isTypingTarget(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement;
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable;
}

/** 每块碎片自己的飞散方向 —— 用 `(卡序号, 碎片序号)` 推出来，**不用 `Math.random`**：
 *  随机的话同一次渲染里重算就会「碎一半又跳一下」，而且单测 / 快照没法复现。 */
function shardVector(cardIndex: number, shardIndex: number): { dx: number; dy: number; rot: number } {
  let seed = (cardIndex + 1) * 2654435761 + (shardIndex + 1) * 40503;
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  const spread = (((seed % 1000) + 1000) % 1000) / 1000;
  const col = shardIndex % SHARD_COLS;
  const row = Math.floor(shardIndex / SHARD_COLS);
  const towardEdge = (col / (SHARD_COLS - 1) - 0.5) * 2;
  const vertical = (row / (SHARD_ROWS - 1) - 0.5) * 2;
  return {
    dx: -140 - spread * 100 + towardEdge * 60,
    dy: vertical * 80 + (spread - 0.5) * 70,
    rot: towardEdge * 80 + spread * 160 - 80,
  };
}

/** 撤销栈里的一条。`after === null` = 那一次是**跳过**（没写东西，撤销只需退回去一张）。 */
interface Step {
  key: string;
  /** 操作**之前**的状态；`undefined` = 本来没有（撤销 = 把那一枚撤掉） */
  before: StickerType | undefined;
  /** 那一次真的写了状态没有（跳过就是 `false`） */
  wrote: boolean;
  /** 那一次**写了哪一色**（`null` = 跳过）。
   *  ⚠ 只用来把撤回区那句话写准（「已投红榜」）—— `wrote` 只说「写没写」，
   *    说不出「写成什么」，而用户要看的正是后者（2026-10-14，PLAN-20261014205414）。 */
  after: StickerType | null;
}

interface QuickVoteDeckProps {
  /** 候选：已排好序。⚠ **顺序与成员都由调用方定**
   *  （默认「全站有过票的影片」，用户切过来时是「我的行程」，两者都空才是热门榜 TOP50）。
   *  这里给的是**全量候选** —— 「已经处理过的不再出现」由本文件按 `handledOf` 在**一轮开始时**过滤。 */
  queue: readonly FilmNode[];
  /** 这一轮按哪一份候选划 —— 只用来显示来源说明与切换入口（口径在 `quick-vote.ts::DeckSource`）。 */
  source: DeckSource;
  /** 候选**还没到**（票数还没结算 / 兜底那份还在路上）。⚠ 与「候选是空的」必须分开说：
   *  混成一句话会让用户以为「真的没有候选」，跑去加片，其实再等一秒就有。 */
  loading: boolean;
  /** 还能切到哪一份候选（`null` = 没有另一份可切，那一行就不渲染）。 */
  switchTo: DeckSource | null;
  /** 切过去。⚠ 换来源 = 换整轮候选，`deckSignature` 会变、卡片从第 1 张重开（那是应然）。 */
  onSwitchSource: (next: DeckSource) => void;
  /** 影片 key → 我当前的票；`undefined` = 未决定 */
  voteOf: (key: string) => StickerType | undefined;
  /** 影片 key → **已经处理过没有**（投过红黑 / 跳过过）—— 只在**一轮开始时**读一次，见文件头。 */
  handledOf: (key: string) => boolean;
  /** 一次表态（红 / 黑）。**跳过不调它** —— 见文件头。 */
  onVote: (key: string, intent: StickerType) => void;
  /** 撤销一次表态：把这一部恢复到 `before`（`undefined` = 把那枚贴纸撤掉）。 */
  onRestore: (key: string, before: StickerType | undefined) => void;
  /** 记一笔「这一张我跳过过」—— 它**不是**投票状态，只让这一张下次不再进队列。 */
  onSkip: (key: string) => void;
  /** 撤销那笔跳过（撤销一步是跳过时要跟着撤，否则「撤回了却再也不出现」）。 */
  onUnskip: (key: string) => void;
  /** 总结页那条出口：关掉卡片并去搜索（关卡片与送焦点都由调用方做，本文件只管叫一声）。 */
  onSearchFilm: () => void;
  onDismiss: () => void;
}

export function QuickVoteDeck({
  queue,
  source,
  loading,
  switchTo,
  onSwitchSource,
  voteOf,
  handledOf,
  onVote,
  onRestore,
  onSkip,
  onUnskip,
  onSearchFilm,
  onDismiss,
}: QuickVoteDeckProps) {
  /** 这一轮要走过的卡片 = 候选去掉**已经处理过**的片（投过 / 跳过过，修订 5）。
   *  ⚠ 与 `queue` 分开：这一轮**开始之后就不再变**（判据见下面那个 effect），
   *    而总结页那条「重新浏览未评价影片」还要在它内部再收窄一次。 */
  const [round, setRound] = useState<readonly FilmNode[]>(() => pendingQueue(queue, handledOf));
  const [index, setIndex] = useState(0);
  const [history, setHistory] = useState<readonly Step[]>([]);
  // 拖动中的位移。⚠ 它是**渲染用**的状态（卡片要跟着手指），判定那条路用的是 `resolveSwipe(dx, dy, unit)`
  const [delta, setDelta] = useState({ dx: 0, dy: 0 });
  const [leaving, setLeaving] = useState<SwipeAxis | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; unit: number } | null>(null);
  /** 「这一张已经在落定了」—— 防止动画期间又被一次指针 / 键盘事件推进两张 */
  const committing = useRef(false);
  /** 最新的候选 / 已处理判据 —— effect 里要读它们，但**不能**把它们写进依赖（见下）。 */
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const handledRef = useRef(handledOf);
  handledRef.current = handledOf;
  /** 队列的**内容身份**（key 序列）—— 「候选换了没有」的判据，**不是**数组引用。 */
  const signature = deckSignature(queue);

  // ⚠ 候选**真的**换了（内容变了：兜底数据到达 / 用户在别处改了行程）→ 整轮重来。
  //   不重置的话 `index` 会指向新数组里**另一部片**，读起来像「卡片自己跳了」。
  //   ⚠ 判据是 `signature`（内容）而不是 `queue`（引用）：引用变了但 key 序列没变时**不重开** ——
  //     否则「投一票 → 上报成功 → 票数聚合换引用 → `deck` 重算」就会把用户划到一半的卡片
  //     甩回第 1 张（2026-10-14 用户报的「5/50 → 1/50」，根因在上游的依赖，这里是第二道防线）。
  useEffect(() => {
    setRound(pendingQueue(queueRef.current, handledRef.current));
    setIndex(0);
    setHistory([]);
    setLeaving(null);
    setDelta({ dx: 0, dy: 0 });
  }, [signature]);

  const card = round[index];
  const unitOf = useCallback((): number => {
    const box = surface.current?.getBoundingClientRect();
    if (!box) return 0;
    return Math.min(box.width, box.height);
  }, []);

  /** 一次落定。`axis === "up"` 就是**跳过**：不调 `onVote`、不碰任何数据。 */
  const commit = useCallback(
    (axis: SwipeAxis) => {
      if (committing.current) return;
      const current = round[index];
      if (!current) return;
      committing.current = true;
      const intent = axisVote(axis);
      const before = voteOf(current.key);
      setLeaving(axis);
      if (intent) {
        onVote(current.key, intent);
        setHistory((prev) => [...prev, { key: current.key, before, wrote: true, after: intent }]);
        // ⚠ 触觉只在**真的写了一张票**时响：跳过不是一次表态，给它一次震动会读成「我投了」。
        buzz(12);
      } else {
        // ⚠ 跳过**不是**投票状态（红 / 黑那本账一个字都不动），但要记一笔「这一张我翻过」——
        //   否则下次打开又从它开始（修订 5）；撤销那一步时要把这一笔撤掉（见 `undo`）。
        onSkip(current.key);
        setHistory((prev) => [...prev, { key: current.key, before, wrote: false, after: null }]);
      }
      const wait = reducedMotion() ? LEAVE_MS_REDUCED : LEAVE_MS;
      window.setTimeout(() => {
        committing.current = false;
        setLeaving(null);
        setDelta({ dx: 0, dy: 0 });
        setIndex((currentIndex) => currentIndex + 1);
      }, wait);
    },
    [index, onSkip, onVote, round, voteOf],
  );

  /** 撤销一步：**先恢复数据、再退回上一张**。
   *  ⚠ 顺序不能反：`onRestore` 会换掉 `board`，而 `voteOf` 读的正是它 ——
   *    先退卡片的话，那一张会在同一帧里以「恢复前」的状态重绘一次（闪一下旧票）。 */
  const undo = useCallback(() => {
    if (committing.current) return;
    const last = history[history.length - 1];
    if (!last) return;
    if (last.wrote) onRestore(last.key, last.before);
    else onUnskip(last.key);
    setHistory((prev) => prev.slice(0, -1));
    setIndex((prev) => Math.max(0, prev - 1));
    setDelta({ dx: 0, dy: 0 });
  }, [history, onRestore, onUnskip]);

  // ⚠ 键盘等价路径：指针玩不了的那一半用户（以及桌面上的鼠标用户）走这里。
  //   ⚠ 空格 / 方向键都是**页面级**快捷键，必须先问「用户是不是在打字」——
  //     这条卡片是弹层，它自己将来会长出输入框（评语），而监听挂在 `window` 上。
  //   ⚠ 撤销另给 `Cmd/Ctrl+Z`：撤销按钮在，但那个组合键是**通用约定**，不给会显得缺一块。
  //   ⚠ `Esc` 不在这里处理 —— 它是 S2 `DialogContainer` 的职责，自造一份会与它抢。
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isTypingTarget()) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const axis: SwipeAxis | null =
        event.key === "ArrowLeft"
          ? "left"
          : event.key === "ArrowRight"
            ? "right"
            : event.key === "ArrowUp" || event.key === " "
              ? "up"
              : null;
      if (!axis) return;
      event.preventDefault();
      commit(axis);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [commit, undo]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (committing.current || !card) return;
    // 只认主键：多指（双指缩放）与右键不该被读成一次投票
    if (event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, unit: unitOf() };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    setDelta({ dx: event.clientX - current.x, dy: event.clientY - current.y });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    const { dx, dy } = delta;
    const axis = resolveSwipe(dx, dy, current.unit);
    // ⚠ 不到阈值 / 方向含混 → 什么也不做，卡片自己弹回原位（CSS 的 transition 负责那一下）
    if (!axis) {
      setDelta({ dx: 0, dy: 0 });
      return;
    }
    commit(axis);
  };

  const unit = unitOf();
  const progress = leaving ? 1 : swipeProgress(delta.dx, delta.dy, unit);
  // 判定「现在亮的是哪一边」——与落定**同一套阈值**（不另写一份）
  const hint: SwipeAxis | null = leaving ?? resolveSwipe(delta.dx, delta.dy, unit);
  const dragging = drag.current !== null || leaving !== null;
  /** 标记强度：只由**朝那一侧的位移**驱动，所以往右拖时「红」渐显、往左拖时「黑」渐显，
   *  两者不会同时亮。⚠ 用比值而不是 `progress`：`progress` 是二维长度，斜着拖会让两边一起亮。 */
  const toward = unit > 0 ? Math.min(1, Math.abs(delta.dx) / (unit * 0.28)) : 0;
  const redGlow = delta.dx > 0 ? toward : 0;
  const blackGlow = delta.dx < 0 ? toward : 0;

  const done = round.length > 0 && index >= round.length;
  /** 撤销栈顶那一步 —— 撤回区那句回执读它（`undefined` = 这一轮还没划过任何一张）。 */
  const last = history[history.length - 1];
  const tally = useMemo(() => {
    let liked = 0;
    let passed = 0;
    for (const film of round) {
      const vote = voteOf(film.key);
      if (vote === "red") liked += 1;
      else if (vote === "black") passed += 1;
    }
    return { liked, passed, undecided: round.length - liked - passed };
  }, [round, voteOf]);

  /** 总结页那两面板报墙。⚠ 直接复用 `round` 的顺序（那是我看片的顺序），不再按票数重排 ——
   *  这一页回答的是「我刚刚表了什么态」，不是「哪一部更受欢迎」。 */
  const likedFilms = round.filter((film) => voteOf(film.key) === "red");
  const passedFilms = round.filter((film) => voteOf(film.key) === "black");

  /** 「候选是空的」那句说明 —— 按**来源**分别说（口径在 `quick-vote.ts::DeckSource`）。
   *
   *  ⚠ 三种「空」必须分开说（修订 5 加了第三种）：
   *    ① **候选还没到**（`loading`）—— 票数 / 兜底数据是**异步**来的，说成「没有候选」
   *       会把用户支去加片，其实再等一秒就有了；
   *    ② **候选本身是空的** —— 按来源说清「该去哪儿加片」，含糊一句会让人以为哪儿都没片；
   *    ③ **候选有、但都被过滤掉了** = 这一批我全划过一遍了（投过 / 跳过过，见上面的分支）。 */
  const emptyMessage = (): string => {
    if (loading) return "正在取候选…稍等一下。";
    if (source === "agenda") {
      return "「我的行程」还是空的 —— 先把想看的场次加进行程，再回来快速投票。";
    }
    if (source === "voted") {
      return "榜上还没有人投票 —— 先去「我的行程」挑几部，或者到榜单上点一枚贴纸。";
    }
    return "榜上还没有人投票，你的行程也是空的 —— 先去「我的行程」挑几部。";
  };

  /** 「重新浏览未评价影片」：把范围收窄到**还没决定**的那些。一片都没剩时按钮禁用。 */
  const undecided = round.filter((film) => voteOf(film.key) === undefined);
  const restartUndecided = () => {
    if (!undecided.length) return;
    setRound(undecided);
    setIndex(0);
    setHistory([]);
  };
  /** 「再划一遍」= 拿回**不过滤**的全量候选。⚠ 这是唯一一条「已经处理过的片重新出现」的路，
   *  所以它必须是**用户主动点**的（修订 5 的口径是「划过的不再出现」，而这一颗按钮就是
   *  「我就是要重划一遍」）。 */
  const restartAll = () => {
    setRound(queue);
    setIndex(0);
    setHistory([]);
  };

  /** 叠在海报底部的那四行信息（2026-10-15，`PLAN-20261015005652` 修订 1）——
   *  对 `73bb53f`（「最好只保留纯海报」）的**部分收回**：用户这次明确要
   *  「中英文名 导演名称 然后 code」，不是把整层文字都要回来（单元 / 国家 / 年份 / 场次时间 /
   *  全站票数 / 简介**仍然不印**）。
   *  ⚠ CODE 那一行**印全部场次编号**、用 `/` 连（"024/099"），且**不带「CODE 」前缀** ——
   *    2026-10-15 修订 3，用户原话：「code 应该需要显示成 004/008 这样 而不是显示成 CODE 004
   *    这样而且丢了其他场次」。口径的实现只有 `quick-vote.ts::showCodesOf` 一处。
   *    它取的是**场次编号**（`Screening.code`），**不是** `map?.subject_id`（那是豆瓣 subject id）；
   *    没有排期的目录片这一行不渲染。
   *  ⚠ 导演取 `cats[0]?.director`：`FilmNode.cats` 是这部片命中的全部目录条目，
   *    同一部片不会有两个不同导演，取第一条即可（与 `util.ts::catMetaLine` 同一来源）。 */
  const infoOf = (film: FilmNode) => {
    const director = film.cats[0]?.director;
    const codes = showCodesOf(film);
    return (
      <div className="qv-info" aria-hidden="true">
        <p className="qv-info-zh">{film.zh}</p>
        {film.en && film.en !== film.zh && <p className="qv-info-en">{film.en}</p>}
        {director && <p className="qv-info-director">导演 {director}</p>}
        {codes && <p className="qv-info-code">{codes}</p>}
      </div>
    );
  };

  /** 只画海报本身（背后那叠 `.qv-ghost` 用它 —— 被压在最前面那张卡下面、大半截挡住，
   *  叠信息层只会看着像乱码，而且它本来就 `aria-hidden`，不需要额外内容）。
   *  ⚠ `alt` 必须是片名：这是读屏用户在**当前**那张卡上的来源（见下面 `cardFaceOf`）。
   *  ⚠ 没有海报时兜底画**完整片名**（不是首字母）—— 那张卡的底色上没有别的东西了。 */
  const posterOf = (film: FilmNode) =>
    film.poster ? (
      <img className="qv-poster" src={film.poster} alt={film.zh} draggable={false} />
    ) : (
      <span className="qv-poster qv-poster--none">{film.zh}</span>
    );

  /** **当前**那张卡的内容：海报 + 叠在底部的那四行信息。只给最前面这一张用 —— 见上。 */
  const cardFaceOf = (film: FilmNode) => (
    <>
      {posterOf(film)}
      {infoOf(film)}
    </>
  );

  return (
    <DialogContainer onDismiss={onDismiss}>
      <Dialog size="L">
        <Heading slot="title">快速投票</Heading>
        <Content>
          <div className="qv" data-qv-done={done ? "" : undefined}>
            {round.length === 0 ? (
              /* ⚠ 三种「空」必须分开说（修订 5 加了第三种）：
                 ① 候选有、但都被过滤掉了 = 这一批我全划过一遍了（投过 / 跳过过）——
                    这种说成「没有候选」会把用户支去加片，说成「正在取候选」会让他一直干等；
                 ② 候选本身是空的 / 还没到 —— 两者的区分在 `emptyMessage` 里，见它的注释。 */
              queue.length > 0 ? (
                <>
                  <p className="qv-empty">这一批候选你都划过一遍了。想改票，去榜单上点那一枚贴纸。</p>
                  <ButtonGroup>
                    <Button variant="secondary" onPress={restartAll}>
                      再划一遍
                    </Button>
                  </ButtonGroup>
                </>
              ) : (
                <p className="qv-empty">{emptyMessage()}</p>
              )
            ) : done ? (
              /* ---------------- 总结页 ----------------
               * ⚠ 三个计数都按**这一轮**算，不按全站：它回答的是「我刚刚划了些什么」。
               * ⚠ 底部两个动作分别对应「还没评价完」与「看结果」——**不强迫**评价全部影片，
               *    跳过的片子就在「未决定」里待着，随时可以从这儿回去接着划。 */
              <div className="qv-summary" data-qv-summary="">
                <p className="qv-summary-title">这一轮划完了</p>
                <p className="qv-summary-line">
                  红榜 <strong data-qv-count="liked">{tally.liked}</strong> · 黑榜{" "}
                  <strong data-qv-count="passed">{tally.passed}</strong> · 未决定{" "}
                  <strong data-qv-count="undecided">{tally.undecided}</strong>
                </p>
                <div className="qv-walls">
                  <section className="qv-wall" aria-label="我的红榜">
                    <h3 className="qv-wall-title">红榜 {likedFilms.length}</h3>
                    <ul className="qv-wall-grid">
                      {likedFilms.map((film) => (
                        <li key={film.key} className="qv-wall-cell" data-qv-wall="liked">
                          {film.poster ? (
                            <img src={film.poster} alt={film.zh} loading="lazy" />
                          ) : (
                            <span className="qv-wall-none">{film.zh}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                  <section className="qv-wall" aria-label="我的黑榜">
                    <h3 className="qv-wall-title">黑榜 {passedFilms.length}</h3>
                    <ul className="qv-wall-grid">
                      {passedFilms.map((film) => (
                        <li key={film.key} className="qv-wall-cell" data-qv-wall="passed">
                          {film.poster ? (
                            <img src={film.poster} alt={film.zh} loading="lazy" />
                          ) : (
                            <span className="qv-wall-none">{film.zh}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                </div>
                {/* 「我划完了还是没看到我看过的那部」—— 冷门片多半两边都没沾上（候选是「榜上有票的」
                    与「我的行程」）。用户 2026-10-15：「你需要提示他 类似于没有找到自己看过的电影吗
                    尝试通过 CODE 搜索」。
                    ⚠ 那枚按钮**不能只关卡片**：卡片是弹层、搜索框在它后面，只关掉的话用户还得自己找一圈。
                      所以它叫的是 `onSearchFilm`（关卡片 + 把焦点送进搜索框），两件事都由调用方做。 */}
                <div className="qv-missing">
                  <p className="qv-missing-text">
                    没找到你看过的那部？用<strong>片名或场次编号（CODE）</strong>搜一下，搜得到就能投。
                  </p>
                  <button type="button" className="qv-missing-btn" onClick={onSearchFilm}>
                    关掉卡片去搜索
                  </button>
                </div>
                <ButtonGroup>
                  <Button variant="secondary" onPress={restartUndecided} isDisabled={!undecided.length}>
                    重新浏览未评价影片
                  </Button>
                  <Button variant="secondary" onPress={restartAll}>
                    再划一遍
                  </Button>
                  <Button onPress={onDismiss}>查看我的榜单</Button>
                </ButtonGroup>
              </div>
            ) : (
              <>
                <p className="qv-counter">
                  第 {index + 1} / {round.length} 部 · {card.title}
                </p>
                {/* 候选来源那一行（2026-10-15，用户：「如果用户有片单 你可以提示他 切换成自己的行程片单」）。
                    ⚠ **只在有得切、或要说清兜底时才渲染**：它是给用户的一句提示 + 一个入口，
                      不是「当前状态仪表盘」—— 恒显会让这一屏白白多占一行，而矮屏上
                      「整块不用滚」的预算很紧（见 `quick-vote.css` 里那几档 `dvh`）。 */}
                {switchTo !== null || source === "hot" ? (
                  <p className="qv-source">
                    {switchTo === null ? (
                      <span className="qv-source-label">
                        榜上还没有人投票 —— 先按「{deckSourceLabel(source)}」给你划。
                      </span>
                    ) : (
                      <>
                        <span className="qv-source-label">
                          {source === "voted" ? "正在按全部有票的影片划" : "正在按你的行程划"}
                        </span>
                        {/* 换来源 = 换整轮候选（`deckSignature` 变、卡片从第 1 张重开）——
                            这是**用户主动点**的，所以可以接受；被动换（票数到达）才是要避免的。 */}
                        <button
                          type="button"
                          className="qv-source-switch"
                          onClick={() => onSwitchSource(switchTo)}
                        >
                          {switchTo === "agenda" ? "换成我的行程" : "换成全部有票的"}
                        </button>
                      </>
                    )}
                  </p>
                ) : null}
                <div className="qv-stage" data-qv-state={deckStateOf(voteOf(card.key))}>
                  {/* 后面那两张：**只是影子**（`aria-hidden`），作用是说清「还有下一张」。
                      它们不接指针 —— 真正的落点判定全在当前那张卡上。 */}
                  {round
                    .slice(index + 1, index + 1 + STACK_DEPTH)
                    .reverse()
                    .map((film, offset, list) => {
                      // 越靠后越小、越往下：`offset` 是**倒着**来的，所以深度要反过来算
                      const depth = list.length - offset;
                      return (
                        <div
                          key={film.key}
                          className="qv-ghost"
                          data-qv-depth={depth}
                          style={{ transform: `translateY(${depth * 10}px) scale(${1 - depth * 0.04})` }}
                          aria-hidden="true"
                        >
                          {posterOf(film)}
                        </div>
                      );
                    })}
                  <div
                    ref={surface}
                    className={`qv-card${dragging ? " qv-card--dragging" : ""}${
                      leaving ? " qv-card--leaving" : ""
                    }`}
                    data-qv-leave={leaving ?? undefined}
                    data-qv-index={index}
                    data-qv-key={card.key}
                    style={{
                      transform: leaving
                        ? undefined
                        : `translate(${delta.dx}px, ${delta.dy}px) rotate(${delta.dx * 0.05}deg)`,
                    }}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                  >
                    {cardFaceOf(card)}
                    {leaving === "left" &&
                      card.poster &&
                      Array.from({ length: SHARD_COUNT }, (_, shard) => {
                        const col = shard % SHARD_COLS;
                        const row = Math.floor(shard / SHARD_COLS);
                        const vector = shardVector(index, shard);
                        return (
                          <span
                            key={shard}
                            className="qv-shard"
                            aria-hidden="true"
                            style={{
                              backgroundImage: `url(${card.poster})`,
                              backgroundSize: `${SHARD_COLS * 100}% ${SHARD_ROWS * 100}%`,
                              backgroundPosition: `${(col * 100) / (SHARD_COLS - 1)}% ${
                                (row * 100) / (SHARD_ROWS - 1)
                              }%`,
                              left: `${(col * 100) / SHARD_COLS}%`,
                              top: `${(row * 100) / SHARD_ROWS}%`,
                              width: `${100 / SHARD_COLS}%`,
                              height: `${100 / SHARD_ROWS}%`,
                              ["--qv-dx" as string]: `${vector.dx}px`,
                              ["--qv-dy" as string]: `${vector.dy}px`,
                              ["--qv-rot" as string]: `${vector.rot}deg`,
                            }}
                          />
                        );
                      })}
                    {leaving === "right" && <span className="qv-stamp" aria-hidden="true" />}
                    {/* 「加入红榜 / 加入黑榜」两枚标记：**跟着拖动距离渐显**（用户明确要求
                        「颜色、透明度和标记强度随拖动距离渐进变化，而不是等松手后才出现」）。
                        ⚠ 强度由 `redGlow` / `blackGlow` 给，而它只读**朝那一侧**的位移 —— 见上面。
                        ⚠ 第三枚「跳过」**已撤**（2026-10-15，用户：「跳过的那个提示 应该显示在海报下面
                          不然往上滑就看不到跳过那两个字了」）—— 它原来压在卡片顶部，而卡片整张会往上
                          飞出屏幕，那两个字的提示当场就没了。现在由下面那一行常驻图例承担
                          （`data-qv-skip-live`），它不跟手飞走。 */}
                    <span
                      className="qv-mark qv-mark--right"
                      data-qv-mark="liked"
                      style={{ opacity: redGlow * 0.95 }}
                      aria-hidden="true"
                    >
                      加入红榜
                    </span>
                    <span
                      className="qv-mark qv-mark--left"
                      data-qv-mark="passed"
                      style={{ opacity: blackGlow * 0.95 }}
                      aria-hidden="true"
                    >
                      加入黑榜
                    </span>
                    {/* ⚠ 2026-10-14（用户：「海报上的信息太多了 …… 最好只保留纯海报」）→
                        2026-10-15 部分收回（用户：「中英文名 导演名称 然后 code 就行」）：
                        单元 / 国家 / 年份 / 场次时间 / 全站票数 / 简介**仍然不印**，只叠回
                        中文名 / 英文名 / 导演 / 全部场次编号 这四行（见上面 `infoOf`），且整块 `aria-hidden`
                        （纯视觉叠层，读屏仍走 `posterOf` 的 `alt`，不会把片名念两遍）。
                        ⚠ 票数（`data-qv-mine`）仍不在卡片上 —— 它本来只是个参照；
                          要核对某部落在哪一档，退出弹层看榜单更直接（那里的卡片信息是全的）。 */}
                    <span className="qv-progress" data-qv-progress={progress.toFixed(2)} aria-hidden="true" />
                  </div>
                </div>
                {/* 常驻方向图例（2026-10-14，PLAN-20261014205414，用户朋友:「不知道左右哪个是喜欢」）。
                    ⚠ 与卡片上那两枚跟手标记**分工不同**：常驻这行回答「左右**是什么**」，
                      跟手那两枚回答「这一下**会投成什么**」。所以它不跟手、不带状态、每张卡都在。
                    ⚠ 2026-10-15 两处改（`PLAN-20261015005652`）：
                      ① 措辞从「喜欢 / 不喜欢」改成「红榜 / 黑榜」—— 这一屏是红黑榜的投票入口
                         （用户：「不能叫喜欢/不喜欢 应该叫红黑吧 因为是红黑榜的」）；「黑」在左、
                         「红」在右，与卡片上那两枚跟手标记的方向一致；
                      ② 「上滑 · 跳过」这半段**兼作跳过提示**（`data-qv-skip-live`）：它就在海报下面，
                         卡片往上飞走时它还在 —— 原来那两个字压在卡片顶部，一滑就看不见了。 */}
                <p className="qv-legend">
                  <span className="qv-legend-left">← 左滑 · 黑榜</span>
                  <span
                    className="qv-legend-skip"
                    data-qv-skip-live={hint === "up" ? "" : undefined}
                  >
                    上滑 · 跳过
                  </span>
                  <span className="qv-legend-right">右滑 · 红榜 →</span>
                </p>
                {/* 指针之外的等价入口 —— 与手势走同一条 `commit`，所以口径不可能漂移。
                    ⚠ 三颗按钮的**顺序与方向一致**（黑榜在左、红榜在右），跳过居中：这是手势的空间排布，
                      反过来会让用户按错一次就投错一票。
                    ⚠ 2026-10-15：文案从「不喜欢 / 喜欢」改成「黑榜 / 红榜」（用户：「不能叫喜欢/不喜欢
                      应该叫红黑吧 因为是红黑榜的」）。箭头保留 —— 它才是「往哪边划」那半句；
                      可访问名写成「投黑榜 / 投红榜」，读屏与 E2E 都读它。 */}
                <div className="qv-actions">
                  <Button
                    size="S"
                    variant="secondary"
                    aria-label="投黑榜"
                    onPress={() => commit("left")}
                  >
                    ← 黑榜
                  </Button>
                  <Button size="S" variant="secondary" onPress={() => commit("up")}>
                    跳过
                  </Button>
                  <Button size="S" aria-label="投红榜" onPress={() => commit("right")}>
                    红榜 →
                  </Button>
                </div>
                {/* 撤回区（2026-10-14，PLAN-20261014205414 用户:「需要指引和反悔机制」）：
                    从一枚弱按钮升级成**状态条** —— 投完说得清「刚才那一下做成了什么」。
                    ⚠ 空态也照样占位，并且把那句话说全（「划错了可以撤回」）：看不见的东西用户不会去用，
                      而撤回恰恰是投票类交互里最需要被看见的那个东西。
                    ⚠ `undo()` 本身**一个字没改**（先恢复数据再退回一张，见上面那段注释）。 */}
                <div className="qv-undo-row" role="status" aria-live="polite">
                  {last ? (
                    <>
                      <span className="qv-undo-text" data-qv-last={last.after ?? "skip"}>
                        {last.after ? voteStateLabel(last.after) : "已跳过"}
                      </span>
                      <button type="button" className="qv-undo" onClick={undo} data-qv-undo="">
                        撤回
                      </button>
                    </>
                  ) : (
                    <span className="qv-undo-idle">划错了可以撤回</span>
                  )}
                </div>
              </>
            )}
          </div>
        </Content>
        <ButtonGroup>
          <Button variant="secondary" onPress={onDismiss}>
            关闭
          </Button>
        </ButtonGroup>
      </Dialog>
    </DialogContainer>
  );
}
