/**
 * 红黑榜「大家贴了什么」的客户端缓存 + 我的投票上报（2026-09-16,PLAN-20260916102339）。
 *
 * 形状与 `want-counts.ts` / `screening-counts.ts` 完全同构（单例缓存 + 广播 + 防抖上报），
 * 差别只在载荷：那边是「一组 film key / 一组场次 code」，这边是「一部片一票红或黑」。
 *
 * ⚠ 隐私边界与 want-ping 一致：只上报**影片 key 与颜色**，绝不上报坐标 / 备注 / 身份。
 * ⚠ 口径：一人一部一票，不做加权（理由见 api 侧 `film-vote-stats.ts`）。
 * ⚠ **API 没上线时页面必须照常可用** —— 读失败一律退化成「大家的票数为空」，
 *    本地贴纸（`redblack.ts` 的 board）不受影响。
 */

import { EDITION } from "./edition";
import { isStickerSkin, type StickerSkin } from "@biff/contracts/sticker";
// ⚠ 只作**类型**引入（`import type`）：`redblack.ts` 是这一层的大户，运行期不值得为两个类型
//    多一次模块加载，也避免任何潜在的首屏顺序纠缠。
import { timeoutSignal } from "./net";
import type { FilmSkinCounts, SkinCrowdCounts } from "./redblack";
import { wholeCount } from "./util";

/** 影片 key → 红 / 黑票数 */
export type FilmVoteCounts = Record<string, { red: number; black: number }>;

/** 单次上报的影片上限（与 api 侧 `MAX_VOTES_PER_PING` 对齐） */
export const MAX_VOTES_PER_PING = 500;

/** 上报端点。⚠ 字面量只有这一处：正常那条路与 `pagehide` 那一条必须打到同一个地址。 */
const PING_URL = "/api/stats/film-votes-ping";

/** 上报载荷里的一票 —— `{ 片 key, 红黑, 评语 }`（2026-09-29,PLAN-20260929181900）。
 *
 * ⚠ **`comment` 字段必须在每一条上出现**（没有评语时是 `null`）。服务端靠「这一份里有没有
 *   任何一个 `comment` 字段」分辨新版 / 旧版前端：一个都没带时它**一个字都不碰**评语列
 *   （老客户端的一次普通上报不能把用户写过的评语静默清空）。
 *   所以这里用 `dedupeVotes` 把「省略字段」一律补成 `null`，而不是把它透传下去。 */
export interface FilmVotePayload {
  key: string;
  vote: "red" | "black";
  comment: string | null;
  skin: StickerSkin | null;
}

/** 调用方**交进来**的一票 —— `comment` / `skin` 可省（`dedupeVotes` 会补成 `null`）。
 *  与 `FilmVotePayload` 分开写，是为了让「省略字段」只出现在**入口**，
 *  进了这条链路之后一定是「字段齐全」的那个形状。 */
export interface FilmVoteInput {
  key: string;
  vote: "red" | "black";
  comment?: string | null;
  skin?: StickerSkin | null;
}

/** 影片 key → **按款**票数（2026-09-29）。
 *
 *  ⚠ 与 `FilmVoteCounts` 是**两本账**：那本是「两色总数」（权威，旧票也在内），
 *    这本只覆盖**带款**的那些票（迁移前的旧票没有款）。两者对不上是**正常的**，
 *    谁也不能假定它们相等 —— 差额就是「没带款的票」，`crowdStickers` 会按 id 给它们兜底。
 *  ⚠ 它纯粹是**展示**用的（群点长什么样），不参与任何计数逻辑：不要拿它去算分数或总数。
 *  ⚠ 类型定义在 `redblack.ts`（三个消费端共用的同一个形状），这里只是**转出去**，
 *    好让「从 film-votes 拿按款分布」这件事仍然只需要认识一个模块。 */
export type { FilmSkinCounts };

let cache: FilmVoteCounts | null = null;
let loading: Promise<FilmVoteCounts> | null = null;
// ⚠ 类型写 `ReturnType<typeof setTimeout>` 而不是 `number`：本模块会被跑在 node 环境下的单测引用，
//   那里的 `setTimeout` 返回的是 `Timeout` 对象（web 的 tsconfig 同时含 DOM 与 node 类型）。
let pingTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function emptyCounts(): FilmVoteCounts {
  return Object.create(null);
}

function emptySkins(): FilmSkinCounts {
  return Object.create(null);
}

/** 服务端**已经收下**的那份我的票（影片 key → 红 / 黑；一人一部一票，故每片恒 1 枚）。
 *
 * ⚠ 它与本地 board **不是一回事**，两者在「本地已改、服务端还没更新」的窗口里会不一致 ——
 *    那正是「收回贴纸后画布仍残留」的成因：卡片要扣掉的是**服务端那份 counts 里属于我的部分**
 *    （= 这一份），而不是「我现在贴了几枚」（本地 board）。口径落在 `redblack.ts::reconcile`，
 *    卡片 / hero / 分享图共用。
 * ⚠ 只在**上报成功**那一刻切换（见 `scheduleFilmVotesPing`），乱切会造出「贴纸先涨回来再降下去」。 */
