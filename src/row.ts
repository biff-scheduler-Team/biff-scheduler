// 场次行单一构造 —— 「影片库 / 我的选片 / 我的行程」三处共用**同一套排版与阅读顺序**
// (2026-09-10 统一,见 docs/plans/PLAN-20260910193000.md;行程档已按用户要求撤销)。
//
// 骨架(三处完全一致):
//   [CODE][影院章][日期][时间]   [片长 · 等级 · 字幕 · GV · 页码(紧凑流式)]   →→   [操作组]
// 各 tab 的差异只经 opts 注入,不再各写一份行结构:
//   · headTitle —— 卡片头片名(行程):置顶 15px 加粗,与选片卡「片名在上、场次在下」同序;
//                  有它时 `acts` 贴卡片头右缘(对齐选片卡「片名行右上角图标组」)
//   · headSub   —— 片名**下方**的影片元信息行(「原始片名 · 单元 · 国家 · 年份 · 导演」),
//                  与「影片库 / 我的选片」卡片副标题同款(12px 次级灰 + **最多两行** `line-clamp-2`)
//   · acts      —— 右侧操作组(影片库 = 定位 ▸ + 加入态;行程 = 映后 / 方案 / 档位 / 移出)
//   · extra     —— 追加行(行程 = 冲突提示),自动 basis-full 独占一行
//   · hideDate  —— 「我的选片」/「我的行程」按日期分节后,日期由节头给出
//
// ⚠ 章组**不再用固定 3 列网格**:`grid-cols-3` 是等宽列,短章(15 / KE)只占自身宽度却要占满
//   1/3 列,章与章之间就出现大片空白(用户反馈「图标之间都有空隙」)。改 `flex flex-wrap`
//   + 4px 间距 —— 章与章紧贴,换行位置由内容与可用宽度决定。
// ⚠ 曾有「行程档」分支(片名置顶 + **元信息降为中灰纯文本**,`title` / `titleExtra` / `plainMeta`),
//   已撤销 —— 元信息三处一律走统一描边章;片名置顶改由 `headTitle` 承担(只动位置,不动章)。

import type { Catalog, Screening } from "./types";
import { dateInfo, el, fmtMinRange } from "./util";
import { codeTip } from "./badges";
import { appendMetaRow, uniformChipEl, venueTip } from "./legend";

/** 场次行默认容器(影片库 / 我的选片;无边框 —— 节内分隔线由调用方按需加) */
export const SHOW_ROW_CLS = "flex flex-wrap items-center gap-x-[8px] gap-y-[4px] px-3 py-[8px]";

/** CODE 章(11px 黑块白字)—— 场次身份的第一元素,三处同款 */
export function codeChip(code: string): HTMLElement {
  const node = el(
    "span",
    "font-extrabold text-11 leading-[1.5] text-on-brand bg-ink-solid rounded-4 px-[6px] py-px",
    code
  );
  node.dataset.tip = codeTip(code);
  return node;
}

/** 元数据章组容器(紧凑流式)—— 片长 + 等级 / 字幕 / GV / 页码的落点,三处同款 */
export function metaChipRow(extraCls = ""): HTMLElement {
  return el("div", "flex flex-wrap items-center gap-x-[4px] gap-y-[3px] min-w-0" + (extraCls ? ` ${extraCls}` : ""));
}

/** 片长说明(hover)—— 网格卡 / 行程行 / 选片行同一份文案 */
const durTip = (min: number): string =>
  `片长 ${min} 分钟(正片,不含映后谈)\nGV 场另有映后谈 — 时长可配置(设置里改全局默认,行程行逐场覆写)`;

export interface ScreeningRowOpts {
  s: Screening;
  cat: Catalog;
  /** 卡片头片名(行程用)—— **置顶 15px 加粗**,与「我的选片」影片卡「片名在上、场次在下」
   *  同一阅读顺序。有 `headTitle` 时 `acts` 挂到卡片头右缘(而非场次行)。 */
  headTitle?: string;
  /** 片名下方的影片元信息行(「原始片名 · 单元 · 国家 · 年份 · 导演」)—— 与「影片库 / 我的选片」
   *  卡片的副标题同款(11.5px `text-meta` 单行截断,hover 出全文)。文案由 `util.ts::filmInfoText` 给。 */
  headSub?: string;
  /** 省略日期(「我的选片」/「我的行程」按日期分节后,日期已由节头给出) */
  hideDate?: boolean;
  /** 覆盖时间文案(行程行按「有效结束」显示,跨午夜带次日标记) */
  timeText?: string;
  /** 行容器完整类;缺省 = SHOW_ROW_CLS(影片库 / 我的选片场次行) */
  rowCls?: string;
  /** 右侧操作组(自动 `ml-auto` 贴右;有 `headTitle` 时贴卡片头右缘) */
  acts?: HTMLElement;
  /** 追加行(自动 `basis-full` 独占一行;行程 = 冲突提示);`null` = 无 */
  extra?: HTMLElement | null;
}

