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
// ② **场次行从 `flex-wrap` 改成两层栅格**。旧版 `flex flex-wrap` + 操作组 `ml-auto`:
//    空间不够时操作组被挤到第 2 行**并右对齐**,留下「[章组] …… [定位 ▸][＋加入]」
//    这种右侧孤立行(用户截图否掉:「这样的暴力换行很丑」)。现在折行位置是**设计好的**:
//      宽(容器 ≥ 540px)   一行:  `[身份][章组] ……………… [操作]`
//      窄                 两层:  `[身份] ……………… [操作]`
//                                `[章组]`
//    身份(CODE / 影院 / 日期 / 时间)与操作组**永远同层**,章组整层下沉、**左对齐**。
//    容器查询靠抽屉 `panel` 上的 `@container`(`library.ts::openFilmPicker`)—— 三个 tab
//    的内容都在它里面,故一处标记即可覆盖三处。
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

/* ---------------- 场次行(两层栅格) ---------------- */

/** 场次行容器 —— 宽:`[身份][章组][操作]` 一行;窄:身份 + 操作在第 1 行、章组整行下沉。
 *  ⚠ 断点 540px 是**容器宽度**(抽屉内容宽),不是视口宽 —— 见 `panel` 上的 `@container`。 */
export const SHOW_ROW_CLS =
  "grid items-center gap-x-[8px] gap-y-[3px] px-3 py-[8px] " +
  "grid-cols-[1fr_auto] @min-[540px]:grid-cols-[auto_1fr_auto]";

/** 身份对(CODE + 影院章 + 日期 + 时间)—— 恒在**第 1 行左**,与操作组同层。
 *  ⚠ 刻意**不给** `min-w-0`:内容是 `whitespace-nowrap`,允许收缩只会把它内部挤到溢出;
 *    让它保持固有宽度,由抽屉的最小宽度(`PICKER_W_MIN`)保证放得下。 */
const WHEN_CLS = "col-start-1 row-start-1 flex items-center gap-[5px] tabular-nums whitespace-nowrap";
/** 元数据章组 —— 宽时在第 1 行中段;窄时整行下沉到第 2 行(**左对齐**,不右漂) */
const WHERE_CLS =
  "col-span-2 row-start-2 flex flex-wrap items-center gap-x-[4px] gap-y-[3px] min-w-0 " +
  "@min-[540px]:col-span-1 @min-[540px]:col-start-2 @min-[540px]:row-start-1";
/** 操作组 —— 恒在**第 1 行右**。`justify-self-end` 贴右:
 *  旧版靠 `ml-auto`,而 `flex-wrap` 折行后 `ml-auto` 会把整组推到第 2 行右缘 → 右侧孤立行。 */
const ACTS_CLS =
  "col-start-2 row-start-1 justify-self-end flex items-center gap-[8px] @min-[540px]:col-start-3";
/** 追加行(行程 = 冲突提示)—— 独占最后一行整宽 */
const EXTRA_CLS = "col-span-2 row-start-3 @min-[540px]:col-span-3 @min-[540px]:row-start-2";

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

  // ---- 身份对(CODE + 影院章) + 日期 + 时间 ----
  const venue = cat.venueById.get(s.venue_id);
  const vCode = venue ? venue.code ?? venue.id.toUpperCase() : s.venue_display;
  const { label, weekday } = dateInfo(s.date);
  const when = el("div", WHEN_CLS);
  when.appendChild(codeChip(s.code));
  when.appendChild(
    uniformChipEl(vCode, venue ? venueTip(venue) : s.venue_display, "font-extrabold text-ink-2 bg-card border-line")
  );
  if (!o.hideDate) when.appendChild(el("span", "text-11 text-meta", `${label} ${weekday}`));
  when.appendChild(
    el("span", "text-12 font-semibold text-ink", o.timeText ?? fmtMinRange(s.start_time, s.end_time))
  );
  line.appendChild(when);

  // ---- 元数据章组(片长 + 等级 / 字幕 / GV / 页码;紧凑流式,无等宽列空隙) ----
  const where = metaChipRow(WHERE_CLS);
  where.appendChild(uniformChipEl(`${s.duration_min}min`, durTip(s.duration_min)));
  appendMetaRow(where, s, { uniform: true });
  line.appendChild(where);

  // ---- 操作组:有卡片头 → 挂到卡片头右缘;否则挂场次行第 1 行右缘 ----
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
