/**
 * 快速投票 —— 红黑榜投票入口的**纯逻辑**（2026-10-14，PLAN-20261014190000）。
 *
 * 这一层只管三件事，件件都可以脱开 DOM 单测：
 *  ① **候选与顺序**：从我的行程里取片单（`store.picks` 的 key 集合 → `films` 里对应的那些），
 *     已投过的**也出现**（再投一次 = 改票）；行程为空时由调用方改用热门榜候选；
 *  ② **手势 → 意图**：位移落在哪一档（左 = 黑 / 右 = 红 / 上 = **跳过**），不到阈值就是「什么也没发生」；
 *  ③ **状态的对外命名**：`undecided` / `liked` / `passed` —— 卡片角标与 E2E 都读它。
 *
 * ⚠ 这里**不碰** `StickerBoard`（那是 `redblack.ts` 的事），也**不碰** DOM。
 *
 * ⚠ **2026-10-14 修订（同日第二次）**：上滑从「记一条『没看过』」改成**纯跳过** ——
 *   `axisVote("up")` 返回 `null`，调用方据此**什么都不写**。一部片对一个人于是只剩两种取值：
 *   `red` / `black`；没有就是**未决定**，而「未决定」不是一个要存的状态，它就是 `board` 里没有这个 key。
 */

import type { FilmNode } from "./app/model";
import type { StickerType } from "./redblack";

/** 判定「算一次滑动」的最小位移，取卡片**较短边**的比例。
 *
 *  ⚠ 用比例而不是像素：同一个手势在手机（卡片窄）与桌面（卡片宽）上应当一样费力。
 *  ⚠ 取 `0.28` 的由来：再小一点会在「按住想上下扫一眼简介」时误触发，再大一点手机上要划到底才认。
 *    只调这一个数就能整体调手感，不要在组件里再散落第二个阈值。 */
export const SWIPE_RATIO = 0.28;

/** 主轴至少要压过副轴这么多倍，才认这个方向。
 *
 *  ⚠ 没有它的话，`dx = 90, dy = 88` 这种斜滑会同时「够左也够上」，
 *    判给谁完全取决于 `if` 的先后 —— 那是把一个「用户其实是随便一划」的动作
 *    变成一次**不确定的投票**。 */
export const SWIPE_AXIS_RATIO = 1.15;

/** 落定方向。`up` 之外没有 `down`：下滑**刻意**不接任何事（不是所有方向都得有含义）。 */
export type SwipeAxis = "left" | "right" | "up";

/** 位移 → 方向；**不到阈值（或方向含混）返回 `null`**，此时卡片弹回原位、什么状态都不改。
 *
 *  `unit` 是卡片的较短边（像素）。 */
export function resolveSwipe(dx: number, dy: number, unit: number): SwipeAxis | null {
  // ⚠ 布局还没量出来时 `unit` 会是 0（首帧 / 隐藏容器），此时**一律不认**：
  //   不夹这一下的话 `limit = 0`，任何一丝位移都会被判成一次投票。
  if (!(unit > 0)) return null;
  const limit = unit * SWIPE_RATIO;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ay >= ax) {
    if (ay < limit) return null;
    // 竖直压不过水平这么多 → 当成斜滑，不认
    if (ay < ax * SWIPE_AXIS_RATIO) return null;
    // ⚠ 只有**向上**有含义：向下滑回的是「再想想」，那正是「什么也不发生」
    return dy < 0 ? "up" : null;
  }
  if (ax < limit) return null;
  if (ax < ay * SWIPE_AXIS_RATIO) return null;
  return dx < 0 ? "left" : "right";
}

/** 方向 → 这一滑该写什么。
 *
 *  ⚠ **这是「左滑 = 黑、右滑 = 红、上滑 = 跳过」这句话的唯一实现**，而且三种方向里
 *    有**一种不写东西**（`up` → `null`）。返回 `null` 的语义是「只往前走一张」，
 *    不是「状态设成空」—— 调用方对它**一个字节都不该写**（用户口径：跳过不覆盖原有评价）。 */