/** 场次行 —— 三处唯一构造。`data-code` 固定挂在行容器上(hover 联动 / C1 时段高亮用)。 */
export function screeningRow(o: ScreeningRowOpts): HTMLElement {
  const { s, cat } = o;
  const row = el("div", o.rowCls ?? SHOW_ROW_CLS);
  row.dataset.code = s.code;

  // ---- 卡片头(行程用):片名置顶 + 影片元信息行 —— 与「我的选片」影片卡同一阅读顺序
  //  (片名 → 元信息 → 场次)----
  //  片名字号 / 字重 / 截断与选片卡头完全同款(15px bold ink + truncate);下缘细分隔线
  //  把「这部片是什么」与「这场怎么排」切开,选片卡展开时也是这条线。
  //  ⚠ 行程特有操作(映后 / 方案 / 档位 / 移出)贴在**片名行**右缘 —— 对齐选片卡「片名行右上角图标组」;
  //    元信息行独占一行(不参与 flex 行,否则长片名会把信息挤没)。
  if (o.headTitle) {
    const head = el("div", "w-full min-w-0 border-b border-line-faint pb-[6px]");
    const titleRow = el("div", "flex items-center gap-x-[8px] min-w-0");
    // ⚠ **最多两行**(`line-clamp-2`),不再是单行 `truncate`(2026-09-11,与 `library.ts::filmRow` 同口径):
    //   行程卡头右侧还挂着操作组(映后 N′ / A / ★ / ✕,≈160px 且 `shrink-0`),它先吃掉宽度,
    //   剩下的才给片名 —— 单行截断会把长片名挤到只剩几个字;放开两行 = 卡片长高、信息纵向重排。
    titleRow.appendChild(el("div", "text-15 font-bold text-ink line-clamp-2 flex-1 min-w-0", o.headTitle));
    if (o.acts) {
      o.acts.classList.add("ml-auto");
      titleRow.appendChild(o.acts);
    }
    head.appendChild(titleRow);
    // 元信息行:与选片卡副标题同款(12px 次级灰 / 最多两行 / 仍超出时 hover 看全文)
    if (o.headSub) {
      const sub = el("div", "text-12 text-meta leading-[1.5] line-clamp-2 mt-[2px]", o.headSub);
      sub.dataset.tip = o.headSub;
      head.appendChild(sub);
    }
    row.appendChild(head);
  }

  // ---- 身份对(CODE + 影院章) + 日期 + 时间 ----
  const venue = cat.venueById.get(s.venue_id);
  const vCode = venue ? venue.code ?? venue.id.toUpperCase() : s.venue_display;
  const { label, weekday } = dateInfo(s.date);
  const when = el("div", "flex items-center gap-[5px] shrink-0 tabular-nums whitespace-nowrap");
  when.appendChild(codeChip(s.code));
  when.appendChild(
    uniformChipEl(vCode, venue ? venueTip(venue) : s.venue_display, "font-extrabold text-ink-2 bg-card border-line")
  );
  if (!o.hideDate) when.appendChild(el("span", "text-11 text-meta", `${label} ${weekday}`));
  when.appendChild(
    el("span", "text-12 font-semibold text-ink", o.timeText ?? fmtMinRange(s.start_time, s.end_time))
  );
  row.appendChild(when);

  // ---- 元数据章组(片长 + 等级 / 字幕 / GV / 页码;紧凑流式,无等宽列空隙) ----
  const where = metaChipRow();
  where.appendChild(uniformChipEl(`${s.duration_min}min`, durTip(s.duration_min)));
  appendMetaRow(where, s, { uniform: true });
  row.appendChild(where);

  // 无卡片头时操作组落场次行右缘(影片库 / 我的选片)
  if (o.acts && !o.headTitle) {
    o.acts.classList.add("ml-auto");
    row.appendChild(o.acts);
  }
  if (o.extra) {
    o.extra.classList.add("basis-full");
    row.appendChild(o.extra);
  }
  return row;
}
