// 卡片头 + 场次行 —— 「影片库 / 我的选片 / 我的行程」三处共用**同一套设计语言与阅读顺序**。
// (2026-09-10 统一,见 docs/plans/PLAN-20260910193000.md;行程档已按用户要求撤销。)
//
// ---- 2026-09-11 三改:两件事 ----
//
// ① **卡片头收成唯一构造 `cardHead()`**。此前 `library.ts::filmRow`(可折叠卡片)与
//    `screeningRow` 的 `headTitle` 分支(行程卡)各写一份骨架,只靠字号 / 灰阶人工对齐 ——
//    用户反馈「电影卡片都是同一个设计语言,不要三套去增加用户的阅读成本」。
//    现在三处卡片头都是同一套三列栅格:
//      `[箭头列 12px][片名 + 副标题 + 状态行][右缘操作 / 图标组]`
//    行程卡没有箭头,**仍留同宽空列** —— 三处的片名左缘严格对齐(差 20px 会很显眼)。
//
// ② **场次行 = 单行优先的「外层不换行 + 内层流式」**(四改,取代三改的两层栅格)。
//    三改把它做成「宽一行 / 窄两层」的容器查询栅格,被用户否掉:窄档下章组整层下沉,
//    第 1 行只剩身份 + 操作组、**中间一大段空白** ——「明明右边有空间也不往右延展」。
//    现在**没有断点**,外层就是两列栅格 `[身份 + 章组(流式)][操作组]`,于是:
//      · 操作组**永远在第 1 行右缘**(外层只有两个格子,它没地方可去);
//      · 「身份 + 章组」自己流式折行 —— 第 1 行先被填满,装不下的章组逐枚折到第 2 行**左对齐**。
//    效果(520px 档):
//      `[001][BT] 9/17 周三 18:00–22:19 [139min][15][GV]        [定位 ▸][＋加入]`
//      `[KE][P.43]`                       ← 只在真的装不下时才出现,且左对齐、不右漂
//
// ⚠ 章组**不用固定 3 列等宽网格**:短章(15 / KE)只占自身宽度却要占满 1/3 列,章与章之间
//   会出现大片空白(用户反馈「图标之间都有空隙」)。它是 `flex flex-wrap` + 4px 间距。
// ⚠ 曾有「行程档」分支(`title` / `titleExtra` / `plainMeta`,元信息降为中灰纯文本),已撤销。

import type { Catalog, Screening } from "./types";
import { dateInfo, el, fmtMinRange } from "./util";
import { codeTip } from "./badges";
import { appendMetaRow, uniformChipEl, venueTip } from "./legend";

/* ---------------- 卡片头(三处唯一构造) ---------------- */

/** 卡片头片名:15px 加粗墨黑,**最多两行**(放开单行截断的理由见 CONVENTIONS §二) */
export const CARD_TITLE_CLS = "text-15 font-bold text-ink line-clamp-2 min-w-0";
/** 卡片头副标题(影片元信息:原始片名 · 单元 · 国家 · 年份 · 导演):12px 次级灰,**最多两行** */
export const CARD_SUB_CLS = "text-12 text-meta leading-[1.5] line-clamp-2";
/** 卡片外壳(行程卡;影片库 / 我的选片的卡片外壳在 `library.ts::filmRow`) */
export const CARD_SHELL_CLS =
  "group border border-line rounded-8 bg-card shadow-[var(--shadow-card)] " +
  "transition-[border-color,box-shadow] duration-[120ms] ease-in-out hover:border-line-strong hover:shadow-[var(--shadow-hover)]";
/** 冲突卡的卡片外壳(红框 + 淡红底) */
export const CARD_SHELL_CONF_CLS =
  "group border border-conf rounded-8 bg-biff-tint shadow-[var(--shadow-card)] " +
  "transition-[border-color,box-shadow] duration-[120ms] ease-in-out hover:border-line-strong hover:shadow-[var(--shadow-hover)]";