let synced: FilmVoteCounts = emptyCounts();

/** 服务端回的**按款**分布（影片 key → 款 → 两色计数）。与 `cache` 同一次响应里到达。
 *
 *  ⚠ 它**含我自己那一枚**（服务端不知道谁是「我」）—— 画群点前要用
 *    `redblack.ts::othersSkins` 扣掉，与 `counts` 用 `reconcile` / `othersOf` 是同一条规矩。
 *  ⚠ 不单独发请求：它与两色总数在**同一个响应体**里（`GET /api/stats/film-votes` 与
 *    上报成功时那一次响应都带 `skins`），分两个接口只会多一次 RTT、还可能读到相差一拍的快照。 */
let skinCache: FilmSkinCounts = emptySkins();

export function onFilmVotesChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}

/* ---------------- 上报失败的通知口(2026-09-28) ----------------
 * 由来:上报是 `fetch(...).catch(() => undefined)` —— 断网 / 被限流时用户以为榜上记了,
 * 其实没有。完全静默与「报错刷屏」都不对,这里只回答「**连续**失败了几次」,
 * 由视图层决定什么时候说一次(它才是知道「有没有说过」的那一层)。
 *
 * ⚠ 2026-09-30 追加**失败种类**:过去只有「失败」这一个概念,视图层只好一律说
 *   「请检查网络后重试」。而那次线上事故(ping 载荷的 `comment: null` 被 zod 拒 ⇒
 *   每一次上报都 422)**根本不是网络问题** —— 提示把人往错的方向带了整整一天。
 *   所以「服务端拒绝了这份载荷」与「请求压根没到」必须分开报。 */

/** 失败的两种性质。`rejected` = 服务端回了个非 2xx（多半是**我们自己的载荷/版本**对不上，
 *  用户重试一万次也不会好）；`offline` = 请求没走通（断网 / 超时 / DNS）。 */
export type FilmVotesPingFailureKind = "rejected" | "offline";

/** 上报被服务端**拒绝**（非 2xx）。带状态码是为了日志里能一眼看出是 4xx 还是 5xx。 */
export class FilmVotesPingRejectedError extends Error {
  constructor(readonly status: number) {
    super(`film-votes-ping ${status}`);
    this.name = "FilmVotesPingRejectedError";
  }
}

const failureListeners = new Set<
  (streak: number, kind: FilmVotesPingFailureKind | null) => void
>();
let pingFailureStreak = 0;

/** 订阅「上报连续失败了几次」。成功时会收到一次 `0`（`kind` 为 `null`），供视图层复位「已提示过」。 */
export function onFilmVotesPingFailure(
  listener: (streak: number, kind: FilmVotesPingFailureKind | null) => void,
): () => void {
  failureListeners.add(listener);
  return () => {
    failureListeners.delete(listener);
  };
}

function reportPingFailure(streak: number, kind: FilmVotesPingFailureKind | null): void {
  pingFailureStreak = streak;
  for (const listener of failureListeners) listener(streak, kind);
}

/** 已缓存的票数（同步读，未加载过则为空表） */
export function peekFilmVotes(): FilmVoteCounts {
  return cache ?? emptyCounts();
}

/** 服务端已确认含我的那份票（同步读，见 `synced` 的说明）。 */
export function peekSyncedVotes(): FilmVoteCounts {
  return synced;
}

/** 服务端回的**按款**分布（同步读，未加载过则为空表）。调用方记得先扣掉自己那一枚。 */
export function peekFilmSkins(): FilmSkinCounts {
  return skinCache;
}

/** 采纳一份「服务端已确认含我」的票。
 *
 * ⚠ **不广播** —— 调用方负责在同一拍里把新的 `counts` 也刷出来（见 `scheduleFilmVotesPing`：
 *    「先采纳、再重拉」），否则两次广播之间会出现「贴纸先涨回来一枚、再降下去」的跳动。
 * ⚠ 空表也是合法输入（我撤回全部票）—— 它表达的是「服务端那份里现在已经没有我了」。 */
export function adoptSyncedVotes(votes: Iterable<{ key: string; vote: "red" | "black" }>): void {
  const next = emptyCounts();
  for (const { key, vote } of votes) {
    if (!key) continue;
    next[key] = vote === "red" ? { red: 1, black: 0 } : { red: 0, black: 1 };
  }
  synced = next;
}

/** 读取端白名单：服务端固然不会发坏数据，但客户端缓存**不能假设上游永远正确**
 *  （旧版本 API、代理改写、半截响应）—— 非法条目一律丢弃，与 `hydrate()` 同一条原则。
 *  ⚠ 取整走 `util.ts::wholeCount`（全站唯一取整口径，与 want / screening / ticket 三个
 *    同构模块同一份实现）—— 此前这里自己写了一份 `Math.trunc`（2026-09-23 收口）。 */
export function parseVotes(raw: unknown): FilmVoteCounts {
  const out = emptyCounts();
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !value || typeof value !== "object") continue;
    const counts = value as { red?: unknown; black?: unknown };
    const red = wholeCount(counts.red);
    const black = wholeCount(counts.black);
    if (red <= 0 && black <= 0) continue;
    out[key] = { red, black };
  }
  return out;
}

