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

/** 把一份票发给服务端，返回它顺手回的全量（老服务端没这个字段 → `null`）。
 *
 * ⚠ 服务端是「**整份替换**」语义（`replaceContributorVotes`），所以超限时**不能**切成互不相交
 *   的块 —— 后一块会把前一块盖掉，等于只发了最后一块。这正是原来 `slice(0, MAX)` 的隐患：
 *   超出的票**永远不会**上报，而且是静默的。
 *   这里按**累积前缀**分批：第 k 批发 `[0, k × MAX)`，于是最后一批就是全量、服务端最终状态正确。
 *   代价是超限时多几个 RTT —— 而 `MAX_VOTES_PER_PING = 500` 已高于当前影片库规模（有排期的近
 *   300 部），这条路径平时走不到；它存在的意义是「万一走到，也不静默丢票」。
 * ⚠ 串行发送：并发写同一个 contributor 的行会互相覆盖，落库顺序无法保证。
 * ⚠ 空表也是合法输入（我撤回了全部票）—— 它发一条空数组，服务端据此清掉我的所有票。 */
async function sendVotes(
  list: readonly FilmVotePayload[],
): Promise<{ votes: unknown; skins: unknown } | null> {
  const total = list.length;
  for (
    let end = Math.min(MAX_VOTES_PER_PING, total);
    ;
    end = Math.min(end + MAX_VOTES_PER_PING, total)
  ) {
    const response = await fetch(PING_URL, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edition: EDITION, votes: list.slice(0, end) }),
      signal: timeoutSignal(12_000),
    });
    // ⚠ 抛**带种类的**错误（见 `FilmVotesPingRejectedError`）：视图层要靠它把
    //   「服务端拒绝」与「网络不通」分开提示 —— 这一条正是 2026-09-30 那次
    //   「提示说检查网络，其实是 422」的根因所在。
    if (!response.ok) throw new FilmVotesPingRejectedError(response.status);
    const body = (await response.json()) as { votes?: unknown; skins?: unknown };
    if (end >= total) {
      // ⚠ 响应里**没有 `votes`** 才是「老服务端」的信号（它压根不回全量）→ 必须回 `null`，
      //   让调用方退回去 `loadFilmVotes(true)` 重拉一次。
      //   加了 `skins` 之后不能图省事一律回对象 —— 那会把这一档悄悄吞掉，表现为
      //   「上报成功了但数字停在旧值」，而且没有任何报错（这条由单测守着）。
      if (!body.votes) return null;
      // ⚠ 新服务端但还没上按款聚合那半边时 `skins` 缺席 → `undefined` →
      //   `applyVotes` 把按款分布**清空**，群点退回「按 id 兜底」。那是**正确**的降级
      //   （不知道就别装作知道），不是错误。
      return { votes: body.votes, skins: body.skins };
    }
  }
}

/* ---------------- 待发队列与退避重试（2026-10-05，PLAN-20261005182415 §A） ----------------
 * 由来：上报原来**只活在一个 1200ms 的 `setTimeout` 闭包里** —— 关页 / 切后台（iOS 会挂起定时器，
 *   甚至把整个标签页回收掉）/ 崩溃，那一次上报就**从来没发生过**。而服务端是**整份替换**语义，
 *   「本地有、服务端没有」只能靠下一次票签名变化碰巧补上 —— 而拖动不改签名（`votesSignature`
 *   不含坐标），补不上。于是「偶发失败」在服务端看就是「这一票永远没上去」。
 * 这里把「要发的这一份票 + 它的序号」落到盘上，载入时先补发一次，失败再按 1s/2s/4s/8s… 退避重试。
 *
 * ⚠ 键落在 `iffday.workspace.*` 而**不是** `biff.*`：`biff.` 前缀会被 `sync-data.ts::readWorkspace`
 *   收进账号文档（`local:biff.*`）、参与跨设备合并（可能弹出「同步冲突」）、也会进 `backup.ts`
 *   的备份快照。而这一份是**本浏览器、本身份**的临时待发状态 —— 不是用户数据，跨设备合并没有意义
 *   （还会把别的设备那一份当成自己的意图发上去）。`iffday.workspace.*` 是既有的
 *   「本地专属、只写盘不上报」命名空间（见 `state.ts` 里那条说明）。 */
export const LS_PENDING_FILM_VOTES = "iffday.workspace.redblackpending.v1";

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

