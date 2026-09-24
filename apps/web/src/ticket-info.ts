/**
 * 票据明细(localStorage `biff.ticketinfo.v2`)纯逻辑:读取归一 / 票数派生 / 徽章文案 / 旧结构迁移
 * (2026-09-24,`PLAN-20260924141442`)。
 *
 * ★ 核心口径:**座位行数就是票数**(用户 2026-09-24:「用添加的座位数作为票数」)——
 *   没有独立的数字字段,`ticketCountOf` 是唯一派生口。
 * ⚠ 只做「数据 → 数字 / 字符串」的换算,**不碰 DOM、不 import `state.ts`** ——
 *   node 直接可测(与 `tickets.ts` 同口径)。
 * ⚠ **本模块不认得任何凭据**:账号 / 密码方案已在修订 3 整体撤销(它落在 `biff.` 前缀下,
 *   会随片单上云)。详情见 `docs/CONVENTIONS.md`。
 */

import type { TicketInfo } from "./types";

/** 单场票数上限(即座位行数上限)。官方口径是「每场限购 2 张」(`InfoDialogs.tsx` 的购票须知原文),
 *  但转票补入 / 多账号合计会超过它 —— 这里取一个「够用、又不会把列表撑到失控」的上限。 */
export const TICKET_COUNT_MAX = 10;

/** 单个座位号的长度上限:防手滑把整段文字粘进输入框、再把 title 撑爆。 */
const SEAT_MAX_LENGTH = 12;

/** 一个 code 的明细:必须是对象,且 `seats` 是数组 —— 其余一律当作「没填」。 */
function readSeats(raw: unknown): unknown {
  return raw && typeof raw === "object" ? (raw as { seats?: unknown }).seats : undefined;
}

/** 座位行归一:逐项去首尾空白 + 截断;**保位**、按上限截行。
 *
 *  ⚠ **绝不从尾部收空项**(与修订 2 的做法相反):空行也代表「有这么一张票」,
 *    收掉它票数就会缩水 —— 而票数正是由行数派生的。空座位的「没填」语义由空串本身承担。 */
export function normalizeSeats(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seats: string[] = [];
  for (const seat of raw) {
    seats.push(typeof seat === "string" ? seat.trim().slice(0, SEAT_MAX_LENGTH) : "");
    if (seats.length >= TICKET_COUNT_MAX) break;
  }
  return seats.length ? seats : undefined;
}

/** 读取时归一:座位行全空 / 结构不对 → `null`(整条丢弃,不留空壳记录)。
 *  ⚠ 空行**不算**「全空」:`["", ""]` 是「两张票、座位还没填」,必须原样留下。 */
export function normalizeTicketInfo(raw: unknown): TicketInfo | null {
  const seats = normalizeSeats(readSeats(raw));
  return seats ? { seats } : null;
}

/** 旧结构(`biff.ticketinfo.v1`:`{count, seats, accountId}`)→ 新结构的一步换算。
 *
 *  ★ 为什么要有它:v1 把「几张」放在独立字段里,而现在的唯一口径是**行数**。迁移就是
 *    「按旧的 `count` 把座位行补齐到那么长」;`accountId` 属于已撤销的账号方案,直接丢弃。
 *  ⚠ 迁移源只读一次,迁完由 `state.ts::loadTicketInfo` 删掉旧键(见 AGENTS §5 的改结构口径)。 */
export function migrateTicketInfoV1(raw: unknown): TicketInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const { count, seats } = raw as { count?: unknown; seats?: unknown };
  const rows = (Array.isArray(seats) ? seats : []).map((s) => (typeof s === "string" ? s : ""));
  const wanted = typeof count === "number" && Number.isFinite(count) ? Math.round(count) : 0;
  const length = Math.max(rows.length, wanted);
  if (length <= 0) return null;
  return normalizeTicketInfo({ seats: Array.from({ length }, (_, i) => rows[i] ?? "") });
}

/** **票数** —— 唯一的派生口(座位行数);没有明细 → `undefined`(与「0 张」区分开)。
 *  ⚠ 别退回「读一个 count 字段」:那会让票数有两个来源,迟早对不上。 */
export function ticketCountOf(info: TicketInfo | undefined): number | undefined {
  const rows = info?.seats?.length ?? 0;
  return rows > 0 ? rows : undefined;
}

/** 行程票数合计 —— 「共 N 张票」的**唯一口径**。
 *
 *  计哪些场次 =「标了已抢到」∪「有票据明细」的并集:
 *   · 只标三态、没加座位行的老用户 → 每场算 1 张,数字与原「实际 N 场」一致,不会有落差;
 *   · 加过座位行的 → 按行数;
 *   · 既没标已抢到、也没有明细的场次 → 不计。 */
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

/** 日程表格子上的张数徽章文案;**没有明细 → `null`**(调用方不渲染,保证零噪声)。 */
export function ticketBadgeText(info: TicketInfo | undefined): string | null {
  const count = ticketCountOf(info);
  return count === undefined ? null : `${count} 张`;
}

/** 徽章 / 概览 tag 的 tooltip:把「几张 / 坐哪」拼成一句。 */
export function ticketInfoTitle(info: TicketInfo | undefined): string {
  const count = ticketCountOf(info);
  if (count === undefined) return "还没有填写票务信息";
  const parts = [`${count} 张`];
  // 座位按「第几张 · 座位号」印,没填的那些直接跳过 —— 只说填了的,不印一串占位符
  const seats = (info?.seats ?? [])
    .map((seat, index) => (seat ? `第 ${index + 1} 张 ${seat}` : ""))
    .filter(Boolean);
  if (seats.length) parts.push(`座位 ${seats.join(" / ")}`);
  return parts.join("，");
}