/** 读取端白名单（按款那一本，2026-09-29）：款必须在契约层的白名单里、计数必须是非负整数。
 *
 *  ⚠ 款**不认识就整条丢掉**，而不是回退成某一款 —— 回退等于「猜用户选了什么」，
 *    画出来的群点会理直气壮地错。丢掉顶多这一款少画几枚（总数那本账仍在，`crowdStickers`
 *    会把它们按 id 兜底），与 `parseVotes` 丢掉非法条目是同一条原则。 */
export function parseFilmSkins(raw: unknown): FilmSkinCounts {
  const out = emptySkins();
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !value || typeof value !== "object") continue;
    const buckets: SkinCrowdCounts = {};
    for (const [skin, bucket] of Object.entries(value as Record<string, unknown>)) {
      if (!isStickerSkin(skin) || !bucket || typeof bucket !== "object") continue;
      const pair = bucket as { red?: unknown; black?: unknown };
      const red = wholeCount(pair.red);
      const black = wholeCount(pair.black);
      if (red <= 0 && black <= 0) continue;
      buckets[skin] = { red, black };
    }
    if (Object.keys(buckets).length) out[key] = buckets;
  }
  return out;
}

/** 用一份**刚从服务端回来的**票替换缓存并广播。
 *  ⚠ 与 `loadFilmVotes` 的分工:它**不发起请求** —— 上报成功时服务端顺手回了全量,
 *    再 GET 一次纯粹是白跑一个 RTT(2026-09-28,见 `scheduleFilmVotesPing`)。
 *  ⚠ 两本账**一起换**:它们来自同一个响应体。只换一本会让群点与数字出现在两个快照上
 *    （老的 `skins` 配新的 `counts`）—— 那正是「群点比数字多一枚」最容易发生的地方。
 *  ⚠ `rawSkins` 是 `undefined` 时（老接口）**清空**而不是保留旧值:那份旧分布对应的是上一拍的
 *    票数,留着比清掉更错。 */
function applyVotes(raw: unknown, rawSkins: unknown): FilmVoteCounts {
  cache = parseVotes(raw);
  skinCache = parseFilmSkins(rawSkins);
  emit();
  return cache;
}

