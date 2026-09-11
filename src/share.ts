// 分享文案(复制到微信 / 群聊)—— 与 `.ics` 并列的「人读」出口。
//
// 为什么单开一套格式:`.ics` 是喂给日历的(机器读,微信里贴过去是一坨不可读的文本),
// 而**单行塞满 6 个字段**的紧凑清单手机上换行一折,「时间 / 片名 / 影院」全糊在一起。
// 分享给朋友要的是「一眼看清哪天看什么」,故这里定一套**两行一场**的纯文本模板。
//
// ★ 格式(空行只出现在日期分节之间):
//
//   🎬 BIFF 2026 看片计划
//   📅 OCT 8–OCT 17 · 共 12 场 / 6 部
//   ━━━━━━━━━━━━
//
//   【OCT 8 周四 · 3 场】
//   10:00–12:20  Foo · 福
//   📍 BCC 1 · 001
//   13:00–14:50  Bar · 吧
//   📍 CGV 1 · 002 · GV 含映后谈
//
// ★ 微信适配的三条约束(改格式时别破坏):
//   ① **不用 Markdown** —— 微信不渲染,`**加粗**` 会原样印出来;层次只靠全角标点(【】· —)与换行。
//   ② **emoji 只做行首标记**(🎬 标题 / 📅 概要 / 📍 影院 / 📝 备注)—— 微信全平台可渲染,
//      且让「两行一场」在纯文本里也能看出哪行是附属信息;正文里不夹 emoji,免得被当噪声。
//   ③ **每行尽量短**:影院走 `legend.ts::venueShort`(短名),片名单独一行(长片名换行也不会
//      把时间 / 影院挤错位);跨午夜场印「次日 05:35」,绝不把 24+ 制的 `29:35` 丢出去。
//
// ★ 口径(与网格 / 行程 / .ics 同源,勿另起一套):
//   · 时间 = **有效结束**(`gv.ts::effEndMin`,含 / 弃映后谈按单场解析);
//   · 片名 = `util.ts::displayTitle`(英文名 · 中文名,全站唯一口径)。

import type { Catalog, Mapping, Screening } from "./types";
import { dateInfo, displayTitle, filmNodeKey, fmtMinRangeMin, groupByDate, hmsToMin } from "./util";
import { effEndMin, gvTalkMin } from "./gv";
import { venueShort } from "./legend";
import { pickEntries, type PickRow } from "./ics";
import { copyText } from "./clipboard";
import { store } from "./state";
import { toast } from "./toast";

/** 概要下方的分隔线(全角制表符,微信里是一条实线)—— 只出现一次,把「概要」与「场次」分开。 */
const DIVIDER = "━━━━━━━━━━━━";

/** GV 标记:有谈段 → 含 / 弃两态;`is_gv` 但谈段配成 0 → 只标 GV。非 GV 场返回空串。 */
export function gvMark(s: Screening, talkOn: boolean): string {
  if (gvTalkMin(s) > 0) return talkOn ? "GV 含映后谈" : "GV 仅正片";
  return s.is_gv ? "GV" : "";
}

/** 场次的第二行(📍 开头)= 影院短名 · CODE · GV 标记,空位自动省略。 */
function venueLine(cat: Catalog, s: Screening, e: PickRow, talkOn: boolean): string {
  const v = cat.venueById.get(s.venue_id);
  const bits = [v ? venueShort(v) : s.venue_display, e.code];
  const gv = gvMark(s, talkOn);
  if (gv) bits.push(gv);
  return `📍 ${bits.join(" · ")}`;
}

/** 日期分节头 —— 【OCT 8 周四 · 3 场】。 */
function dateHead(iso: string, count: number): string {
  const { label, weekday } = dateInfo(iso);
  return `【${label} ${weekday} · ${count} 场】`;
}

