/**
 * 票务 JSON 导入(localStorage 侧见 `state.ts`;纯逻辑:解析 + 归一)
 * (2026-09-24,`PLAN-20260924141442` 修订 5)。
 *
 * ★ 为什么是**另一条通道**,而不是复用 `backup.ts::parseBackupText`:
 *   备份导入是**整体替换**(先清空全部 `biff.` 键再写入 —— 见 `backup.ts` 文件头口径③)。
 *   而「导入我买的票」是**增量**诉求:用户已经在用这个工具(有选片 / 顺位 / 设置),
 *   拿备份通道导票会把这些全洗掉。所以票务导入**只写票务相关的键**,且是合并语义。
 *
 * ★ 对外格式(刻意做得好手写 —— 用户可能自己照着改):
 *   ```json
 *   { "app": "biff-scheduler-tickets", "version": 1,
 *     "tickets": [
 *       { "code": "001", "seats": ["Sec 7 · R2 S4"], "name": "RAOJIARUI",
 *         "bookingNo": "269KETJVWXV0Z027S", "account": "foxmail" },
 *       { "code": "003", "seats": 2, "name": "RAOJIARUI", "bookingNo": "269HE2U4B4232G6ZV" }
 *     ] }
 *   ```
 *   裸数组 `[ … ]` 也认(只复制了 `tickets` 段的场景)。
 *
 * ★ `seats` 的四种写法都接受(其余字段都是纯文本,可省):
 *   · `["Sec 7 · R2 S4"]` —— 一张票、有座号;
 *   · `["", ""]`          —— **两张票、不划位**(空串 = 没座号,与界面上的「不划位」档同一形态);
 *   · `2`                 —— 同上,短写法(数字 = 这么多张、都不划位);
 *   · 省略                 —— 一张票、没座号。
 *
 * ⚠ 被本模块拒收的情况**一律给得出可照做的中文原因**;特别是**同一个 code 出现两次直接报错**,
 *   不静默取后者 —— 那会让人以为「导入成功了」却少了一半票。
 * ⚠ 本模块**不知道片单**:`code` 是否存在于当前届的排期里,由调用方拿 `cat.byCode` 过滤
 *   (与 `.ics` 导入同一分工)。所以这里只做形状与格式校验。
 */

import { TICKET_COUNT_MAX, normalizeTicketInfo } from "./ticket-info";
import type { TicketInfo } from "./types";

/** 信封标识 —— 与 `backup.ts` 的 `BACKUP_APP` 一样,用来确认「这确实是一份票务导入」。
 *  ⚠ 但**不强制校验**它:裸数组 / 手写对象都该能导(用户手抄时不会记得填 app)。 */
export const TICKET_IMPORT_APP = "biff-scheduler-tickets";

/** 一行 = 一笔预约(一个场次)。**座位行数就是票数**,与 `TicketInfo` 同一口径。 */
export interface TicketImportRow extends TicketInfo {
  code: string;
}

export type TicketImportParse =
  | { ok: true; rows: TicketImportRow[]; /** 张数合计(用于预览文案) */ seatTotal: number }
  | { ok: false; error: string };

/** 场次 code 的形状:官方三位数字编号(`001`),或本工具给 P&I 场次编的 `PI-09-01`。 */
const CODE_RE = /^(?:\d{3}|PI-\d{2}-\d{2})$/;

/** 把 `seats` 的四种写法归一成 `string[]`(见文件头)。认不出来 → `null`(由调用方给原因)。 */
function readSeats(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [""];
  if (typeof raw === "string") return [raw];
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 1) return null;
    // ⚠ 与界面同一个上限:多写的行不该悄悄多出票来
    return Array.from({ length: Math.min(raw, TICKET_COUNT_MAX) }, () => "");
  }
  if (Array.isArray(raw)) {
    return raw.map((seat) => (typeof seat === "string" ? seat : ""));
  }
  return null;
}

/** 取出待解析的行数组:信封 `{ tickets: [...] }` 或裸数组。 */
function readRows(raw: unknown): unknown[] | string {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const tickets = (raw as { tickets?: unknown }).tickets;
    if (Array.isArray(tickets)) return tickets;
    return "这份 JSON 里没有 `tickets` 数组(应为 { \"tickets\": [ … ] } 或一个数组)";
  }
  return "票务导入内容应为一个 JSON 对象或数组";
}

/** 解析用户给的票务 JSON。失败时给出**能照做的**中文原因。 */
export function parseTicketImport(text: string): TicketImportParse {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "内容为空" };

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "不是有效的 JSON —— 请确认复制的是完整内容" };
  }

  const table = readRows(raw);
  if (typeof table === "string") return { ok: false, error: table };
  if (table.length === 0) return { ok: false, error: "这份内容里没有任何票务记录" };

  const rows: TicketImportRow[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < table.length; i++) {
    const item = table[i];
    const at = `第 ${i + 1} 条`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: `${at}不是一个对象` };
    }
    const { code } = item as { code?: unknown };
    if (typeof code !== "string" || !CODE_RE.test(code.trim())) {
      return {
        ok: false,
        error: `${at}的场次编号不对("${String(code ?? "")}"）—— 应为三位官方编号(如 001)或 PI-09-01`,
      };
    }
    const trimmedCode = code.trim();
    // ⚠ 重复 code **直接报错**,不静默取后者:同一场出现两笔预约时,合并规则该由人决定,
    //   猜错的表现是「导入成功但少了一半票」—— 那种错用户很难发现。
    if (seen.has(trimmedCode)) {
      return {
        ok: false,
        error: `场次 ${trimmedCode} 出现了多次 —— 请把同一场的座位合到一条记录里`,
      };
    }
    const seats = readSeats((item as { seats?: unknown }).seats);
    if (!seats) {
      return { ok: false, error: `${at}(${trimmedCode})的 seats 认不出来 —— 应为座位号数组,或一个正整数张数` };
    }
    const record = normalizeTicketInfo({ ...(item as object), seats });
    if (!record) {
      return { ok: false, error: `${at}(${trimmedCode})没有任何有效信息` };
    }
    seen.add(trimmedCode);
    rows.push({ code: trimmedCode, ...record });
  }

  const seatTotal = rows.reduce((n, row) => n + (row.seats?.length ?? 0), 0);
  return { ok: true, rows, seatTotal };
}

/** 这段文本**像不像**票务导入?
 *
 *  ⚠ 存在的理由:`ExportDialog` 那个导入框同时收备份 / `.ics` / 票务三种内容,而三种的
 *    「认不出来」错误提示各不相同。先按形状分流,才能给出**对症**的那一句
 *    (把一份票务 JSON 当备份解析,报的会是「没找到任何 biff.* 数据」—— 用户看不懂)。
 *  ⚠ 判据只从**顶层形状**看,不解析每一条 —— 真正的问题留给 `parseTicketImport` 报。 */
export function looksLikeTicketImport(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    // 解析不了就**不当**票务导入:交给备份通道报「不是有效的 JSON」(既有行为不变)。
    return false;
  }
  if (Array.isArray(raw)) {
    const first = raw[0];
    return Boolean(first && typeof first === "object" && "code" in (first as object));
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.tickets)) return true;
    return obj.app === TICKET_IMPORT_APP;
  }
  return false;
}
