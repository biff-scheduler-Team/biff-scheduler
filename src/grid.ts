// 选片网格 — 自研 CSS 网格:行=影厅,列=当日时间轴;卡片绝对定位。
// 全量化:网格 / 卡片 / 标签 / 时间标尺 / 转场紧底色提示 / ⓘ / 冲突旗 / 其他旗 全部 Tailwind utility。

import type { Catalog, Group, Mapping, Priority, Screening } from "./types";
import { OK_SLACK, el, fmtEndClock, fmtMinRange, fmtMinRangeMin, hmsToMin, todayIsoLocal } from "./util";
import { screeningsByVenue } from "./data";
import { codeTip, screeningBadgeKeys } from "./badges";
import { effEndMin, filmEndMin, gvTalkMin } from "./gv";
import { appendMetaRow, durChip, venueTip } from "./legend";
import { PRI_DOT_BG, PRI_LABEL } from "./pick";

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
 * 徽章行**整行按 `zoom` 等比缩**(见 appendCard):章体是 legend.ts 的显式 `text-[9.5px]`,父级
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
  /** 已选场次投影:code → { 影片 key, 方案 }。判「已选 / 在哪个方案」全走它(唯一数据源) */
  slots: Map<string, { key: string; group: Group }>;
  group: Group;
  mappingOf: (code: string) => Mapping | undefined; // 豆瓣映射(回填中文名)
  conflictCodes: Set<string> | undefined; // 当日、当前方案冲突 code
  transitMin: number; // 跨馆转场缓冲(1a 余量判定)
  /** GV 映后谈是否参加(全局默认 + 单场覆写解析后):决定正片/整场拆分、紧转场按哪段结束算 */
  gvTalkOf: (code: string) => boolean;
  /** 该片档位(必看/备选/随缘):undefined = 未打标 —— 与红绿灯底色正交,只画标题行前的档位色点 */
  wishOf?: (s: Screening) => Priority | undefined;
  hourFilter?: number | null; // 点击时间轴整点 → 只看该小时段场次(其余 hour-dim);null = 不过滤
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

function titleFor(s: Screening, map: Mapping | undefined): string {
  return s.title_zh || map?.title_cn || s.title_en;
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
  const rows = screeningsByVenue(ctx.cat, date);
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
  // 画布底板:极浅灰(bg-page)+ 内嵌圆角 —— 外层白面板(#grid-wrap)成为「画框」,
  // 未选中的白卡落在灰底上才有轮廓(旧版画布无底色 → 透出面板白,与卡片「白底叠白底」)。
  const scroll = el("div", "overflow-x-auto pb-[6px] cursor-grab bg-page rounded-[8px]");
  const min = el("div", "w-max min-w-full");
  min.style.width = `${totalW}px`;

  // 时间标尺(ruler):底部强描边与场馆行分隔。粘性列空占位(动态轴首根整点标签左锚定画在轨道内,
  // 替代旧「9:00 放粘性列」的写法 —— 轴界不再固定 9 点,只有当日首场那一格需要贴左)。
  const ruler = el("div", `${ROW_BASE_CLS} border-b border-line`);
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
      "not-italic font-extrabold text-biff bg-biff-soft border border-biff-line rounded-[3px] text-center whitespace-nowrap",
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
    min.appendChild(el("div", "py-[26px] px-3 text-center text-muted", "当日暂无排片"));
  }

  scroll.appendChild(min);
  attachPan(scroll); // D3:按住鼠标左右拖 = 平移时间轴(滚动条同时可用;容器无横向溢出时守卫自动跳过)
  return scroll;
}

/** 分钟 → 标尺标签。**24+ 时制**:h ≥ 24 加「次日」前缀,小时折回 24h 内显示(1440 → "次日 00:00")。
 *  整点标签与缩放后补的半点/刻钟标签共用它 —— 一处口径,跨午夜轴不会两种写法。 */
function clockLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h >= 24 ? "次日 " : ""}${String(h % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
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
    const subCls = "absolute bottom-[7px] -translate-x-1/2 pointer-events-none tabular-nums text-[9.5px] text-muted";
    for (let m = axis.start + subStep; m < axis.end; m += subStep) {
      if (m % 60 === 0) continue;
      const sub = el("span", subCls, clockLabel(m));
      sub.style.left = `${(m - axis.start) * pxPerMin}px`;
      ticks.appendChild(sub);
    }
  }
  for (let h = h0; h <= h1; h++) {
    const x = (h * 60 - axis.start) * pxPerMin;
    const isFirst = h === h0; // A3:首根左锚定,不 -translate-x-1/2
    const on = ctx.hourFilter === h;
    // 24+ 时制:整点标签取模 24(24:00 → "00:00"),h ≥ 24 一律加「次日」前缀
    const label = clockLabel(h * 60);
    const nextLabel = clockLabel((h + 1) * 60);
    const b = el(
      "button",
      "absolute top-[1px] border-0 bg-transparent px-[5px] py-[1px] tabular-nums text-[10.5px] font-bold rounded-[4px] transition-colors cursor-pointer " +
        (isFirst ? "left-0 text-left" : "-translate-x-1/2 ") +
        // hover 底用 bg-card(白药丸)而非 bg-hover(#fafafa)—— 画布已是浅灰底,再 hover 成更浅色等于没反馈
        (on ? "bg-biff text-on-brand" : "text-ink-2 hover:bg-card hover:text-biff"),
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
      "absolute top-[1px] -translate-x-1/2 z-[6] pointer-events-none text-[9px] font-extrabold text-on-brand bg-biff leading-[1.3] px-[4px] py-px rounded-[3px] whitespace-nowrap shadow-[0_0_0_1px_var(--color-card)]",
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

/** 拖完吞掉随之而来的 click,避免误触发卡片点选 / ⓘ 弹层等(位移 < 阈值时放行)。 */
let panSuppress = false;
document.addEventListener(
  "click",
  (ev: MouseEvent) => {
    if (!panSuppress) return;
    panSuppress = false;
    ev.stopPropagation();
    ev.preventDefault();
  },
  true
);

/**
 * 鼠标拖拽平移:pointerdown 记录起点;move/up 临时挂到 document(不用 setPointerCapture,
 * 否则 pointerup 会被重定向到容器,浏览器合成的 click 落在公共祖先,破坏卡片点选委托)。
 * 拖动中 @utility panning 置 grabbing 光标并禁用子元素 pointer-events(hover 联动不再闪烁)。
 * 触摸/触控板走原生 overflow 滚动,不接管。
 */
function attachPan(scroll: HTMLElement): void {
  let pid = -1;
  let startX = 0;
  let startLeft = 0;
  let moved = false;

  const down = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    if (scroll.scrollWidth <= scroll.clientWidth + 1) return; // D1:超宽屏装得下 → 无需平移,不接管(避免拖动吞点击)
    pid = e.pointerId;
    startX = e.clientX;
    startLeft = scroll.scrollLeft;
    moved = false;
    panSuppress = false;
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
  };

  const move = (e: PointerEvent) => {
    if (e.pointerId !== pid) return;
    const dx = e.clientX - startX;
    if (!moved && Math.abs(dx) > PAN_DRAG_PX) {
      moved = true;
      panSuppress = true;
      scroll.classList.add("panning");
    }
    if (moved) scroll.scrollLeft = startLeft - dx;
  };

  const up = (e: PointerEvent) => {
    if (e.pointerId !== pid) return;
    pid = -1;
    moved = false;
    scroll.classList.remove("panning");
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", up);
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
  for (const [code, slot] of ctx.slots) {
    if (slot.group !== ctx.group) continue;
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
    const gap = startB - endA;
    if (gap <= 0) continue; // 防御:重叠必已在冲突组
    const need = a.venue_id !== b.venue_id ? ctx.transitMin : 0;
    const slack = gap - need;
    if (slack >= OK_SLACK) continue;

    const bad = slack < 0;
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

/** 方形元素(档位色点)等比缩 —— 只缩字号不会让它变小,矮行里就成了一枚突兀的大圆点 */
function scaleBox(node: HTMLElement, basePx: number, scale: number): void {
  if (Math.abs(scale - 1) < 1e-3) return;
  const px = `${+(basePx * scale).toFixed(2)}px`;
  node.style.width = px;
  node.style.height = px;
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
  const talkOn = (ctx.gvTalkOf?.(s.code) ?? true) && talk > 0;
  const slot = ctx.slots.get(s.code);
  const isConflict = Boolean(ctx.conflictCodes?.has(s.code));
  const inCurrent = Boolean(slot && slot.group === ctx.group);
  const inOther = Boolean(slot && slot.group !== ctx.group);
  // 待选(未选中且没选在另一方案):画布灰底上的白卡 —— 极淡边框 + 中灰文字,视为「待激活容器」;
  // hover 时描边加深(叠既有 shadow-hover 投影 + hl-card 红晕),文字不恢复墨色(激活靠点选后的整卡底色)。
  const isIdle = !isConflict && !inCurrent && !inOther;
  const { rowH, insetY, fontScale, showBadges } = ctx.row; // 纵向行几何(由行高倍率派生)

  // 基底 + 选中 / 冲突 / 其他方案 等状态组合在构造时一次算完(JS 后续不需 toggle)
  const parts: string[] = ["group"];
  parts.push(
    "absolute bg-card rounded-[5px] px-[7px] pb-1 pt-[5px] overflow-hidden cursor-pointer flex flex-col gap-px transition-[box-shadow,border-color] duration-[120ms] ease-in-out hover:shadow-[var(--shadow-hover)] hover:z-[2]"
  );
  if (isConflict) {
    // 完全冲突(时间重叠,无法同看):红底 in-conf + 2px 红框,红标题 + ⚠;与绿/黄同一整卡底色语法
    parts.push("border-2 border-conf in-conf");
  } else {
    parts.push(isIdle ? "border border-line hover:border-line-strong" : "border border-line");
    if (inCurrent) parts.push("in-plan"); // 已选 = 绿底(优先级不参与网格染色 — 见行程行 seg)
    else if (inOther) parts.push("in-other");
  }

  const card = el("div", parts.join(" "));
  card.dataset.code = s.code;
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
  if (ctx.hourFilter != null) {
    const inHour = start < (ctx.hourFilter + 1) * 60 && end > ctx.hourFilter * 60;
    if (!inHour) card.classList.add("hour-dim");
  }

  // 身份行:CODE + 起止时间(排片核心信息,时间升格加墨;时间 span 独立便于 fitTimeTexts 量测降级,
  // 窄卡放不下完整 "09:00–10:40" 时由挂载后实测降级为只显开始时间,完整时间移入 hover —— 绝不硬裁)。
  // E1:pr-[20px] 把行尾让给右上角标(ⓘ 右 3~18px / ⚠ 右 22px+),角标悬浮于预留空白,不遮挡时间文本。
  const t1 = el("span", "flex items-center gap-[3px] text-[12px] text-muted whitespace-nowrap overflow-hidden pr-[20px]");
  // 待选卡:CODE / 时间降一档灰阶(text-muted / text-ink-2);已选/冲突/另一方案仍用墨色(text-ink)
  const codeB = el("b", `shrink-0 text-[12px] ${isIdle ? "text-muted" : "text-ink"}`, s.code);
  codeB.dataset.tip = codeTip(s.code);
  // GV 拆分卡只显「正片段」区间(谈段由右侧拼接块自述);跨午夜两端带「次日」标记
  const cardRange = talk > 0 ? fmtMinRangeMin(start, filmEndMin(s)) : fmtMinRange(s.start_time, s.end_time);
  const timeSpan = el(
    "span",
    `card-time shrink-0 text-[12px] font-semibold tabular-nums ${isIdle ? "text-ink-2" : "text-ink"}`,
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

  // D2 重排:顺序 = 身份行(CODE+时间)→ 中文片名 → 英文名 → 徽章流沉底。
  // 徽章流不再横插在时间与片名之间 —— 宽卡下单行放下,不再 wrap 挤压标题区;
  // mt-auto 把徽章贴到卡底,与标题区形成天然分组。信息零删除,各徽章 data-tip 悬停即示义。
  const zh = titleFor(s, ctx.mappingOf(s.code));
  const ttlCls = `text-[13px] font-bold truncate flex-1 min-w-0${
    isConflict ? " text-conf" : isIdle ? " text-ink-2" : ""
  }`;
  // 「我的选片」档位色点(7px):标题行最前 —— 与红绿灯整卡底色正交,一眼看出"这是我标的必看/随缘"
  const wishP = ctx.wishOf?.(s);
  const ttlRow = el("span", "flex items-center gap-[4px] min-w-0");
  if (wishP) {
    const dot = el("span", `shrink-0 w-[7px] h-[7px] rounded-full ${PRI_DOT_BG[wishP]}`);
    dot.dataset.tip = `我的选片 · ${PRI_LABEL[wishP]}(在「我的选片」可总览/取消)`;
    // 色点是**方盒**(w/h 写死 7px):只缩字号它不会变小,矮行里就成了一枚突兀的大圆点 → 走 scaleBox
    scaleBox(dot, 7, fontScale);
    ttlRow.appendChild(dot);
  }
  const ttl = el("span", ttlCls, zh); // 13px:卡片内最大一号字,缩放基准
  scaleText(ttl, 13, fontScale);
  ttlRow.appendChild(ttl);
  const sub = el("span", "text-[11px] text-muted truncate", s.title_en !== zh ? s.title_en : `${s.duration_min}min`);
  scaleText(sub, 11, fontScale);
  card.append(ttlRow, sub);

  // 徽章行:等级 → 字幕 → 特性(GV/首映…) → 页码 → 片长。无任何徽章(理论仅 mock 缺字段)时不创建,避免空行。
  // 缩放与门控两件事都在这里:
  //  ① 缩放走 `zoom`(**布局级**)而不是 font-size —— 章体是 legend.ts 的显式 `text-[9.5px]`,
  //     父级 font-size **不级联**下去;而 `zoom` 连子元素显式 px 一起缩(章高 17.78px → 90% 档 16.68px)。
  //     不缩的话那枚固定高的章在 83px 行里会把卡片顶破(四行只剩 0.79px 余量)。
  //  ② `rowH < 80`(55 / 70% 两档)整行不画:四行实在装不下,最先舍信息量最低的它 ——
  //     等级 / 字幕 / GV / 页码 / 片长在 ⓘ 弹层与 hover 提示里都还在,不是信息删除。
  if (
    showBadges &&
    (s.rating || s.subs?.length || typeof s.page === "number" || screeningBadgeKeys(s).length)
  ) {
    const bdgRow = el("span", "mt-auto flex gap-[3px] flex-wrap items-center leading-none");
    appendMetaRow(bdgRow, s);
    bdgRow.appendChild(durChip(s.duration_min));
    if (Math.abs(fontScale - 1) >= 1e-3) bdgRow.style.zoom = `${+fontScale.toFixed(3)}`;
    card.appendChild(bdgRow);
  }

  // ⓘ 详情钮:in-other 卡片不随 hover 出现 → opacity-40 始终;其它 opacity-0 + group-hover/group-focus-within 触发
  const infoCls = inOther
    ? "absolute top-[3px] right-[3px] border-0 bg-transparent text-muted text-[11px] py-px px-[3px] rounded-[4px] opacity-40 hover:text-biff hover:bg-[var(--biff-red-tint-3)]"
    : "absolute top-[3px] right-[3px] border-0 bg-transparent text-muted text-[11px] py-px px-[3px] rounded-[4px] opacity-0 transition-opacity duration-100 group-hover:opacity-[0.85] group-focus-within:opacity-[0.85] hover:text-biff hover:bg-[var(--biff-red-tint-3)]";
  const infoBtn = el("button", infoCls, "ⓘ");
  infoBtn.dataset.info = s.code;
  infoBtn.dataset.tip = "影片资料 / 豆瓣";
  scaleText(infoBtn, 11, fontScale); // 绝对定位、不影响行高,但缩了才与整卡同一比例
  card.appendChild(infoBtn);

  // 两个角标也是「卡片的一部分」→ 同倍率缩(绝对定位,不影响行高预算)
  if (inOther) {
    const grpTag = el(
      "span",
      "absolute left-[3px] top-[2px] text-[9px] font-bold text-muted border border-line rounded-[3px] px-[2px]",
      slot!.group
    );
    scaleText(grpTag, 9, fontScale);
    card.appendChild(grpTag);
  }
  if (isConflict) {
    const warn = el("span", "absolute right-[22px] top-[2px] text-[11px] text-conf", "⚠");
    scaleText(warn, 11, fontScale);
    card.appendChild(warn);
  }

  tracks.appendChild(card);

  // ---- GV 映后谈块(拼接卡右侧;talk=0 不创建)----
  if (talk > 0) {
    const talkEl = el("div");
    talkEl.dataset.code = s.code; // 双向 hover 联动(与正片卡同高亮);点击经 [data-talk] 分支拦截
    talkEl.dataset.talk = "1";
    // 几何:紧贴正片卡右缘(无间隙拼接),右缘与整场槽位右缘对齐
    const filmW = (filmEndMin(s) - start) * pxPerMin - 4;
    talkEl.style.left = `${(start - axisStart) * pxPerMin + 2 + filmW}px`;
    talkEl.style.top = `${insetY}px`;
    talkEl.style.width = `${talk * pxPerMin}px`;
    talkEl.style.height = `${rowH - insetY * 2}px`;

    // 状态外观:冲突沿用红(整场都在冲突区);已选且参加 → 同 in-plan 绿 = 两张一起选中;
    // 放弃映后谈 → gv-talk-off 灰虚线淡出(块仍占槽位,只表示"我不参加")
    const stateTokens: string[] = [];
    if (isConflict) stateTokens.push("border-2 border-conf in-conf");
    else if (inCurrent && talkOn) stateTokens.push("border border-line in-plan");
    else if (inOther && talkOn) stateTokens.push("border border-line in-other");
    else if (!talkOn) stateTokens.push("border border-dashed border-line gv-talk-off");
    else stateTokens.push("border border-line");
    talkEl.className =
      "absolute overflow-hidden cursor-pointer select-none flex flex-col items-center justify-center gap-[1px] rounded-[5px] " +
      stateTokens.join(" ");

    // 谈段斜纹底(透明层,不抢父级背景色,优先级染色/紧张底色仍整块生效)
    const hatch = el("span", "absolute inset-0 pointer-events-none rounded-[5px]");
    hatch.style.backgroundImage =
      "repeating-linear-gradient(-45deg, color-mix(in srgb, var(--color-ink) 6%, transparent) 0 5px, transparent 5px 10px)";
    talkEl.appendChild(hatch);

    // 未选中(待选)时谈块与正片卡同一「待激活」灰阶,避免两张拼接卡文字一深一浅
    const rng = el(
      "span",
      `relative text-[8.5px] tabular-nums leading-[1.2] whitespace-nowrap ${isIdle ? "text-muted" : "text-ink-2"}`,
      talkTimeRange(s)
    );
    const lab = el(
      "span",
      `relative text-[9px] font-bold whitespace-nowrap leading-[1.3] ${isIdle ? "text-ink-2" : "text-ink"}`,
      talkOn && inCurrent ? `✓ 映后 ${talk}′` : `映后 ${talk}′`
    );
    if (!talkOn) lab.classList.add("text-muted", "line-through");
    // 谈块两行自带 leading-[1.2] / [1.3] → 原样传给 scaleText(否则会被默认的 1.45 顶掉、块变高)
    scaleText(rng, 8.5, fontScale, "1.2");
    scaleText(lab, 9, fontScale, "1.3");
    talkEl.append(rng, lab);

    talkEl.dataset.tip = talkTip(s, talk, talkOn, inCurrent);
    // 时间筛选联动:与正片卡同一套 hour-dim(谈段同样淡化,状态语言一致)
    if (ctx.hourFilter != null) {
      const inHour = start < (ctx.hourFilter + 1) * 60 && end > ctx.hourFilter * 60;
      if (!inHour) talkEl.classList.add("hour-dim");
    }
    tracks.appendChild(talkEl);
    return { card, talkEl };
  }

  return { card, talkEl: null };
}

/** 映后谈块 hover 说明(按当前状态切换文案;第 1 行标题 = 谈段区间,其余分点) */
function talkTip(s: Screening, talk: number, talkOn: boolean, inCurrent: boolean): string {
  const endMin = filmEndMin(s) + talk; // 谈段末 = 正片末 + 配置时长(时长可全局改 / 逐场覆写)
  const filmEnd = fmtEndClock(filmEndMin(s));
  const range = `${fmtMinRangeMin(filmEndMin(s), endMin)} 映后谈 ${talk}min(GV 嘉宾到场)`;
  const howTo = "映后时长可在设置里改默认值,或在行程行点 ⏱ 逐场覆写";
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