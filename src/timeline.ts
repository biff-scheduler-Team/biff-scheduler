// 移动端单日纵向时间线(2026-09-12,PLAN-20260912002532)——
// ≤768px 时替换二维甘特(`grid.ts::buildGrid`)。
//
// 为什么需要它:二维网格是 **26 厅 × 时间轴**,缩放下限 0.55(行高 51px / 字号 55%),
// 横向刻度 3.0 × 0.55 ≈ 1.65px/min,一天约 14h ⇒ 轨道 ≈1386px + 影厅列 ——
// 390px 竖屏要横滚 4 屏以上、同时纵滚 26 行,形态本身不可用。故窄屏此前走「列表优先」,
// 把甘特降级为次级入口;结果是用户「一打开就是影片库,时间轴被挡住」(其实是 `display:none`)。
// 本文件给出「手机上可用的时间轴」形态。
//
// 形态 = 流式列表 + 时间轨(刻意**不是**「真时间轴」)
// ---------------------------------------------------
// 真时间轴(卡片按分钟绝对定位)要求时间重叠的场次**并排分列**;390px ÷ 2~3 列 ≈ 130px/列,
// 而场次行的「CODE / 影厅 / 时间 / 时长 / 章组」在 130px 里完全放不下 ——
// 那只是把「不可用」从横向搬到纵向。故这里牺牲「时长比例」这一条视觉信息,换回可读性:
//   · 卡片按**开始时间升序**依次排列(不绝对定位);
//   · 左缘一条时间轴:竖线 + 每场一个时间点 + `HH:MM`;
//   · 相邻两场**已选**之间画连接件(赶场间隔 / 重叠)—— 与 `agenda.ts::gapConnector` 同口径。
//
// ⚠ 每张卡 = `row.ts::screeningRow`(零新排版):「电影卡片都是同一个设计语言,不要三套」
//   是既定纪律(见 docs/CONVENTIONS.md §二)。底色语言也与二维网格**逐字同源**:
//   已选 = `in-plan`(淡绿底)、冲突 = `in-conf` + `border-2 border-conf`(淡红底红框)、
//   未选 = `border border-line`。
// ⚠ 时间线**不带**「定位 ▸」(2026-09-12 用户明确否掉:时间线本身就是时间轴);
//   加入 / 移出 = **整卡点选**,与二维网格同一交互 —— 委托复用 `main.ts` 既有的
//   `#grid-scroll [data-code]` 分支,本文件不新增任何事件监听。
// ⚠ 时间线**不参与**就地 patch(`patchGridStates`)、不画跨行冲突连线(`drawConflictLinks`)、
//   不做纵向锚点(`rowAnchor` 读 `[data-vrow]`,时间线不挂它 ⇒ 自然失效)。始终全量重建。

import type { Catalog, Screening } from "./types";
import { el, hmsToMin, minToClock, nextDayTag, slackBetween, type SlackResult } from "./util";
import { effEndMin, gvTalkMin } from "./gv";
import { matchesFilters, type FilterState } from "./filters";
import { SHOW_ROW_CLS, screeningRow } from "./row";

/** 时间轨列宽(px)—— 放得下 `HH:MM`(11px 等宽数字 ≈ 34px)+ 右侧 10px 内距 */
const RAIL_W = 45;
/** 轨道列与卡片之间的间距 —— 连接件的左内距按它换算(见 `connector`)。 */
const RAIL_GAP = 12;

/** 时间线的一张卡:场次行骨架 + 卡片外壳(底色由 `in-plan` / `in-conf` 覆盖,与网格同源)。
 *  ⚠ 外壳类**只加外壳**(边框 / 圆角 / 白底),不动 `SHOW_ROW_CLS` 的栅格与内距。 */
const TL_CARD_CLS =
  `${SHOW_ROW_CLS} border border-line rounded-8 bg-card shadow-[var(--shadow-card)]`;

export interface TimelineOpts {
  /** **甘特图那套**排片筛选(字幕 / 影厅 / GV)—— 时间线读同一份:被筛掉的场次不列 */
  filters?: FilterState;
  /** 已选场次投影:code → 影片 key(唯一数据源) */
  slots: Map<string, { key: string }>;
  /** GV 映后谈是否参加(全局默认 + 单场覆写解析后)—— 有效结束口径与网格 / 行程同源 */
  gvTalkOf: (code: string) => boolean;
  /** 跨馆转场缓冲(分钟) */
  transitMin: number;
}

/** 时间线的一条目 —— 排序 + 与「上一场已选」的间隔判定(纯函数,可 node 单测)。 */
export interface TimelineEntry {
  s: Screening;
  /** 是否已加入行程(底色 / 连接件的判定源) */
  picked: boolean;
  /** 与**上一场已选**的重叠分钟(>0 = 画红色「重叠」连接件);本场未选 / 前面无已选 = 0 */
  overlapMin: number;
  /** 与上一场已选的余量判定;null = 本场未选 / 前面没有已选场 */
  slack: SlackResult | null;
  /** 与上一场已选是否**跨馆**(连接件文案用) */
  crossVenue: boolean;
}