export async function loadFilmVotes(force = false): Promise<FilmVoteCounts> {
  if (cache && !force) return cache;
  if (loading && !force) return loading;
  loading = (async () => {
    try {
      const response = await fetch(`/api/stats/film-votes?edition=${EDITION}`, {
        credentials: "same-origin",
        cache: "no-store",
        signal: timeoutSignal(12_000),
      });
      if (!response.ok) return cache ?? emptyCounts();
      const body = (await response.json()) as { votes?: unknown; skins?: unknown };
      return applyVotes(body.votes, body.skins);
    } catch {
      // 接口还没部署 / 断网：留一份空表，页面照常能贴（只是看不到大家的票）
      return cache ?? emptyCounts();
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** 一份票 → 去掉重复（同一部片只留最后一条，防抖窗口内后到的覆盖先到的），
 *  并把 `comment` 一律归成 `string | null`（缺字段 / 空串 → `null`）。
 *
 * ⚠ **不许在 dedupe 之后省掉 `comment` 键**：见 `FilmVotePayload` 的说明 —— 少带字段
 *   会被服务端读成「旧版前端」，那次上报的评语一个都写不进去（而且不报错）。 */
function dedupeVotes(votes: Iterable<FilmVoteInput>): FilmVotePayload[] {
  const out = new Map<string, FilmVotePayload>();
  for (const entry of votes) {
    const comment = typeof entry.comment === "string" && entry.comment.trim() ? entry.comment : null;
    // ⚠ 与 `comment` 逐字同一条规矩：**每一条都要带 `skin` 键**（不认识时给 `null`）。
    //   服务端靠「这一份里有没有 `skin` 字段」分辨新旧前端 —— 少带会被读成旧版，
    //   那次上报**根本不会**把款写进去（用户选了款却跟没选一样，而且不报错）。
    out.set(entry.key, { key: entry.key, vote: entry.vote, comment, skin: normalizeSkin(entry.skin) });
  }
  return [...out.values()];
}

/** 上报侧的款归一：不在白名单里（含 `undefined`）一律当「没带款」。
 *  ⚠ 与读取侧 `parseFilmSkins` 同一道收口 —— 两边都只认契约层那一份白名单。 */
function normalizeSkin(value: unknown): StickerSkin | null {
  return isStickerSkin(value) ? value : null;
}

/* ---------------- 增量待发队列与退避重试（2026-10-05，PLAN-20261005182415 §A + §C） ----------------
 * 两轮叠出来的东西，一起说清楚：
 *   · §A 解决「上报只活在内存里」—— 关页 / 切后台（iOS 会挂起定时器、甚至回收标签页）/ 崩溃，
 *     那一次上报就**从来没发生过**。所以「要发的东西」必须落盘、载入时先补发、失败退避重试。
 *   · §C 解决「发的到底是什么」—— 原来是**整份替换**（把本机全部票发上去，服务端照单替换），
 *     于是多端 / 清缓存会**删掉服务端已有的票**，失败还得整份重来。现在发的是**一批 op**
 *     （每个改动一条、按影片合并）：错的只会是那一部片，部分载荷不再有破坏性，重放天然幂等。
 *
 * 盘上那一份（`LS_PENDING_FILM_VOTES`）四个字段：
 *   · `clientId` —— 本机标识（服务端的水位按它分开记：两台设备各数各的 seq，不互相吞）；
 *   · `seq`      —— **已经被服务端确认过**的最大批次号，发下一批时 +1；
 *   · `base`     —— 上一次调度时的那面墙（= 队列里那些 op 全落地之后，服务端「应该」有的那份），
 *                  用来算下一轮改了什么；
 *   · `ops`      —— 还没被确认的意图（按影片合并：同一部片只留最后一条）。
 *
 * ⚠ 键是 `...pending.v2`（§A 那版是 v1）：盘上结构变了 —— 按 §5「新 key + 一次性迁移 + 删旧 key」
 *   的规矩换键，并在读的时候把 v1 删掉。**v1 里那份没发成功的票不会因此丢**：它本来就在本地 board 里，
 *   而新键的 `base` 从**空**开始 ⇒ 下一次调度会把整面墙作为 `set` 发上去。这条同时也是
 *   「换设备 / 清 cookie 之后本地有、服务端没有」的自愈路径。
 * ⚠ 键落在 `iffday.workspace.*` 而**不是** `biff.*`：`biff.` 前缀会被 `sync-data.ts::readWorkspace`
 *   收进账号文档（`local:biff.*`）、参与跨设备合并（可能弹出「同步冲突」）、也进 `backup.ts` 的备份
 *   快照。而这一份是**本浏览器、本身份**的临时待发状态 —— 不是用户数据，跨设备合并没有意义
 *   （还会把别的设备那一份当成自己的意图发上去）。`iffday.workspace.*` 是既有的
 *   「本地专属、只写盘不上报」命名空间（见 `state.ts` 里那条说明）。 */
export const LS_PENDING_FILM_VOTES = "iffday.workspace.redblackpending.v2";
/** §A 那一版的键（整份票）。载入时读一次就删 —— 留着只会让下一个人猜哪一份才是真的。 */
const LS_PENDING_FILM_VOTES_V1 = "iffday.workspace.redblackpending.v1";

/** `fetch(..., { keepalive: true })` 的 body 上限（字节）。超了就不发，见 `sendFilmVotesKeepalive`。 */
export const KEEPALIVE_BODY_LIMIT = 64 * 1024;

/** 退避重试的基数与封顶（ms）。抽成常量是为了让「1s → 2s → 4s → 8s」这条口径可测。 */
export const PING_RETRY_BASE_MS = 1_000;
export const PING_RETRY_CAP_MS = 30_000;

/** 第 `attempt` 次重试等多久：1s → 2s → 4s → 8s → 16s → 30s（之后封顶 30s）。
 *  ⚠ 纯函数：退避序列是**能算错又看不出来**的那类东西（多等一轮 / 少等一轮都不会报错）。 */
export function pingRetryDelay(attempt: number): number {
  return Math.min(PING_RETRY_CAP_MS, PING_RETRY_BASE_MS * 2 ** Math.max(0, attempt));
}

/** 这一次失败还该不该重试。
 *
 *  ⚠ 服务端**拒绝了这份载荷**（4xx）时不重试：重试一万次也不会好，而且会把「服务端拒绝」这条
 *    唯一的线索淹没在重试里（2026-09-30 那次「每个上报都被 422 拒、提示却一直说检查网络」
 *    的教训）。
 *  ⚠ **已知代价**（PLAN §A 的「已知取舍」）：按用户口径 4xx 一律不重试，于是**限流 429 也被归进来**
 *    —— 而限流是临时状态、重试几乎必然成功。真要改只改这一处（它只在这一行判）。
 *  ⚠ 网络异常 / 12s 超时（都归到 `offline`）一律重试：那才是退避存在的意义。 */
export function shouldRetryPing(error: unknown): boolean {
  return error instanceof FilmVotesPingRejectedError ? error.status >= 500 : true;
}

/* ---------------- 一条 op（上行载荷，§C） ----------------
 * ⚠ **只有两种**：`set`（把这部片设成某状态 —— 颜色 / 评语 / 款**一起**）与 `remove`（撤掉）。
 *   没有「改色」这种第三类：改色就是一次新的 `set`。这一条正是**重放幂等**的来源
 *   （把同一部片设成同一个状态，第二次是空差分），也是服务端水位能挡住乱序的前提。
 * ⚠ `set` 里 `comment` / `skin` **必须显式带上**（没写评语时是 `null`）：服务端按「这一票现在
 *   是什么状态」整条覆盖 —— 省掉字段等于告诉它「这部片现在没有评语」，那不是用户的意思。 */
export type VoteOp =
  | { op: "set"; key: string; vote: "red" | "black"; comment: string | null; skin: StickerSkin | null }
  | { op: "remove"; key: string };

/** 盘上（与内存里）那一份待发。 */
interface PendingOps {
  clientId: string;
  /** **已经被服务端确认**的最大批次号；发下一批时 +1。 */
  seq: number;
  /** 上一次调度时的那面墙。⚠ **空表是合法初值**（新装的设备服务端什么都没有）——
   *  于是第一次调度会把整面墙作为 `set` 发上去（见文件头那条自愈说明）。 */
  base: FilmVotePayload[];
  /** 还没被确认的意图。 */
  ops: VoteOp[];
  /** 服务端**拒绝过**这一份（4xx）→ 不再自动发（`shouldRetryPing` 那张口径的落点）。
   *  ⚠ 它**不落盘**：盘上那份只回答「要发什么」，「这一拍该不该发」是一次载入内的事 ——
   *    下次开页面重新判断一次（那时载荷可能已经被新版修好了）。
   *  ⚠ 用户再动一次手就把它清掉，等于「载荷变了就再试一次」。 */
  blocked?: boolean;
}

let pending: PendingOps | null = null;
/** 已经被服务端确认应用过的最大 seq。比它旧的响应一律丢弃 —— 否则「旧响应」会把新状态盖回去
 *  （表现就是「刚收回的那枚贴纸又冒出来」）。 */
let appliedSeq = 0;
/** 串行化：同一时刻只允许**一条**在途。`pagehide` 那一发（keepalive）不等响应，不占这个位。 */
let inFlight = false;
let retryAttempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
/** 生命周期监听只挂一次（`redblack.ts::pagehideBound` 同一手法）。 */
let lifecycleBound = false;
/** §A 那个旧键只清一次。 */
let legacyPurged = false;

/** 本机标识。⚠ 不用 `crypto.randomUUID()` 直接调：它在**非安全上下文**（http 预览 / 内嵌 WebView）
 *  里不存在，而这条路径必须永远能生出一个 id —— 否则整条待发队列落不了盘。
 *  ⚠ 它**不是**身份：身份是服务端那个匿名 cookie / 账号 subject（见服务端 `film_vote_sync` 的说明）。 */
function newClientId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 同一部片的「状态」是否一致（用来差分）。key 由调用方保证相同。 */
function sameVote(left: FilmVotePayload, right: FilmVotePayload): boolean {
  return left.vote === right.vote && left.comment === right.comment && left.skin === right.skin;
}

/** 差出「要让服务端从 `base` 变成 `board` 需要哪些 op」。
 *
 *  ⚠ **只发改动过的那几部片** —— 这是 §C 相对 §A（每次都发整份）的全部价值：贴一枚贴纸的载荷
 *    是**一条** op，而不是整个榜单。
 *  ⚠ 判据是「与上一轮相比的内容」而不是「服务端真相」：没被确认的意图在 `ops` 里排着队，
 *    所以这里只会**补齐差额**，不会因为「不确定服务端有没有」而重复发。
 *  ⚠ 纯函数（可单测）：顺序按「新 board 的插入序 + 被删掉的 key」，同一部片不会出现两条。 */
export function planVoteOps(
  base: readonly FilmVotePayload[],
  board: readonly FilmVotePayload[],
): VoteOp[] {
  const before = new Map(base.map((entry) => [entry.key, entry]));
  const after = new Map(board.map((entry) => [entry.key, entry]));
  const ops: VoteOp[] = [];
  for (const [key, entry] of after) {
    const old = before.get(key);
    if (old && sameVote(old, entry)) continue; // 没变 → 不发
    ops.push({ op: "set", key, vote: entry.vote, comment: entry.comment, skin: entry.skin });
  }
  for (const key of before.keys()) {
    if (!after.has(key)) ops.push({ op: "remove", key });
  }
  return ops;
}

/** 新老意图合并（**同一部片只留最后一条**）。
 *  ⚠ 必须按 key 合并：同一部片在一次失败的窗口里被连改三次，只该发最后那一条 —— 服务端要的是
 *    「这部片现在是这个状态」，中间那两次没有意义（也正是载荷能塞进 keepalive 的原因）。 */
export function coalesceOps(existing: readonly VoteOp[], fresh: readonly VoteOp[]): VoteOp[] {
  const merged = new Map<string, VoteOp>();
  for (const op of existing) merged.set(op.key, op);
  for (const op of fresh) merged.set(op.key, op);
  return [...merged.values()];
}

/** 一条 op 的白名单收口（盘上那份可能是上一版写的 / 被人手改过）。
 *  ⚠ 与读票数那条**相反**：这里不「丢掉那一条」而是**整份丢弃** —— 丢一条 op = 用户那次改动
 *    静默没了，而 `base` 还宣称它已经同步过，于是**永远补不回来**。整份丢掉则 `base` 归零，
 *    下一次调度会把整面墙重发（自愈）。 */
function parseOp(raw: unknown): VoteOp | null {
  if (!raw || typeof raw !== "object") return null;
  const op = raw as { op?: unknown; key?: unknown; vote?: unknown; comment?: unknown; skin?: unknown };
  if (typeof op.key !== "string" || !op.key) return null;
  if (op.op === "remove") return { op: "remove", key: op.key };
  if (op.op !== "set") return null;
  if (op.vote !== "red" && op.vote !== "black") return null;
  return {
    op: "set",
    key: op.key,
    vote: op.vote,
    comment: typeof op.comment === "string" ? op.comment : null,
    skin: isStickerSkin(op.skin) ? op.skin : null,
  };
}

/** 盘上那一份 → 白名单收口（任一条不认识就整份丢弃，理由见 `parseOp`）。 */
function readPending(): PendingOps | null {
  if (typeof localStorage === "undefined") return null; // node 环境的单测
  let raw: string | null;
  try {
    raw = localStorage.getItem(LS_PENDING_FILM_VOTES);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      clientId?: unknown;
      seq?: unknown;
      base?: unknown;
      ops?: unknown;
    };
    if (typeof parsed?.clientId !== "string" || !parsed.clientId) return null;
    if (typeof parsed.seq !== "number" || !Number.isFinite(parsed.seq)) return null;
    if (!Array.isArray(parsed.base) || !Array.isArray(parsed.ops)) return null;
    const base: FilmVoteInput[] = [];
    for (const item of parsed.base) {
      if (!item || typeof item !== "object") return null;
      const entry = item as { key?: unknown; vote?: unknown; comment?: unknown; skin?: unknown };
      if (typeof entry.key !== "string" || !entry.key) return null;
      if (entry.vote !== "red" && entry.vote !== "black") return null;
      base.push({
        key: entry.key,
        vote: entry.vote,
        comment: typeof entry.comment === "string" ? entry.comment : null,
        skin: isStickerSkin(entry.skin) ? entry.skin : null,
      });
    }
    const ops: VoteOp[] = [];
    for (const item of parsed.ops) {
      const op = parseOp(item);
      if (!op) return null;
      ops.push(op);
    }
    return {
      clientId: parsed.clientId,
      seq: Math.max(0, Math.trunc(parsed.seq)),
      base: dedupeVotes(base),
      ops: coalesceOps([], ops),
    };
  } catch {
    return null;
  }
}

/** 写盘 / 清盘。⚠ 失败一律吞掉（配额满 / 隐私模式）—— 退化成「只有内存里那一份」，
 *  与 `redblack.ts::saveStickers` 是同一条取舍：写不进去不该让上报本身失败。 */
function writePending(job: PendingOps | null): void {
  if (typeof localStorage === "undefined") return;
  try {
    // ⚠ 只写这四个字段（不带 `blocked`）：盘上那份要能被 `readPending` 的白名单完整收下
    if (job) {
      localStorage.setItem(
        LS_PENDING_FILM_VOTES,
        JSON.stringify({ clientId: job.clientId, seq: job.seq, base: job.base, ops: job.ops }),
      );
    } else {
      localStorage.removeItem(LS_PENDING_FILM_VOTES);
    }
  } catch {
    /* 见上 */
  }
}

/** 删掉 §A 那个旧键（只在真正要读写待发状态时清一次）。 */
function purgeLegacyPending(): void {
  if (legacyPurged) return;
  legacyPurged = true;
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(LS_PENDING_FILM_VOTES_V1);
  } catch {
    /* 见 `writePending` */
  }
}

function ensurePending(): PendingOps {
  if (!pending) pending = { clientId: newClientId(), seq: 0, base: [], ops: [] };
  return pending;
}

/** 一条成功响应里我们要的那两本账（两条发送路径共用这一处解析）。 */
interface PingBody {
  votes: unknown;
  skins: unknown;
}

function parsePingBody(body: unknown): PingBody | null {
  if (!body || typeof body !== "object") return null;
  const parsed = body as { votes?: unknown; skins?: unknown; appliedSeq?: unknown };
  // ⚠ 响应里**没有 `votes`** 才是「服务端还不认增量」的信号 → `null`，让调用方退回去重拉。
  if (!parsed.votes) return null;
  return { votes: parsed.votes, skins: parsed.skins };
}

/** 把**一片** op 发上去（一片 = 一条请求；超限时由 `flushFilmVotesPing` 切片，每片一个批次号）。
 *  ⚠ 与 §A 那版「累积前缀」分批**正好相反**：op 是增量，发前缀等于丢掉后半截 —— 所以这里只发
 *    传进来的这一片，剩下的下一片接着发。 */
async function sendOpBatch(
  ops: readonly VoteOp[],
  clientId: string,
  seq: number,
): Promise<PingBody | null> {
  const response = await fetch(PING_URL, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ edition: EDITION, ops, clientId, seq }),
    signal: timeoutSignal(12_000),
  });
  // ⚠ 抛**带种类的**错误（见 `FilmVotesPingRejectedError`）：视图层要靠它把「服务端拒绝」与
  //   「网络不通」分开提示 —— 这一条正是 2026-09-30 那次「提示说检查网络，其实是 422」的根因。
  if (!response.ok) throw new FilmVotesPingRejectedError(response.status);
  return parsePingBody(await response.json());
}

