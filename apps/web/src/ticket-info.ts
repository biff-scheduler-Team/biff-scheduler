/**
 * 票据明细(localStorage `biff.ticketinfo.v1`)纯逻辑:读取归一 / 张数合计 / 徽章文案
 * (2026-09-24,`PLAN-20260924141442`)。
 *
 * ⚠ 只做「数据 → 数字 / 字符串」的换算,**不碰 DOM、不 import `state.ts` / `ticket-accounts.ts`** ——
 *   node 直接可测(与 `tickets.ts` 同口径)。
 * ⚠ 与抢票三态(`biff.tickets.v1` / `tickets.ts`)的分工见 `types.ts::TicketInfo` 的注释,这里不重复。
 * ⚠ 账号解析**不在这里** —— 它要读账号表(本地专属的另一只键),放 `ticket-accounts.ts`。
 */

import type { TicketInfo } from "./types";

/** 单场张数上限。官方口径是「每场限购 2 张」(`InfoDialogs.tsx` 的购票须知原文),
 *  但转票补入 / 多账号合计会超过它 —— 这里取一个「够用、又不会把输入框变成无意义数字」的上限。 */
export const TICKET_COUNT_MAX = 10;

/** 单个座位号的长度上限:防手滑把整段文字粘进输入框、再把 title 撑爆。 */
const SEAT_MAX_LENGTH = 12;

/** 归一张数:1..`TICKET_COUNT_MAX` 的整数;**其余一律视为「没填」**(不是 1,也不是 0)。
 *  ⚠ 「没填」与「1 张」必须是两个状态:格子徽章只在**显式填过**时才出现,否则整张画布全是「1 张」噪声。 */
function normalizeCount(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  const count = Math.round(raw);
  return count >= 1 && count <= TICKET_COUNT_MAX ? count : undefined;
}

/** 归一 `seats`:**保位对齐**、按张数截断、只收尾部的空项;结果为空 → `undefined`。
 *
 *  ⚠ 中间的空项**必须保留成空串**,不能像常规做法那样「丢掉空值」——
 *    数组下标 = 第几张票,丢掉中间那一项会把「第 3 张是 14」读成「第 2 张是 14」。
 *    尾部空项才是真正无意义的(用户只填了前两张),故只从尾巴收。 */
function normalizeSeats(raw: unknown, max: number): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seats: string[] = [];
  for (const seat of raw) {
    seats.push(typeof seat === "string" ? seat.trim().slice(0, SEAT_MAX_LENGTH) : "");
    if (seats.length >= max) break;
  }
  while (seats.length && !seats[seats.length - 1]) seats.pop();
  return seats.length ? seats : undefined;
}

/** 读取时归一:<br>
 *  · 不是对象 → `null`(整条丢弃);<br>
 *  · 三个字段都没落下有效值 → `null`(不留空壳记录,免得 localStorage 只增不减);<br>
 *  · `count` 非法 → 视为没填(而不是改写成 1);`seats` 超长 / 超量 → 截断。 */
export function normalizeTicketInfo(raw: unknown): TicketInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const { count, seats, accountId } = raw as {
    count?: unknown;
    seats?: unknown;
    accountId?: unknown;
  };
  const next: TicketInfo = {};
  const normalizedCount = normalizeCount(count);
  if (normalizedCount !== undefined) next.count = normalizedCount;
  // 张数没填时按上限截断座位,别让一条无主数据带上 500 个座位
  const normalizedSeats = normalizeSeats(seats, normalizedCount ?? TICKET_COUNT_MAX);
  if (normalizedSeats) next.seats = normalizedSeats;
  if (typeof accountId === "string" && accountId) next.accountId = accountId;
  return next.count === undefined && !next.seats && !next.accountId ? null : next;
}

/** **显式填过**的张数;没填 → `undefined`(编辑弹层的输入框拿它 `?? 1` 当默认值)。 */
export function ticketCountOf(info: TicketInfo | undefined): number | undefined {
  const count = info?.count;
  return typeof count === "number" && count >= 1 ? count : undefined;
}

/** 行程票数合计 —— 「共 N 张票」的**唯一口径**。
 *
 *  计哪些场次 =「标了已抢到」∪「有票据明细记录」的并集:
 *   · 只标三态、没填张数的老用户 → 每场算 1 张,数字与原「实际 N 场」一致,不会有落差;
 *   · 填了张数的 → 按填的数;
 *   · 既没标已抢到、也没有明细的场次 → 不计。
 *  ⚠ 别收窄成「只数已抢到」—— 用户完全可能只填张数、不去点三态(那是他自己填的票)。 */
export function totalTicketCount(
  gotCodes: ReadonlySet<string>,
  info: ReadonlyMap<string, TicketInfo>,
): number {
  let total = 0;
  for (const code of new Set([...gotCodes, ...info.keys()])) {
    total += ticketCountOf(info.get(code)) ?? 1;
  }
  return total;
}

/** 日程表格子上的张数徽章文案;**没显式填张数 → `null`**(调用方不渲染,保证零噪声)。 */
export function ticketBadgeText(info: TicketInfo | undefined): string | null {
  const count = ticketCountOf(info);
  return count === undefined ? null : `${count} 张`;
}

/** 徽章 / 概览 tag 的 tooltip:把「几张 / 坐哪 / 哪个账号」拼成一句。
 *  `accountName` 由调用方**先解析好**(依赖账号表,见 `ticket-accounts.ts::resolveAccountOf`)——
 *  本模块不认识账号表,只负责排版。 */
export function ticketInfoTitle(
  info: TicketInfo | undefined,
  accountName: string | null,
): string {
  const parts: string[] = [];
  const count = ticketCountOf(info);
  if (count !== undefined) parts.push(`${count} 张`);
  // 座位按「第几张 · 座位号」印,中间的空档直接跳过 —— 只说填了的,不印一串占位符
  const seats = (info?.seats ?? [])
    .map((seat, index) => (seat ? `第 ${index + 1} 张 ${seat}` : ""))
    .filter(Boolean);
  if (seats.length) parts.push(`座位 ${seats.join(" / ")}`);
  parts.push(accountName ? `账号 ${accountName}` : "未指定账号");
  return parts.join("，");
}