/** 已选场次 → 「带场次的已排行」,按 **日期 → 开场时间** 排序。
 *  ⚠ 排序放在这里(而不是留给调用方):日期分节头与日期区间都依赖「已排序」,
 *  少一个调用点忘了排序就产出错乱文案 —— 分享文案(`buildShareText`)与分享图片(`poster.ts`)共用本函数。
 *  排期里已不存在的 code(换版)静默跳过。 */
export function orderedPickRows(
  cat: Catalog,
  entries: PickRow[]
): { e: PickRow; s: Screening }[] {
  return entries
    .map((e) => ({ e, s: cat.byCode.get(e.code) }))
    .filter((r): r is { e: PickRow; s: Screening } => Boolean(r.s))
    .sort((a, b) => a.s.date.localeCompare(b.s.date) || a.s.start_time.localeCompare(b.s.start_time));
}

/** 概要:场次数 / 影片数 / 日期区间文本(空输入 → null)。
 *  分享文案与分享图片的「共 N 场 / M 部 · 日期区间」必须同源,否则两处出口会各印一个数。 */
export interface ShareSummary {
  count: number;
  films: number;
  range: string;
}

export function shareSummary(
  cat: Catalog,
  rows: { e: PickRow; s: Screening }[]
): ShareSummary | null {
  if (rows.length === 0) return null;
  const films = new Set(rows.map((r) => filmNodeKey(cat, r.s))).size;
  const first = rows[0].s.date;
  const last = rows[rows.length - 1].s.date;
  const range =
    first === last ? dateInfo(first).label : `${dateInfo(first).label}–${dateInfo(last).label}`;
  return { count: rows.length, films, range };
}

/** 生成分享文案(纯函数,便于单测)。
 *
 *  排序在函数内做(**按日期 → 开场时间**):分节头与日期区间都依赖「已排序」,
 *  不把这件事留给调用方 —— 少一个调用点忘了排序就产出错乱文案的坑。
 *  空输入返回空串(调用方据此给「还没有选片」提示,不复制空文本)。 */
export function buildShareText(
  cat: Catalog,
  entries: PickRow[],
  mappings: Map<string, Mapping>,
  talkOf: (code: string) => boolean
): string {
  const rows = orderedPickRows(cat, entries);
  const sum = shareSummary(cat, rows);
  if (!sum) return "";

  const fest = cat.schedule.festival;
  const lines: string[] = [
    `🎬 ${fest.name} ${fest.year} 看片计划`,
    `📅 ${sum.range} · 共 ${sum.count} 场 / ${sum.films} 部`,
    DIVIDER,
  ];

  for (const [date, group] of groupByDate(rows, (r) => r.s.date)) {
    lines.push("", dateHead(date, group.length));
    for (const { e, s } of group) {
      // 映后谈取舍与网格 / .ics 同一解析:有谈段才问 talkOf,谈段为 0(非 GV / 时长配 0)的场无开关
      const talk = gvTalkMin(s);
      const talkOn = talk > 0 ? talkOf(e.code) : true;
      lines.push(
        `${fmtMinRangeMin(hmsToMin(s.start_time), effEndMin(s, talkOn))}  ` +
          displayTitle(s, mappings.get(e.code)?.title_cn)
      );
      lines.push(venueLine(cat, s, e, talkOn));
      if (e.note) lines.push(`📝 ${e.note}`);
    }
  }
  return lines.join("\n");
}

/** 复制**全部**已排场次的分享文案 —— 导出菜单「分享文案(复制)」的入口。 */
export function copyShareText(cat: Catalog, gvTalkOf: (code: string) => boolean): void {
  document.getElementById("export-menu")!.classList.add("is-hidden");
  const entries = pickEntries(store.picks, cat);
  if (entries.length === 0) {
    toast("还没有选片,先在网格里点选场次");
    return;
  }
  const text = buildShareText(cat, entries, store.mappings, gvTalkOf);
  void copyText(text).then((ok) =>
    toast(ok ? `已复制分享文案(${entries.length} 场),粘贴到微信即可` : "复制失败,请手动选择复制")
  );
}