/** 当日时间线条目:过筛选 → 按开始时间升序 → 逐条算「与上一场已选」的间隔 / 重叠。
 *
 *  ⚠ 连接件只服务**已选**场次:时间线列的是当天**全部**场次(≈75 场),
 *    给任意相邻两场都画「赶场间隔」是纯噪声 —— 未排进场次的间隔没有意义。
 *    故 `prev` 只在遇到已选场次时推进:已选 → 已选 之间才是用户真正要走的那条线。
 *  ⚠ 排序键取 `start_time` 字典序(`"HH:MM:SS"` 定宽)+ `venue_id` 兜底同时刻的稳定序;
 *    **24+ 时制**照旧(跨午夜场 `start_time` 可 ≥ `"24:00"`,不取模)。 */
export function timelineEntries(cat: Catalog, date: string, o: TimelineOpts): TimelineEntry[] {
  const list = cat.schedule.screenings
    .filter((s) => s.date === date)
    .filter((s) => !o.filters || matchesFilters(s, o.filters))
    .sort((a, b) => a.start_time.localeCompare(b.start_time) || a.venue_id.localeCompare(b.venue_id));

  const out: TimelineEntry[] = [];
  let prev: Screening | null = null;
  let prevEnd = 0;
  for (const s of list) {
    const picked = o.slots.has(s.code);
    let overlapMin = 0;
    let slack: SlackResult | null = null;
    let crossVenue = false;
    if (picked && prev) {
      const cross = prev.venue_id !== s.venue_id;
      const r = slackBetween(prevEnd, hmsToMin(s.start_time), !cross, o.transitMin);
      slack = r;
      overlapMin = r.gap < 0 ? -r.gap : 0;
      crossVenue = cross;
    }
    out.push({ s, picked, overlapMin, slack, crossVenue });
    if (picked) {
      prev = s;
      // 有效结束口径与网格 / 行程 / .ics 同源:有谈段且参加 → 正片末 + 映后时长;
      // 无谈段(非 GV / 时长配成 0)→ 仍取官方 end_time(见 gv.ts 文件头)。
      prevEnd = effEndMin(s, gvTalkMin(s) > 0 ? o.gvTalkOf(s.code) : true);
    }
  }
  return out;
}

export interface TimelineCtx extends TimelineOpts {
  cat: Catalog;
  /** 当日**已选**冲突 code 集合(与二维网格同源:`conflicts.get(date).codeSet`)。
   *  未选场次恒不在其中 —— 冲突只在「我的行程」里才有意义。 */
  conflictCodes?: Set<string>;
}

/** 单日纵向时间线 —— 产出**替代 `#grid-scroll` 的容器**(由 `main.ts::renderTimeline` 挂载)。
 *  ⚠ `data-grid="1"` 与二维网格同标记:让既有「网格已挂载」的判定继续成立(切回宽屏时走全量重建)。 */
export function buildTimeline(ctx: TimelineCtx, date: string): HTMLElement {
  const entries = timelineEntries(ctx.cat, date, ctx);

  // 画布底板与二维网格同源(`bg-page` + `rounded-8`):外层白面板 `#grid-wrap` 是画框,
  // 白卡落在浅灰底上才有轮廓。
  const root = el("div", "bg-page rounded-8 p-[10px]");
  root.dataset.grid = "1";
  root.dataset.timeline = "1";

  if (entries.length === 0) {
    root.appendChild(
      el(
        "div",
        "py-[34px] px-3 text-center text-13 text-muted leading-[1.8]",
        "这一天在当前筛选下没有场次 —— 放宽排片筛选或换一天看看"
      )
    );
    return root;
  }

  // 内层 = 轴线的定位上下文(`root` 带内距,直接在里面定位会算进内距 —— 45px 就不对了)
  const inner = el("div", "relative grid gap-[6px]");
  // 时间轴竖线:贯穿整条列表;两端各缩 14px,不顶到第一张卡的上缘 / 最后一张卡的下缘
  // ⚠ 位置走**内联样式**:Tailwind v4 只生成源码里完整字面量出现的类,
  //   `left-[${n}px]` 这种拼接产物**不会被生成**(与 grid.ts::ROW_BASE_CLS 同一条坑)。
  const axis = el("span", "absolute top-[14px] bottom-[14px] w-px bg-line-strong");
  axis.style.left = `${RAIL_W}px`;
  inner.appendChild(axis);

  for (const e of entries) {
    if (e.picked && e.slack) inner.appendChild(connector(e));
    inner.appendChild(card(ctx, e));
  }
  root.appendChild(inner);
  return root;
}

