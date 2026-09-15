// 分享文案(复制到微信 / 群聊)—— 与 `.ics` 并列的「人读」出口。
//
// 为什么单开一套格式:`.ics` 是喂给日历的(机器读,微信里贴过去是一坨不可读的文本),
// 而**单行塞满 6 个字段**的紧凑清单手机上换行一折,「时间 / 片名 / 影院」全糊在一起。
// 分享给朋友要的是「一眼看清哪天看什么」,故这里定一套**两行一场**的纯文本模板。
//
// ★ 格式(空行只出现在「批次 / 日期」分节之间):
//
//   🎬 BIFF 2026 看片计划
//   📅 OCT 8–OCT 17 · 共 12 场 / 6 部
//   ━━━━━━━━━━━━
//
//   【OCT 8 周四 · 3 场】
//   004  10:00–12:20  Foo · 福
//   📍 BCC 1
//
// ★ 两个可选扩展(`ShareOptions`,由导出弹层的勾选框决定):
//   · `ranking`  → 场次行尾 `· 顺位 N`,并逐行附**同冲突组的备选场次**:
//                   259  19:40–21:34  Paper Tiger · 纸老虎
//                   📍 Sohyang Theatre · 顺位 1
//                      ↳ 备选 265  20:10–22:04  Some Film · 某片  LOTTE 6 · 顺位 2
//   · `batching` → 先按**开票批次**分节(【第 1 批 · 9/17 14:00 KST / 北京 13:00】),
//                  节内再按日期分节;空批次不输出。
//
// ★ 为什么 CODE 提到**行首**(2026-09-15 改,`PLAN-20260915234414`):分享文案的第二个用途是
//   **抢票分工** —— 朋友要按放映代码去官网找场次、在群里报号。CODE 行首才对齐成列,扫一眼就能定位;
//   挂在影院行尾时它随影院名长短左右漂移,几个人对着屏幕找号很费劲。
//
// ★ 微信适配的三条约束(改格式时别破坏):
//   ① **不用 Markdown** —— 微信不渲染,`**加粗**` 会原样印出来;层次只靠全角标点(【】· —)与换行。
//   ② **emoji 只做行首标记**(🎬 标题 / 📅 概要 / 📍 影院 / 📝 备注 / ↳ 备选)—— 微信全平台可渲染,
//      且让「两行一场」在纯文本里也能看出哪行是附属信息;正文里不夹 emoji,免得被当噪声。
//   ③ **每行尽量短**:影院走 `legend.ts::venueShort`(短名),片名单独一行(长片名换行也不会
//      把时间 / 影院挤错位);跨午夜场印「次日 05:35」,绝不把 24+ 制的 `29:35` 丢出去。
//
// ★ 口径(与网格 / 行程 / .ics 同源,勿另起一套):
//   · 时间 = **有效结束**(`gv.ts::effEndMin`,含 / 弃映后谈按单场解析);
//   · 片名 = `util.ts::displayTitle`(英文名 · 中文名,全站唯一口径);
//   · 顺位 / 备选 = **当前行程**的冲突组(`plans.ts`),**不是方案快照** ——
//     方案快照每个冲突组只留第 1 顺位,拿它印顺位恒等于「顺位 1」,朋友没法分工(见该 PLAN)。

import type { Catalog, Mapping, Screening } from "./types";
import { dateInfo, displayTitle, filmNodeKey, fmtMinRangeMin, groupByDate, hmsToMin } from "./util";
import { effEndMin, gvTalkMin } from "./gv";
import { venueShort } from "./legend";
import type { PickRow } from "./ics";

/** 概要下方的分隔线(全角制表符,微信里是一条实线)—— 只出现一次,把「概要」与「场次」分开。 */
const DIVIDER = "━━━━━━━━━━━━";

/** GV 标记:有谈段 → 「含映后谈」/「仅正片」;`is_gv` 但谈段配成 0 → 只标「GV」。非 GV 场返回空串。
 *  ⚠ 文案是**分享文案与分享图片共用**的单一来源(`poster.ts` 的 GV chip 也走它)。 */
export function gvMark(s: Screening, talkOn: boolean): string {
  if (gvTalkMin(s) > 0) return talkOn ? "含映后谈" : "仅正片";
  return s.is_gv ? "GV" : "";
}

/** 场次的第二行(📍 开头)= 影院短名 · GV 标记 · 顺位,空位自动省略。
 *  ⚠ CODE **不在这里** —— 已前置到第一行行首(见文件头)。 */
function venueLine(cat: Catalog, s: Screening, talkOn: boolean, rank: number | undefined): string {
  const v = cat.venueById.get(s.venue_id);
  const bits = [v ? venueShort(v) : s.venue_display];
  const gv = gvMark(s, talkOn);
  if (gv) bits.push(gv);
  if (rank !== undefined) bits.push(`顺位 ${rank}`);
  return `📍 ${bits.join(" · ")}`;
}