export interface CardHeadOpts {
  /** 片名 */
  title: string;
  /** 影片元信息行(「原始片名 · 单元 · 国家 · 年份 · 导演」);不传 = 不占行 */
  sub?: string;
  /** 片名右侧紧跟的附属(影片库 / 我的选片的豆瓣评分章) */
  titleExtra?: HTMLElement;
  /** 片名行**右缘**的操作 / 图标组 —— 三处同一槽位:
   *  影片库 / 我的选片 = ☆ ⓘ ✕;行程 = 映后 N′ / A / ★ / ✕ */
  trailing?: HTMLElement;
  /** 片名区下方的状态行(影片库 / 我的选片 = 「共 N 场 / 已排 N 场」+ 豆瓣链接;行程不传) */
  status?: HTMLElement;
  /** 展开 / 折叠箭头(**仅可折叠卡片**:影片库 / 我的选片);不传 → 仍留同宽空列 */
  collapse?: { open: boolean; attr: string; value: string };
  /** 下缘细分隔线 —— 把「这部片是什么」与「这场怎么排」切开 */
  divider?: boolean;
}

/** 卡片头 —— 三处唯一构造。`[箭头列][片名 + 副标题 + 状态行][右缘操作 / 图标组]`。 */
export function cardHead(o: CardHeadOpts): HTMLElement {
  const head = el(
    "div",
    "grid grid-cols-[12px_minmax(0,1fr)_auto] items-start gap-x-[8px] gap-y-[6px] px-3 py-[10px]" +
      (o.divider ? " border-b border-line-faint" : "") +
      (o.collapse ? " cursor-pointer select-none hover:bg-hover" : "")
  );
  if (o.collapse) head.dataset[o.collapse.attr] = o.collapse.value;

  // 第 1 列:箭头(定宽 12px)。行程卡没有箭头也占位 —— 三处片名左缘才对得齐。
  head.appendChild(
    el(
      "span",
      "text-muted text-10 leading-none pt-[5px] transition-transform duration-150 ease-in-out" +
        (o.collapse?.open ? " rotate-90" : ""),
      o.collapse ? "▶" : ""
    )
  );

  const titles = el("div", "grid gap-[3px] min-w-0");
  const titleRow = el("div", "flex items-start gap-2 min-w-0");
  titleRow.appendChild(el("div", `${CARD_TITLE_CLS} flex-1`, o.title));
  if (o.titleExtra) titleRow.appendChild(o.titleExtra); // 豆瓣章贴首行(items-start)
  titles.appendChild(titleRow);
  if (o.sub) {
    const sub = el("div", CARD_SUB_CLS, o.sub);
    sub.dataset.tip = o.sub; // 两行还放不下时 hover 看全文
    titles.appendChild(sub);
  }
  if (o.status) titles.appendChild(o.status);
  head.appendChild(titles);

  // 第 3 列:右缘槽位。**没有也要占位** —— 缺了它 `minmax(0,1fr)` 会把片名区撑满整行,
  // 标题换行点就会随「这张卡有没有操作组」抖动。
  head.appendChild(o.trailing ?? el("span", ""));
  return head;
}

/* ---------------- 场次行(单行优先:外层不换行 + 内层流式) ---------------- */

/** 场次行容器 —— 两列栅格:`[身份 + 章组(流式)][操作组]`。
 *  ⚠ **折行位置是设计好的**,这是本行排版的关键(2026-09-11 四改):
 *    · 外层**只有两个格子**,故**操作组永远在第 1 行右缘** —— 不会被甩到下一行;
 *    · 「身份 + 章组」是第 1 格里的**独立流式容器**(`FLOW_CLS`),它自己按可用宽度折行 ——
 *      第 1 行会被**填满**之后才折,折下来的章组**左对齐**(不会出现右侧孤立行)。
 *  旧版把三组塞进**同一个** `flex-wrap` + 操作组 `ml-auto`:`flex-wrap` 按**固有宽度**断行,
 *  空间不够时最后一项(操作组)被甩到第 2 行、又被 `ml-auto` 顶到右缘 → 用户截图否掉的
 *  「[章组] …… [定位 ▸][＋加入]」右侧孤立行,且明明右边有空间也不往右延展。
 *  ⚠ `minmax(0,1fr)` 而非 `1fr`:后者 min 是 `auto`,第 1 格不肯收缩 → 流式容器无从折行。 */
export const SHOW_ROW_CLS = "grid items-start gap-x-[8px] gap-y-[3px] px-3 py-[8px] grid-cols-[minmax(0,1fr)_auto]";

/** 「身份 + 章组」的**流式容器**(第 1 格):先填满第 1 行,装不下才逐枚折到下一行(左对齐)。
 *  ⚠ 章组直接作为它的子节点(不再套一层容器)—— 套一层就变成「整组一起折」,
 *    第 1 行会被浪费掉(用户原话:「明明右边有空间也不往右延展」)。 */
