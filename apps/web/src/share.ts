// 分享文案(复制到微信 / 群聊)—— 与 `.ics` 并列的「人读」出口。
//
// 为什么单开一套格式:`.ics` 是喂给日历的(机器读,微信里贴过去是一坨不可读的文本),
// 而**单行塞满 6 个字段**的紧凑清单手机上换行一折,「时间 / 片名 / 影院」全糊在一起。
// 分享给朋友要的是「一眼看清哪天看什么」,故这里定一套**缩进块**的纯文本模板。
//
// ★ 格式(空行只出现在「批次 / 日期」分节之间):
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
//   · 顺位 → 组内第 1 = 「主选」,第 2 起 = 「备选②③…」(带圈数字);
//   · GV   → 「映后」(含谈) / 「仅正片」(弃谈) / 「GV」(有 GV 但没配谈段时长)。
//   ⚠ 顺位只对**冲突组**内的场次有值,共同场次不印(查不到就省略,别兜底成「主选」)。
//
// ★ 两个可选扩展(`ShareOptions`,由导出弹层的勾选框决定):
//   · `ranking`  → 状态列多一个「主选 / 备选②」,并逐块附**同冲突组的备选场次**
//                  (同款三行缩进块,前缀 `    ↳ `);
//   · `batching` → 先按**开票批次**分节(【第 1 批 · 9/17 14:00 KST / 北京 13:00】),
//                  节内再按日期分节;空批次不输出。
//      ⚠ 备选块按**自己的批次**归节(`shareUnits`):与主选不同批次的备选会被抬成独立块
//      (`↳ 806 …`,顺位印「349 的备选③」)—— 否则第 1 批的备选会被埋在第 2 批的主选下面,
//      抢票当天按节扫清单就漏了。
//
// ★ 为什么 CODE 在**行首**(2026-09-15 改,`PLAN-20260915234414`):分享文案的第二个用途是
//   **抢票分工** —— 朋友要按放映代码去官网找场次、在群里报号。CODE 行首才对齐成列,扫一眼就能定位。
//
// ★ 微信适配的三条约束(改格式时别破坏):
//   ① **不用 Markdown** —— 微信不渲染,`**加粗**` / `|` 表格会原样印出来;层次只靠全角标点(【】· —)、
//      换行与缩进。
//   ② **不用 emoji**(2026-09-16 改):早期用 🎬 / 📅 / 📍 / 📝 做行首标记,用户反馈「去掉 EMOJI」——
//      纯文本里 emoji 反而更乱,且各端渲染宽度不一,缩进对不齐。状态位一律走文字
//      (`主选` / `备选②` / `映后`)。`↳` 是**箭头符号不是 emoji**(等宽、各端一致),备选块保留它。
//   ③ **每行尽量短**:影院走 `legend.ts::venueShort`(短名),片名 / 影院各自单独一行(长片名换行也不会
//      把时间 / 影院挤错位);跨午夜场印「次日 05:35」,绝不把 24+ 制的 `29:35` 丢出去。
//
// ★ 口径(与网格 / 行程 / .ics 同源,勿另起一套):
//   · 时间 = **有效结束**(`gv.ts::effEndMin`,含 / 弃映后谈按单场解析);
//   · 片名 = `util.ts::bilingualRows`(与全站 `bilingualTitle` 同判同规则,只是拆成两行);
//   · 顺位 / 备选 = **当前行程**的冲突组(`plans.ts`),**不是方案快照** ——
//     方案快照每个冲突组只留第 1 顺位,拿它印顺位恒等于「主选」,朋友没法分工(见该 PLAN)。

import type { Catalog, Mapping, Screening } from "./types";
import { bilingualRows, dateInfo, filmNodeKey, fmtMinRangeMin, groupByDate, hmsToMin } from "./util";
import { effEndMin, gvTalkMin } from "./gv";
import { venueShort } from "./legend";
import type { PickRow } from "./ics";

/** 概要下方的分隔线(全角制表符,微信里是一条实线)—— 只出现一次,把「概要」与「场次」分开。 */
const DIVIDER = "━━━━━━━━━━━━";

/** 备选块的行首标记 —— 分享文案拼成 `    ↳ ` 前缀,分享图片画成同一枚箭头
 *  (`poster.ts` 读它,别再各写一个符号)。 */
export const ALT_MARK = "↳";

/** 备选块的行首前缀 —— 比主选块多一层缩进,一眼看出「这是同一组的备选方案」。 */
const ALT_PREFIX = `    ${ALT_MARK} `;

/** GV 标记:有谈段 → 「映后」/「仅正片」;`is_gv` 但谈段配成 0 → 只标「GV」。非 GV 场返回空串。
 *  ⚠ 文案是**分享文案 / 分享图片 chip / 方案「查看场次」弹层**共用的单一来源
 *  (`poster.ts::buildPosterModel` 的 `gv` 字段也走它)—— 改文案会三处一起变。 */
