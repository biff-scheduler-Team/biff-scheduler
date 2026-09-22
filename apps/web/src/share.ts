// 分享文案(复制到微信 / 群聊)—— 与 `.ics` 并列的「人读」出口。
//
// 为什么单开一套格式:`.ics` 是喂给日历的(机器读,微信里贴过去是一坨不可读的文本),
// 而**单行塞满 6 个字段**的紧凑清单手机上换行一折,「时间 / 片名 / 影院」全糊在一起。
// 分享给朋友要的是「一眼看清哪天看什么」,故这里定一套**缩进块**的纯文本模板。
//
// ★ 格式(空行只出现在「日期」分节之间):
//
//   BIFF 2026 看片计划
//   OCT 8–OCT 17 · 共 12 场 / 6 部
//   ━━━━━━━━━━━━
//
//   【OCT 8 · 周四】
//   004  10:00–12:20  Foo
//                     福
//                     BCC 1 · 映后
//
// ★ 为什么是**缩进块**(2026-09-16 改,`PLAN-20260916002752`):一行一个字段在手机上折行后
//   各字段会互相错位;缩进块把「同一场」的边界画出来 —— 续行缩进到**英文名的起始列**,
//   一眼能看出哪几行属于同一场(用户原话「这种有缩进的」)。
//
// ★ 状态列(影院行 ` · ` 之后的位,空则省略):
//   · GV → 「映后」(含谈) / 「仅正片」(弃谈) / 「GV」(有 GV 但没配谈段时长)。
//   ⚠ **顺位标记与开票批次分节已于 2026-09-22 整体去掉**
//     (用户「分享的地方去掉顺位和批次了」,`PLAN-20260922102751`):
//     选片顺位(`biff.ranks.v1`)与开票时间提醒本身都还在,只是不再印进分享内容 ——
//     它让「一份对外成品」多了两个与应用内状态耦合的开关,收益不抵复杂度。
//
// ★ 为什么 CODE 在**行首**(2026-09-15 改,`PLAN-20260915234414`):分享文案的第二个用途是
//   **抢票分工** —— 朋友要按放映代码去官网找场次、在群里报号。CODE 行首才对齐成列,扫一眼就能定位。
//
// ★ 微信适配的三条约束(改格式时别破坏):
//   ① **不用 Markdown** —— 微信不渲染,`**加粗**` / `|` 表格会原样印出来;层次只靠全角标点(【】· —)、
//      换行与缩进。
//   ② **不用 emoji**(2026-09-16 改):早期用 🎬 / 📅 / 📍 / 📝 做行首标记,用户反馈「去掉 EMOJI」——
//      纯文本里 emoji 反而更乱,且各端渲染宽度不一,缩进对不齐。状态位一律走文字(`映后`)。
//   ③ **每行尽量短**:影院走 `legend.ts::venueShort`(短名),片名 / 影院各自单独一行(长片名换行也不会
//      把时间 / 影院挤错位);跨午夜场印「次日 05:35」,绝不把 24+ 制的 `29:35` 丢出去。
//
// ★ 口径(与网格 / 行程 / .ics 同源,勿另起一套):
//   · 时间 = **有效结束**(`gv.ts::effEndMin`,含 / 弃映后谈按单场解析);
//   · 片名 = `util.ts::bilingualRows`(与全站 `bilingualTitle` 同判同规则,只是拆成两行)。

import type { Catalog, Mapping, Screening } from "./types";
import { bilingualRows, dateInfo, filmNodeKey, fmtMinRangeMin, groupByDate, hmsToMin } from "./util";
import { effEndMin, gvTalkMin } from "./gv";
import { venueShort } from "./legend";
import type { PickRow } from "./ics";

/** 概要下方的分隔线(全角制表符,微信里是一条实线)—— 只出现一次,把「概要」与「场次」分开。 */
const DIVIDER = "━━━━━━━━━━━━";

