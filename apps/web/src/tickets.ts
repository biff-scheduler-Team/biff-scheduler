/**
 * 票务状态(`biff.tickets.v1`)纯逻辑:枚举 / 读取归一 / 派生「实际行程」/ prune。
 *
 * 不碰 DOM、不 import `state.ts` —— node 直接可测。
 * ⚠ 「实际行程」只是**视图筛选**(`state === "got"`),不另建第二套场次清单:
 *   数据仍在 `biff.picks.v2` 那一份行程里,票务状态是挂在它上面的附加层。
 */

import type { TicketRecord, TicketState, TicketVia } from "./types";

/** 三态 —— 顺序即控件顺序(控件 / 徽章 / 提示都读这一份)。 */
export const TICKET_STATES = ["got", "missed", "dropped"] as const;

export const TICKET_STATE_LABELS: Record<TicketState, string> = {
  got: "已抢到",
  missed: "没抢到",
  dropped: "放弃",
};

const stateSet = new Set<string>(TICKET_STATES);

export function isTicketState(value: unknown): value is TicketState {
  return typeof value === "string" && stateSet.has(value);
}

export function isTicketVia(value: unknown): value is TicketVia {
  return value === "self" || value === "transfer";
}

/** 读取时归一:状态非法 → null(整条丢弃);`via` 非法 / 缺省 → 退回「自己抢到」(不写回 `self`)。 */
export function normalizeTicketRecord(raw: unknown): TicketRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const { state, via } = raw as { state?: unknown; via?: unknown };
  if (!isTicketState(state)) return null;
  return isTicketVia(via) && via === "transfer" ? { state, via: "transfer" } : { state };
}

/** 「实际行程」= 标记为「已抢到」的场次(含转票补入的场次)。 */
export function actualCodeSet(records: ReadonlyMap<string, TicketRecord>): Set<string> {
  const codes = new Set<string>();
  for (const [code, record] of records) {
    if (record.state === "got") codes.add(code);
  }
  return codes;
}

/** 已移出行程的场次,其票务状态已无意义 → 返回应删掉的 code(不直接改 Map,便于单测)。 */
export function staleTicketCodes(
  records: ReadonlyMap<string, TicketRecord>,
  alive: (code: string) => boolean,
): string[] {
  const stale: string[] = [];
  for (const code of records.keys()) {
    if (!alive(code)) stale.push(code);
  }
  return stale;
}