/** 待发的那一份。*/
interface PendingFilmVotes {
  /** 单调递增的序号：**每次「用户改了票」都换一个新号**，用来丢弃落后的响应。 */
  seq: number;
  votes: FilmVotePayload[];
  /** 服务端**拒绝过**这一份（4xx）→ 不再自动发（`shouldRetryPing` 那张口径的落点）。
   *  ⚠ 它**不落盘**：盘上那份只回答「要发什么」，「这一拍该不该发」是一次载入内的事 ——
   *    下次开页面重新判断一次（那时载荷可能已经被新版修好了）。
   *  ⚠ 用户再动一次手就换新 `seq` → 这个标记自然失效，等于「载荷变了就再试一次」。 */
  blocked?: boolean;
}

let pending: PendingFilmVotes | null = null;
/** 内存里的序号游标。载入时用盘上那份的号兜底（否则新一轮的号会比盘上那份还小）。 */
let pendingSeq = 0;
/** 已经被服务端确认应用过的最大 seq。比它旧的响应一律丢弃 —— 否则「旧响应」会把新状态盖回去
 *  （表现就是「刚收回的那枚贴纸又冒出来」）。 */
let appliedSeq = 0;
/** 串行化：同一时刻只允许**一条**在途。`pagehide` 那一发（keepalive）不等响应，不占这个位。 */
let inFlight = false;
let retryAttempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
/** 生命周期监听只挂一次（`redblack.ts::pagehideBound` 同一手法）。 */
let lifecycleBound = false;

/** 盘上那一份 → 白名单收口。
 *
 *  ⚠ **任一条不认识就整份丢弃**，而不是像读票数那样「丢掉那一条」：这里的每一跳都对应服务端
 *    的一次**整份替换**，丢掉一条 = 那一票被当成「用户撤回了」删掉 —— 是破坏性的。
 *    宁可这次不补发（用户下一次动手会重新落盘），也不要拿一份残缺的载荷去碰服务端。
 *  ⚠ `votes: []` 是**合法**的（用户撤回了全部票，服务端据此清空我这一份）——
 *    所以判据是「有没有一个合法的 `seq`」，不是「表里有没有票」。 */
function readPending(): PendingFilmVotes | null {
  if (typeof localStorage === "undefined") return null; // node 环境的单测
  let raw: string | null;
  try {
    raw = localStorage.getItem(LS_PENDING_FILM_VOTES);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { seq?: unknown; votes?: unknown };
    if (typeof parsed?.seq !== "number" || !Number.isFinite(parsed.seq)) return null;
    if (!Array.isArray(parsed.votes)) return null;
    const votes: FilmVoteInput[] = [];
    for (const item of parsed.votes) {
      if (!item || typeof item !== "object") return null;
      const entry = item as { key?: unknown; vote?: unknown; comment?: unknown; skin?: unknown };
      if (typeof entry.key !== "string" || !entry.key) return null;
      if (entry.vote !== "red" && entry.vote !== "black") return null;
      votes.push({
        key: entry.key,
        vote: entry.vote,
        comment: typeof entry.comment === "string" ? entry.comment : null,
        skin: isStickerSkin(entry.skin) ? entry.skin : null,
      });
    }
    return { seq: Math.max(0, Math.trunc(parsed.seq)), votes: dedupeVotes(votes) };
  } catch {
    return null;
  }
}

/** 写盘 / 清盘。⚠ 失败一律吞掉（配额满 / 隐私模式）—— 退化成「只有内存里那一份」，
 *  与 `redblack.ts::saveStickers` 是同一条取舍：写不进去不该让上报本身失败。 */
function writePending(next: PendingFilmVotes | null): void {
  if (typeof localStorage === "undefined") return;
  try {
    // ⚠ 只写 `{seq, votes}`（不带 `blocked`）：盘上那份要能被 `readPending` 的**白名单**完整收下，
    //   多写一个只会落进 `undefined`/`null` 的争议里。见 `PendingFilmVotes::blocked` 的说明。
    if (next) localStorage.setItem(LS_PENDING_FILM_VOTES, JSON.stringify({ seq: next.seq, votes: next.votes }));
    else localStorage.removeItem(LS_PENDING_FILM_VOTES);
  } catch {
    /* 见上 */
  }
}