export function gvMark(s: Screening, talkOn: boolean): string {
  if (gvTalkMin(s) > 0) return talkOn ? "映后" : "仅正片";
  return s.is_gv ? "GV" : "";
}

/** 带圈序号(`①`..`⑩`);超出范围退回阿拉伯数字(冲突组不会有 11 场,但别印出 undefined)。 */
const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩";

function circled(n: number): string {
  return n >= 1 && n <= CIRCLED.length ? CIRCLED[n - 1] : String(n);
}

/** 顺位标记:组内第 1 = 「主选」,第 2 起 = 「备选②」。共同场次(无顺位)返回空串 —— 别兜底成「主选」。
 *  ⚠ 分享文案与分享图片**共用本函数**(`poster.ts` 的状态列也读它)—— 措辞只有这一处,别各写一份。
 *  `of` = 脱离主选、自己占一行的备选行所属主选的 code(见 `shareUnits`):此时印「349 的备选③」——
 *  备选按自己的批次归节后,不写清它替代哪一场,朋友就没法按顺位分工。 */
export function rankMark(rank: number | undefined, of?: string): string {
  const mark = rank === undefined ? "" : rank === 1 ? "主选" : `备选${circled(rank)}`;
  if (!of) return mark;
  return mark ? `${of} 的${mark}` : `${of} 组`;
}

/** 状态列(影院行)= 影院短名 · 顺位标记 · GV 标记,空位自动省略。 */
function venueBits(
  cat: Catalog,
  s: Screening,
  talkOn: boolean,
  rank: number | undefined,
  of?: string
): string {
  const v = cat.venueById.get(s.venue_id);
  const bits = [v ? venueShort(v) : s.venue_display];
  const mark = rankMark(rank, of);
  if (mark) bits.push(mark);
  const gv = gvMark(s, talkOn);
  if (gv) bits.push(gv);
  return bits.join(" · ");
}

/** 一场 / 一条备选 → 缩进块:首行 `CODE  时间  英文名`,续行(中文名 / 影院行)缩进到**英文名的起始列**。
 *  ⚠ 缩进按**实际首行前缀宽度**算,不写死空格数 —— CODE 位数与时间串长度都可能变
 *    (跨午夜还会多出「次日 」),写死会在那些块里错位。 */
