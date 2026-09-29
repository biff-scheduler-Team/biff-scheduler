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
import { wholeCount } from "./util";

/** 影片 key → 红 / 黑票数 */
export type FilmVoteCounts = Record<string, { red: number; black: number }>;

/** 单次上报的影片上限（与 api 侧 `MAX_VOTES_PER_PING` 对齐） */
export const MAX_VOTES_PER_PING = 500;

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
}

/** 调用方**交进来**的一票 —— `comment` 可省（`dedupeVotes` 会补成 `null`）。
 *  与 `FilmVotePayload` 分开写，是为了让「省略字段」只出现在**入口**，
 *  进了这条链路之后一定是「字段齐全」的那个形状。 */
export interface FilmVoteInput {
  key: string;
  vote: "red" | "black";
  comment?: string | null;
}

let cache: FilmVoteCounts | null = null;
let loading: Promise<FilmVoteCounts> | null = null;
// ⚠ 类型写 `ReturnType<typeof setTimeout>` 而不是 `number`：本模块会被跑在 node 环境下的单测引用，
//   那里的 `setTimeout` 返回的是 `Timeout` 对象（web 的 tsconfig 同时含 DOM 与 node 类型）。
let pingTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function emptyCounts(): FilmVoteCounts {
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
 * 由视图层决定什么时候说一次(它才是知道「有没有说过」的那一层)。 */

const failureListeners = new Set<(streak: number) => void>();
let pingFailureStreak = 0;

/** 订阅「上报连续失败了几次」。成功时会收到一次 `0`,供视图层复位「已提示过」。 */
export function onFilmVotesPingFailure(listener: (streak: number) => void): () => void {
  failureListeners.add(listener);
  return () => {
    failureListeners.delete(listener);
  };
}

function reportPingFailure(streak: number): void {
  pingFailureStreak = streak;
  for (const listener of failureListeners) listener(streak);
}

/** 已缓存的票数（同步读，未加载过则为空表） */
export function peekFilmVotes(): FilmVoteCounts {
  return cache ?? emptyCounts();
}

/** 服务端已确认含我的那份票（同步读，见 `synced` 的说明）。 */
export function peekSyncedVotes(): FilmVoteCounts {
  return synced;
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

/** 用一份**刚从服务端回来的**票替换缓存并广播。
 *  ⚠ 与 `loadFilmVotes` 的分工:它**不发起请求** —— 上报成功时服务端顺手回了全量,
 *    再 GET 一次纯粹是白跑一个 RTT(2026-09-28,见 `scheduleFilmVotesPing`)。 */
function applyVotes(raw: unknown): FilmVoteCounts {
  cache = parseVotes(raw);
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
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) return cache ?? emptyCounts();
      const body = (await response.json()) as { votes?: unknown };
      return applyVotes(body.votes);
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
    out.set(entry.key, { key: entry.key, vote: entry.vote, comment });
  }
  return [...out.values()];
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
async function sendVotes(list: readonly FilmVotePayload[]): Promise<unknown | null> {
  const total = list.length;
  for (
    let end = Math.min(MAX_VOTES_PER_PING, total);
    ;
    end = Math.min(end + MAX_VOTES_PER_PING, total)
  ) {
    const response = await fetch("/api/stats/film-votes-ping", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edition: EDITION, votes: list.slice(0, end) }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`film-votes-ping ${response.status}`);
    const body = (await response.json()) as { votes?: unknown };
    if (end >= total) return body.votes ?? null;
  }
}

/** 上报我的投票。**发全量**（1200ms 防抖）—— 服务端按整份替换，
 *  所以断网一段时间后重新上报一次就能自愈，不需要在本地记「待同步队列」。
 *  ⚠ 用全局 `setTimeout` 而不是 `window.setTimeout`：与 `screening-counts.ts` 同一条理由
 *    （模块可能被跑在 node 环境里的单测引用）。
 *  ⚠ 载荷里的 `comment` 由 `dedupeVotes` 统一补成 `null`/字符串（**每条都带字段**），
 *    所以调用方哪怕只给 `{key, vote}` 也不会踩到「服务端当成旧版前端」那条坑。 */
export function scheduleFilmVotesPing(votes: Iterable<FilmVoteInput>): void {
  const list = dedupeVotes(votes);
  clearTimeout(pingTimer);
  pingTimer = setTimeout(() => {
    void sendVotes(list)
      .then((rawVotes) => {
        // 服务端已收下这份票 → 它现在**含我**，扣减基准跟着切过去。
        // ⚠ 顺序不能倒：先采纳（不广播）、再更新 counts（它内部那次 `emit` 会把新的 counts 与
        //   新的 synced 一起送到页面），中间不留「服务端仍算我旧票」的那一帧。
        adoptSyncedVotes(list);
        reportPingFailure(0);
        // ⚠ 新服务端在响应里顺手回了全量 → 直接用，省掉「上报成功再 GET 一次」的那个 RTT；
        //   老服务端（没这个字段）才退回去重拉。
        if (rawVotes === null) return loadFilmVotes(true);
        return applyVotes(rawVotes);
      })
      .catch(() => {
        reportPingFailure(pingFailureStreak + 1);
      });
  }, 1200);
}
