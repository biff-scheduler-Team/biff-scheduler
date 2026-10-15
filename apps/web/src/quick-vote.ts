/**
 * 快速投票 —— 红黑榜投票入口的**纯逻辑**（2026-10-14，PLAN-20261014190000）。
 *
 * 这一层只管四件事，件件都可以脱开 DOM 单测：
 *  ① **候选与顺序**：两个来源共用同一套骨架（`orderedByFirstScreening`）——
 *     `quickVoteOrder`（我的行程 = `store.picks` 的 key 集合）与 `votedQueue`
 *     （**全站有过票的影片**，2026-10-15 起是缺省来源）；两者都空时才由调用方改用热门榜候选；
 *     ⚠ 2026-10-14 修订 5（用户拍板）：**已经处理过的片（投过 / 跳过过）不再进队列** ——
 *     过滤归 `pendingQueue`，而且只在**一轮开始时**做一次；改票入口挪到榜单上那一枚，
 *     所以这两个函数**不看** `board`（它们只回答「候选是谁」）；
 *  ② **手势 → 意图**：位移落在哪一档（左 = 黑 / 右 = 红 / 上 = **跳过**），不到阈值就是「什么也没发生」；
 *  ③ **状态的对外命名**：`undecided` / `liked` / `passed` —— 卡片角标与 E2E 都读它；
 *  ④ **候选来源的对外命名**：`voted` / `agenda` / `hot`（`DeckSource`）—— 来源说明条与切换按钮读它。
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
 *  规则：**行程内去重影片**都进候选。
 *  ⚠ 这是**候选来源**那一层：它**不看** `board`，也不在这里判「投过没有」——
 *    「已经处理过的片不再进队列」是 `pendingQueue` 的事（修订 5），而那条判据的另一半
 *    （「跳过过」这本账）只有视图层拿得到，所以过滤留在调用方。
 *
 *  顺序：按**我在行程里最早的那一场**升序；没有场次的目录片排在最后，并列按目录序（确定性）。
 *  ⚠ 「最早那场」直接用 `film.shows[0]`，**不在这里另写一套日期比较** ——
 *    `app/model.ts::buildFilms` 建 `shows` 时就是按 (date, start_time) 排好序推进去的，
 *    这里是复用同一份口径（AGENTS §5「同一口径只允许一处实现」）。
 *  ⚠ 行程为空时返回空数组，由调用方改用热门榜候选（见组件里的 `deckQueue`）—— 纯函数不猜数据来源。 */
export function quickVoteOrder(films: readonly FilmNode[], keys: ReadonlySet<string>): FilmNode[] {
  return orderedByFirstScreening(films, (film) => keys.has(film.key));
}

/** 全站**有过票**的影片 → 投票队列（2026-10-15，`PLAN-20261015005652`）。
 *
 *  用户原话：「打开之后默认直接所有有过票的都作为滑动的片单吧这样也不会遗漏 反正划一下也很快」。
 *  规则：`hasVote(key)` 认的那些（**服务端聚合**里红 + 黑 > 0，与我自己的行程无关）。
 *
 *  ⚠ 顺序**刻意不看票数**：按票数降序时，「我自己那一票上报成功 → 服务端聚合多一枚」就会让
 *    顺序当场变化 —— 而 `deckSignature` 判的正是 key 序列，一变 `QuickVoteDeck` 就重开这一轮、
 *    `index` 归零（用户报过的「划了五部又从 5/50 变成 1/50」）。所以顺序只由**片单本身**决定。
 *  ⚠ 与 `quickVoteOrder` 共用同一个排序骨架：两个来源的顺序口径一旦分叉，「换来源」就会把
 *    用户划到的位置甩到别处。 */
export function votedQueue(
  films: readonly FilmNode[],
  hasVote: (key: string) => boolean,
): FilmNode[] {
  return orderedByFirstScreening(films, (film) => hasVote(film.key));
}

/** 两个候选来源**共用**的挑选 + 排序骨架：留下 `keep` 认的那些，按**最早一场**升序
 *  （没有场次的目录片排最后），并列按目录序。
 *
 *  ⚠ 这是「候选怎么排」的**唯一**实现（AGENTS §5）—— `quickVoteOrder` / `votedQueue` 都只是
 *    各自给一个 `keep` 判据，不另写一遍排序。 */
