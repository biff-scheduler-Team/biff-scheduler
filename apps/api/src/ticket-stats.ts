/**
 * 抢票结果口径（抢票分析模块，2026-09-20，PLAN-20260920161837）。
 *
 * 身份与权重口径**完全照抄**「同场观影人数」(`screening-stats.ts`) —— 登录 1.0 / 匿名 0.75
 * （见 `want-stats.ts`），差别只在载荷：那边是「一组场次 code」，这边是「场次 code → 最终结果」。
 *
 * ★ 为什么是**四值**，而不是用户看到的**三态**：
 *   UI 上只有「已抢到 / 没抢到 / 放弃」，但 `via === "transfer"`（票是别人转的）必须从「已抢到」
 *   里**摘出来** —— 转票不等于自己抢到，混进分子会让抢到率虚高。归一成独立取值后，
 *   这条业务规则在服务端只有一份实现（`outcomeOf`），且天然满足「转票不进分子也不进分母」。
 *   ⚠ 只认 `state === "got"` 的转票：`state.ts::setTicket` 改状态时**保留** `via`
 *     （把「已抢到」改成「放弃」不该弄丢「转票」标记），所以 `dropped` + `via=transfer` 是
 *     真实存在的组合 —— 它是一条「放弃」，不是一次转票获得。
 *
 * ★ 为什么本模块**不算率值**（没有 `ticketRates`）：
 *   率值是纯展示派生，前端 `rush-analysis.ts::ticketOutcomeStats` 实现一次即可；服务端再算一遍
 *   就是同一口径两份实现（红线 5）。服务端只负责**存与聚合**。
 */

import { SCREENING_CODE_MAX_LENGTH } from "./screening-stats";

/** 用户自述的三态（与前端 `types.ts::TicketState` 同集；「售罄」这类票务系统内部状态刻意不在其中）。 */
export type TicketState = "got" | "missed" | "dropped";

/** 是否「票是别人转的」（与前端 `types.ts::TicketVia` 同集）。 */
export type TicketVia = "self" | "transfer";

/** 落库口径 —— `got` 里 `via=transfer` 的那些被摘成独立的 `transfer`。 */
export type TicketOutcome = "got" | "transfer" | "missed" | "dropped";

/** ⚠ 声明成 `as const` 元组（而不是 `readonly TicketState[]`）：zod 的 `z.enum()` 要的是
 *  `readonly [string, ...string[]]`，宽数组类型传不进去。取值仍然是这三条。 */
export const TICKET_STATES = ["got", "missed", "dropped"] as const;

export const TICKET_OUTCOMES = ["got", "transfer", "missed", "dropped"] as const;

/** 一场的四个计数（展示时 `Math.round`）。 */
export interface TicketCounts {
  got: number;
  transfer: number;
  missed: number;
  dropped: number;
}

/** 一次上报最多带多少场（与 want-ping / screening-ping 的 500 对齐） */
export const MAX_TICKET_ENTRIES_PER_PING = 500;

const stateSet = new Set<string>(TICKET_STATES);
const outcomeSet = new Set<string>(TICKET_OUTCOMES);

export function isTicketState(value: unknown): value is TicketState {
  return typeof value === "string" && stateSet.has(value);
}

export function isTicketOutcome(value: unknown): value is TicketOutcome {
  return typeof value === "string" && outcomeSet.has(value);
}

/** (自述三态, 来源) → 落库四值。**转票规则的唯一实现点**。
 *  非法 / 缺失的三态 → `null`（调用方丢弃该条，与 `hydrate()` 的「只取白名单」同一原则）。 */
export function outcomeOf(state: unknown, via: unknown): TicketOutcome | null {
  if (!isTicketState(state)) return null;
  if (state === "got" && via === "transfer") return "transfer";
  return state;
}

/** 上报列表 → Map。同一场出现多次时**以最后一条为准**（前端可能把旧值和新值一起发上来了）；
 *  非法条目（空 code / 超长 code / 非白名单 state）静默丢弃，
 *  与 `hydrate()` / `normalizeVotes` 的「只取白名单」同一条原则。 */
export function normalizeTicketEntries(
  input: Iterable<{ code: unknown; state: unknown; via?: unknown }>,
): Map<string, TicketOutcome> {
  const out = new Map<string, TicketOutcome>();
  for (const item of input) {
    if (!item || typeof item.code !== "string") continue;
    if (!item.code || item.code.length > SCREENING_CODE_MAX_LENGTH) continue;
    const outcome = outcomeOf(item.state, item.via);
    if (!outcome) continue;
    out.set(item.code, outcome);
  }
  return out;
}

/** 两次上报的差异，拆成「要撤的」与「要记的」——
 *  **改结果会同时出现在两边**（旧值进 removed、新值进 added），调用方只要
 *  「先按 removed 减、再按 added 加」就能正确处理改状态。与 `film-vote-stats.ts::diffVotes` 同构。 */
export function diffOutcomes(
  previous: ReadonlyMap<string, TicketOutcome>,
  next: ReadonlyMap<string, TicketOutcome>,
): {
  removed: Array<{ code: string; outcome: TicketOutcome }>;
  added: Array<{ code: string; outcome: TicketOutcome }>;
} {
  const removed: Array<{ code: string; outcome: TicketOutcome }> = [];
  const added: Array<{ code: string; outcome: TicketOutcome }> = [];
  for (const [code, outcome] of previous) {
    if (next.get(code) !== outcome) removed.push({ code, outcome });
  }
  for (const [code, outcome] of next) {
    if (previous.get(code) !== outcome) added.push({ code, outcome });
  }
  return { removed, added };
}

/** 权重和 → 展示用整数；四项全 ≤ 0 的场次**不返回**（没结果标记的场次本来就该是「无数据」，
 *  回一行全 0 只会让前端多一堆「有计数但为 0」的分支）。与 `formatVoteCounts` 同一条原则。 */
export function formatTicketCounts(
  rows: Iterable<{
    code: string;
    got_sum: string | number;
    transfer_sum: string | number;
    missed_sum: string | number;
    dropped_sum: string | number;
  }>,
): Record<string, TicketCounts> {
  const counts: Record<string, TicketCounts> = Object.create(null);
  for (const row of rows) {
    const got = sumOf(row.got_sum);
    const transfer = sumOf(row.transfer_sum);
    const missed = sumOf(row.missed_sum);
    const dropped = sumOf(row.dropped_sum);
    if (got <= 0 && transfer <= 0 && missed <= 0 && dropped <= 0) continue;
    counts[row.code] = { got: Math.round(got), transfer: Math.round(transfer), missed: Math.round(missed), dropped: Math.round(dropped) };
  }
  return counts;
}

/** D1 的聚合列理论上都是文本，但换实现 / 手工查库时也可能到手数字，统一兜一层。 */
function sumOf(raw: string | number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