export function axisVote(axis: SwipeAxis): StickerType | null {
  if (axis === "left") return "black";
  if (axis === "right") return "red";
  return null;
}

/** 拖动进度 0..1（到 1 就是「松手即落定」）—— 给视图层做透明度 / 倾角 / 标记强度的渐显。
 *  ⚠ 它只影响**看起来**，不参与判定；判定那条路是 `resolveSwipe`。 */
export function swipeProgress(dx: number, dy: number, unit: number): number {
  if (!(unit > 0)) return 0;
  return Math.min(1, Math.hypot(dx, dy) / (unit * SWIPE_RATIO));
}

/** 「我的行程」的影片集合 → 投票队列。
 *
 *  规则（用户 2026-10-14 确认）：**行程内去重影片，全部都要再过一遍** ——
 *  已投过的片子照样出现（它的用途就是改票），所以这里**不看** `board`。
 *
 *  顺序：按**我在行程里最早的那一场**升序；没有场次的目录片排在最后，并列按目录序（确定性）。
 *  ⚠ 「最早那场」直接用 `film.shows[0]`，**不在这里另写一套日期比较** ——
 *    `app/model.ts::buildFilms` 建 `shows` 时就是按 (date, start_time) 排好序推进去的，
 *    这里是复用同一份口径（AGENTS §5「同一口径只允许一处实现」）。
 *  ⚠ 行程为空时返回空数组，由调用方改用热门榜候选（见组件里的 `deckQueue`）—— 纯函数不猜数据来源。 */
export function quickVoteOrder(films: readonly FilmNode[], keys: ReadonlySet<string>): FilmNode[] {
  const picked: Array<{ film: FilmNode; index: number }> = [];
  films.forEach((film, index) => {
    if (keys.has(film.key)) picked.push({ film, index });
  });
  return picked
    .sort((a, b) => compareByFirstScreening(a.film, b.film) || a.index - b.index)
    .map((entry) => entry.film);
}

/** 按第一场排 —— 与 `app/model.ts::buildFilms` 里那条排序**逐字同形**（有场次的排前面）。 */
function compareByFirstScreening(a: FilmNode, b: FilmNode): number {
  const left = a.shows[0];
  const right = b.shows[0];
  if (!left || !right) return left ? -1 : right ? 1 : 0;
  return left.date.localeCompare(right.date) || left.start_time.localeCompare(right.start_time);
}

/** 我对一部片的状态，用**规格里的那三个词**表达（2026-10-14）。
 *
 *  ⚠ 这是**对外命名**，不是第二份数据模型：它由 `board` 里有没有那一枚、是哪一色推出来
 *    （`liked` ← 红、`passed` ← 黑、`undecided` ← 没有）。内部存的一直只有 `StickerType`。
 *  ⚠ 为什么要有它：卡片的 `data-qv-state`、总结页的三个计数、以及 AI 复查要读的机读属性
 *    都需要**一组稳定的字符串**，直接写 `red`/`black`/`undefined` 会让「未决定」在
 *    属性里表达不出来（`undefined` 会被 React 从 DOM 上摘掉）。 */
export type DeckState = "undecided" | "liked" | "passed";

/** `StickerType | undefined` → 规格里的三态名。 */
export function deckStateOf(vote: StickerType | undefined): DeckState {
  if (vote === "red") return "liked";
  if (vote === "black") return "passed";
  return "undecided";
}

/** 卡片上那句「这部片现在是什么状态」的文案 —— **唯一**口径，别在 JSX 里另写一份三元链。 */
export function voteStateLabel(vote: StickerType | undefined): string {
  if (vote === "red") return "已投红榜";
  if (vote === "black") return "已投黑榜";
  return "还没决定";
}
