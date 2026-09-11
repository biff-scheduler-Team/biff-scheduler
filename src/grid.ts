// 选片网格 — 自研 CSS 网格:行=影厅,列=当日时间轴;卡片绝对定位。
// 全量化:网格 / 卡片 / 标签 / 时间标尺 / 转场紧底色提示 / ⓘ / 冲突旗 / 其他旗 全部 Tailwind utility。

import type { Catalog, Mapping, Screening } from "./types";
import type { ConflictResult } from "./conflict";
import { displayTitle, el, fmtEndClock, fmtMinRange, fmtMinRangeMin, hmsToMin, slackBetween, todayIsoLocal } from "./util";
import { screeningsByVenue } from "./data";
import { codeTip } from "./badges";
import { effEndMin, filmEndMin, gvTalkMin } from "./gv";
import { hasBadges, metaRowFor, venueTip } from "./legend";
import { matchesFilters, venueAllowed, type FilterState } from "./filters";

export const ROW_H = 92; // 100% 基准行高(1 行 = 1 影厅);实际行高 = ROW_H × 缩放倍率,见 rowMetrics
const TRAIL_PAD = 60; // A3:末 tick 右侧 +60px 安全边距(标签半宽 + 呼吸),两端标签永不悬出/被裁
export const PX_PER_MIN = 3.0; // 100% 基准刻度(每小时 180px;1.5h≈270px;2h≈360px)
// 横向更舒展 → 6 chip 徽章行单行排开、短场次(60–95min)不再因行宽不足换行或降级时间。
// 实际刻度一律由 main 侧算好经 GridCtx.pxPerMin 传入(横纵共用一个缩放倍率,见 ZOOM_LEVELS)。
const AXIS_FALLBACK = { start: 9 * 60, end: 23 * 60 }; // A1:当日无排片时的时间轴兜底窗口
const AXIS_LEAD_MIN = 30; // A1:首场开映前保留的呼吸时间(轴起点对齐到整点)
const CARD_INSET_Y = 2; // 卡片上下留白(100% 档;随行高缩放,见 rowMetrics)

/* ---------------- 缩放:横纵**同一倍率**(整体等比) ---------------- */
/**
 * 缩放倍率 —— **横向时间刻度与纵向行高共用同一个倍率**,卡片内所有组件(字号 / 留白 / 色点 / 徽章行)
 * 也按同一倍率**线性**缩放。这样卡片「大 → 小」时内部排版严格等比:字号与卡片宽高同比例收放,
 * 不会出现「行高先塌、字号没跟上」那种组件挤作一团的错乱(旧版字号走 z^0.6 阻尼、横向另有独立倍率)。
 *
 * 阶梯刻意离散(沿阶梯走用 stepZoom):连续缩放会让卡片文本在「换行 / 截断 / 显示几行」之间反复抖。
 * 100% = ROW_H = 92px = PX_PER_MIN;55% 时行高 51px、字号 55%,一屏能看到约 17 影厅。
 * 下限 0.55(再小标题就难以扫读),上限 1.2(卡片更舒展)。
 */
export const ZOOM_LEVELS: number[] = [0.55, 0.7, 0.9, 1, 1.2];
export const ZOOM_MIN = ZOOM_LEVELS[0];
export const ZOOM_MAX = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/** 沿阶梯走一档:严格大于当前倍率的最小档(放大)/ 严格小于的最大档(缩小)。
 *  不先吸附再位移 —— 旧值可能是持久化下来的档间值,吸附会让 +/− 跳过相邻档。 */
export function stepZoom(z: number, dir: 1 | -1): number {
  if (dir === 1) {
    const up = ZOOM_LEVELS.find((l) => l > z + 1e-6);
    return up ?? ZOOM_MAX;
  }
  const idx = ZOOM_LEVELS.findIndex((l) => l >= z - 1e-6);
  return idx <= 0 ? ZOOM_MIN : ZOOM_LEVELS[idx - 1];
}

/** 行几何(行高 / 字号 / 留白 / 徽章行开关)—— 卡片与泳道**唯一**的取数口 */
export interface RowMetrics {
  /** 行高(px)= ROW_H × 倍率 */
  rowH: number;
  /** 卡片内字号倍率 —— **线性 = 行高倍率**(等比):字号与卡片宽高同比例,排版严格等比不挤乱。 */
  fontScale: number;
  /** 卡片上下留白(随行高收缩,但保底 1px —— 归零后相邻两行卡片会糊成一片) */
  insetY: number;
  /** 是否还画徽章行(等级/字幕/GV/页码/片长)—— 矮到装不下四行时最先舍它(信息在 ⓘ / hover 仍在) */
  showBadges: boolean;
}

/**
 * 行几何单一来源:行高 / 字号倍率 / 留白 / 徽章行开关全从这里派生。
 *
 * **字号倍率 = 行高倍率(线性)**:卡片宽高与字号同比例收放,内容高 / 行高之比恒定 ⇒ 无论缩到
 * 哪一档,卡片内排版都严格等比,不会出现组件挤作一团(旧版字号走 z^0.6 阻尼,行高先塌、字号滞后)。
 *
 * 徽章行**整行按 `zoom` 等比缩**(见 appendCard):章体是 legend.ts 的显式 `text-10`,父级
 * font-size 不级联;而 `zoom` 是布局级缩放,子元素显式 px 也跟着缩 —— 那枚固定 17.78px 高的章
 * 若不缩就会顶破矮行。`rowH < 80`(55 / 70% 两档)时整行不画:矮行里最先舍信息量最低的它 ——
 * 等级 / 字幕 / GV / 页码 / 片长在 ⓘ 弹层与 hover 提示里都还在,不是信息删除。
 */
export function rowMetrics(z: number): RowMetrics {
  const rowH = Math.round(ROW_H * z);
  return {
    rowH,
    fontScale: z, // 等比:字号倍率 = 行高倍率(线性)
    insetY: Math.max(1, Math.round(CARD_INSET_Y * z)),
    showBadges: rowH >= 80,
  };
}

/* ---------------- 影厅列几何(随横向倍率) ---------------- */
/**
 * 影厅列几何 —— **列宽 / 代码 chip 宽 / chip 字号三者同源**。
 *
 * 行标签只放官方影院代码(B1 / BT / L10 / BCM),整格 hover 出全名 + 韩名 + 分区(legend.ts::venueTip)。
 * 列宽于是从「装下最长全名 205px」变成「装下一枚代码 chip」:100% 由 148px 收到 ~49px,
 * 多出来的宽度全给时间轴,且**再也不会截断**(旧版 148px 只有 100px 可用,而全名要 205px)。
 *
 * **列宽与字号同源,都跟缩放倍率走**:100%(= PX_PER_MIN)时列宽 ~49px、字号 10px;
 * 缩放时与时间轴一起缩 / 展(整体等比),而不是「只有轨道在拉伸、影厅列钉死 148px」。
 * 字号给 9~22px 的可读钳制(影厅列是导航而非卡片组件,极端倍率下保证仍能认出代码)。
 *
 * ⚠ 列宽**不能**写成 Tailwind 字面量类(`grid-cols-[${n}px]` 拼不出来,见 buildGrid 注释),
 *   一律走内联 `gridTemplateColumns`;`main.ts` 的缩放锚点换算依赖「轨道起点 = labelW」,必须同源。
 */
export function labelMetrics(pxPerMin: number): {
  labelW: number;
  chipW: number;
  fontPx: number;
  padX: number;
} {
  const z = pxPerMin / PX_PER_MIN;
  const fontPx = Math.round(Math.min(22, Math.max(9, 10 * z)));
  const chipW = Math.round(fontPx * 2.8); // 容下 3 字符代码(L10 / BCM)+ 左右边框
  const padX = fontPx; // 列内边距跟着字号走 → 列宽与 chip 严格等比
  return { labelW: chipW + 2 * padX + 1, chipW, fontPx, padX };
}

/** 适应宽度:在**离散缩放阶梯**里挑一个「刚好把当天整条轴塞进可用宽」的最大档(都塞不下则取最小档)。
 *  每档总宽 = 影厅列 + 轴长 × 刻度 + 右端 TRAIL_PAD(末 tick 标签不被裁);与整体缩放同源 ——
 *  选中的档同时作用于横向刻度与纵向行高。 */
export function fitZoomLevel(cat: Catalog, date: string, availW: number): number {
  const axis = axisRangeFor(cat, date);
  const axisMin = Math.max(axis.end - axis.start, 60);
  const totalW = (z: number): number => {
    const pxPerMin = PX_PER_MIN * z;
    return labelMetrics(pxPerMin).labelW + axisMin * pxPerMin + TRAIL_PAD;
  };
  let best = ZOOM_MIN;
  for (const l of ZOOM_LEVELS) {
    if (totalW(l) <= availW) best = l;
  }
  return best;
}

