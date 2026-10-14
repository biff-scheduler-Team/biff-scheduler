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
import { introOf } from "../intros";
import {
  axisVote,
  deckSignature,
  deckStateOf,
  pendingQueue,
  resolveSwipe,
  swipeProgress,
  voteStateLabel,
  type SwipeAxis,
} from "../quick-vote";
import type { StickerCounts, StickerType } from "../redblack";
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

/** 撤销栈里的一条。`vote === null` = 那一次是**跳过**（没写东西，撤销只需退回去一张）。 */
interface Step {
  key: string;
  /** 操作**之前**的状态；`undefined` = 本来没有（撤销 = 把那一枚撤掉） */
  before: StickerType | undefined;
  /** 那一次真的写了状态没有（跳过就是 `false`） */
  wrote: boolean;
}

interface QuickVoteDeckProps {
  /** 候选：已排好序。⚠ **顺序由调用方定**（行程里有片就用行程、行程为空则用热门榜 TOP50）。
   *  这里给的是**全量候选** —— 「已经处理过的不再出现」由本文件按 `handledOf` 在**一轮开始时**过滤。 */
  queue: readonly FilmNode[];
  /** 队列的来源，只用来显示一句说明。`false` = 这不是我的行程，而是热门榜兜底 */
  fromAgenda: boolean;
  /** 影片 key → 我当前的票；`undefined` = 未决定 */
  voteOf: (key: string) => StickerType | undefined;
  /** 影片 key → **已经处理过没有**（投过红黑 / 跳过过）—— 只在**一轮开始时**读一次，见文件头。 */
  handledOf: (key: string) => boolean;
  /** 影片 key → 这一部的全站票数（卡片上要显示「红 x · 黑 y」） */
  countsOf: (key: string) => StickerCounts;
  /** 一次表态（红 / 黑）。**跳过不调它** —— 见文件头。 */
  onVote: (key: string, intent: StickerType) => void;
  /** 撤销一次表态：把这一部恢复到 `before`（`undefined` = 把那枚贴纸撤掉）。 */
  onRestore: (key: string, before: StickerType | undefined) => void;
  /** 记一笔「这一张我跳过过」—— 它**不是**投票状态，只让这一张下次不再进队列。 */
  onSkip: (key: string) => void;
  /** 撤销那笔跳过（撤销一步是跳过时要跟着撤，否则「撤回了却再也不出现」）。 */
  onUnskip: (key: string) => void;
  onDismiss: () => void;
}

