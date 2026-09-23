/**
 * 「大家抢到没有」的客户端缓存 + 我的抢票结果上报（抢票分析模块，2026-09-20，PLAN-20260920161837）。
 *
 * 形状与 `film-votes.ts` / `screening-counts.ts` 完全同构（单例缓存 + 广播 + 防抖上报），
 * 差别只在载荷：这边是「场次 code → 最终结果（已抢到 / 转票 / 没抢到 / 放弃）」。
 *
 * ⚠ 隐私边界与 want-ping / screening-ping 一致：只上报**场次 code 与结果**，
 *   绝不上报备注 / 片单 / 身份。服务端只回四种计数的聚合数字，不回名单。
 * ⚠ **接口没上线时页面必须照常可用** —— 读失败一律退化成「结果面为空」，
 *   本地票务三态（`biff.tickets.v1`）不受影响。
 */

import { EDITION } from "./edition";
import { wholeCount } from "./util";
import type { TicketState, TicketVia } from "./types";

/** 一场的四项计数（与 api 侧 `ticket-stats.ts::TicketCounts` 同形）。 */
export interface TicketCounts {
  got: number;
  transfer: number;
  missed: number;
  dropped: number;
}

/** 场次 code → 四项计数 */
export type TicketOutcomeCounts = Record<string, TicketCounts>;

/** 单次上报的场次上限（与 api 侧 `MAX_TICKET_ENTRIES_PER_PING` 对齐） */
export const MAX_TICKET_ENTRIES_PER_PING = 500;

/** 上报的一条：只带场次 code 与结果，不带任何备注。 */
export interface TicketEntry {
  code: string;
  state: TicketState;
  via?: TicketVia;
}

let cache: TicketOutcomeCounts | null = null;
let loading: Promise<TicketOutcomeCounts> | null = null;
// ⚠ 类型写 `ReturnType<typeof setTimeout>` 而不是 `number`：本模块会被跑在 node 环境下的单测引用，
//   那里的 `setTimeout` 返回的是 `Timeout` 对象（web 的 tsconfig 同时含 DOM 与 node 类型）。
let pingTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function emptyCounts(): TicketOutcomeCounts {
  return Object.create(null);
}

export function onTicketCountsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** 已缓存的结果计数（同步读，未加载过则为空表） */
export function peekTicketCounts(): TicketOutcomeCounts {
  return cache ?? emptyCounts();
}

/** 读取端白名单：服务端固然不会发坏数据，但客户端缓存**不能假设上游永远正确**
 *  （旧版本 API、代理改写、半截响应）—— 非法条目一律丢弃，四项全 0 的行也丢弃，
 *  与 `film-votes.ts::parseVotes` 同一条原则。
 *  ⚠ 取整走 `util.ts::wholeCount`（全站唯一取整口径，与 want / screening / film-votes
 *    三个同构模块同一份实现）—— 此前这里自己写了一份 `Math.trunc`（2026-09-23 收口）。 */
export function parseTicketCounts(raw: unknown): TicketOutcomeCounts {
  const out = emptyCounts();
  if (!raw || typeof raw !== "object") return out;
  for (const [code, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!code || !value || typeof value !== "object") continue;
    const row = value as Partial<Record<keyof TicketCounts, unknown>>;
    const got = wholeCount(row.got);
    const transfer = wholeCount(row.transfer);
    const missed = wholeCount(row.missed);
    const dropped = wholeCount(row.dropped);
    if (got <= 0 && transfer <= 0 && missed <= 0 && dropped <= 0) continue;
    out[code] = { got, transfer, missed, dropped };
  }
  return out;
}

export async function loadTicketCounts(force = false): Promise<TicketOutcomeCounts> {
  if (cache && !force) return cache;
  if (loading && !force) return loading;
  loading = (async () => {
    try {
      const response = await fetch(`/api/stats/ticket-counts?edition=${EDITION}`, {
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) return cache ?? emptyCounts();
      const body = (await response.json()) as { tickets?: unknown };
      cache = parseTicketCounts(body.tickets);
      emit();
      return cache;
    } catch {
      // 接口还没部署 / 断网：留一份空表，页面照常可用（只是结果面不渲染）
      return cache ?? emptyCounts();
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** 上报我的抢票结果。**发全量**（1200ms 防抖）—— 服务端按整份替换，
 *  所以断网一段时间后重新上报一次就能自愈，不需要在本地记「待同步队列」。
 *
 *  ⚠ 用全局 `setTimeout` 而不是 `window.setTimeout`：与 `screening-counts.ts` 同一条理由
 *    （本模块会被 `state.ts` 引用，而 `state.ts` 会被跑在 node 环境里的单测 import）。
 *  ⚠ **载入期不得调用** —— 见 `state.ts::ticketsTouched` 的守卫说明。 */
export function scheduleTicketPing(entries: Iterable<TicketEntry>): void {
  // 同一场只留一条（防抖窗口内重复调用时，后到的覆盖先到的）
  const list = [...new Map([...entries].map((entry) => [entry.code, entry])).values()].slice(
    0,
    MAX_TICKET_ENTRIES_PER_PING,
  );
  clearTimeout(pingTimer);
  pingTimer = setTimeout(() => {
    void fetch("/api/stats/ticket-results-ping", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edition: EDITION, entries: list }),
      signal: AbortSignal.timeout(12_000),
    })
      .then((response) => {
        // 上报成功后再拉一次，让自己这份立刻体现在全站数字里
        if (response.ok) return loadTicketCounts(true);
      })
      .catch(() => undefined);
  }, 1200);
}