/** 一条**成功**响应 → 采纳。两条发送路径（正常 / keepalive）共用它。
 *
 *  ⚠ 序号守卫在这一处：这份载荷若已被更晚的一份取代（`job.seq < appliedSeq`），整条响应**丢弃**
 *    —— 既不 `adoptSyncedVotes` 也不 `applyVotes`。不然旧响应会把新状态盖回去：表现是
 *    「刚收回的贴纸又冒出来一枚」，而且要等下一次上报才自愈。
 *  ⚠ 抽成一处而不是两条路各写一遍：`appliedSeq` / `clearPending` / `adoptSyncedVotes` /
 *    `reportPingFailure` 这四件事**必须同进同退**，漏掉其中一件都只有「过一会儿才刷新」可察。 */
function applyPingSuccess(
  job: PendingFilmVotes,
  raw: { votes: unknown; skins: unknown } | null,
): FilmVoteCounts | Promise<FilmVoteCounts> | undefined {
  if (job.seq < appliedSeq) return undefined; // 旧响应：丢弃
  appliedSeq = job.seq;
  clearPending(job.seq);
  retryAttempt = 0;
  // 服务端已收下这份票 → 它现在**含我**，扣减基准跟着切过去。
  // ⚠ 顺序不能倒：先采纳（不广播）、再更新 counts（它内部那次 `emit` 会把新的 counts 与
  //   新的 synced 一起送到页面），中间不留「服务端仍算我旧票」的那一帧。
  // ⚠ `skins` 也必须在**同一拍**换成新的：两本账来自同一个响应体，分批换会让群点
  //   短暂画在「新数字 + 旧分布」上 —— 那正是「群点比数字多/少一枚」的成因。
  adoptSyncedVotes(job.votes);
  reportPingFailure(0, null);
  // ⚠ 新服务端在响应里顺手回了全量 → 直接用，省掉「上报成功再 GET 一次」的那个 RTT；
  //   老服务端（没这个字段）才退回去重拉。
  if (raw === null) return loadFilmVotes(true);
  return applyVotes(raw.votes, raw.skins);
}

/** `pagehide` / 切后台那一刻的**最后一发**。
 *
 *  返回值只回答「有没有发出去」—— 页面正在走，**不能等**它。但拿到响应时仍然照收（见下）：
 *  `visibilitychange(hidden)` 之后用户可能又切回来，这一发是能拿到结果的。
 *
 *  ⚠ 两条硬约束（PLAN §A）：① `keepalive` 的 body 上限是 64KB；
 *    ② 服务端是**整份替换** —— 所以**绝不能**在这里发分批前缀或截断载荷（那会把其余的票删掉）。
 *    任一不满足就**干脆不发**，留着 pending 下次开页面补。
 *  ⚠ 失败**不提示、不重试**（页面正在走，弹一个没人看的提示只会更糟）；`blocked` 的那一份干脆不发。 */
export function sendFilmVotesKeepalive(): boolean {
  const job = pending;
  if (!job || job.blocked || typeof window === "undefined") return false;
  // 一份发不完（超过单次上限）→ 不发：分批的后一批会把前一批盖掉，而这条路是「最后一发」
  if (job.votes.length > MAX_VOTES_PER_PING) return false;
  const body = JSON.stringify({ edition: EDITION, votes: job.votes });
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
        const parsed = (await response.json()) as { votes?: unknown; skins?: unknown };
        // ⚠ 与正常那条路**共用**同一个收尾（序号守卫在里面）：这条「更新的一份」若不用它的响应推进
        //   `appliedSeq`，随后回来的**旧**响应就会把新数字盖回去。
        applyPingSuccess(job, parsed.votes ? { votes: parsed.votes, skins: parsed.skins } : null);
      })
      .catch(() => undefined);
    return true;
  } catch {
    // 同步抛（例如 keepalive 配额被浏览器拒）→ 当作没发出去
    return false;
  }
}

/** 清掉待发（内存 + 盘），并且**只在 seq 对得上时**才清：
 *  在途期间用户又改了票（新 seq 已经写进 pending）时，不能把新的那一份一起清掉。 */
function clearPending(seq: number): void {
  if (pending?.seq !== seq) return;
  pending = null;
  writePending(null);
  clearTimeout(retryTimer);
  retryTimer = undefined;
}

function schedulePingRetry(): void {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    flushFilmVotesPing();
  }, pingRetryDelay(retryAttempt));
  retryAttempt += 1;
}