/** 一批被服务端确认之后要做的四件事（两条发送路径共用）。
 *
 *  ⚠ `seq` 守卫：这份载荷若已被更晚的一份取代（`seq < appliedSeq`），整条响应**丢弃** ——
 *    既不推水位、不采纳、也不用它的 counts 覆盖画面，否则「旧响应」会把新状态盖回去。
 *  ⚠ 按**对象身份**移除已确认的 op（`new Set(batch)` + `filter`）：在途期间用户改了同一部片时，
 *    队列里那条已经是**新对象**，这一批确认的只是旧值 —— 新那条必须留着继续发。
 *  ⚠ 只有**队列见底**时才切「服务端已含我」的基准（`adoptSyncedVotes`）：`base` 是「队列里那些 op
 *    全落地之后」的那面墙，切片还没发完时它比服务端真实状态**超前**，拿它当基准等于把还没上去的
 *    票当成已确认（画布上就会把「我的」算成「别人的」）。 */
function applyPingSuccess(
  job: PendingOps,
  batch: readonly VoteOp[],
  seq: number,
  raw: PingBody | null,
): PingBody | null {
  if (seq < appliedSeq) return null;
  appliedSeq = seq;
  job.seq = Math.max(job.seq, seq);
  const confirmed = new Set(batch);
  job.ops = job.ops.filter((op) => !confirmed.has(op));
  if (job.ops.length === 0) adoptSyncedVotes(job.base);
  writePending(job);
  clearTimeout(retryTimer);
  retryTimer = undefined;
  retryAttempt = 0;
  reportPingFailure(0, null);
  return raw;
}

