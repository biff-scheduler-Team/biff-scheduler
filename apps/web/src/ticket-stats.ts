/**
 * 「大家抢到没有」的客户端缓存（抢票分析模块，2026-09-20，PLAN-20260920161837）。
 *
 * 形状与 `film-votes.ts` / `screening-counts.ts` 完全同构（单例缓存 + 广播），
 * 载荷是「场次 code → 四项结果计数」。
 *
 * ⚠ **上报端已于 2026-09-30 整体删除**（`PLAN-20260930213528`）：`scheduleTicketPing` 唯一的
 *   数据来源是本地票务三态（`biff.tickets.v1`），而三态随卡片视图下线 ⇒ 没有可上报的结果了。
 *   服务端 `/api/stats/ticket-results-ping` 与计数表**原样保留**，只是不再有新数据写入。
 * ⚠ **接口没上线时页面必须照常可用** —— 读失败一律退化成「结果面为空」。
 */

import { EDITION } from "./edition";
import { timeoutSignal } from "./net";
import { wholeCount } from "./util";

/** 一场的四项计数（与 api 侧 `ticket-stats.ts::TicketCounts` 同形）。 */
export interface TicketCounts {
  got: number;
  transfer: number;
  missed: number;
  dropped: number;
}

/** 场次 code → 四项计数 */
export type TicketOutcomeCounts = Record<string, TicketCounts>;

let cache: TicketOutcomeCounts | null = null;
let loading: Promise<TicketOutcomeCounts> | null = null;
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
        signal: timeoutSignal(12_000),
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

/* `scheduleTicketPing()` / `TicketEntry` / `MAX_TICKET_ENTRIES_PER_PING` 已于 2026-09-30 删除
 * (`PLAN-20260930213528`):它们的唯一输入是本地票务三态,而三态随卡片视图一并下线。
 * 读取端(`loadTicketCounts` / `peekTicketCounts` / `parseTicketCounts`)保留不动 ——
 * 抢票分析链路仍按服务端返回的存量计数渲染。 */

