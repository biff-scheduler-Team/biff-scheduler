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
import type { FilmSkinCounts, SkinCrowdCounts } from "./redblack";
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
        signal: AbortSignal.timeout(12_000),
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
    const response = await fetch("/api/stats/film-votes-ping", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edition: EDITION, votes: list.slice(0, end) }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`film-votes-ping ${response.status}`);
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
      .then((raw) => {
        // 服务端已收下这份票 → 它现在**含我**，扣减基准跟着切过去。
        // ⚠ 顺序不能倒：先采纳（不广播）、再更新 counts（它内部那次 `emit` 会把新的 counts 与
        //   新的 synced 一起送到页面），中间不留「服务端仍算我旧票」的那一帧。
        // ⚠ `skins` 也必须在**同一拍**换成新的：两本账来自同一个响应体，分批换会让群点
        //   短暂画在「新数字 + 旧分布」上 —— 那正是「群点比数字多/少一枚」的成因。
        adoptSyncedVotes(list);
        reportPingFailure(0);
        // ⚠ 新服务端在响应里顺手回了全量 → 直接用，省掉「上报成功再 GET 一次」的那个 RTT；
        //   老服务端（没这个字段）才退回去重拉。
        if (raw === null) return loadFilmVotes(true);
        return applyVotes(raw.votes, raw.skins);
      })
      .catch(() => {
        reportPingFailure(pingFailureStreak + 1);
      });
  }, 1200);
}