/** `pagehide` / 切后台那一刻的**最后一发**。
 *
 *  返回值只回答「有没有发出去」—— 页面正在走，**不能等**它。但拿到响应时仍然照收（见下）：
 *  `visibilitychange(hidden)` 之后用户可能又切回来，这一发是能拿到结果的。
 *
 *  ⚠ 两条硬约束（PLAN §A）：① `keepalive` 的 body 上限是 64KB；
 *    ② 一片 op 发不完（超过单批上限）时**干脆不发** —— keepalive 拿不到可靠响应，切片会丢后半截。
 *    任一不满足就留着 pending 下次开页面补。 */
export function sendFilmVotesKeepalive(): boolean {
  const job = pending;
  if (!job || job.blocked || job.ops.length === 0) return false;
  if (typeof window === "undefined") return false;
  if (job.ops.length > MAX_VOTES_PER_PING) return false;
  const batch = job.ops;
  // ⚠ 批次号**在发送这一刻就预支**（`++`），不能用 `job.seq + 1` 现算：keepalive 那一发与正常
  //   那一发会同时在途，现算的话两批拿到**同一个号** ⇒ ① 服务端会把后到那批当成重放跳过，
  //   ② 客户端的「旧响应丢弃」守卫（`seq < appliedSeq`）也判不出来 —— 旧响应会把新 counts 盖回去。
  //   号有空洞无所谓：服务端的水位只在真正落库时前进。
  const seq = (job.seq += 1);
  const body = JSON.stringify({ edition: EDITION, ops: batch, clientId: job.clientId, seq });
  if (new TextEncoder().encode(body).length > KEEPALIVE_BODY_LIMIT) return false;
  try {
    void fetch(PING_URL, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    })
      .then(async (response) => {
        if (!response.ok) throw new FilmVotesPingRejectedError(response.status);
        const raw = applyPingSuccess(job, batch, seq, parsePingBody(await response.json()));
        if (raw) await applyVotes(raw.votes, raw.skins);
      })
      .catch(() => undefined);
    return true;
  } catch {
    // 同步抛（例如 keepalive 配额被浏览器拒）→ 当作没发出去
    return false;
  }
}