function block(
  cat: Catalog,
  s: Screening,
  mapping: Mapping | undefined,
  talkOn: boolean,
  rank: number | undefined,
  prefix: string,
  note = "",
  of = ""
): string[] {
  const time = fmtMinRangeMin(hmsToMin(s.start_time), effEndMin(s, talkOn));
  const head = `${prefix}${s.code}  ${time}  `;
  const pad = " ".repeat(head.length);
  const titles = bilingualRows(s.title_en, s.title_zh || mapping?.title_cn);
  const out = [
    `${head}${titles[0] ?? ""}`,
    ...titles.slice(1).map((t) => `${pad}${t}`),
    `${pad}${venueBits(cat, s, talkOn, rank, of)}`,
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

/** 一个「打印单元」= 主选行 / 被抬成独立行的备选行,各带**紧跟自己的**备选(同批次的那几条)。
 *  ⚠ **分享文案与分享图片共用本函数**(见 `poster.ts`)。 */
export interface ShareUnit {
  e: PickRow;
  s: Screening;
  /** 紧跟本行的备选行(与主选**同批次**;不按批次分节时 = 全部备选) */
  alts: ShareRow[];
  /** 备选独立行:所属主选的 code;主选行 undefined */
  altOf?: string;
}

/** 已选场次 → 打印单元序列(按 日期 → 开场时间 排)。
 *
 *  ★ 为什么备选要**单独归自己的批次节**(2026-09-16):开票批次是**场次级**属性
 *  (`batch.ts::ticketBatchOf`),而备选与主选常常落在不同批次 —— 例如主选 349(第 2 批)的备选
 *  806 是 Actors' House(第 1 批)。旧版按「备选紧跟主选」排版,806 被埋在第 2 批节里,
 *  **第 1 批开票那天按节扫清单根本看不到它**,而这恰恰是抢票当天唯一要用的信息。
 *  ⚠ 只抬「批次不同」的那几条:与主选同批次的备选仍紧跟主选(「主选 + 备选同框」是排它的意义),
 *  不分批次时行为与旧版完全一致。 */
export function shareUnits(
  cat: Catalog,
  entries: PickRow[],
  ranking?: ShareRanking,
  batching?: ShareBatching
): ShareUnit[] {
  const rows = orderedPickRows(cat, entries);
  const items: (ShareUnit & { seq: number; sub: number })[] = [];
  rows.forEach((row, seq) => {
    const alts: ShareRow[] = [];
    items.push({ ...row, alts, seq, sub: 0 });
    for (const mate of ranking?.matesOf(row.e.code) ?? []) {
      const s = cat.byCode.get(mate);
      if (!s) continue; // 排期里已不存在(换版)→ 静默跳过
      const e: PickRow = { code: mate, note: "" }; // 备选没有备注(备注是「已选场次」的属性)
      if (batching && batching.batchOf(s) !== batching.batchOf(row.s)) {
        items.push({ e, s, alts: [], altOf: row.e.code, seq, sub: 1 });
      } else {
        alts.push({ e, s });
      }
    }
  });
  // 主选行的相对顺序由 `orderedPickRows` 定(seq 递增 ⇒ 再排一次不变);被抬出来的备选按
  // **自己的** 日期 / 开场时间插进序列,再由 `batchSections` 归到它自己的批次节。
  return items
    .sort(
      (a, b) =>
        a.s.date.localeCompare(b.s.date) ||
        a.s.start_time.localeCompare(b.s.start_time) ||
        a.seq - b.seq ||
        a.sub - b.sub
    )
    .map((it) => ({ e: it.e, s: it.s, alts: it.alts, altOf: it.altOf }));
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
 *  ⚠ 顺位只对**冲突组**内的场次有值(共同场次没有),`rankOf` 查不到时不印 —— 别兜底成「主选」。 */
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

/** 按批次切段(保持段内原有「日期 → 开场时间」顺序;批次升序,空批次不出现)。
 *  ⚠ **分享文案与分享图片共用**(`poster.ts` 也读它)—— 两处各切一遍必然出现
 *  「文案分了 2 节、图上只有 1 节」这种对不上的图。 */
export function batchSections<T>(rows: T[], batchOf: (row: T) => number): { batch: number; rows: T[] }[] {
  const sections: { batch: number; rows: T[] }[] = [];
  const index = new Map<number, T[]>();
  for (const row of rows) {
    const batch = batchOf(row);
    const list = index.get(batch);
    if (list) {
      list.push(row);
      continue;
    }
    const created: T[] = [row];
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
 *  `options` 缺省时输出即为「CODE 行首 + 三行缩进块」的基线版式(与勾选框全不勾一致)。 */
export function buildShareText(
  cat: Catalog,
  entries: PickRow[],
  mappings: Map<string, Mapping>,
  talkOf: (code: string) => boolean,
  options: ShareOptions = {}
): string {
  const units = shareUnits(cat, entries, options.ranking, options.batching);
  // ⚠ 概要只数**主选行**:被抬出来的备选不是「要去看的那一场」,计进「共 N 场」会与场次行对不上
  const sum = shareSummary(cat, units.filter((u) => !u.altOf));
  if (!sum) return "";

  const fest = cat.schedule.festival;
  const lines: string[] = [
    `${fest.name} ${fest.year} 看片计划`,
    `${sum.range} · 共 ${sum.count} 场 / ${sum.films} 部`,
    DIVIDER,
  ];

  /** 一个单元(缩进块)+ 紧跟它的备选块(带顺位时) */
  const pushUnit = (u: ShareUnit): void => {
    const { e, s } = u;
    // 映后谈取舍与网格 / .ics 同一解析:有谈段才问 talkOf,谈段为 0(非 GV / 时长配 0)的场无开关
    const talk = gvTalkMin(s);
    const talkOn = talk > 0 ? talkOf(e.code) : true;
    const rank = options.ranking?.rankOf.get(e.code);
    // 被抬出来的备选行:**不缩进**(它自己占一行),但顺位标记带「谁的备选」(`349 的备选③`)
    lines.push(
      ...block(cat, s, mappings.get(e.code), talkOn, rank, u.altOf ? `${ALT_MARK} ` : "", e.note, u.altOf)
    );
    for (const alt of u.alts) {
      const altTalk = gvTalkMin(alt.s);
      const altTalkOn = altTalk > 0 ? talkOf(alt.e.code) : true;
      lines.push(
        ...block(
          cat,
          alt.s,
          mappings.get(alt.e.code),
          altTalkOn,
          options.ranking?.rankOf.get(alt.e.code),
          ALT_PREFIX
        )
      );
    }
  };

  const batching = options.batching;
  const sections = batching
    ? batchSections(units, (u) => batching.batchOf(u.s))
    : [{ batch: null, rows: units }];
  for (const section of sections) {
    if (section.batch !== null && batching) lines.push("", `【${batching.headOf(section.batch)}】`);
    for (const [date, group] of groupByDate(section.rows, (u) => u.s.date)) {
      lines.push("", dateHead(date));
      for (const u of group) pushUnit(u);
    }
  }
  return lines.join("\n");
}