const FLOW_CLS = "col-start-1 row-start-1 flex flex-wrap items-center gap-x-[6px] gap-y-[3px] min-w-0";
/** 操作组(第 2 格)—— 恒在**第 1 行右缘**;`shrink-0` 保证它不被章组挤变形 */
const ACTS_CLS = "col-start-2 row-start-1 flex items-center gap-[6px] shrink-0";
/** 追加行(行程 = 冲突提示)—— 独占下一行整宽 */
const EXTRA_CLS = "col-span-2 row-start-2";

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

/** 片长说明(hover)—— 网格卡 / 行程行 / 选片行同一份文案 */
const durTip = (min: number): string =>
  `片长 ${min} 分钟(正片,不含映后谈)\nGV 场另有映后谈 — 时长可配置(设置里改全局默认,行程行逐场覆写)`;

export interface ScreeningRowOpts {
  s: Screening;
  cat: Catalog;
  /** 卡片头片名 —— **有它 = 返回整张行程卡**(卡片头 + 场次行);无它 = 只返回场次行
   *  (影片库 / 我的选片:场次行直接嵌在影片卡里)。 */
  headTitle?: string;
  /** 卡片头下方的影片元信息行(文案由 `util.ts::filmInfoText` 给) */
  headSub?: string;
  /** 省略日期(「我的选片」/「我的行程」按日期分节后,日期已由节头给出) */
  hideDate?: boolean;
  /** 覆盖时间文案(行程行按「有效结束」显示,跨午夜带次日标记) */
  timeText?: string;
  /** **只返回场次行时**的行容器类;缺省 = `SHOW_ROW_CLS`(影片库 / 我的选片) */
  rowCls?: string;
  /** **返回整张卡片时**的卡片外壳类;缺省 = `CARD_SHELL_CLS`(冲突行传 `CARD_SHELL_CONF_CLS`) */
  cardCls?: string;
  /** 操作组 —— 有 `headTitle` 时贴**卡片头右缘**,否则贴**场次行第 1 行右缘** */
  acts?: HTMLElement;
  /** 追加行(行程 = 冲突提示);`null` = 无 */
  extra?: HTMLElement | null;
}

/** 场次行 / 行程卡 —— 三处唯一构造。
 *  `data-code` 挂在**最外层**元素上(hover 联动 / C1 时段高亮 / `act.closest("[data-code]")` 都靠它)。 */
export function screeningRow(o: ScreeningRowOpts): HTMLElement {
  const { s, cat } = o;
  const line = el("div", o.rowCls ?? SHOW_ROW_CLS);
  const isCard = Boolean(o.headTitle);

  // ---- 第 1 格:身份 + 章组的**流式容器** ----
  const flow = el("div", FLOW_CLS);

  // 身份对(CODE + 影院章) + 日期 + 时间 —— 一枚整体(`shrink-0`),不会被拆到两行
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
  flow.appendChild(when);

  // ---- 章组(片长 + 等级 / 字幕 / GV / 页码)—— **直接进流容器**:
  //      逐枚参与折行,第 1 行先被填满;若套一层容器就变成「整组一起折」,第 1 行右侧会被浪费 ----
  flow.appendChild(uniformChipEl(`${s.duration_min}min`, durTip(s.duration_min)));
  appendMetaRow(flow, s, { uniform: true });
  line.appendChild(flow);

  // ---- 操作组:有卡片头 → 挂到卡片头右缘;否则挂场次行**第 1 行右缘**(见 SHOW_ROW_CLS 注释) ----
  if (o.acts && !isCard) {
    o.acts.classList.add(...ACTS_CLS.split(" "));
    line.appendChild(o.acts);
  }
  if (o.extra) {
    o.extra.classList.add(...EXTRA_CLS.split(" "));
    line.appendChild(o.extra);
  }

  if (!isCard) {
    line.dataset.code = s.code;
    return line;
  }

  // ---- 行程卡 = 卡片外壳 + 卡片头 + 场次行(头在行**外**,各自内距,不叠)----
  const card = el("div", o.cardCls ?? CARD_SHELL_CLS);
  card.dataset.code = s.code;
  card.appendChild(
    cardHead({ title: o.headTitle!, sub: o.headSub, trailing: o.acts, divider: true })
  );
  card.appendChild(line);
  return card;
}