export function QuickVoteDeck({
  queue,
  fromAgenda,
  voteOf,
  handledOf,
  countsOf,
  onVote,
  onRestore,
  onSkip,
  onUnskip,
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
        setHistory((prev) => [...prev, { key: current.key, before, wrote: true }]);
        // ⚠ 触觉只在**真的写了一张票**时响：跳过不是一次表态，给它一次震动会读成「我投了」。
        buzz(12);
      } else {
        // ⚠ 跳过**不是**投票状态（红 / 黑那本账一个字都不动），但要记一笔「这一张我翻过」——
        //   否则下次打开又从它开始（修订 5）；撤销那一步时要把这一笔撤掉（见 `undo`）。
        onSkip(current.key);
        setHistory((prev) => [...prev, { key: current.key, before, wrote: false }]);
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

  const posterOf = (film: FilmNode) =>
    film.poster ? (
      <img className="qv-poster" src={film.poster} alt="" draggable={false} />
    ) : (
      <span className="qv-poster qv-poster--none" aria-hidden="true">
        {film.zh.slice(0, 1)}
      </span>
    );

  return (
    <DialogContainer onDismiss={onDismiss}>
      <Dialog size="L">
        <Heading slot="title">快速投票</Heading>
        <Content>
          <div className="qv" data-qv-done={done ? "" : undefined}>
            {round.length === 0 ? (
              /* ⚠ 三种「空」必须分开说（修订 5 加了第三种）：
                 ① 候选本身是空的 —— `fromAgenda` 为真 = 真的没有候选（我的行程是空的）；
                    为假 = 兜底那份（热门榜）还没到 —— 而这一支是**异步**来的。
                    混成一句话会让用户以为「行程是空的」，跑去加片，其实再等一秒就有了。
                 ② **候选有、但都被过滤掉了** = 这一批我全划过一遍了（投过 / 跳过过）——
                    这种说成「行程是空的」会把用户支去加片，说成「正在取候选」会让他一直干等。 */
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
                <p className="qv-empty">
                  {fromAgenda
                    ? "还没有可以投票的影片。先去「我的行程」把想看的场次加进来，再回来快速投票。"
                    : "正在取热门榜的候选…稍等一下。若一直不动，先把想看的场次加进「我的行程」。"}
                </p>
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
                {fromAgenda ? null : (
                  <p className="qv-source">我的行程还是空的 —— 先按热门榜 TOP 50 给你划。</p>
                )}
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
                    {posterOf(card)}
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
                        ⚠ 强度由 `redGlow` / `blackGlow` 给，而它只读**朝那一侧**的位移 —— 见上面。 */}
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
                    <span
                      className="qv-mark qv-mark--up"
                      data-qv-mark="skip"
                      style={{ opacity: hint === "up" ? 0.95 : 0 }}
                      aria-hidden="true"
                    >
                      跳过
                    </span>
                    <div className="qv-caption">
                      <p className="qv-title">{card.title}</p>
                      {card.en && card.en !== card.zh && <p className="qv-en">{card.en}</p>}
                      {/* 元信息行：**复用 `FilmNode.meta`**（单元 · 国家 · 年份 · 导演，口径在
                          `util.ts::filmInfoOf`）—— 卡片上不另拼一份，否则必与影片库 / 行程分叉。 */}
                      {card.meta && <p className="qv-meta">{card.meta}</p>}
                      <p className="qv-sub">
                        {card.shows.length
                          ? `${card.shows.length} 场 · ${card.shows[0].date} ${card.shows[0].start_time} 起${
                              card.shows[0].duration_min ? ` · ${card.shows[0].duration_min} 分钟` : ""
                            }`
                          : "目录片 · 暂无排期"}
                      </p>
                      <p className="qv-counts">
                        全站 红 {countsOf(card.key).red} · 黑 {countsOf(card.key).black}
                        {" · "}
                        <strong data-qv-mine={deckStateOf(voteOf(card.key))}>{voteStateLabel(voteOf(card.key))}</strong>
                      </p>
                      {/* 简短介绍取自现有豆瓣产物（`intros.ts::introOf`）—— **不引第二份数据**。
                          没拉到 / 没这条映射时整段不渲染，而不是画一句「暂无简介」。 */}
                      {introOf(card.map?.subject_id) ? (
                        <p className="qv-intro">{introOf(card.map?.subject_id)}</p>
                      ) : null}
                    </div>
                    <span className="qv-progress" data-qv-progress={progress.toFixed(2)} aria-hidden="true" />
                  </div>
                </div>
                {/* 指针之外的等价入口 —— 与手势走同一条 `commit`，所以口径不可能漂移。
                    ⚠ 三颗按钮的**顺序与方向一致**（黑在左、红在右），跳过居中：这是手势的空间排布，
                      反过来会让用户按错一次就投错一票。 */}
                <div className="qv-actions">
                  <Button variant="secondary" onPress={() => commit("left")}>
                    投黑榜
                  </Button>
                  <Button variant="secondary" onPress={() => commit("up")}>
                    跳过
                  </Button>
                  <Button onPress={() => commit("right")}>投红榜</Button>
                </div>
                <div className="qv-undo-row">
                  <button
                    type="button"
                    className="qv-undo"
                    onClick={undo}
                    disabled={!history.length}
                    data-qv-undo=""
                  >
                    撤销上一步
                  </button>
                </div>
                <p className="qv-help">
                  左滑投黑榜 · 右滑投红榜 · 上滑跳过（跳过不会改动已有的评价）。键盘：← → 评价，空格跳过，
                  Cmd/Ctrl + Z 撤销。
                </p>
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