function orderedByFirstScreening(
  films: readonly FilmNode[],
  keep: (film: FilmNode) => boolean,
): FilmNode[] {
  const picked: Array<{ film: FilmNode; index: number }> = [];
  films.forEach((film, index) => {
    if (keep(film)) picked.push({ film, index });
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

/** 从候选里去掉**已经处理过**的片 —— 已投过红 / 黑（`board` 里有那一枚）与**快速投票里跳过过**的那些。
 *
 *  2026-10-14（PLAN-20261014190000 修订 5，用户拍板）：改票入口从这张卡片挪到**榜单上那一枚**，
 *  卡片这边改成「划过一遍就不再来」—— 所以过滤必须发生，否则用户每次打开都从第 1 张重划。
 *
 *  ⚠ 只在**一轮开始时**调一次（打开卡片 / 候选换源），**不要**在划的过程中重新过滤：
 *    刚划掉的那一张会让后面所有卡的索引整体前移，读起来就是「刚划完就被甩回前面」。
 *  ⚠ 它**不读** `board` / localStorage：判据由调用方给（纯函数不猜数据来源，与 `quickVoteOrder`
 *    同一条规矩）。也正因此，「投过」与「跳过」两件事可以合成一个 `handled` 判据传进来。 */
export function pendingQueue(
  films: readonly FilmNode[],
  handled: (key: string) => boolean,
): FilmNode[] {
  return films.filter((film) => !handled(film.key));
}

/** 队列的**内容身份**（key 序列）—— 视图层用它判断「候选换了没有」。
 *
 *  ⚠ 判据必须是**内容**而不是数组引用：上游每次重算 `useMemo` 都会造一个新数组
 *    （票数刷新、榜单重排、`buildHotRows` 重跑），拿引用当判据的话，用户划到一半就会被
 *    重置回第 1 张（2026-10-14 用户报的「5/50 → 1/50」）。
 *  ⚠ 分隔符用 `\n`：影片 key 里不可能出现换行，所以「a\nb」不会被读成别的组合。
 *  ⚠ 空队列 → 空串（`EMPTY_DECK` 那份模块级常量的签名）。 */
export function deckSignature(films: readonly FilmNode[]): string {
  return films.map((film) => film.key).join("\n");
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

/** 「扫码投票」那个二维码里编的链接 —— **唯一**口径（2026-10-14，PLAN-20261014205414）。

 *  ⚠ 为什么带 `sort=red&vote=1`：扫码的人目的就是**投票**，不是看榜。
 *    `sort=red` 让落地档是红榜（`BoardPage::readTab` 的缺省），`vote=1` 让它当场弹出快速投票卡片
 *    （`BoardPage` 的落地 effect 只在 `sort` 缺失时才决定，所以这里必须把两个都写全，
 *    否则「扫码 → 落到热门榜 → 卡片根本没挂载」）。
 *  ⚠ `origin` 由调用方给（含协议，如 `https://biff.lcandy.co`）—— 域名只有 `poster-brush.ts::SITE`
 *    一处来源，纯函数不去猜它（与 `quickVoteOrder` / `pendingQueue` 同一条规矩）。 */
export function voteUrl(origin: string): string {
  return `${origin}/redblack?sort=red&vote=1`;
}

/** 卡片上那句「这部片现在是什么状态」的文案 —— **唯一**口径，别在 JSX 里另写一份三元链。 */
export function voteStateLabel(vote: StickerType | undefined): string {
  if (vote === "red") return "已投红榜";
  if (vote === "black") return "已投黑榜";
  return "还没决定";
}

/** 海报上「CODE」那一行要印的字：这部片**全部场次编号**，用 `/` 连起来
 *  （2026-10-15，`PLAN-20261015005652` 修订 3）。
 *
 *  用户原话：「code 应该需要显示成 004/008 这样 而不是显示成 CODE 004 这样而且丢了其他场次」——
 *  两件事：① 编号本身就自明，去掉「CODE 」这个前缀；② 原来只印 `shows[0]`，
 *  一部片排了两场时第二场的编号当场消失（`白色战争` = 024 + 099）。
 *
 *  ⚠ 顺序**直接沿用 `film.shows`**：`app/model.ts::buildFilms` 建它时已按 (date, start_time)
 *    排好序，这里不另写一套比较（AGENTS §5「同一口径只允许一处实现」）。
 *  ⚠ 没有排期的目录片返回空串，调用方据此**不渲染**这一行（不是印一串空气）。 */
export function showCodesOf(film: FilmNode): string {
  return film.shows.map((show) => show.code).join("/");
}

/** 这一轮**按哪一份候选**划（2026-10-15，`PLAN-20261015005652`）。
 *
 *  ⚠ 来源只有三种，且**第三种是兜底**：
 *    · `voted` —— **全站有过票的影片**（缺省。用户：「默认直接所有有过票的都作为滑动的片单」）；
 *    · `agenda` —— **我的行程**（用户有行程时可切过来：「切换成自己的行程片单」）；
 *    · `hot`   —— 热门榜 TOP 50（榜上一票都没有、行程也空时才有的一条路，原行为）。
 *  ⚠ 它只是**对外命名**：卡片的来源说明条、切换按钮的文案、E2E 都读它，别在 JSX 里另写一份字面量。 */
export type DeckSource = "voted" | "agenda" | "hot";

/** 来源的说明文案（唯一口径）。 */
export function deckSourceLabel(source: DeckSource): string {
  if (source === "agenda") return "我的行程";
  if (source === "hot") return "热门榜 TOP 50";
  return "全部有票的影片";
}