/** 当日时间轴起点分钟 —— 轨道内 x = `labelMetrics().labelW` 处即该时刻(供 main 侧换算缩放锚点) */
export function axisStartFor(cat: Catalog, date: string): number {
  return axisRangeFor(cat, date).start;
}

/** 冲突 / 紧转场 / 已选 的红绿灯底色:优先级不参与网格染色(见行程行 seg),故无 p-* 类映射。 */
export interface GridCtx {
  cat: Catalog;
  /** 横向刻度(px/min)= PX_PER_MIN × 缩放倍率。由 main 侧算好传入 —— 缩放是视图偏好,grid 只负责画 */
  pxPerMin: number;
  /** 行几何(行高 / 字号倍率 / 留白 / 徽章行开关)—— 由 main 侧 `rowMetrics(缩放倍率)` 算好传入 */
  row: RowMetrics;
  /** 已选场次投影:code → 影片 key。判「是否已选」全走它(唯一数据源) */
  slots: Map<string, { key: string }>;
  mappingOf: (code: string) => Mapping | undefined; // 豆瓣映射(回填中文名)
  conflictCodes: Set<string> | undefined; // 当日冲突 code
  /** 当日冲突 pair(与 conflictCodes 同源)—— 卡片 hover 说明 + 跨行连线都读它 */
  conflictPairs?: [string, string][];
  transitMin: number; // 跨馆转场缓冲(1a 余量判定)
  /** GV 映后谈是否参加(全局默认 + 单场覆写解析后):决定正片/整场拆分、紧转场按哪段结束算 */
  gvTalkOf: (code: string) => boolean;
  hourFilter?: number | null; // 点击时间轴整点 → 只看该小时段场次(其余 hour-dim);null = 不过滤
  /** **甘特图那套**排片筛选(字幕 / 影厅 / GV)—— 判定与控件在 `filters.ts`;
   *  网格只读它算「淡不淡」与「哪些影厅行要整行去掉」。缺省 = 不过滤。
   *  ⚠ 影片库抽屉另有一份**独立**状态(见 filters.ts 文件头),不从这里传。 */
  filters?: FilterState;
}

/** A1 动态时间轴:轴界由「当日最早开映 − 呼吸时间」与「最晚散场」对齐整点推导,不再写死 09:00–23:00 ——
 *  早场 / 午夜场(00:xx 收场)自动外扩;整点标签取模 24 显示(24:00 → "00:00"),配合 TRAIL_PAD 不被右缘裁成 "00"。
 *  **24+ 时制**:跨午夜场的 end_time ≥ "24:00"(如 "29:35"),`hmsToMin` 直接得 1775 → 轴界自然外扩到次日;
 *  刻度 h ≥ 24 的标签加「次日」前缀,并在 24:00 处画一条日期分隔线(见 buildRulerTicks)。 */
function axisRangeFor(cat: Catalog, date: string): { start: number; end: number } {
  let first = Infinity;
  let last = -Infinity;
  for (const s of cat.schedule.screenings) {
    if (s.date !== date) continue;
    const st = hmsToMin(s.start_time);
    // 轴末取「官方槽位末」与「GV 含映后结束」的较大者 —— 映后时长可配置(gv.ts::gvTalkMin),
    // 调大后谈块会画到官方槽位之外,轴末不跟着外扩就会被右缘裁掉。
    const en = Math.max(hmsToMin(s.end_time), filmEndMin(s) + gvTalkMin(s));
    if (st < first) first = st;
    if (en > last) last = en;
  }
  if (!Number.isFinite(first)) return { ...AXIS_FALLBACK };
  const start = Math.max(0, Math.floor((first - AXIS_LEAD_MIN) / 60) * 60);
  const end = Math.max(Math.ceil(last / 60) * 60, start + 2 * 60);
  return { start, end };
}

/** A5「现在」时刻在该日时间轴内的像素位;不在轴内(或非当天)返回 null(角标/红线随每次渲染取当前时间) */
function nowPxFor(axis: { start: number; end: number }, pxPerMin: number): number | null {
  const d = new Date();
  const m = d.getHours() * 60 + d.getMinutes();
  return m >= axis.start && m <= axis.end ? (m - axis.start) * pxPerMin : null;
}

// 粘性场馆列 / 标尺左上空格:底色 = 画布灰(bg-page),与卡片白底拉开层级;
// 列分隔交给 border-r,不再用白底(旧值 bg-card 与卡片同色 → 代码 chip 像浮在空白上)。
// 左右内边距由 buildGrid 按缩放内联写(labelMetrics().padX)—— 这里不写死 px-*,否则列宽与内边距不同步。
const LABEL_BOX_CLS =
  "sticky left-0 z-[3] bg-page border-r border-line py-[6px] flex flex-col justify-center min-h-[28px]";

// 行 / 标尺的栅格骨架:**只有 "grid"**,列宽由 buildGrid 内联 `gridTemplateColumns` 写。
// ⚠ Tailwind v4 只生成源码里的完整字面量类,拼不出 `grid-cols-[${n}px]` 这种动态宽度 ——
//   缩放要改影厅列宽,所以必须走内联样式;main 侧的缩放锚点换算依赖
//   「轨道起点 = 影厅列宽 = labelMetrics().labelW」,同源。
const ROW_BASE_CLS = "grid";

