// .ics 导出 — 一律 UTC(Z) 绝对时间 + 相对提醒;UID=code@biff-2026。

import type { Catalog, Group, Mapping, PlanEntry, Priority, Screening } from "./types";
import { effEndHms, gvTalkMin } from "./gv";
import { esc } from "./util";

const KST_OFFSET_MS = 9 * 3600 * 1000; // KST = UTC+9

function toUtcStamp(dateIso: string, hhmm: string): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  const [h, min] = hhmm.split(":").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d, h, min) - KST_OFFSET_MS);
  return utc.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // 20261008T020000Z
}

function fold(line: string): string {
  // iCal 行限 75 octets,超长用 CRLF+空格折叠
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let cur = line;
  while (cur.length > 0) {
    parts.push(cur.slice(0, 75));
    cur = cur.slice(75);
  }
  return parts.join("\r\n ");
}

export const PRIORITY_TAG: Record<Priority, string> = { must: "必看", maybe: "备选", wild: "随缘" };
/** 未设档位(priority=null)在 ICS 描述里的兜底标签 */
export const PRIORITY_TAG_UNSET = "未分级";
/** 档位标签(含未设兜底),供 ICS / 清单等文本出口复用 */
export function priorityTag(p: Priority | null): string {
  return p ? PRIORITY_TAG[p] : PRIORITY_TAG_UNSET;
}

export function buildIcs(
  cat: Catalog,
  entries: PlanEntry[],
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
    const title = s.title_zh || map?.title_cn || s.title_en;
    const gv = s.is_gv ? " (GV)" : "";
    const summary = `[${e.code}] ${title}${gv}`;

    // 映后谈取舍:参加 → 结束=槽位末(官方 end_time 已含);放弃 → 结束=正片末
    const talk = gvTalkMin(s);
    const talkOn = talk > 0 ? talkOf(e.code) : true;
    const endHms = effEndHms(s, talkOn);

    const desc: string[] = [];
    desc.push(`${s.title_en}${s.title_kr ? " / " + s.title_kr : ""}`);
    const timeNote = talk > 0 ? (talkOn ? ` · 含映后 ${talk}min` : ` · 已放弃映后谈(仅正片)`) : "";
    desc.push(`时间(KST):${s.start_time}–${endHms} · ${s.duration_min}min${timeNote}`);
    desc.push(`场馆:${s.venue_display}`);
    desc.push(`方案:${e.group} · ${priorityTag(e.priority)}`);
    if (map?.douban_url) desc.push(`豆瓣:${map.douban_url}`);
    if (e.note) desc.push(`备注:${e.note}`);

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${e.code}@biff-2026`);
    lines.push(`DTSTAMP:${toUtcStamp(s.date, "00:00")}`);
    lines.push(`DTSTART:${toUtcStamp(s.date, s.start_time)}`);
    lines.push(`DTEND:${toUtcStamp(s.date, endHms)}`);
    lines.push(fold(`SUMMARY:${esc(summary)}`));
    lines.push(fold(`LOCATION:${esc(s.venue_display)}`));
    lines.push(fold(`DESCRIPTION:${esc(desc.join("\\n"))}`));
    lines.push("BEGIN:VALARM");
    lines.push("ACTION:DISPLAY");
    lines.push(`TRIGGER:-PT${alarmMin}M`);
    lines.push(`DESCRIPTION:${esc(title)} 即将开始`);
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

/** 按方案过滤 + 按日期/开始时间排序 */
export function pickEntries(
  entries: PlanEntry[],
  cat: Catalog,
  which: Group | "ALL"
): PlanEntry[] {
  const withTime = entries
    .filter((e) => (which === "ALL" ? true : e.group === which))
    .map((e) => ({ e, s: cat.byCode.get(e.code) }))
    .filter((x): x is { e: PlanEntry; s: Screening } => Boolean(x.s));
  withTime.sort((a, b) => a.s.date.localeCompare(b.s.date) || a.s.start_time.localeCompare(b.s.start_time));
  return withTime.map((x) => x.e);
}