function schedulePingRetry(): void {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    flushFilmVotesPing();
  }, pingRetryDelay(retryAttempt));
  retryAttempt += 1;
}

/** 把待发队列**发出去**（一片；还有剩就接着发，见 `finally`）。
 *
 *  `keepalive: true` = 「页面正在走」那一发（见 `sendFilmVotesKeepalive`）：不等响应、不占在途位。
 *
 *  ⚠ 在途时**不发第二条**：两条并发写同一个 contributor 的落库顺序无法保证（水位能挡住乱序，
 *    但没必要自己制造乱序）。
 *  ⚠ 队列为空 / 服务端**拒绝过**这一份（4xx）就什么都不做。 */
export function flushFilmVotesPing(options: { keepalive?: boolean } = {}): void {
  const job = pending;
  if (!job || job.blocked || job.ops.length === 0) return;
  if (options.keepalive) {
    sendFilmVotesKeepalive();
    return;
  }
  if (inFlight) return;
  const batch = job.ops.slice(0, MAX_VOTES_PER_PING);
  // ⚠ 与 keepalive 那条同样**先预支号**（见那里的说明）：两条在途必须拿到不同的号
  const seq = (job.seq += 1);
  inFlight = true;
  let confirmed = false;
  void sendOpBatch(batch, job.clientId, seq)
    .then((raw) => {
      confirmed = true;
      const applied = applyPingSuccess(job, batch, seq, raw);
      // ⚠ 服务端在响应里顺手回了全量 → 直接用，省掉「上报成功再 GET 一次」的那个 RTT；
      //   老服务端（不认增量、没这个字段）才退回去重拉。老服务端那条也会让上报变成 422 →
      //   走「服务端拒绝」那条提示，不会静默。
      if (applied) return applyVotes(applied.votes, applied.skins);
      return loadFilmVotes(true);
    })
    .catch((error: unknown) => {
      reportPingFailure(
        pingFailureStreak + 1,
        error instanceof FilmVotesPingRejectedError ? "rejected" : "offline",
      );
      if (!shouldRetryPing(error)) {
        // 4xx：这一份不再自动发（用户再动一次手会清掉这个标记，等于「载荷变了就再试一次」）。
        // ⚠ 标记只活在内存里，见 `PendingOps::blocked`。
        job.blocked = true;
        return;
      }
      schedulePingRetry();
    })
    .finally(() => {
      inFlight = false;
      // ⚠ 只有在**这一次真的成功**、而队列还没见底时才接着发（切片 / 在途期间又改了票）。
      //   失败时交给退避计时器 —— 在这里无条件补发会变成死循环。
      if (confirmed && pending && pending.ops.length > 0) flushFilmVotesPing();
    });
}