export function buildGrid(ctx: GridCtx, date: string): HTMLElement {
  const allRows = screeningsByVenue(ctx.cat, date);
  // ★ 影厅筛选 = **纵轴整行的去留**(不只是淡化):不去的影院留在轴上只是白占一行高。
  //   字幕 / GV 两道仍只淡化卡片 —— 它们说的是「这场我不想要」,留着才看得清当天还有什么;
  //   影厅说的是「我根本不会去那儿」,整行没有信息量。
  //   ⚠ 行数会随筛选变 ⇒ 必须进几何签名(见 gridGeometryKey 的 venueKey),否则 patch 路径
  //     会在「行已变但 DOM 没重建」的状态下静默错位。
  const rows = ctx.filters
    ? allRows.filter(({ venue, list }) => venueAllowed(venue?.id ?? list[0]?.venue_id ?? "", ctx.filters!))
    : allRows;
  const axis = axisRangeFor(ctx.cat, date); // A1:当日动态轴(最早开映→最晚散场,整点对齐)
  const axisMin = axis.end - axis.start;
  const pxPerMin = ctx.pxPerMin; // 横向刻度(100% = PX_PER_MIN);由 main 侧随 GridCtx 传入
  const { rowH } = ctx.row; // 泳道高(行高倍率派生);卡片留白由 appendCard 从 ctx.row 另取
  const { labelW, chipW, fontPx, padX } = labelMetrics(pxPerMin); // 影厅列宽随横向倍率(与 main 侧锚点换算同源)
  const trackW = axisMin * pxPerMin;
  const totalW = labelW + trackW + TRAIL_PAD;
  /** 行 / 标尺共用的栅格列宽 —— 内联写(见 ROW_BASE_CLS 注释:Tailwind 拼不出动态宽度) */
  const rowCols = `${labelW}px 1fr`;
  const nowPx = todayIsoLocal() === date ? nowPxFor(axis, pxPerMin) : null;

  // D3:横向溢出常态化 → 原生滚动条始终可用 + cursor-grab 拖拽平移恒挂(attachPan 内部对装得下的容器自行守卫)
  // ★ 2026-09-11 **工作台化**:容器同时承担纵向滚动(限高由 main.ts::fitGridHeight 内联写入)。
  //   旧版只有 `overflow-x-auto` —— 横向滚动条被画在「标尺 + 29 行」这整块内容的**最底部**:
  //   要横向滚动必须先滚到页面最底,且 overlay 滚动条会浮在最后一行卡片上(用户反馈)。
  //   现在横向滚动条常驻容器底部(永远在视口内),纵向滚动条落在容器右缘。
  // 画布底板:极浅灰(bg-page)+ 内嵌圆角 —— 外层白面板(#grid-wrap)成为「画框」,
  // 未选中的白卡落在灰底上才有轮廓(旧版画布无底色 → 透出面板白,与卡片「白底叠白底」)。
  // `pb-[10px]`:横向滚动条(占位式或 overlay)与最后一行卡片之间留出呼吸位,绝不压住卡片。
  const scroll = el("div", "overflow-auto pb-[10px] cursor-grab bg-page rounded-8");
  scroll.dataset.grid = "1"; // 复用路径的锚点标记(见 main.ts::renderGrid / patchGridStates)
  const min = el("div", "relative w-max min-w-full");
  min.style.width = `${totalW}px`;
  // 冲突连线层(见 drawConflictLinks):覆盖整个画布、`pointer-events-none`,且**是首个子节点** ——
  // 先画即落在行 / 卡片**之下**,连线只从两张冲突卡之间的空白处露出,不会糊在文字上。
  const linkLayer = el("div", "absolute inset-0 pointer-events-none");
  linkLayer.dataset.confLinks = "1";
  min.appendChild(linkLayer);

  // 时间标尺(ruler):底部强描边与场馆行分隔。粘性列空占位(动态轴首根整点标签左锚定画在轨道内,
  // 替代旧「9:00 放粘性列」的写法 —— 轴界不再固定 9 点,只有当日首场那一格需要贴左)。
  // ★ 工作台化:纵向滚动改由容器承担 → 标尺 `sticky top-0` 吸在容器顶部(滚到第 20 厅也看得见时刻)。
  //   `bg-page` 不能省:不透明底才能盖住从它下面滚过去的行(否则卡片会从刻度缝里透出来)。
  const ruler = el("div", `${ROW_BASE_CLS} sticky top-0 z-[4] bg-page border-b border-line`);
  // 锚点给 main.ts 的定位用:标尺吸顶会盖住容器顶部一条,纵向居中的「可视净区」要从它下缘起算
  // (见 main.ts::scrollTargetFor)。没有这个锚点只能按 clientHeight 居中 → 卡片整体偏上。
  ruler.dataset.gridRuler = "1";
  ruler.style.gridTemplateColumns = rowCols;
  ruler.append(el("div", LABEL_BOX_CLS), buildRulerTicks(ctx, axis, pxPerMin, trackW, nowPx));
  min.appendChild(ruler);

  const cardEls = new Map<string, HTMLElement>();
  const talkEls = new Map<string, HTMLElement>(); // GV 映后谈块(与正片卡同 code 关联)
  let venueIdx = 0;
  for (const { venue, list } of rows) {
    const row = el(
      "div",
      `${ROW_BASE_CLS}${venueIdx > 0 ? " border-t border-line-soft" : ""}`
    );
    row.style.gridTemplateColumns = rowCols;
    // 行锚点标识:行高缩放后 main 侧要按「参考线落在第几行(小数)」把页面滚动补回来,否则视口会跳走
    // (见 main.ts::rowAnchor)。同时给无头验收当选择器用。
    row.dataset.vrow = venue ? venue.id : list[0]?.venue_id ?? "";
    const label = el("div", LABEL_BOX_CLS);
    label.style.paddingLeft = `${padX}px`;
    label.style.paddingRight = `${padX}px`;
    // 行标签 = **官方影院代码一枚**(B1 / BT / L10 / BCM),整格 hover 出全名 / 韩名 / 分区 / 代码说明。
    // 不再放影院名:旧版 148px 列里只有 100px 可用,而最长全名要 205px,必被 truncate 裁成
    // 「Busan Cinema …」—— 且区分性字词全在末尾(B1/B2/B3 会截成一模一样)。代码是唯一塞得进
    // 窄列又不丢信息的写法;全名不丢,由 tooltip 兜住(见 legend.ts::venueTip)。
    const codeText = venue ? venue.code ?? venue.id.toUpperCase() : list[0]?.venue_id ?? "?";
    if (venue) label.dataset.tip = venueTip(venue);
    const line = el("div", "flex items-center justify-center min-w-0");
    const code = el(
      "i",
      "not-italic font-extrabold text-biff-ink bg-biff-soft border border-biff-line rounded-3 text-center whitespace-nowrap",
      codeText
    );
    code.style.width = `${chipW}px`;
    code.style.fontSize = `${fontPx}px`;
    code.style.lineHeight = "1.45";
    line.appendChild(code);
    label.appendChild(line);
    row.appendChild(label);

    const tracks = el("div", "relative");
    tracks.style.width = `${trackW + TRAIL_PAD}px`;
    tracks.style.height = `${rowH}px`;
    const hourPx = 60 * pxPerMin;
    const halfPx = 30 * pxPerMin;
    // A2 甘特列感:整点竖线 ink 10%、半点竖线 ink 4%,贯穿整行(卡片浮于线上);与标尺整点刻度同 x 对齐。
    // 放大后(hourPx ≥ 300)再叠一层刻钟竖线 ink 2.5% —— 高倍下半小时间距近 100px,不给细刻度就只剩空挡。
    // 层序:先写的在上层,故 hour → half → quarter 依次降权。
    const hourLine = "color-mix(in srgb, var(--color-ink) 10%, transparent)";
    const halfLine = "color-mix(in srgb, var(--color-ink) 4%, transparent)";
    const grads = [
      `repeating-linear-gradient(90deg, transparent 0 ${hourPx - 1}px, ${hourLine} ${hourPx - 1}px ${hourPx}px)`,
      `repeating-linear-gradient(90deg, transparent 0 ${halfPx - 1}px, ${halfLine} ${halfPx - 1}px ${halfPx}px)`,
    ];
    if (hourPx >= 300) {
      const q = 15 * pxPerMin;
      const qLine = "color-mix(in srgb, var(--color-ink) 2.5%, transparent)";
      grads.push(`repeating-linear-gradient(90deg, transparent 0 ${q - 1}px, ${qLine} ${q - 1}px ${q}px)`);
    }
    tracks.style.backgroundImage = grads.join(", ");

    for (const s of list) {
      const { card, talkEl } = appendCard(tracks, s, ctx, pxPerMin, axis.start);
      cardEls.set(s.code, card);
      if (talkEl) talkEls.set(s.code, talkEl);
    }
    // 「现在」时刻竖线贯穿各行(标尺已画带标签的一段,行内补全高)
    if (nowPx !== null) {
      const rowNow = el("span", "absolute top-0 bottom-0 w-[1.5px] now-line pointer-events-none z-[5]");
      rowNow.style.left = `${nowPx - 0.75}px`;
      tracks.appendChild(rowNow);
    }
    row.appendChild(tracks);
    min.appendChild(row);
    venueIdx++;
  }

  if (rows.length > 0) markTightPairs(ctx, date, cardEls, talkEls); // §14 1a:转场紧 → 问题卡淡底色提示

  if (rows.length === 0) {
    // 区分「当天本来就没排片」与「被影厅筛选藏空了」—— 后者是用户自己筛的,得给出退出路径
    min.appendChild(
      el(
        "div",
        "py-[26px] px-3 text-center text-muted",
        allRows.length > 0
          ? "当前影厅筛选下,当日所有影厅都被隐藏 —— 改筛选或点「全部」恢复"
          : "当日暂无排片"
      )
    );
  }

  scroll.appendChild(min);
  attachPan(scroll); // D3:按住鼠标左右拖 = 平移时间轴(滚动条同时可用;容器无横向溢出时守卫自动跳过)
  return scroll;
}

/** 标尺刻度区:整点标签(A1 加粗表格数字、可点=时间筛选)+ 整点 +6px 短刻度线 + 「现在」线/角标。
 *  A3:首根整点标签左锚定(不居中,左半永不越界);末 tick 之后容器留有 TRAIL_PAD 右侧安全边距。
 *  缩放:整点间距随刻度拉开 → 放大后补半点 / 刻钟标签(标尺行同时加高一行),否则 3.0× 时一屏只剩一个标签。 */