/** 备选行(仅在带顺位时输出)= 同冲突组的其余场次:`↳ 备选 CODE  时间  片名  影院 · 顺位 N`。
 *  ⚠ **不印日期** —— 冲突按日期隔离(`conflict.ts::computeConflicts` 先按 date 分桶),同组必然同日;
 *  ⚠ **必须印片名** —— 备选常常是**另一部片**,不印片名朋友不知道自己抢的是什么;
 *  ⚠ 排期里已不存在(换版)→ 返回空串,由调用方跳过。 */
function altLine(
  cat: Catalog,
  code: string,
  mappings: Map<string, Mapping>,
  talkOf: (code: string) => boolean,
  rank: number | undefined
): string {
  const s = cat.byCode.get(code);
  if (!s) return "";
  const talk = gvTalkMin(s);
  const talkOn = talk > 0 ? talkOf(code) : true;
  const v = cat.venueById.get(s.venue_id);
  const bits = [
    `↳ 备选 ${code}`,
    fmtMinRangeMin(hmsToMin(s.start_time), effEndMin(s, talkOn)),
    displayTitle(s, mappings.get(code)?.title_cn),
    v ? venueShort(v) : s.venue_display,
  ];
  const head = `   ${bits.join("  ")}`;
  return rank === undefined ? head : `${head} · 顺位 ${rank}`;
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

/** 顺位(抢票分工)—— code → 组内顺位 + 同冲突组的其余场次。
 *  ⚠ 顺位只对**冲突组**内的场次有值(共同场次没有),`rankOf` 查不到时不印 —— 别兜底成 1。 */
export interface ShareRanking {
  rankOf: ReadonlyMap<string, number>;
  /** 同冲突组的其余场次(按顺位升序,不含自身);不在冲突组 → 空数组 */
  matesOf: (code: string) => string[];
}

/** 开票批次分节 —— 判据在 `batch.ts`,这里只负责排版(不重复判一次)。 */
export interface ShareBatching {
  /** 场次 → 批次号(`batch.ts::ticketBatchOf`) */
  batchOf: (s: Screening) => number;
  /** 批次节头文案(`第 1 批 · 9/17 14:00 KST / 北京 13:00`)—— 时间文案由 `extras.ts` 给 */
  headOf: (batch: number) => string;
}

export interface ShareOptions {
  ranking?: ShareRanking;
  batching?: ShareBatching;
}

type ShareRow = { e: PickRow; s: Screening };

/** 按批次切段(保持段内原有「日期 → 开场时间」顺序;批次升序,空批次不出现)。 */
function batchSections(rows: ShareRow[], batchOf: (s: Screening) => number): { batch: number; rows: ShareRow[] }[] {
  const sections: { batch: number; rows: ShareRow[] }[] = [];
  const index = new Map<number, ShareRow[]>();
  for (const row of rows) {
    const batch = batchOf(row.s);
    const list = index.get(batch);
    if (list) {
      list.push(row);
      continue;
    }
    const created: ShareRow[] = [row];
    index.set(batch, created);
    sections.push({ batch, rows: created });
  }
  return sections.sort((a, b) => a.batch - b.batch);
}

/** 生成分享文案(纯函数,便于单测)。
 *
 *  排序在函数内做(**按日期 → 开场时间**):分节头与日期区间都依赖「已排序」,
 *  不把这件事留给调用方 —— 少一个调用点忘了排序就产出错乱文案的坑。
 *  空输入返回空串(调用方据此给「还没有选片」提示,不复制空文本)。
 *
 *  `options` 缺省时输出即为「CODE 前置 + 两行一场」的基线版式(与勾选框全不勾一致)。 */
export function buildShareText(
  cat: Catalog,
  entries: PickRow[],
  mappings: Map<string, Mapping>,
  talkOf: (code: string) => boolean,
  options: ShareOptions = {}
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

  /** 一场的三行(场次 / 影院 / 备注)+ 备选行(带顺位时) */
  const pushShow = (row: ShareRow): void => {
    const { e, s } = row;
    // 映后谈取舍与网格 / .ics 同一解析:有谈段才问 talkOf,谈段为 0(非 GV / 时长配 0)的场无开关
    const talk = gvTalkMin(s);
    const talkOn = talk > 0 ? talkOf(e.code) : true;
    const rank = options.ranking?.rankOf.get(e.code);
    lines.push(
      `${e.code}  ${fmtMinRangeMin(hmsToMin(s.start_time), effEndMin(s, talkOn))}  ` +
        displayTitle(s, mappings.get(e.code)?.title_cn)
    );
    lines.push(venueLine(cat, s, talkOn, rank));
    if (e.note) lines.push(`📝 ${e.note}`);
    for (const mate of options.ranking?.matesOf(e.code) ?? []) {
      const line = altLine(cat, mate, mappings, talkOf, options.ranking?.rankOf.get(mate));
      if (line) lines.push(line);
    }
  };

  const batching = options.batching;
  const sections = batching ? batchSections(rows, batching.batchOf) : [{ batch: null, rows }];
  for (const section of sections) {
    if (section.batch !== null && batching) lines.push("", `【${batching.headOf(section.batch)}】`);
    for (const [date, group] of groupByDate(section.rows, (r) => r.s.date)) {
      lines.push("", dateHead(date, group.length));
      for (const row of group) pushShow(row);
    }
  }
  return lines.join("\n");
}
