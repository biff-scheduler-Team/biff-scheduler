/**
 * 票据明细(localStorage `biff.ticketinfo.v3`)纯逻辑:读取归一 / 票数派生 / 徽章文案 / 旧结构迁移
 * (2026-09-24,`PLAN-20260924141442`)。
 *
 * ★ 核心口径:**座位行数就是票数**(用户 2026-09-24:「用添加的座位数作为票数」)——
 *   没有独立的数字字段,`ticketCountOf` 是唯一派生口。
 * ★ 「不划位」(自由入座)在这套口径下有**唯一一种**表示:**全空的座位行**(修订 4,
 *   2026-09-24 用户「有不划位的 需要考虑这种情况」)。没有 `unreserved` 字段 ——
 *   档位由 `allSeatsBlank` 从行内容**推断**,只活在界面上。见 `types.ts::TicketInfo`。
 * ★ 修订 5(2026-09-24)为**导入**加了三个并列文本字段:`name` / `bookingNo` / `account`,
 *   都是**每场一条**(不是每张票一条)—— 对应 BIFF 一笔预约一行、1~2 张票共用同一个预约号。
 *   故结构从 v2 升到 v3(见 `state.ts::loadTicketInfo` 的两级迁移)。
 * ⚠ 只做「数据 → 数字 / 字符串」的换算,**不碰 DOM、不 import `state.ts`** ——
 *   node 直接可测(与 `tickets.ts` 同口径)。
 * ⚠ **本模块不认得任何凭据**:`account` 是账号**名**标签,不是密码。账号 / 密码方案已在修订 3
 *   整体撤销(理由:落在 `biff.` 前缀下会随片单上云)。详情见 `docs/CONVENTIONS.md`。
 */

import type { TicketInfo } from "./types";

/** 单场票数上限(即座位行数上限)。官方口径是「每场限购 2 张」(`InfoDialogs.tsx` 的购票须知原文),
 *  但转票补入 / 多账号合计会超过它 —— 这里取一个「够用、又不会把列表撑到失控」的上限。 */
export const TICKET_COUNT_MAX = 10;

/** 单个座位号的长度上限:防手滑把整段文字粘进输入框、再把 title 撑爆。
 *  ⚠ 2026-09-24 修订 5 从 12 提到 32:BIFF 的座号不是「F12」那么短,而是
 *    `Sec 7 · R2 S4`(13)/ `Floor 3 · R1 S8`(14)/ `Floor 1 · R8 S23`(15)这种带区/排前缀的形态 ——
 *    12 会把它们**静默截断**(实测用户导入的 17 笔里有 12 笔超长)。 */
const SEAT_MAX_LENGTH = 32;
/** 姓名 / 预约号 / 账号名的长度上限。同为「防手滑粘贴」,不是业务约束:
 *  预约号实测 17 位(`269LEYE2LGJ37124A`),留一倍余量。 */
const NAME_MAX_LENGTH = 24;
const BOOKING_NO_MAX_LENGTH = 32;
const ACCOUNT_MAX_LENGTH = 32;

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

/** 文本字段归一:非字符串 / 空串 / 纯空白 → `undefined`(**缺省而不是空串** ——
 *  空串会在存储里留一堆无意义的键,也会让 `JSON.stringify` 的等值判重失效)。 */
function normalizeField(raw: unknown, max: number): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, max) : undefined;
}

/** 读取时归一:座位行全空 / 结构不对 → `null`(整条丢弃,不留空壳记录)。
 *  ⚠ 空行**不算**「全空」:`["", ""]` 是「两张票、座位还没填」,必须原样留下。
 *  ⚠ v2 → v3 的迁移**就在这里完成** —— 新加的三个字段都是可选的,旧记录读进来天然合法,
 *    所以不需要单独的迁移函数(见 `state.ts::loadTicketInfo` 的说明)。 */
export function normalizeTicketInfo(raw: unknown): TicketInfo | null {
  const seats = normalizeSeats(readSeats(raw));
  if (!seats) return null;
  const source = raw as Record<string, unknown>;
  const record: TicketInfo = { seats };
  const name = normalizeField(source.name, NAME_MAX_LENGTH);
  if (name) record.name = name;
  const bookingNo = normalizeField(source.bookingNo, BOOKING_NO_MAX_LENGTH);
  if (bookingNo) record.bookingNo = bookingNo;
  const account = normalizeField(source.account, ACCOUNT_MAX_LENGTH);
  if (account) record.account = account;
  return record;
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

/** 露天场的场馆 id —— 「默认落不划位档」唯一的判据(见 `defaultUnreserved`)。 */
const UNRESERVED_VENUE_ID = "bt";

/** 这一场要不要**默认**落「不划位」档(2026-09-24 修订 4)。
 *
 *  只回答弹层打开时的**初始档位**,用户随手可改 —— 且**永不写回存储**。
 *  ⚠ 这是**常识默认,不是数据**:`schedule.json` / `venues.json` / 官方票务规约
 *    (`festival-extras.json::ticketing`)三处都查过,**没有**任何「划位 / 不划位」字段,
 *    理不出逐场判据。所以它只覆盖唯一有据可依的那一类场景。
 *  ⚠ 为什么是露天场:本届 Open Cinema(露天放映)8 场全在 `bt` 20:00,是站上唯一
 *    能指认的「自由入座」场景(见 `docs/plans/PLAN-20260915234414.md` 的官方片单核对)。
 *  ⚠ 为什么**排除开闭幕**:`001` / `002` 也在露天场(18:00),但那是典礼场(固定座席)——
 *    按 `venue_id` 一刀切会把两场最重要的场次默认成自由入座。
 *    (`tags` 里正好有 `opening` / `closing`,判据写法与 `extras.ts::priceOf` 同源。)
 *  ⚠ 新场馆 / 新场馆 id 一律返回 `false`(默认「划位」):猜错成自由入座会让人
 *    以为自己填的座位号丢了,而猜成划位只是多勾一次复选框。 */
export function defaultUnreserved(venueId: string, tags: readonly string[]): boolean {
  if (venueId !== UNRESERVED_VENUE_ID) return false;
  return !tags.includes("opening") && !tags.includes("closing");
}

/** 座位行**全空** —— 即「不划位」的落库形态(见 `types.ts::TicketInfo` 的修订 4 说明)。
 *  没有明细 / 没有行 → `false`:一张票都没有的场次不谈档位,别把它误判成「不划位」。 */
export function allSeatsBlank(info: TicketInfo | undefined): boolean {
  const seats = info?.seats ?? [];
  return seats.length > 0 && seats.every((seat) => !seat);
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
  // 一个座位号都没有 → **明说「座位未填」**,不再只报张数(旧版那句会让人怀疑界面丢了东西)。
  // ⚠ 这句话刻意兼容两种情形:真的不划位、以及划位但座位号还没抄 —— 数据上两者不可区分
  //   (见 `types.ts::TicketInfo` 的修订 4);所以这里只陈述事实,不去猜是哪一种。
  if (seats.length) parts.push(`座位 ${seats.join(" / ")}`);
  else parts.push("座位未填");
  // 姓名 / 预约号 / 账号(修订 5)。顺序按「在影院门口最可能要报的那个」排:
  // 预约号排姓名前面 —— 换票窗口要的是那串号,不是名字。
  if (info?.bookingNo) parts.push(`预约号 ${info.bookingNo}`);
  if (info?.name) parts.push(info.name);
  if (info?.account) parts.push(`账号 ${info.account}`);
  return parts.join("，");
}
