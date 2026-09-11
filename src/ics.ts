// .ics 导出 — 一律 UTC(Z) 绝对时间 + 相对提醒;UID=code@biff-2026。

import type { Catalog, Group, Mapping, PickEntry, Priority, Screening } from "./types";
import { effEndHms, gvTalkMin } from "./gv";
import { PRI_LABEL } from "./pick";
import { displayTitle, fmtMinRange } from "./util";

/** 导出用的「一场已选」行:方案 / 场次来自场次级,档位 / 备注来自影片级(唯一数据源的投影) */
export interface PickRow {
  code: string;
  group: Group;
  priority: Priority | null;
  note: string;
}

const KST_OFFSET_MS = 9 * 3600 * 1000; // KST = UTC+9

/** "YYYY-MM-DD" + "HH:MM" → UTC 时间戳。
 *  ⚠️ 跨午夜场用 **24+ 时制**(endHms 可能是 "29:35"):`Date.UTC(y,m-1,d,29,35)` 由 JS 自动进位到次日 05:35,
 *  故这里**不要**对小时取模 —— 取模会把 DTEND 折到 DTSTART 之前(旧版 `%24` 数据下实测 DTEND 早 18.4h)。 */
function toUtcStamp(dateIso: string, hhmm: string): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  const [h, min] = hhmm.split(":").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d, h, min) - KST_OFFSET_MS);
  return utc.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // 20261008T020000Z
}

/** RFC5545 TEXT 值转义:反斜杠 / 分号 / 逗号 / 换行必须转义,
 *  否则含逗号的片名或场馆名会被日历解析器拆成多个字段。
 *  ⚠ 与 HTML 转义无关(旧实现误用 `util.ts::esc`,已移除)。 */
function icsEsc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** iCal 行按 **UTF-8 字节** 限 75 octets 折叠(中文 1 字 = 3 字节 —— 按字符折会超限)。
 *  折点以**码点**为单位,不会切断代理对(emoji);续行以空格开头,故内容上限 74。 */
function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let cur = "";
  let bytes = 0;
  let limit = 75; // 首行 75 octets;续行前缀空格占 1 → 内容上限 74
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) {
      parts.push(cur);
      cur = "";
      bytes = 0;
      limit = 74;
    }
    cur += ch;
    bytes += n;
  }
  if (cur) parts.push(cur);
  return parts.join("\r\n ");
}

/** 未设档位(priority=null)在 ICS 描述里的兜底标签 */
export const PRIORITY_TAG_UNSET = "未分级";
/** 档位标签(含未设兜底),供 ICS / 清单等文本出口复用 —— 档位文案单一来源 `pick.ts::PRI_LABEL` */
export function priorityTag(p: Priority | null): string {
  return p ? PRI_LABEL[p] : PRIORITY_TAG_UNSET;
}

export function buildIcs(
  cat: Catalog,
  entries: PickRow[],
  mappings: Map<string, Mapping>,
  alarmMin: number,
  /** 该场是否参加映后谈(调用方 = 全局默认 + 单场覆写解析后);talk=0 的场不受影响 */
  talkOf: (code: string) => boolean
): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//biff-scheduler//BIFF 2026//CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:BIFF 2026 看片计划",
  ];

  for (const e of entries) {
    const s = cat.byCode.get(e.code);
    if (!s) continue;
    const map = mappings.get(e.code);
    const title = displayTitle(s, map?.title_cn);
    const gv = s.is_gv ? " (GV)" : "";
    const summary = `[${e.code}] ${title}${gv}`;

    // 映后谈取舍:参加 → 结束 = 正片末 + 映后时长(时长可配置:全局默认 + 单场覆写);放弃 → 结束 = 正片末
    const talk = gvTalkMin(s);
    const talkOn = talk > 0 ? talkOf(e.code) : true;
    const endHms = effEndHms(s, talkOn);

    const desc: string[] = [];
    desc.push(`${s.title_en}${s.title_kr ? " / " + s.title_kr : ""}`);
    const timeNote = talk > 0 ? (talkOn ? ` · 含映后 ${talk}min` : ` · 已放弃映后谈(仅正片)`) : "";
    desc.push(`时间(KST):${fmtMinRange(s.start_time, endHms)} · ${s.duration_min}min${timeNote}`);
    desc.push(`场馆:${s.venue_display}`);
    desc.push(`方案:${e.group} · ${priorityTag(e.priority)}`);
    if (map?.douban_url) desc.push(`豆瓣:${map.douban_url}`);
    if (e.note) desc.push(`备注:${e.note}`);

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${e.code}@biff-2026`);
    lines.push(`DTSTAMP:${toUtcStamp(s.date, "00:00")}`);
    lines.push(`DTSTART:${toUtcStamp(s.date, s.start_time)}`);
    lines.push(`DTEND:${toUtcStamp(s.date, endHms)}`);
    lines.push(fold(`SUMMARY:${icsEsc(summary)}`));
    lines.push(fold(`LOCATION:${icsEsc(s.venue_display)}`));
    lines.push(fold(`DESCRIPTION:${icsEsc(desc.join("\n"))}`));
    lines.push("BEGIN:VALARM");
    lines.push("ACTION:DISPLAY");
    lines.push(`TRIGGER:-PT${alarmMin}M`);
    lines.push(fold(`DESCRIPTION:${icsEsc(title)} 即将开始`)); // 片名长(尤其中文)时会超 75 octets,必须折叠
    lines.push("END:VALARM");
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

export function downloadIcs(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 从选片记录展开出「某方案(或 A+B)的全部场次」,按日期/开始时间排序。
 *  一场一行 —— 档位随影片级记录带出,故同一部片的多场档位必然一致。 */
export function pickEntries(
  picks: Map<string, PickEntry>,
  cat: Catalog,
  which: Group | "ALL"
): PickRow[] {
  const rows: { r: PickRow; s: Screening }[] = [];
  for (const e of picks.values()) {
    for (const p of e.picks) {
      if (which !== "ALL" && p.group !== which) continue;
      const s = cat.byCode.get(p.code);
      if (!s) continue; // 排期换版后已不存在的场次 → 静默跳过
      rows.push({ r: { code: p.code, group: p.group, priority: e.priority, note: e.note }, s });
    }
  }
  rows.sort((a, b) => a.s.date.localeCompare(b.s.date) || a.s.start_time.localeCompare(b.s.start_time));
  return rows.map((x) => x.r);
}