/** 把当前待发的那一份**发出去**。
 *
 *  `keepalive: true` = 「页面正在走」那一发（见 `sendFilmVotesKeepalive`）：不等响应、不占在途位。
 *
 *  ⚠ 在途时**不发第二条**：两条并发写同一个 contributor 的落库顺序无法保证，而超限时
 *    `sendVotes` 是按**累积前缀**分批的 —— 顺序错了会把后一批的内容盖回去。
 *  ⚠ 服务端**拒绝过**这一份（4xx）就干脆不发：口径收在 `shouldRetryPing` 一处。 */
export function flushFilmVotesPing(options: { keepalive?: boolean } = {}): void {
  const job = pending;
  if (!job || job.blocked) return;
  if (options.keepalive) {
    sendFilmVotesKeepalive();
    return;
  }
  if (inFlight) return;
  inFlight = true;
  void sendVotes(job.votes)
    .then((raw) => applyPingSuccess(job, raw))
    .catch((error: unknown) => {
      reportPingFailure(
        pingFailureStreak + 1,
        error instanceof FilmVotesPingRejectedError ? "rejected" : "offline",
      );
      if (!shouldRetryPing(error)) {
        // 4xx：这一份不再自动发（用户再动一次手会换新 seq，等于「载荷变了就再试一次」；
        // 换一次载入也会重新判断）。⚠ 标记只活在内存里，见 `PendingFilmVotes::blocked`。
        job.blocked = true;
        return;
      }
      schedulePingRetry();
    })
    .finally(() => {
      inFlight = false;
      // ⚠ 在途期间用户又改了票 → 立刻补发**最新**那一份。
      //   判据必须是「比这一份更新」而不是「有 pending」：同一份失败时由退避计时器负责，
      //   在这里无条件补发会变成死循环。
      if (pending && pending.seq > job.seq) flushFilmVotesPing();
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
  /** 页面正在走 → 最后一发（不等响应、不清 pending）。 */
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
    //   所以「贴完就切走」那一份很可能**根本没发出去过**。
    // ⚠ 只在「**没有人在等这次发送**」时才补（`retryTimer` 为空）：若退避计时器正等着，
    //   交给它就行 —— 否则每次前后台来回都插一发，把退避白白抵消掉。
    if (retryTimer === undefined) flushFilmVotesPing();
  });
}

/** 页面载入时把上一次没发成功的那一份补上。
 *
 *  ⚠ 只在**盘上真有 pending** 时动作：没有就不能碰服务端 —— 本地为空多半只是「这台机器还没数据」
 *    （换设备 / 清过缓存），而服务端是整份替换，拿空榜上报会把服务端属于我的票清掉。
 *    这与 `RedBlackPage` 那条 `actedRef` 是同一条保护的两种入口。
 *  ⚠ 不走 1200ms 防抖：上一次已经防过了，而且用户正等着它上墙。 */
export function resumePendingFilmVotes(): void {
  const stored = readPending();
  if (!stored) return;
  if (!pending || stored.seq > pending.seq) {
    pendingSeq = Math.max(pendingSeq, stored.seq);
    pending = stored;
  }
  bindPingLifecycle();
  flushFilmVotesPing();
}

/** 上报我的投票。**发全量**（1200ms 防抖）—— 服务端按整份替换。
 *
 *  ⚠ 待发的那一份**同时落盘**（见上面那段说明）：关页 / 切后台 / 崩溃之后，`resumePendingFilmVotes`
 *    会在下一次载入时把它补上。所以「靠重发一次自愈」这句话现在真的成立 —— 原来它成立的前提是
 *    「用户还会再动一次手，而且这一页还活着」。
 *  ⚠ 用全局 `setTimeout` 而不是 `window.setTimeout`：与 `screening-counts.ts` 同一条理由
 *    （模块可能被跑在 node 环境里的单测引用）。
 *  ⚠ 载荷里的 `comment` / `skin` 由 `dedupeVotes` 统一补齐（**每条都带字段**），
 *    所以调用方哪怕只给 `{key, vote}` 也不会踩到「服务端当成旧版前端」那条坑。 */
export function scheduleFilmVotesPing(votes: Iterable<FilmVoteInput>): void {
  const list = dedupeVotes(votes);
  // 新意图作废旧的退避：用户又动了一次手，该按新载荷立刻发，而不是等上一轮退避走完
  clearTimeout(retryTimer);
  retryTimer = undefined;
  retryAttempt = 0;
  pendingSeq += 1;
  pending = { seq: pendingSeq, votes: list };
  writePending(pending);
  bindPingLifecycle();
  clearTimeout(pingTimer);
  pingTimer = setTimeout(() => {
    pingTimer = undefined;
    flushFilmVotesPing();
  }, 1200);
}