/** 一张场次卡 —— `screeningRow` 骨架 + 卡片外壳 + 状态底色(与二维网格**逐字同源**的类组合)。
 *  ⚠ `data-card="1"`:`main.ts::jumpToScreening` 用它找落点(时间线同样是「定位」的合法目标)。 */
function card(ctx: TimelineCtx, e: TimelineEntry): HTMLElement {
  const conflict = ctx.conflictCodes?.has(e.s.code) ?? false;
  // 冲突优先(红) > 已选(绿) > 常态 —— 与 `grid.ts::cardStateOf` 同一优先级
  const stateCls = conflict
    ? "border-2 border-conf in-conf"
    : e.picked
      ? "border border-line in-plan"
      : "border border-line hover:border-line-strong";

  const row = el("div", "grid items-start");
  // 轨道列宽 / 列间距走**内联**(见 inner 轴线注释:动态值拼不出 Tailwind 类)
  row.style.gridTemplateColumns = `${RAIL_W}px minmax(0,1fr)`;
  row.style.columnGap = `${RAIL_GAP}px`;

  // ---- 第 1 列:时间轨(时间文本 + 落在轴线上的圆点)----
  // ⚠ 时间点是**绝对定位**在轨道列右缘的:圆点中心必须正落在竖线上(见 `inner` 的轴线),
  //   故用 `right-[-3.5px]`(圆点宽 7 ⇒ 中心 = 列右缘)。
  const rail = el("div", "relative text-right pr-[10px] pt-[11px] text-11 font-bold tabular-nums text-meta");
  rail.textContent = `${nextDayTag(hmsToMin(e.s.start_time))}${minToClock(hmsToMin(e.s.start_time))}`;
  rail.dataset.tip = "本场开始时刻";
  const dotCls = conflict
    ? "bg-conf"
    : e.picked
      ? "bg-ok"
      : "bg-line-strong";
  rail.appendChild(el("span", `absolute right-[-3.5px] top-[16px] w-[7px] h-[7px] rounded-full border border-card ${dotCls}`));
  row.appendChild(rail);

  // ---- 第 2 列:场次卡(零新排版 —— 与「影片库 / 我的选片 / 我的行程」同一套骨架)----
  const body = screeningRow({ s: e.s, cat: ctx.cat, rowCls: `${TL_CARD_CLS} ${stateCls}` });
  body.dataset.card = "1";
  if (conflict) body.dataset.tip = "与行程里另一场时间重叠 —— 两场无法同时观看";
  row.appendChild(body);
  return row;
}

/** 卡间连接件 —— **只在相邻两场都已选**时出现(见 `timelineEntries` 注释)。
 *  视觉与 `agenda.ts::gapConnector` 同语言:左侧竖虚线 + 一行小字;
 *  重叠 = 红实线 + 「⚠ 与上一场重叠 Nmin」,赶不上 = 红字,偏紧 = 黄字,宽裕 = 灰字。 */
function connector(e: TimelineEntry): HTMLElement {
  const r = e.slack!;
  // ⚠ 不加 `col-span-2`:`inner` 是**单列**栅格,连接件本来就占满整行 ——
  //   写 `col-span-2` 反而会凭空多出一个隐式列(把行挤窄)。
  const wrap = el("div", "relative min-h-[16px] flex items-center");
  wrap.style.paddingLeft = `${RAIL_W + RAIL_GAP}px`; // 与卡片左缘对齐(内联:见 inner 轴线注释)

  const overlap = e.overlapMin > 0;
  const cls = overlap || r.verdict === "bad"
    ? "text-conf font-extrabold"
    : r.verdict === "tight"
      ? "text-tight font-bold"
      : "text-muted";

  let txt: string;
  if (overlap) txt = `⚠ 与上一场重叠 ${e.overlapMin}min`;
  else {
    txt = `间隔 ${r.gap}min`;
    if (e.crossVenue && r.need > 0) txt += ` · 跨馆缓冲 ${r.need}min`;
    if (r.verdict === "bad") txt += " · 赶不上";
  }

  // 竖轨:虚线(宽裕)↔ 实线(重叠)—— 重叠是「真的看不了」,与「只是赶得紧」必须一眼分开
  const rail = el(
    "span",
    `absolute top-0 bottom-0 border-l ${overlap ? "border-solid border-conf" : "border-dashed border-line-strong"}`
  );
  rail.style.left = `${RAIL_W}px`; // 骑在时间轴竖线上(内联:见 inner 轴线注释)
  wrap.appendChild(rail);
  const label = el("span", `text-11 ${cls}`, txt);
  label.dataset.tip = overlap
    ? `与上一场已选场次时间重叠 ${e.overlapMin}min —— 两场无法同时观看\n可去「我的行程」的冲突组拖动排出偏好次序`
    : `上一场已选结束到本场开始的间隔 ${r.gap}min` +
      (e.crossVenue ? `,跨馆缓冲 ${r.need}min` : "") +
      `,余量 ${r.slack}min`;
  wrap.appendChild(label);
  return wrap;
}
