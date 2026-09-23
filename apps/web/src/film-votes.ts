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
      cache = parseVotes(body.votes);
      emit();
      return cache;
    } catch {
      // 接口还没部署 / 断网：留一份空表，页面照常能贴（只是看不到大家的票）
      return cache ?? emptyCounts();
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** 上报我的投票。**发全量**（1200ms 防抖）—— 服务端按整份替换，
 *  所以断网一段时间后重新上报一次就能自愈，不需要在本地记「待同步队列」。
 *  ⚠ 用全局 `setTimeout` 而不是 `window.setTimeout`：与 `screening-counts.ts` 同一条理由
 *    （模块可能被跑在 node 环境里的单测引用）。 */
export function scheduleFilmVotesPing(
  votes: Iterable<{ key: string; vote: "red" | "black" }>,
): void {
  // 同一部片只留一条（防抖窗口内重复调用时，后到的覆盖先到的）
  const list = [...new Map([...votes].map((entry) => [entry.key, entry])).values()].slice(
    0,
    MAX_VOTES_PER_PING,
  );
  clearTimeout(pingTimer);
  pingTimer = setTimeout(() => {
    void fetch("/api/stats/film-votes-ping", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edition: EDITION, votes: list }),
      signal: AbortSignal.timeout(12_000),
    })
      .then((response) => {
        if (!response.ok) return;
        // 服务端已收下这份票 → 它现在**含我**，扣减基准跟着切过去。
        // ⚠ 顺序不能倒：先采纳（不广播）、再重拉 —— 重拉内部那次 `emit` 会把新的 counts 与新的
        //   synced 一起送到页面，中间不留「服务端仍算我旧票」的那一帧。
        adoptSyncedVotes(list);
        // 上报成功后再拉一次，让自己这一票立刻体现在榜单上
        return loadFilmVotes(true);
      })
      .catch(() => undefined);
  }, 1200);
}