/** GV 标记:有谈段 → 「映后」/「仅正片」;`is_gv` 但谈段配成 0 → 只标「GV」。非 GV 场返回空串。
 *  ⚠ 文案是**分享文案 / 分享图片 chip / 方案「查看场次」弹层**共用的单一来源
 *  (`poster.ts::buildPosterModel` 的 `gv` 字段也走它)—— 改文案会三处一起变。 */
export function gvMark(s: Screening, talkOn: boolean): string {
  if (gvTalkMin(s) > 0) return talkOn ? "映后" : "仅正片";
  return s.is_gv ? "GV" : "";
}

/** 状态列(影院行)= 影院短名 · GV 标记,空位自动省略。 */
function venueBits(cat: Catalog, s: Screening, talkOn: boolean): string {
  const v = cat.venueById.get(s.venue_id);
  const bits = [v ? venueShort(v) : s.venue_display];
  const gv = gvMark(s, talkOn);
  if (gv) bits.push(gv);
  return bits.join(" · ");
}

/** 一场 → 缩进块:首行 `CODE  时间  英文名`,续行(中文名 / 影院行)缩进到**英文名的起始列**。
 *  ⚠ 缩进按**实际首行前缀宽度**算,不写死空格数 —— CODE 位数与时间串长度都可能变
 *    (跨午夜还会多出「次日 」),写死会在那些块里错位。 */
function block(
  cat: Catalog,
  s: Screening,
  mapping: Mapping | undefined,
  talkOn: boolean,
  note = ""
): string[] {
  const time = fmtMinRangeMin(hmsToMin(s.start_time), effEndMin(s, talkOn));
  const head = `${s.code}  ${time}  `;
  const pad = " ".repeat(head.length);
  const titles = bilingualRows(s.title_en, s.title_zh || mapping?.title_cn);
  const out = [
    `${head}${titles[0] ?? ""}`,
    ...titles.slice(1).map((t) => `${pad}${t}`),
    `${pad}${venueBits(cat, s, talkOn)}`,
  ];
  if (note) out.push(`${pad}备注 ${note}`);
  return out;
}

/** 日期分节头 —— 【OCT 8 · 周四】。 */
function dateHead(iso: string): string {
  const { label, weekday } = dateInfo(iso);
  return `【${label} · ${weekday}】`;
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
 *  空输入返回空串(调用方据此给「还没有选片」提示,不复制空文本)。
 *
 *  ⚠ 没有可选开关(2026-09-22):顺位 / 开票批次两个扩展已去掉(`PLAN-20260922102751`),
 *    本函数现在恒产出「CODE 行首 + 三行缩进块」这一种版式。 */
export function buildShareText(
  cat: Catalog,
  entries: PickRow[],
  mappings: Map<string, Mapping>,
  talkOf: (code: string) => boolean
): string {
  const rows = orderedPickRows(cat, entries);
  // ⚠ 概要只数**主选行** —— 这里 `rows` 全是「要去看的那一场」(备选行已随顺位移除)
  const sum = shareSummary(cat, rows);
  if (!sum) return "";

  const fest = cat.schedule.festival;
  const lines: string[] = [
    `${fest.name} ${fest.year} 看片计划`,
    `${sum.range} · 共 ${sum.count} 场 / ${sum.films} 部`,
    DIVIDER,
  ];

  for (const [date, group] of groupByDate(rows, (r) => r.s.date)) {
    lines.push("", dateHead(date));
    for (const { e, s } of group) {
      // 映后谈取舍与网格 / .ics 同一解析:有谈段才问 talkOf,谈段为 0(非 GV / 时长配 0)的场无开关
      const talk = gvTalkMin(s);
      const talkOn = talk > 0 ? talkOf(e.code) : true;
      lines.push(...block(cat, s, mappings.get(e.code), talkOn, e.note));
    }
  }
  return lines.join("\n");
}