/** 挂 `pagehide` / `visibilitychange` —— **两个都要**：
 *  iOS 上切到别的 App 走的是 `visibilitychange`，「关闭标签页 / 被系统回收」走 `pagehide`；
 *  少挂一个就有一整类场景不补发。
 *  ⚠ **惰性挂**（第一次上报 / 补发时才挂），不在 import 期碰 DOM：本模块被 node 环境的单测直接
 *    import（与 `redblack.ts::scheduleSaveStickers` 挂 `pagehide` 是同一个手法）。 */
function bindPingLifecycle(): void {
  if (lifecycleBound || typeof window === "undefined") return;
  lifecycleBound = true;
  /** 页面正在走 → 最后一发（不等响应、不清队列）。 */
  const lastChance = () => {
    sendFilmVotesKeepalive();
  };
  window.addEventListener("pagehide", lastChance);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      lastChance();
      return;
    }
    // 回到前台 → 补一次。⚠ 这**不是**「重试」：切到后台会把 1200ms 的防抖定时器一起挂起，
    //   所以「贴完就切走」那一批很可能**根本没发出去过**。
    // ⚠ 只在「**没有人在等这次发送**」时才补（`retryTimer` 为空）：若退避计时器正等着，
    //   交给它就行 —— 否则每次前后台来回都插一发，把退避白白抵消掉。
    if (retryTimer === undefined) flushFilmVotesPing();
  });
}

/** 页面载入时把上一次没发成功的那一批补上。
 *
 *  ⚠ 只在**盘上真有 ops** 时动作；队列为空就什么都不做（`base` 本来就是空的，见文件头那条自愈说明）。
 *  ⚠ 不走 1200ms 防抖：上一次已经防过了，而且用户正等着它上墙。
 *  ⚠ 顺手清掉 §A 那个旧键。 */
export function resumePendingFilmVotes(): void {
  purgeLegacyPending();
  const stored = readPending();
  if (!pending && stored) pending = stored;
  bindPingLifecycle();
  if (pending && pending.ops.length > 0) flushFilmVotesPing();
}

/** 上报我的投票（**增量**：只发改动过的那几部片，见 `planVoteOps`）。
 *
 *  ⚠ 待发的那一份**同时落盘**：关页 / 切后台 / 崩溃之后，`resumePendingFilmVotes` 会在下一次
 *    载入时把它补上。所以「靠重发一次自愈」这句话现在真的成立 —— 原来它成立的前提是
 *    「用户还会再动一次手，而且这一页还活着」。
 *  ⚠ 用全局 `setTimeout` 而不是 `window.setTimeout`：与 `screening-counts.ts` 同一条理由
 *    （模块可能被跑在 node 环境里的单测引用）。
 *  ⚠ 载荷里的 `comment` / `skin` 由 `dedupeVotes` 统一补齐（**每条都带字段**），
 *    所以调用方哪怕只给 `{key, vote}` 也不会把用户写过的评语 / 选过的款清掉。 */
export function scheduleFilmVotesPing(votes: Iterable<FilmVoteInput>): void {
  const board = dedupeVotes(votes);
  const job = ensurePending();
  const fresh = planVoteOps(job.base, board);
  job.base = board;
  job.ops = coalesceOps(job.ops, fresh);
  // 新载荷 → 重新允许自动发（4xx 那个标记只对「同一份载荷」有效）
  job.blocked = false;
  writePending(job);
  // 新意图作废旧的退避：用户又动了一次手，该按新载荷立刻发，而不是等上一轮退避走完
  clearTimeout(retryTimer);
  retryTimer = undefined;
  retryAttempt = 0;
  bindPingLifecycle();
  clearTimeout(pingTimer);
  pingTimer = setTimeout(() => {
    pingTimer = undefined;
    flushFilmVotesPing();
  }, 1200);
}