function buildRulerTicks(
  ctx: GridCtx,
  axis: { start: number; end: number },
  pxPerMin: number,
  trackW: number,
  nowPx: number | null
): HTMLElement {
  const hourPx = 60 * pxPerMin;
  // 细刻度步长:≥240px/小时 → 半点;≥480px/小时 → 刻钟。0 = 不补(100% 及以下,原样)
  const subStep = hourPx >= 480 ? 15 : hourPx >= 240 ? 30 : 0;
  const ticks = el("div", `relative ${subStep ? "min-h-[44px]" : "min-h-[28px]"}`);
  ticks.style.width = `${trackW + TRAIL_PAD}px`;
  const h0 = axis.start / 60;
  const h1 = axis.end / 60;
  // 跨午夜(轴越过 24:00):在 24:00 处画一条虚线日期分隔线,提示右侧刻度属次日
  if (axis.end > 24 * 60) {
    const dayLine = el("span", "absolute top-0 bottom-0 w-px bg-ink/40 pointer-events-none");
    dayLine.style.left = `${(24 * 60 - axis.start) * pxPerMin - 0.5}px`;
    dayLine.dataset.tip = "跨午夜分界 —— 右侧为次日凌晨";
    ticks.appendChild(dayLine);
  }
  // 细刻度标签(半点 / 刻钟):贴标尺下沿、比整点小一档灰一档;整点位置由主标签占据,故跳过整点
  if (subStep) {
    const subCls = "absolute bottom-[7px] -translate-x-1/2 pointer-events-none tabular-nums text-10 text-muted";
    for (let m = axis.start + subStep; m < axis.end; m += subStep) {
      if (m % 60 === 0) continue;
      const sub = el("span", subCls, fmtEndClock(m));
      sub.style.left = `${(m - axis.start) * pxPerMin}px`;
      ticks.appendChild(sub);
    }
  }
  for (let h = h0; h <= h1; h++) {
    const x = (h * 60 - axis.start) * pxPerMin;
    const isFirst = h === h0; // A3:首根左锚定,不 -translate-x-1/2
    const on = ctx.hourFilter === h;
    // 24+ 时制:整点标签取模 24(24:00 → "00:00"),h ≥ 24 一律加「次日」前缀
    const label = fmtEndClock(h * 60);
    const nextLabel = fmtEndClock((h + 1) * 60);
    const b = el(
      "button",
      "absolute top-[1px] border-0 bg-transparent px-[5px] py-[1px] tabular-nums text-11 font-bold rounded-4 transition-colors cursor-pointer " +
        (isFirst ? "left-0 text-left" : "-translate-x-1/2 ") +
        // hover 底用 bg-card(白药丸)而非 bg-hover(#fafafa)—— 画布已是浅灰底,再 hover 成更浅色等于没反馈
        (on ? "bg-biff text-on-brand" : "text-ink-2 hover:bg-card hover:text-biff-ink"),
      label
    );
    b.style.left = `${x}px`;
    b.dataset.hour = String(h);
    b.dataset.tip = `只看 ${label}–${nextLabel} 段场次;再点取消`;
    ticks.appendChild(b);
    // A1:整点刻度 +6px 短线(与场馆行内整点竖线同 x,视觉上标尺与行内刻度相连)
    const tickLine = el("span", "absolute bottom-0 w-px h-[6px] bg-ink/25 pointer-events-none");
    tickLine.style.left = `${x - 0.5}px`;
    ticks.appendChild(tickLine);
  }
  // A5「现在」时刻竖线 + 角标:仅当天且当前时刻落在当日轴内时画(主线程跨分钟定时器触发重画推进)
  if (nowPx !== null) {
    const nowMark = el("span", "absolute top-0 bottom-0 w-[1.5px] now-line pointer-events-none z-[5]");
    nowMark.style.left = `${nowPx - 0.75}px`;
    ticks.appendChild(nowMark);
    const d = new Date();
    const nowTag = el(
      "span",
      "absolute top-[1px] -translate-x-1/2 z-[6] pointer-events-none text-9 font-extrabold text-on-brand bg-biff leading-[1.3] px-[4px] py-px rounded-3 whitespace-nowrap shadow-[0_0_0_1px_var(--color-card)]",
      `现在 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    );
    nowTag.style.left = `${nowPx}px`;
    ticks.appendChild(nowTag);
  }
  return ticks;
}

/* ---------------- 时间轴鼠标拖动平移 ---------------- */
/** 位移超过该 px 判定为拖动(否则视为点击,交给委托点选) */
const PAN_DRAG_PX = 5;

/**
 * 鼠标拖拽平移:pointerdown 记录起点;move/up 临时挂到 document(不用 setPointerCapture,
 * 否则 pointerup 会被重定向到容器,浏览器合成的 click 落在公共祖先,破坏卡片点选委托)。
 * 拖动中 @utility panning 置 grabbing 光标并禁用子元素 pointer-events(hover 联动不再闪烁)。
 * 触摸/触控板走原生 overflow 滚动,不接管。
 *
 * ⚠ 「拖完吞掉随之而来的 click」的监听器**挂在 down、由 click 自己摘**(2026-09-11 改):
 *    旧版是**模块级常驻** `document.addEventListener("click", …, true)` + 一个全局 `panSuppress` 标志,
 *    两个问题:① 模块一被 import 就注册监听(加载期副作用,导致本文件在 node 环境无法单测);
 *    ② 标志只在「下一次 click」里复位 —— 若拖动以 pointercancel 收场(没有后续 click),
 *       它会残留成 true,**吞掉下一次无关点击**。
 *    现在:`moved` 就是唯一判据,由 click 自己消费并复位;pointercancel / 未拖动时立即摘除。
 */
function attachPan(scroll: HTMLElement): void {
  let pid = -1;
  let startX = 0;
  let startLeft = 0;
  let moved = false;

  /** 拖动过 → 吞掉这一次 click(避免误触发卡片点选 / ⓘ 弹层);没拖动 → 放行 */
  const swallowClick = (ev: MouseEvent): void => {
    document.removeEventListener("click", swallowClick, true);
    const dragged = moved;
    moved = false; // 只吞一次(拖动结束后紧随的那一次)
    if (!dragged) return;
    ev.stopPropagation();
    ev.preventDefault();
  };

  const down = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    if (scroll.scrollWidth <= scroll.clientWidth + 1) return; // D1:超宽屏装得下 → 无需平移,不接管(避免拖动吞点击)
    pid = e.pointerId;
    startX = e.clientX;
    startLeft = scroll.scrollLeft;
    moved = false;
    // click 一定在 pointerup 之后派发 → 必须在 down 就挂上,否则吞不到拖动结束的那一次
    document.addEventListener("click", swallowClick, true);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
  };

  const move = (e: PointerEvent) => {
    if (e.pointerId !== pid) return;
    const dx = e.clientX - startX;
    if (!moved && Math.abs(dx) > PAN_DRAG_PX) {
      moved = true;
      scroll.classList.add("panning");
    }
    if (moved) scroll.scrollLeft = startLeft - dx;
  };

  const up = (e: PointerEvent) => {
    if (e.pointerId !== pid) return;
    pid = -1;
    scroll.classList.remove("panning");
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", up);
    // ⚠ **不要**在这里复位 moved:紧随其后的 click 还要靠它判定「这次是拖动,不是点选」。
    // 只在「确定不会有 click 来消费」时立刻摘掉(pointercancel / 根本没拖动)。
    if (e.type === "pointercancel" || !moved) {
      moved = false;
      document.removeEventListener("click", swallowClick, true);
    }
  };

  scroll.addEventListener("pointerdown", down);
}

/** §14 1a:当前方案同日相邻场次,余量 slack=间隔−跨馆缓冲 <OK_SLACK 时,把「衔接的两场」整卡淡黄底标出 ——
 *  时间紧张(不足=扣除缓冲后为负 / 偏紧=0≤余量<15)同一黄色系;红只保留给「完全冲突」(时间重叠,
 *  由冲突视觉独立覆盖,此函数跳过)。通过 card.style.background 内联覆盖 in-plan 绿底(黄 > 绿)。
 *  整卡面积提示 → 不遮文字、不受间隔宽窄与同馆/跨馆影响;hover 卡片即时浮窗看完整算式(data-tip)。
 *  中间片同时接两对紧转场时取更严重状态(不足 盖 偏紧,浮窗文案区分),浮窗列出其参与的所有衔接。 */
const TIGHT_BG = "color-mix(in srgb, var(--color-tight) 24%, var(--color-card))";

interface TightMark {
  bad: boolean; // 是否已到"缓冲后不足"(bad 覆盖 tight)
  notes: string[]; // 参与衔接的说明行(hover 浮窗)
}

function markTightPairs(
  ctx: GridCtx,
  date: string,
  cardEls: Map<string, HTMLElement>,
  talkEls?: Map<string, HTMLElement>
): void {
  const picks: Screening[] = [];
  for (const code of ctx.slots.keys()) {
    const s = ctx.cat.byCode.get(code);
    if (s && s.date === date) picks.push(s);
  }
  picks.sort((a, b) => hmsToMin(a.start_time) - hmsToMin(b.start_time));

  const marks = new Map<string, TightMark>();
  for (let i = 0; i + 1 < picks.length; i++) {
    const a = picks[i];
    const b = picks[i + 1];
    if (ctx.conflictCodes?.has(a.code) || ctx.conflictCodes?.has(b.code)) continue; // 冲突已由 conf 视觉覆盖
    // GV 放弃映后谈 → 该场按正片末算有效结束,紧转场随之放宽
    const aTalkOn = ctx.gvTalkOf?.(a.code) ?? true;
    const endA = effEndMin(a, aTalkOn);
    const startB = hmsToMin(b.start_time);
    const { gap, need, slack, verdict } = slackBetween(endA, startB, a.venue_id === b.venue_id, ctx.transitMin);
    if (gap <= 0) continue; // 防御:重叠必已在冲突组
    if (verdict === "ok") continue;

    const bad = verdict === "bad";
    const endATxt = fmtEndClock(endA);
    // 「已弃映后」= 有谈段且本场选了放弃 —— **不能**拿 endA 与官方 end_time 裸比:
    // 映后时长可配置,配置值 ≠ 官方槽位余量时会把「参加」误判成「已弃」(见 gv.ts 文件头)
    const endADropped = gvTalkMin(a) > 0 && !aTalkOn;
    const note = `${a.code} ${endATxt}结束${endADropped ? "(已弃映后)" : ""} → ${b.code} ${b.start_time}开始 · 间隔 ${gap}min${
      need ? ` · 跨馆需缓冲 ${need}min` : ""
    } · 余量 ${slack}min(${bad ? "不足" : "偏紧"})`;
    for (const code of [a.code, b.code]) {
      const m = marks.get(code);
      if (!m) marks.set(code, { bad, notes: [note] });
      else {
        m.bad = m.bad || bad;
        m.notes.push(note);
      }
    }
  }

  for (const [code, m] of marks) {
    const card = cardEls.get(code);
    if (!card) continue;
    // 黄盖绿(时间紧张的已选卡整卡淡黄底,不叠优先级色 — 网格不再按优先级染色):
    // in-plan 的 !important 绿底须用同等级 inline !important 才能压过 → setProperty(..., "important")
    card.style.setProperty("background", TIGHT_BG, "important");
    card.dataset.tip =
      (m.bad ? "时间紧张 · 转场不足(缓冲后赶不上)" : "时间紧张 · 衔接偏紧(余量 <15min)") +
      "\n" +
      m.notes.join("\n");
    // GV 映后谈块:仍在参加谈后(有效结束=槽位末)才镜像同款紧张底色,保证"两张一起选中"的整体感
    const talkEl = talkEls?.get(code);
    if (talkEl && (ctx.gvTalkOf?.(code) ?? true)) {
      talkEl.style.setProperty("background", TIGHT_BG, "important");
      talkEl.dataset.tip = card.dataset.tip;
    }
  }
}

/** GV 映后谈块上的两行小字时间区(谈段区间,如 15:45–16:10);块窄,字号再降一级。
 *  跨午夜时两端都折回 24h 内并带「次日」标记(如「次日 01:30–次日 02:00」)。 */
function talkTimeRange(s: Screening): string {
  return fmtMinRangeMin(filmEndMin(s), filmEndMin(s) + gvTalkMin(s));
}

/** 卡片内文本随行高等比缩小(基准 px × fontScale)。
 *  行高**一并显式写**:`body` 的 `line-height: 1.45`(style.css)是无单位数,本来就会按元素自身
 *  font-size 重算,所以这一步在基准情形下与继承结果逐字相同 —— 显式写是「自证」:卡片内每一行的
 *  行盒高度只由本函数的两个入参决定,不受父级 font-size / 未来改全局行高影响。
 *  `lineHeight` 可覆写:映后谈块那两行自带 `leading-[1.2]/[1.3]`,要原样传进去(否则会被 1.45 顶掉)。
 *  ⚠ 一律内联:Tailwind v4 拼不出 `text-[${n}px]` 这种动态字面量(与 ROW_BASE_CLS 同一条坑)。
 *  fontScale = 1(100% 档)时直接 return —— 保持类名基准,基准外观零变化。 */
function scaleText(node: HTMLElement, basePx: number, scale: number, lineHeight = "1.45"): void {
  if (Math.abs(scale - 1) < 1e-3) return;
  node.style.fontSize = `${+(basePx * scale).toFixed(2)}px`;
  node.style.lineHeight = lineHeight;
}

/* ---------------- 卡片状态模型(全量构建 / 就地复用 共用) ----------------
 * 2026-09-11(PLAN-20260911004000):网格改为「几何不变则就地 patch」——
 * 点选 / 改档位 / 冲突 / 紧转场 / 时间筛选都只重刷状态,不再重建整棵 DOM。
 * 为此把原先内联在 `appendCard` 里的状态判定抽成**纯描述符** `cardStateOf()`:
 *   · 两条路径(构建 / patch)读同一份描述符 → 不可能漂移;
 *   · 描述符不碰 DOM → 可在 node 环境单测(见 tests/grid-state.test.ts)。
 * ⚠ **几何不在描述符里**:位置 / 宽高 / 字号只在构建期算一次,复用路径不碰它们
 *   (几何变了就必须全量重建,见 `gridGeometryKey()`)。 */

/** 卡片基底类(几何与文字以外的一切;复用路径**不重置**它) */
const CARD_BASE_CLS =
  "group absolute bg-card rounded-5 px-[7px] pb-1 pt-[5px] overflow-hidden cursor-pointer " +
  "flex flex-col gap-px transition-[box-shadow,border-color] duration-[120ms] ease-in-out " +
  "hover:shadow-[var(--shadow-hover)] hover:z-[2]";

/** 谈块基底类 */
const TALK_BASE_CLS =
  "absolute overflow-hidden cursor-pointer select-none flex flex-col items-center justify-center gap-[1px] rounded-5";

/** ⓘ 按钮的恒定部分 */
const INFO_BASE_CLS =
  "absolute top-[3px] right-[3px] border-0 bg-transparent text-muted text-11 py-px px-[3px] rounded-4 " +
  "hover:text-biff-ink hover:bg-[var(--biff-red-tint-3)]";
/** ⓘ 的可见性变体:常态隐藏,hover / focus 时显现 */
const INFO_HOVER_CLS =
  "opacity-0 transition-opacity duration-100 group-hover:opacity-[0.85] group-focus-within:opacity-[0.85]";

/** 状态类「词表」—— patch 时按词表**差分**切换,而不是整串赋 className。
 *  ⚠ 整串赋 className 会连瞬态类一起抹掉:`hl-card` / `hl-row`(hover 联动)、
 *    `flash-locate`(定位闪烁 3s)、`panning`(拖拽中)。那三类由别处加、别处摘。 */
const CARD_STATE_VOCAB = [
  "border",
  "border-line",
  "hover:border-line-strong",
  "border-2",
  "border-conf",
  "in-conf",
  "in-plan",
] as const;
const TALK_STATE_VOCAB = [
  "border",
  "border-line",
  "border-2",
  "border-conf",
  "border-dashed",
  "in-conf",
  "in-plan",
  "gv-talk-off",
] as const;
/** 文字色调词表(身份行 CODE / 时间、片名、谈块两行共用) */
const TONE_VOCAB = ["text-muted", "text-ink", "text-ink-2", "text-conf"] as const;

/** 按词表切换一组状态类(先全摘、再全加;不在词表里的类原样保留)。
 *  ⚠ 词表条目与 `wanted` **都允许是多类字符串**,内部按空白拆成 token 再交给 classList ——
 *    `classList.remove("a b")` 会抛 `InvalidCharacterError`(踩过:ⓘ 的可见性变体是两段多类字符串,
 *    一旦抛出,整个微任务广播中断 → 网格状态静默不更新)。 */
function setVocab(node: HTMLElement, vocab: readonly string[], wanted: string): void {
  for (const group of vocab) for (const c of group.split(" ")) if (c) node.classList.remove(c);
  for (const c of wanted.split(" ")) if (c) node.classList.add(c);
}

/** GV 谈块的状态描述符 */
export interface TalkState {
  /** 是否参加映后谈 */
  on: boolean;
  /** 谈块状态类 */
  stateCls: string;
  /** 主标签文案(参加且在行程中 → 带 ✓) */
  label: string;
  /** 谈段区间文案 */
  range: string;
  /** 是否被时间筛选淡化 */
  dim: boolean;
  /** hover 说明 */
  tip: string;
}

/** 网格卡的状态描述符(**不含几何**) */
export interface CardState {
  /** 待选(未选且不冲突)—— 文字降一档灰阶 */
  isIdle: boolean;
  isConflict: boolean;
  /** 已选(绿底) */
  inCurrent: boolean;
  /** 整卡状态类(按 CARD_STATE_VOCAB 组合) */
  stateCls: string;
  /** 时间筛选:该场不在所选小时段内 → 淡化 */
  dim: boolean;
  /** 冲突角标(与 isConflict 同源,单独列出便于 patch 直接 toggle) */
  warn: boolean;
  /** 冲突卡的 hover 说明(列出每一个冲突对方;undefined = 不冲突) */
  conflictTip: string | undefined;
  /** GV 谈块(undefined = 该场无谈段,不建块也不 patch) */
  talk: TalkState | undefined;
}

/** 冲突卡的 hover 说明:逐个列出与之时间重叠的场次(CODE + 片名 + 时段 + 影厅)。
 *  这是「两张冲突卡隔着几十行、高亮也照不到对方」时最直接的信息兜底 —— 不用滚到对面就知道撞的是谁。 */
function conflictTipOf(s: Screening, ctx: GridCtx, isConflict: boolean): string | undefined {
  if (!isConflict || !ctx.conflictPairs?.length) return undefined;
  const others = ctx.conflictPairs
    .filter(([a, b]) => a === s.code || b === s.code)
    .map(([a, b]) => (a === s.code ? b : a));
  if (others.length === 0) return undefined;
  const lines = others.map((c) => {
    const o = ctx.cat.byCode.get(c);
    if (!o) return c;
    const title = displayTitle(o, ctx.mappingOf(c)?.title_cn);
    const v = ctx.cat.venueById.get(o.venue_id);
    const vTxt = v ? v.code ?? v.id.toUpperCase() : o.venue_display;
    return `${c}《${title}》${o.start_time.slice(0, 5)}–${o.end_time.slice(0, 5)} · ${vTxt}`;
  });
  return ["时间重叠 — 与下列场次无法同时观看", ...lines].join("\n");
}

/** 计算某场次在网格上的**全部状态**(纯函数:只读 ctx,不碰 DOM、不改入参)。
 *  这是网格卡状态的唯一真源 —— 构建路径与 patch 路径都必须走它。 */
export function cardStateOf(s: Screening, ctx: GridCtx): CardState {
  const start = hmsToMin(s.start_time);
  const end = hmsToMin(s.end_time);
  const talk = gvTalkMin(s);
  const talkOn = (ctx.gvTalkOf?.(s.code) ?? true) && talk > 0;
  const slot = ctx.slots.get(s.code);
  const isConflict = Boolean(ctx.conflictCodes?.has(s.code));
  const inCurrent = Boolean(slot);
  // 待选(未选且不冲突):画布灰底上的白卡 —— 极淡边框 + 中灰文字,视为「待激活容器」;
  // hover 时描边加深(叠既有 shadow-hover 投影 + hl-card 红晕),文字不恢复墨色(激活靠点选后的整卡底色)。
  const isIdle = !isConflict && !inCurrent;
  // 淡化:时间筛选(非选中小时段)+ 字幕/影厅/GV 三道筛选不通过者 —— 两条来源共用一个 dim,
  // 因为对用户而言它们是同一件事:「这场现在不在我的视野里」。
  const hourDim = ctx.hourFilter != null && !(start < (ctx.hourFilter + 1) * 60 && end > ctx.hourFilter * 60);
  const dim = hourDim || (ctx.filters ? !matchesFilters(s, ctx.filters) : false);

  let stateCls: string;
  if (isConflict) {
    // 完全冲突(时间重叠,无法同看):红底 in-conf + 2px 红框,红标题 + ⚠;与绿/黄同一整卡底色语法
    stateCls = "border-2 border-conf in-conf";
  } else {
    stateCls = isIdle ? "border border-line hover:border-line-strong" : "border border-line";
    if (inCurrent) stateCls += " in-plan"; // 已选 = 绿底(优先级不参与网格染色 — 见行程行 seg)
  }

  let talkState: TalkState | undefined;
  if (talk > 0) {
    // 状态外观:冲突沿用红(整场都在冲突区);已选且参加 → 同 in-plan 绿 = 两张一起选中;
    // 放弃映后谈 → gv-talk-off 灰虚线淡出(块仍占槽位,只表示"我不参加")
    let cls: string;
    if (isConflict) cls = "border-2 border-conf in-conf";
    else if (inCurrent && talkOn) cls = "border border-line in-plan";
    else if (!talkOn) cls = "border border-dashed border-line gv-talk-off";
    else cls = "border border-line";
    talkState = {
      on: talkOn,
      stateCls: cls,
      label: talkOn && inCurrent ? `✓ 映后 ${talk}′` : `映后 ${talk}′`,
      range: talkTimeRange(s),
      dim,
      tip: talkTip(s, talk, talkOn, inCurrent),
    };
  }

  return {
    isIdle,
    isConflict,
    inCurrent,
    stateCls,
    dim,
    warn: isConflict,
    conflictTip: conflictTipOf(s, ctx, isConflict),
    talk: talkState,
  };
}

/** 把状态描述符落到**已存在**的卡片 DOM 上(几何 / 文字内容不动) */
function applyCardState(card: HTMLElement, st: CardState): void {
  setVocab(card, CARD_STATE_VOCAB, st.stateCls);
  card.classList.toggle("hour-dim", st.dim);
  const codeB = card.querySelector<HTMLElement>('[data-card-code="1"]');
  const timeSpan = card.querySelector<HTMLElement>(".card-time");
  const ttl = card.querySelector<HTMLElement>('[data-card-title="1"]');
  const warn = card.querySelector<HTMLElement>('[data-warn="1"]');
  if (codeB) setVocab(codeB, TONE_VOCAB, st.isIdle ? "text-muted" : "text-ink");
  if (timeSpan) setVocab(timeSpan, TONE_VOCAB, st.isIdle ? "text-ink-2" : "text-ink");
  if (ttl) setVocab(ttl, TONE_VOCAB, st.isConflict ? "text-conf" : st.isIdle ? "text-ink-2" : "");
  if (warn) warn.classList.toggle("is-hidden", !st.warn);
  // 冲突说明:patch 路径上一步已清空所有卡片的 tip,这里按状态重新挂上(非冲突卡保持无 tip)
  if (st.conflictTip) card.dataset.tip = st.conflictTip;
}

/** 把谈块状态落到**已存在**的谈块 DOM 上(几何 / 斜纹底不动) */
function applyTalkState(talkEl: HTMLElement, st: CardState): void {
  if (!st.talk) return;
  setVocab(talkEl, TALK_STATE_VOCAB, st.talk.stateCls);
  talkEl.classList.toggle("hour-dim", st.talk.dim);
  talkEl.dataset.tip = st.talk.tip;
  const rng = talkEl.querySelector<HTMLElement>('[data-talk-range="1"]');
  if (rng) setVocab(rng, TONE_VOCAB, st.isIdle ? "text-muted" : "text-ink-2");
  const lab = talkEl.querySelector<HTMLElement>('[data-talk-label="1"]');
  if (lab) {
    setVocab(lab, TONE_VOCAB, st.isIdle ? "text-ink-2" : "text-ink");
    lab.classList.toggle("line-through", !st.talk.on);
    lab.classList.toggle("text-muted", !st.talk.on);
    lab.textContent = st.talk.label;
  }
}

function appendCard(
  tracks: HTMLElement,
  s: Screening,
  ctx: GridCtx,
  pxPerMin: number,
  axisStart: number
): { card: HTMLElement; talkEl: HTMLElement | null } {
  const start = hmsToMin(s.start_time);
  const end = hmsToMin(s.end_time);
  const talk = gvTalkMin(s); // GV 映后谈分钟(全局默认 + 单场覆写;0 = 不拆,普通整卡)
  const st = cardStateOf(s, ctx); // 状态唯一真源(与 patchGridStates 共用)
  const { isIdle, isConflict } = st;
  const { rowH, insetY, fontScale, showBadges } = ctx.row; // 纵向行几何(由行高倍率派生)

  const card = el("div", `${CARD_BASE_CLS} ${st.stateCls}`);
  card.dataset.code = s.code;
  card.dataset.card = "1"; // 复用路径的选择器锚点
  // GV 拆分:主卡只画「正片段」(结束=正片末),谈段由右侧紧贴的 talk 块承接 → 视觉两张拼接
  const cardEnd = talk > 0 ? filmEndMin(s) : end;
  card.style.left = `${(start - axisStart) * pxPerMin + 2}px`;
  card.style.top = `${insetY}px`;
  card.style.width = `${(cardEnd - start) * pxPerMin - 4}px`;
  card.style.height = `${rowH - insetY * 2}px`;
  // 内边距随行高等比缩(基准 = 类名里的 pt-[5px] pb-1 px-[7px]);倍率 1 时写入值与之逐字相同 → 基准外观不变
  card.style.paddingTop = `${+(5 * fontScale).toFixed(2)}px`;
  card.style.paddingBottom = `${+(4 * fontScale).toFixed(2)}px`;
  card.style.paddingLeft = `${+(7 * fontScale).toFixed(2)}px`;
  card.style.paddingRight = `${+(7 * fontScale).toFixed(2)}px`;

  // 时间筛选:非选中小时段的场次淡化(hour-dim),保留上下文与 hover 可读(槽位整段含谈判定)
  if (st.dim) card.classList.add("hour-dim");

  // 身份行:CODE + 起止时间(排片核心信息,时间升格加墨;时间 span 独立便于 fitTimeTexts 量测降级,
  // 窄卡放不下完整 "09:00–10:40" 时由挂载后实测降级为只显开始时间,完整时间移入 hover —— 绝不硬裁)。
  // E1:pr-[20px] 把行尾让给右上角标(ⓘ 右 3~18px / ⚠ 右 22px+),角标悬浮于预留空白,不遮挡时间文本。
  const t1 = el("span", "flex items-center gap-[3px] text-12 text-muted whitespace-nowrap overflow-hidden pr-[20px]");
  // 待选卡:CODE / 时间降一档灰阶(text-muted / text-ink-2);已选 / 冲突仍用墨色(text-ink)
  const codeB = el("b", `shrink-0 text-12 ${isIdle ? "text-muted" : "text-ink"}`, s.code);
  codeB.dataset.cardCode = "1";
  codeB.dataset.tip = codeTip(s.code);
  // GV 拆分卡只显「正片段」区间(谈段由右侧拼接块自述);跨午夜两端带「次日」标记
  const cardRange = talk > 0 ? fmtMinRangeMin(start, filmEndMin(s)) : fmtMinRange(s.start_time, s.end_time);
  const timeSpan = el(
    "span",
    `card-time shrink-0 text-12 font-semibold tabular-nums ${isIdle ? "text-ink-2" : "text-ink"}`,
    cardRange
  );
  timeSpan.dataset.full = cardRange;
  timeSpan.dataset.short = s.start_time; // 降级备选:只显开始时刻
  t1.append(codeB, timeSpan);
  // 行尾让给右上角标(ⓘ / ⚠)的预留位也随倍率缩(基准 = 类名里的 pr-[20px]);倍率 1 时不写,保持基准外观
  if (Math.abs(fontScale - 1) >= 1e-3) t1.style.paddingRight = `${+(20 * fontScale).toFixed(2)}px`;
  card.appendChild(t1);
  // 字号随行高等比缩(基准 12px)。容器 t1 是 **flex** 而不是块容器 → 两个子项各自的行盒就是
  // 自身 font-size × 1.45,不存在「父级 strut 撑住行高、矮行里行盒不缩」那个坑,故只缩叶子。
  scaleText(codeB, 12, fontScale);
  scaleText(timeSpan, 12, fontScale);

  // D2 重排:顺序 = 身份行(CODE+时间)→ 片名(英文名 · 中文名)→ 其余片名 / 片长 → 徽章流沉底。
  // 徽章流不再横插在时间与片名之间 —— 宽卡下单行放下,不再 wrap 挤压标题区;
  // mt-auto 把徽章贴到卡底,与标题区形成天然分组。信息零删除,各徽章 data-tip 悬停即示义。
  // ⚠ 片名口径全站统一为「英文名 · 中文名」(见 util.ts::bilingualTitle),卡片窄时 `truncate`
  //   会裁掉尾巴 —— 故整串同时挂 hover 提示,中文名不会真的丢失。
  const title = displayTitle(s, ctx.mappingOf(s.code)?.title_cn);
  const ttlCls = `text-13 font-bold truncate min-w-0${
    isConflict ? " text-conf" : isIdle ? " text-ink-2" : ""
  }`;
  const ttl = el("span", ttlCls, title); // 13px:卡片内最大一号字,缩放基准
  ttl.dataset.cardTitle = "1";
  ttl.dataset.tip = title; // 窄卡 truncate 时 hover 看全片名(英文名 · 中文名)
  scaleText(ttl, 13, fontScale);
  // 次级行:韩文名(官方只印韩文时 title_en 就是韩文名,故要排掉同值)→ 否则片长兜底
  const sub = el(
    "span",
    "text-11 text-muted truncate",
    s.title_kr && s.title_kr !== s.title_en ? s.title_kr : `${s.duration_min}min`
  );
  scaleText(sub, 11, fontScale);
  card.append(ttl, sub);

  // 徽章行:等级 → 字幕 → 特性(GV/首映…) → 页码 → 片长。无任何徽章(理论仅 mock 缺字段)时不创建,避免空行。
  // 缩放与门控两件事都在这里:
  //  ① 缩放走 `zoom`(**布局级**)而不是 font-size —— 章体是 legend.ts 的显式 `text-10`,
  //     父级 font-size **不级联**下去;而 `zoom` 连子元素显式 px 一起缩(章高 17.78px → 90% 档 16.68px)。
  //     不缩的话那枚固定高的章在 83px 行里会把卡片顶破(四行只剩 0.79px 余量)。
  //  ② `rowH < 80`(55 / 70% 两档)整行不画:四行实在装不下,最先舍信息量最低的它 ——
  //     等级 / 字幕 / GV / 页码 / 片长在 ⓘ 弹层与 hover 提示里都还在,不是信息删除。
  if (showBadges && hasBadges(s)) {
    // 徽章行走**模板缓存**(legend.ts::metaRowFor):同一场次只逐枚构造一次,之后 clone
    const bdgRow = metaRowFor(s);
    if (Math.abs(fontScale - 1) >= 1e-3) bdgRow.style.zoom = `${+fontScale.toFixed(3)}`;
    card.appendChild(bdgRow);
  }

  // ⓘ 详情钮:常态 opacity-0,hover / focus 时显现(触屏无 hover,见 CONVENTIONS)
  const infoBtn = el("button", `${INFO_BASE_CLS} ${INFO_HOVER_CLS}`, "ⓘ");
  infoBtn.dataset.info = s.code;
  infoBtn.dataset.tip = "影片资料 / 豆瓣";
  scaleText(infoBtn, 11, fontScale); // 绝对定位、不影响行高,但缩了才与整卡同一比例
  card.appendChild(infoBtn);

  // 冲突角标 = **实心红点**(取代旧 ⚠ 字形 —— 用户明确不要 emoji)。位置与右上角 ⓘ 并列,
  // 直径随行高等比缩(与卡片内其他组件同一缩放口径);颜色与整卡红底 / 红框同族。
  const dot = +(7 * fontScale).toFixed(2);
  const warn = el("span", "absolute right-[22px] top-[3px] rounded-full bg-conf pointer-events-none");
  warn.dataset.warn = "1";
  warn.style.width = `${dot}px`;
  warn.style.height = `${dot}px`;
  warn.classList.toggle("is-hidden", !st.warn);
  card.appendChild(warn);
  if (st.conflictTip) card.dataset.tip = st.conflictTip;

  tracks.appendChild(card);

  // ---- GV 映后谈块(拼接卡右侧;talk=0 不创建)----
  if (talk > 0) {
    const talkSt = st.talk!; // talk > 0 ⇒ 必有谈块状态(cardStateOf 保证)
    const talkEl = el("div", `${TALK_BASE_CLS} ${talkSt.stateCls}`);
    talkEl.dataset.code = s.code; // 双向 hover 联动(与正片卡同高亮);点击经 [data-talk] 分支拦截
    talkEl.dataset.talk = "1";
    // 几何:紧贴正片卡右缘(无间隙拼接),右缘与整场槽位右缘对齐
    const filmW = (filmEndMin(s) - start) * pxPerMin - 4;
    talkEl.style.left = `${(start - axisStart) * pxPerMin + 2 + filmW}px`;
    talkEl.style.top = `${insetY}px`;
    talkEl.style.width = `${talk * pxPerMin}px`;
    talkEl.style.height = `${rowH - insetY * 2}px`;

    // 谈段斜纹底(透明层,不抢父级背景色,优先级染色/紧张底色仍整块生效)
    const hatch = el("span", "absolute inset-0 pointer-events-none rounded-5");
    hatch.style.backgroundImage =
      "repeating-linear-gradient(-45deg, color-mix(in srgb, var(--color-ink) 6%, transparent) 0 5px, transparent 5px 10px)";
    talkEl.appendChild(hatch);

    // 未选中(待选)时谈块与正片卡同一「待激活」灰阶,避免两张拼接卡文字一深一浅
    const rng = el(
      "span",
      `relative text-9 tabular-nums leading-[1.2] whitespace-nowrap ${isIdle ? "text-muted" : "text-ink-2"}`,
      talkSt.range
    );
    rng.dataset.talkRange = "1";
    const lab = el(
      "span",
      `relative text-9 font-bold whitespace-nowrap leading-[1.3] ${isIdle ? "text-ink-2" : "text-ink"}`,
      talkSt.label
    );
    lab.dataset.talkLabel = "1";
    if (!talkSt.on) lab.classList.add("text-muted", "line-through");
    // 谈块两行自带 leading-[1.2] / [1.3] → 原样传给 scaleText(否则会被默认的 1.45 顶掉、块变高)
    scaleText(rng, 8.5, fontScale, "1.2");
    scaleText(lab, 9, fontScale, "1.3");
    talkEl.append(rng, lab);

    talkEl.dataset.tip = talkSt.tip;
    // 时间筛选联动:与正片卡同一套 hour-dim(谈段同样淡化,状态语言一致)
    if (talkSt.dim) talkEl.classList.add("hour-dim");
    tracks.appendChild(talkEl);
    return { card, talkEl };
  }

  return { card, talkEl: null };
}

/** 网格「几何签名」—— 只由**影响卡片位置 / 宽高 / 字号 / 轴界 / 行集合**的输入构成。
 *  相同 ⇒ 结构可整体复用,只需 `patchGridStates()` 重刷状态;
 *  不同 ⇒ 必须 `buildGrid()` 全量重建(换日期 / 缩放 / 改映后时长 / 改影厅筛选)。
 *
 *  ⚠ 为什么用「内容签名」而不是「修订号」:几何输入散落在 Screening(起止 / 片长 / 是否 GV)
 *    与 GV 配置(全局默认 + 逐场覆写)两处 —— 用修订号就得**每处改动都记得 bump**,
 *    漏一次就是「卡片尺寸与数据不一致」的静默错位。内容签名不需要任何人记得。
 *    代价是 O(当日场次数) 的字符串拼装(几百字符),远低于重建数百个 DOM 节点。
 *
 *  ⚠ `venueKey`(见 filters.ts::venueFilterKey)必须进签名:影厅筛选决定**纵轴行集合**,
 *    行数一变就必须重建 —— 少了它,筛选后行已该消失但走 patch 路径 → 界面纹丝不动。
 *    空串 = 无影厅筛选,与旧行为逐字一致。 */
export function gridGeometryKey(
  cat: Catalog,
  date: string,
  pxPerMin: number,
  rowH: number,
  venueKey = ""
): string {
  let acc = `${date}|${pxPerMin.toFixed(4)}|${rowH}|${venueKey}|`;
  for (const s of cat.schedule.screenings) {
    if (s.date !== date) continue;
    // duration_min 决定正片末(GV 拆分卡主卡的宽度),gvTalkMin 决定谈块宽度与轴末 —— 都必须在签名里
    acc += `${s.code}:${s.start_time}:${s.end_time}:${s.duration_min}:${s.is_gv ? gvTalkMin(s) : 0};`;
  }
  return acc;
}

/** 冲突**跨行连线**:把同一冲突组的两张卡用一条红色虚线连起来(落在两卡时间重叠段的中点)。
 *
 *  为什么需要它:甘特图一行 = 一个影厅,29 行一屏根本放不下。冲突的两张卡常常一张在最上面、
 *  一张在最下面 —— 现有的 hover 高亮只能亮「看得见的那一张」,用户不知道对面在哪(原话:
 *  「我选了一个最下方的冲突,这样高亮我也看不到最上面的」)。连线的两端画在两张卡**相邻的那条边**
 *  (上卡的底边 → 下卡的顶边),中间穿过空白行;即使对面在屏幕外,也能顺着线看出「往上/往下还有一张」。
 *
 *  ⚠ 必须在**挂载后**调用:行高 / 卡片位置全部实测(`getBoundingClientRect`),不读任何常量 ——
 *    行高随缩放变、行与行之间还有 1px 分隔线,算出来的坐标迟早会漂。
 *  ⚠ 连线层是 `min` 的**首个子节点**(见 buildGrid):先画 → 落在行 / 卡片**之下**,
 *    只从空白处露出,不会糊在卡片文字上。 */
export function drawConflictLinks(grid: HTMLElement, conflicts: ConflictResult | undefined): void {
  const min = grid.firstElementChild as HTMLElement | null;
  const layer = min?.querySelector<HTMLElement>('[data-conf-links="1"]');
  if (!min || !layer) return;
  layer.replaceChildren();
  if (!conflicts || conflicts.pairs.length === 0) return;

  const box = min.getBoundingClientRect();
  const conf = "var(--color-conf)";
  for (const [a, b] of conflicts.pairs) {
    const ca = grid.querySelector<HTMLElement>(`[data-card="1"][data-code="${a}"]`);
    const cb = grid.querySelector<HTMLElement>(`[data-card="1"][data-code="${b}"]`);
    if (!ca || !cb) continue; // 有一端不在当前视图(理论不会:冲突双方同属当前方案、同一天)
    const ra = ca.getBoundingClientRect();
    const rb = cb.getBoundingClientRect();
    // 纵向:上卡的**底边** → 下卡的**顶边**(与 a/b 谁先谁后无关)
    const [topRect, botRect] = ra.top <= rb.top ? [ra, rb] : [rb, ra];
    const yTop = topRect.bottom - box.top;
    const yBot = botRect.top - box.top;
    if (yBot - yTop < 3) continue; // 同一行(理论不会:同影厅不可能同时开两场)
    // 横向:落在两卡**时间重叠段**的中点;无重叠(防御分支)则退化为两卡中点
    const xL = Math.max(ra.left, rb.left) - box.left;
    const xR = Math.min(ra.right, rb.right) - box.left;
    const x = xR > xL ? (xL + xR) / 2 : ((ra.left + ra.right) / 2 + (rb.left + rb.right) / 2) / 2 - box.left;

    const line = el("span", "absolute pointer-events-none");
    line.style.left = `${x}px`;
    line.style.top = `${yTop}px`;
    line.style.height = `${yBot - yTop}px`;
    line.style.borderLeft = `1.5px dashed ${conf}`;
    line.style.opacity = "0.7";
    layer.appendChild(line);
    // 两端各一枚实心圆点,把「线头」钉在卡缘上(虚线在浅灰底上偏淡,圆点让它一眼可见)
    for (const y of [yTop, yBot]) {
      const cap = el("span", "absolute pointer-events-none rounded-full");
      cap.style.left = `${x - 2.5}px`;
      cap.style.top = `${y - 2.5}px`;
      cap.style.width = "5px";
      cap.style.height = "5px";
      cap.style.background = conf;
      cap.style.opacity = "0.7";
      layer.appendChild(cap);
    }
  }
}

/** 就地重刷整张网格的**状态**(几何不动)。
 *  用于「几何签名未变」的变更:点选 / 移出 / 改档位 / 冲突变化 / 紧转场变化 / 时间筛选 / 方案切换。
 *
 *  ⚠ **必须先清掉上一轮的内联紧张底色**:`markTightPairs` 写的是
 *    `style.setProperty("background", …, "important")`,不清不会自己消失 ——
 *    漏了这步,「不再紧张」的卡会残留黄底(经典 diff bug,且不报错、不报类型错)。
 *  同理它覆写的 `dataset.tip`(完整算式)也要先删,否则旧算式会继续挂在卡上。 */
export function patchGridStates(grid: HTMLElement, ctx: GridCtx, date: string): void {
  const cards = grid.querySelectorAll<HTMLElement>('[data-card="1"]');
  const talkByCode = new Map<string, HTMLElement>();
  for (const t of grid.querySelectorAll<HTMLElement>('[data-talk="1"]')) {
    const c = t.dataset.code;
    if (c) talkByCode.set(c, t);
  }

  // 1) 清上一轮紧张标记(内联底色 + 覆写的 tip)
  for (const card of cards) {
    card.style.removeProperty("background");
    delete card.dataset.tip;
  }

  // 2) 逐卡重算状态并落地;谈块同轮处理(状态只算一次)
  const cardEls = new Map<string, HTMLElement>();
  const talkEls = new Map<string, HTMLElement>();
  for (const card of cards) {
    const code = card.dataset.code;
    const s = code ? ctx.cat.byCode.get(code) : undefined;
    if (!code || !s) continue;
    const st = cardStateOf(s, ctx);
    applyCardState(card, st);
    cardEls.set(code, card);
    const talkEl = talkByCode.get(code);
    if (talkEl && st.talk) {
      talkEl.style.removeProperty("background");
      applyTalkState(talkEl, st);
      talkEls.set(code, talkEl);
    }
  }

  // 3) 紧转场重标(内部写内联底色 + tip)
  markTightPairs(ctx, date, cardEls, talkEls);
}

/** 映后谈块 hover 说明(按当前状态切换文案;第 1 行标题 = 谈段区间,其余分点) */
function talkTip(s: Screening, talk: number, talkOn: boolean, inCurrent: boolean): string {
  const endMin = filmEndMin(s) + talk; // 谈段末 = 正片末 + 配置时长(时长可全局改 / 逐场覆写)
  const filmEnd = fmtEndClock(filmEndMin(s));
  const range = `${fmtMinRangeMin(filmEndMin(s), endMin)} 映后谈 ${talk}min(GV 嘉宾到场)`;
  const howTo = "映后时长可在设置里改默认值,或在行程行点映后胶囊的数字逐场覆写";
  if (!inCurrent)
    return [
      range,
      "你还没加入本场 — 点正片 = 连映后谈一起加入",
      `点这里 = 只看正片(放弃映后谈,该场按 ${filmEnd} 结束,转场 / 冲突即时放宽)`,
      howTo,
    ].join("\n");
  return talkOn
    ? [
        range,
        "已在行程中 — 默认连映后谈一起选",
        `点这里放弃 → 该场按 ${filmEnd} 结束,后续转场按正片末算`,
        howTo,
      ].join("\n")
    : [
        range,
        `已放弃 — 仅正片,${filmEnd} 结束`,
        `点这里恢复参加 → 按 ${fmtEndClock(endMin)} 结束`,
        howTo,
      ].join("\n");
}

/**
 * 卡片时间防截断:网格已挂载到 DOM 后调用(此时可同步量 t1.scrollWidth)。
 * 完整 "09:00–10:40" 放不下 → 降级为只显开始时间 "09:00";仍放不下 → 时间文本藏起,
 * 完整区间放入 data-tip(hover 即时可见)——绝不出现 "00:0…" 这类被裁断的中间态。
 */
export function fitTimeTexts(host: HTMLElement): void {
  host.querySelectorAll<HTMLElement>(".card-time").forEach((span) => {
    const row = span.parentElement as HTMLElement | null;
    if (!row) return;
    const full = span.dataset.full ?? "";
    const short = span.dataset.short ?? "";
    const show = (t: string): void => {
      span.textContent = t;
      span.dataset.tip = full; // 完整时间永远可 hover 查看
    };
    show(full);
    if (row.scrollWidth <= row.clientWidth + 1) return; // 完整放得下
    show(short);
    if (row.scrollWidth <= row.clientWidth + 1) return; // 开始时间放得下
    show(""); // 极端窄:藏时间,CODE 与 hover 兜底
  });
}