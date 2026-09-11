// 排片表「字段徽章 + 图例总览」单源模块(2026 第 31 届官方 Schedule Guide 口径)
//  - 等级 / 字幕 / 节目册页码 等小徽章:随卡片/行程/影片库/详情弹层渲染,每枚带 data-tip 即时解释
//  - 「ⓘ 日程表说明」总览弹层内容(字段速读 / Schedule Guide 三栏 / 徽章 / 影院代码 / 网格图例 / Notice)
//    2026-09-11 重排:每段收进「分区卡片」(标题条 + 内容区),示例区画成一张模拟网格卡,
//    表格改细线 + 行 hover,弹层宽度走 modal.ts 的 `xl`(880px)。
//    同日二次对齐官方新版:等级 / 字幕 / 特性章改**彩底白字实心胶囊**,图例改为官方
//    「Ratings | Subtitle | Information」三栏,末尾「特别提示」改为官方 Notice 素圆点列表。
// 场馆名两层口径:紧凑层(甘特影厅列 / 影片库截断行)走 venues.json 的 `short` 短名,
// 详情层(hover tooltip / 本弹层表 / ICS LOCATION)给英文全名 + 韩名。
// 官方影院代码(BT/B1/C1/L2…)不单独当行标签,放行首 chip + 悬停说明。

import type { Catalog, RatingKey, Screening, SubsKey, Venue } from "./types";
import { el } from "./util";
import { BADGE_DEFS, badgeEl, codeTip, DOUBAN_CHIP_TITLE, screeningBadgeKeys, UNIFORM_CHIP_BASE } from "./badges";

/** 徽章基底(与 badges.ts 同字阶体系;全部字面量 → Tailwind v4 扫描可见)。
 *  ⚠ **只放尺寸 / 排版,不放颜色** —— Tailwind 里同族 utility(`text-*` / `bg-*` / `border-*`)
 *    谁生效取决于它们在产物 CSS 里的先后,而不是 class 属性里的先后;基底带色会让变体的
 *    覆盖变成「碰运气」。颜色一律由各变体自己写全。 */
const CHIP_BASE =
  "not-italic text-10 font-extrabold rounded-3 px-[3px] py-px border " +
  "leading-[1.45] whitespace-nowrap select-none shrink-0 cursor-help inline-flex items-center";

/** 官方新版实底章的**共用配色** —— 彩底 + 白字 + 同色描边(描边只是补齐盒模型,不另起色) */
const CHIP_SOLID = "text-on-brand border-transparent";

/* ---------------- 观影等级 ---------------- */
interface RateDef {
  label: string;
  cls: string; // chip 配色(完整字面量)
  zh: string; // 中文说明
  kr: string; // 한국어 표기
  en: string; // 官方准入英文
  tip: string; // hover 说明(悬停在具体徽章上即示)
}

export const RATING_DEFS: Record<RatingKey, RateDef> = {
  ALL: {
    label: "ALL",
    cls: `${CHIP_BASE} ${CHIP_SOLID} bg-rate-all-solid`,
    zh: "全年龄",
    kr: "전체관람가",
    en: "All ages admitted",
    tip: "观影等级 ALL — 全年龄可观看\n전체관람가 · All ages admitted",
  },
  "12": {
    label: "12",
    cls: `${CHIP_BASE} ${CHIP_SOLID} bg-rate-12-solid`,
    zh: "12 岁以上",
    kr: "12세이상관람가",
    en: "Under 12 not admitted",
    tip: "观影等级 12(12세이상관람가)\n未满 12 岁不得入场 · Under 12 not admitted",
  },
  "15": {
    label: "15",
    cls: `${CHIP_BASE} ${CHIP_SOLID} bg-rate-15-solid`,
    zh: "15 岁以上",
    kr: "15세이상관람가",
    en: "Under 15 not admitted",
    tip: "观影等级 15(15세이상관람가)\n未满 15 岁不得入场 · Under 15 not admitted",
  },
  "19": {
    label: "19",
    cls: `${CHIP_BASE} ${CHIP_SOLID} bg-rate-19-solid`,
    zh: "19 岁以上",
    kr: "청소년관람불가",
    en: "Under 19 not admitted",
    tip: "观影等级 19(청소년관람불가)\n未满 19 岁不得入场 · Under 19 not admitted",
  },
};

/* ---------------- 字幕 / 对白标识 ---------------- */
interface SubsDef {
  label: string;
  cls: string;
  en: string; // 官方英文全称
  zh: string; // 中文释义
  tip: string;
}

export const SUBS_DEFS: Record<SubsKey, SubsDef> = {
  KE: {
    label: "KE",
    cls: `${CHIP_BASE} ${CHIP_SOLID} bg-subs-ke-solid`,
    en: "Korean Subtitles + English Subtitles or Dialogue",
    zh: "韩文字幕 + 英文字幕或英文对白(最常见)",
    tip: "字幕 KE — Korean Subtitles + English Subtitles or Dialogue\n韩文字幕 + 英文字幕或英文对白",
  },
  KN: {
    label: "KN",
    cls: `${CHIP_BASE} ${CHIP_SOLID} bg-subs-kn-solid`,
    en: "Korean Subtitles + Non-English Dialogue without English Subtitles",
    zh: "韩文字幕 + 非英语外语对白(无英字;外语观众慎选)",
    tip: "字幕 KN — Korean Subtitles + Non-English Dialogue without English Subtitles\n韩文字幕 + 非英语外语对白,不配英文字幕\n多为日 / 中 / 西语对白片,不熟该语言需留意",
  },
  KK: {
    label: "KK",
    cls: `${CHIP_BASE} ${CHIP_SOLID} bg-subs-kk-solid`,
    en: "Korean Subtitles + Korean Dialogue",
    zh: "韩文字幕 + 韩语对白(无外文字幕)",
    tip: "字幕 KK — Korean Subtitles + Korean Dialogue\n韩文字幕 + 韩语对白(无外文字幕;同时为听障观众提供语音 / 字幕解说)",
  },
  NO: {
    label: "NO",
    cls: `${CHIP_BASE} ${CHIP_SOLID} bg-subs-no-solid`,
    en: "No Dialogue",
    zh: "无对白(实验 / 纪录 / 纯影像)",
    tip: "字幕 NO — No Dialogue\n无对白影片(实验 / 纪录 / 纯影像)",
  },
};

/** 等级的**展示顺序** —— 必须显式列出:`RATING_DEFS` 的键是 `ALL / 12 / 15 / 19`,
 *  而 JS 对象会把「整数样」的键(`"12"`/`"15"`/`"19"`)排到最前、无视书写顺序 →
 *  直接 `Object.keys` 会渲染成 12 / 15 / 19 / ALL,与官方图例的 ALL 打头不符。 */
export const RATING_ORDER: RatingKey[] = ["ALL", "12", "15", "19"];

/** 未标注(格内无字幕标识)= 英文字幕 + 韩语对白 —— 说明文案(总览用) */
const SUBS_UNMARKED = {
  en: "English Subtitles + Korean Dialogue",
  zh: "英文字幕 + 韩语对白(未标注 = 即此义)",
};

/**
 * `subs` 归一化成数组(渲染入口唯一归一化点)。
 * 官方 META 会**同时印多个**标识 —— 实测 `KE KK`(2025 版 4 场:028/029/109/268),
 * 语义是「有韩字 + 有英字,且配韩语对白」的**叠加**,不是二选一。
 * 2026-09-10 起数据契约是 `SubsKey[]`;但 `public/schedule.json`(2026 mock 演示数据)
 * 仍是早期的标量字符串,这里一并兼容,免得 `SUBS_DEFS[array]` 取到 undefined 静默不渲染。
 */
export function subsKeys(subs: Screening["subs"] | SubsKey): SubsKey[] {
  if (!subs) return [];
  return Array.isArray(subs) ? subs : [subs];
}

/** 单个徽章 DOM(label + data-tip) */
function chipEl(def: { label: string; cls: string; tip: string }): HTMLElement {
  const node = el("i", def.cls, def.label);
  node.dataset.tip = def.tip;
  return node;
}

/** 节目册页码的 hover 说明(uniform 与常规两条路径共用,避免文案漂移) */
export function pageTip(page: number): string {
  return `节目册页码 P.${page}\n该场在官方 Ticket Catalogue(节目册)中的页码\n购票 / 翻册对表用`;
}

/** 节目册页码徽章:P.167 */
export function pageChip(page: number): HTMLElement {
  return chipEl({ label: `P.${page}`, cls: `${CHIP_BASE} text-meta bg-card border-line`, tip: pageTip(page) });
}

/** 片长徽章:100'
 *  - 默认(网格卡徽章流末尾):透明无框尾注,不抢等级 / 字幕的视觉;
 *  - boxed(图例 / 说明总览):与 P.167 同款中性描边章 —— 说明里要「看得出这是一枚章」。 */
export function durChip(min: number, opts?: { boxed?: boolean }): HTMLElement {
  const cls = opts?.boxed
    ? `${CHIP_BASE} text-meta bg-card border-line`
    : `${CHIP_BASE} text-meta bg-transparent border-transparent px-[2px]`;
  const node = el("i", cls, `${min}'`);
  node.dataset.tip = `片长 ${min} 分钟\n正片时长(不含映后谈)\nGV 场另有映后谈 — 时长可配置(设置里改全局默认,行程行映后胶囊逐场覆写),可在卡片 / 行程里单独放弃`;
  return node;
}

/** 豆瓣评分章:豆 8.5 —— 影片库 / 影片详情弹层 / 图例总览共用同一处 markup(extraCls 供调用方补间距) */
export function doubanChip(rating: number, extraCls?: string): HTMLElement {
  const node = el(
    "span",
    "inline-block text-11 font-bold text-muted border border-line bg-card rounded px-[6px] " +
      "leading-[1.7] select-none whitespace-nowrap cursor-help" + (extraCls ? ` ${extraCls}` : ""),
    `豆 ${rating}`
  );
  node.dataset.tip = DOUBAN_CHIP_TITLE;
  return node;
}

/* ---- 总览「示例节点」:非徽章类字段也要有章的外形 + hover 说明 ---- */

/** 放映时间字段(加墨 + 等宽数字;与网格卡身份行同款) */
function timeField(range: string): HTMLElement {
  const node = el("b", "text-13 font-semibold tabular-nums whitespace-nowrap cursor-help", range);
  node.dataset.tip =
    "放映时间 起–止(KST)\n" +
    "GV 映后场的结束时间 = 正片末 + 映后谈时长(正片 + 映后 N′)\n" +
    "映后时长可配置:设置里改全局默认,行程行点映后胶囊的数字逐场覆写\n" +
    "该段可在卡片 / 行程单独放弃 — 放弃后按正片结束算转场";
  return node;
}

/** 放映 CODE 字段(红字 + 场次编号说明;与网格卡身份行同款) */
function codeField(code: string): HTMLElement {
  const node = el("b", "text-13 text-biff-ink whitespace-nowrap cursor-help", code);
  node.dataset.tip = codeTip(code);
  return node;
}

/** 「未标注」占位章:虚线空框 = 格内没有这枚标识 */
function blankChip(): HTMLElement {
  const node = el("i", `${CHIP_BASE} text-meta bg-card border-line border-dashed`, "(空白)");
  node.dataset.tip = "格内未标注该字段\n字幕未标注 = 官方默认「英文字幕 + 韩语对白」";
  return node;
}

/** 场次编号占位章 —— 官方图例 Information 列里的 `---` Code(白底虚线框 + 灰字) */
function codePlaceholderChip(): HTMLElement {
  const node = el("i", `${CHIP_BASE} text-meta bg-card border-line border-dashed`, "---");
  node.dataset.tip = codeTip("---");
  return node;
}

/** 网格底色小色块(与顶栏图例条同款:10px 圆角色块 + 同色描边) */
function swatch(bg: string, borderCls: string): HTMLElement {
  const i = el("i", `inline-block w-[10px] h-[10px] rounded-3 mr-[5px] align-[-1px] border ${borderCls}`);
  i.style.background = bg;
  return i;
}

/** 图例行左键:色块 / 徽章 + 文字标签(整块作 key;与右侧说明分列,见 buildGuideBody §6)。
 *  `shrink-0` 必须留 —— 作为 flex item 时,长说明会把 key 挤到折行,图例就不成列了。 */
function labeled(icon: HTMLElement, text: string): HTMLElement {
  const span = el("span", "inline-flex items-center shrink-0");
  span.append(icon, document.createTextNode(text));
  return span;
}

/** 观影等级在 **uniform 模式**下的强调色描边(白底 + 同族描边 + 同族字)。
 *  为什么只有等级留强调:它是**硬性准入信息**(未满岁不得入场),扫场次时必须一眼看到;
 *  其余标签(字幕 / GV / 页码)是补充说明,统一灰描边即可。
 *  ⚠ 必须字面量书写(Tailwind v4 只生成源码里完整出现的类),勿拼 `text-rate-${k}`。 */
const RATING_ACCENT: Record<RatingKey, string> = {
  ALL: "font-bold text-rate-all bg-card border-rate-all",
  "12": "font-bold text-rate-12 bg-card border-rate-12",
  "15": "font-bold text-biff-ink bg-card border-biff",
  "19": "font-bold text-rate-19 bg-card border-rate-19",
};

/** 统一章 DOM(uniform 模式):默认中性灰描边;`variant` 换配色 / 字重(等级走强调色描边)。
 *  导出给影片行场次行自建「影院代码 / 时长」两枚章用 —— 保证与 appendMetaRow 那组**同一套**尺寸 / 圆角。 */
export function uniformChipEl(label: string, tip: string, variant = ""): HTMLElement {
  const node = el("i", `${UNIFORM_CHIP_BASE} ${variant || "font-semibold text-ink-2 bg-card border-line"}`, label);
  node.dataset.tip = tip;
  return node;
}

/** 「观影等级」章(uniform 口径,无等级则 null)—— 行程行元信息**只留这一枚带框章**时用。
 *  等级是**硬性准入信息**(未满岁不得入场),扫场次时必须一眼看到 → 保框、保强调色;
 *  其余(影院 / 片长 / 字幕 / 页码)在行程行降为中灰纯文本,减少画面的框框数量。 */
export function ratingChipEl(s: Screening): HTMLElement | null {
  const key = s.rating;
  if (!key || !RATING_DEFS[key]) return null;
  const def = RATING_DEFS[key];
  return uniformChipEl(def.label, def.tip, RATING_ACCENT[key]);
}

/**
 * 场次完整字段徽章流,按官方格序追加到 host:
 * 等级 → 字幕 → 场次特性(GV/首映/大师班…) → 节目册页码。
 * host 应为 flex/flex-wrap 容器(grid 卡 chips 行 / 行程标题行 / 弹层 when 行 / 影片库行)。
 * `opts.uniform` = 影片行「场次行」那套**统一描边章**(见 badges.ts::UNIFORM_CHIP_BASE):
 * 全部降为中性灰描边、只给观影等级留强调色 —— 场次行信息密度高,实心章会喧宾夺主。
 * 网格卡 / 行程行**不传**该选项,保留各自的实心章(那是「一眼看到有映后谈」的主信号)。
 */
export function appendMetaRow(host: HTMLElement, s: Screening, opts?: { uniform?: boolean }): void {
  const u = opts?.uniform === true;
  const rateKey = s.rating;
  if (rateKey && RATING_DEFS[rateKey]) {
    const def = RATING_DEFS[rateKey];
    host.appendChild(u ? uniformChipEl(def.label, def.tip, RATING_ACCENT[rateKey]) : chipEl(def));
  }
  // 字幕标识可同时多个(官方叠加印,如 KE KK)→ 逐个成章;归一化见 subsKeys()
  for (const k of subsKeys(s.subs)) {
    const def = SUBS_DEFS[k];
    host.appendChild(u ? uniformChipEl(def.label, def.tip) : chipEl(def));
  }
  for (const k of screeningBadgeKeys(s)) host.appendChild(badgeEl(k, u ? { uniform: true } : undefined));
  if (typeof s.page === "number" && s.page > 0) {
    host.appendChild(u ? uniformChipEl(`P.${s.page}`, pageTip(s.page)) : pageChip(s.page));
  }
}

/** 该场是否有任何徽章(等级 / 字幕 / 特性 / 页码)—— 无则整行不建,避免空行 */
export function hasBadges(s: Screening): boolean {
  return Boolean(s.rating || s.subs?.length || typeof s.page === "number" || screeningBadgeKeys(s).length);
}

/** 网格卡「场次徽章行」的模板缓存 —— 按「code + 全部输入字段」键,每次返回 `cloneNode`。
 *  徽章内容只由 Screening 的静态字段决定(等级 / 字幕 / tags / 页码 / 片长),加载后不再变;
 *  一张网格卡要造 4~6 枚徽章,而整网格重建时是数百张卡 —— `cloneNode` 比逐枚
 *  `createElement` + 拼类名字符串便宜得多。
 *  ⚠ 缓存的是**未缩放**模板:缩放(`style.zoom`)由调用方在 clone 上设,不污染模板;
 *  ⚠ 模板节点**不入 DOM**(只作 clone 源),否则会被 replaceWith / 移出污染。 */
const metaRowCache = new Map<string, HTMLElement>();

export function metaRowFor(s: Screening): HTMLElement {
  const key = [
    s.code,
    s.rating ?? "",
    s.subs?.join(",") ?? "",
    s.page ?? "",
    s.duration_min,
    s.is_gv ? 1 : 0,
    s.tags?.join(",") ?? "",
  ].join("|");
  let tpl = metaRowCache.get(key);
  if (!tpl) {
    tpl = el("span", "mt-auto flex gap-[3px] flex-wrap items-center leading-none");
    appendMetaRow(tpl, s);
    tpl.appendChild(durChip(s.duration_min));
    metaRowCache.set(key, tpl);
  }
  return tpl.cloneNode(true) as HTMLElement;
}

/* ---------------- 影院代码 / 分区 ---------------- */
/** 影院 → 分区说明。key 必须与 venues.json 的 `group` 值一致(2025 真实数据:
 *  bcc/cgv/lotte/kofic 在 CENTUM 主场区,megabox/sohyang/bcm 在南浦洞),
 *  否则图例「分区」列整列显示 `—`。 */
const GROUP_AREA: Record<string, string> = {
  bcc: "CENTUM 主场区 · 电影殿堂(Busan Cinema Center)",
  cgv: "CENTUM 主场区 · CGV Centum City",
  lotte: "CENTUM 主场区 · LOTTE CINEMA Centum City",
  kofic: "CENTUM 主场区 · KOFIC Theater(电影振兴委员会)",
  shinsegae: "CENTUM 主场区 · 新世界 Centum City 文化厅",
  dsumedia: "CENTUM 主场区 · 东西大学-KIT Centum Campus",
  megabox: "南浦洞 · MEGABOX Busan Theater",
  sohyang: "南浦洞 · 东西大学 Sohyang Theatre",
  bcm: "南浦洞 · 釜山市民媒体中心",
};

/** 场馆短名 —— **紧凑层的唯一取用口**。甘特影厅列只有 148px(可写 ≈98~103px),全名
 *  「Busan Cinema Center Cinema 1」(≈178px)必被截成「Busan Cinema …」,而三个厅的区分性
 *  字词全在末尾 → B1/B2/B3 三行看起来一模一样。故行标签走 `short`(品牌 + 厅号,实测 ≤98px 零截断),
 *  全名留给 tooltip / ⓘ 弹层 / ICS。旧 JSON 无 `short` 时回退全名(仅会截断,不会空白)。 */
export function venueShort(v: Venue): string {
  return v.short || v.name;
}

/** 场馆行悬停说明(全名 + 韩文名作标题;分区 / 官方代码分点) */
export function venueTip(v: Venue): string {
  const lines = [v.name_kr ? `${v.name} · ${v.name_kr}` : v.name];
  lines.push(`分区 — ${GROUP_AREA[v.group] ?? "—"}`);
  if (v.code) {
    lines.push(`官方影院代码 ${v.code} — 与官方 Ticket Catalogue 对表用`);
  }
  return lines.join("\n");
}

/* ================================================================
 * 「ⓘ 日程表说明」总览弹层内容
 * ================================================================ */

/** 按「影院」归并的代码总表 —— **直接由 `venues.json` 推导**(2026-09-11 起)。
 *  原先是一张写死的 2025 表(含当年才有的 M1–M4 / BD / C7),换届后必然过期且不会报错;
 *  现在按 `group` 归并真实数据,换版本自动跟着变,不存在的影院也不会凭空列出来。 */
function venueCodeGroups(cat: Catalog): { group: string; list: [string, string][] }[] {
  const order: string[] = [];
  const byGroup = new Map<string, Venue[]>();
  for (const v of cat.venues) {
    if (!byGroup.has(v.group)) {
      byGroup.set(v.group, []);
      order.push(v.group);
    }
    byGroup.get(v.group)!.push(v);
  }
  return order.map((g) => ({
    group: GROUP_AREA[g] ?? g,
    list: byGroup.get(g)!.map((v): [string, string] => [
      v.code ?? v.id.toUpperCase(),
      v.name_kr ? `${v.name} · ${v.name_kr}` : v.name,
    ]),
  }));
}

/* ---- 排版积木(2026-09-11 重排)----
 *  旧版是「小标题 + 裸表格」一路直排,7 段挤在 640px 里毫无层级;
 *  现在每段收进一张**分区卡片**(标题条 + 内容区),弹层加宽到 `xl`(见 modal.ts::MODAL_WIDTH),
 *  表格 / 图例 / 提示各自有独立内距与描边 —— 读起来像一本小册子,而不是一堆裸文本。 */

/** 分区卡片:标题条(红方块 + 中文标题 + 英文副题)+ 内容区。
 *  红方块走**真实 span** 而非 `before:` 伪元素 —— 伪元素类名必须写全字面量才进构建产物,
 *  真实节点既好维护又能被 Tailwind 直接扫到。 */
function guideSection(title: string, sub: string, content: HTMLElement): HTMLElement {
  const sec = el("section", "rounded-10 border border-line bg-card overflow-hidden");
  const head = el("div", "flex items-center gap-[7px] px-[12px] py-[8px] bg-hover border-b border-line");
  head.appendChild(el("span", "shrink-0 w-[8px] h-[8px] border-[2.5px] border-biff rounded-2 box-border"));
  head.appendChild(el("h4", "m-0 text-14 font-bold tracking-[0.01em]", title));
  if (sub) head.appendChild(el("span", "text-11 font-semibold text-meta tracking-[0.02em]", sub));
  const inner = el("div", "px-[12px] py-[10px]");
  inner.appendChild(content);
  sec.append(head, inner);
  return sec;
}

/** 顶部提示条(浅红底 + 左侧红竖条)—— 与卡片拉开距离,一眼知道「这是前言」 */
function guideCallout(text: string): HTMLElement {
  return el(
    "div",
    "border border-biff-line border-l-[3px] border-l-biff bg-biff-tint rounded-9 " +
      "px-[12px] py-[9px] text-12 leading-[1.65] text-ink-2",
    text
  );
}

/** 窄屏兜底:表格可能比弹层宽 → 包一层横向滚动,不撑破卡片 */
function scrollBox(node: HTMLElement): HTMLElement {
  const box = el("div", "overflow-x-auto");
  box.appendChild(node);
  return box;
}

function mkTable(heads: string[]): { tbl: HTMLTableElement; tbody: HTMLTableSectionElement } {
  const tbl = el("table", "w-full border-collapse") as HTMLTableElement;
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  hr.className = "text-meta text-11 font-bold tracking-[0.04em] text-left";
  heads.forEach((hd) => {
    const th = document.createElement("th");
    th.className = "py-[5px] pr-2 font-bold whitespace-nowrap border-b border-line";
    th.textContent = hd;
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  const tbody = document.createElement("tbody");
  tbl.append(thead, tbody);
  return { tbl, tbody };
}

function addRow(tbody: HTMLTableSectionElement, cells: (string | HTMLElement)[]): void {
  const tr = document.createElement("tr");
  tr.className = "border-b border-line-faint last:border-b-0 align-top transition-colors hover:bg-hover";
  cells.forEach((c) => {
    const td = document.createElement("td");
    td.className = "py-[6px] pr-[10px] text-13 leading-[1.55]";
    if (typeof c === "string") td.textContent = c;
    else td.appendChild(c);
    tr.appendChild(td);
  });
  tbody.appendChild(tr);
}

/** 分区内的小字补充说明 */
function note(text: string): HTMLElement {
  return el("div", "mt-[9px] text-12 leading-[1.65] text-muted", text);
}

/** 官方 Schedule Guide 的一栏:栏标题 + 「章 → 说明」列表。
 *  官方是三栏并排(Ratings / Subtitle / Information);窄屏用 auto-fit 自动折成一栏。 */
function guideColumn(title: string, rows: [HTMLElement, string][]): HTMLElement {
  const col = el("div", "grid gap-[7px] content-start min-w-0");
  col.appendChild(el("h5", "m-0 pb-[6px] text-13 font-bold border-b border-line", title));
  const ul = el("ul", "grid gap-[6px] m-0 p-0 list-none");
  for (const [chip, text] of rows) {
    const li = el("li", "flex items-start gap-[7px] text-12 leading-[1.5]");
    li.appendChild(chip);
    li.appendChild(el("span", "min-w-0 text-ink-2", text));
    ul.appendChild(li);
  }
  col.appendChild(ul);
  return col;
}

/** 官方「Notice」块的内容:圆点条目(官方是素圆点,不是我们原来的红方块 —— 照搬) */
function noticeList(items: string[]): HTMLElement {
  const ul = el("ul", "grid gap-[6px] m-0 p-0 list-none");
  for (const t of items) {
    const li = el("li", "flex items-start gap-[7px] text-13 leading-[1.6] text-ink-2");
    li.appendChild(el("span", "shrink-0 text-meta", "•"));
    li.appendChild(el("span", "min-w-0", t));
    ul.appendChild(li);
  }
  return ul;
}

/** 总览弹层主体(点击「ⓘ 日程表说明」打开;main.ts 装配) */
export function buildGuideBody(cat: Catalog): HTMLElement {
  const body = el("div", "grid gap-[12px]");

  // ---- 前言 ----
  body.appendChild(
    guideCallout(
      "字段与代码口径照搬 2026 第 31 届 BIFF 官网排期页的 Schedule Guide;排期 / 片名 / 分级 / 字幕 / GV 均取自官网实时页面(tools/scrape_biff_web.py 抓取)。悬停任意小徽章即看即时解释,本页为总览。"
    )
  );

  // ---- 1 字段速读 ----
  {
    const wrap = el("div", "grid gap-[10px]");
    wrap.appendChild(el("div", "text-12 text-meta", "下面是一张网格卡的完整字段 —— 悬停任意字段 / 徽章看即时解释。"));
    // 示例做成**一张模拟网格卡**(身份行 + 徽章行),而不是一条平铺的内联流:
    // 读图例的人先在网格里见过这张卡,这里长得一样才对得上号。
    const demo = el(
      "div",
      "grid gap-[6px] rounded-8 border border-line bg-card shadow-[var(--shadow-card)] px-[11px] py-[9px]"
    );
    const identity = el("div", "flex items-center gap-[8px] flex-wrap");
    identity.append(
      timeField("09:00–10:40"),
      codeField("004"),
      el("span", "text-13 font-semibold text-ink-2", "Last Samurai Standing · 이쿠사가미: 전쟁의 신")
    );
    const chips = el("div", "flex items-center gap-[5px] flex-wrap");
    chips.append(
      chipEl(RATING_DEFS["15"]),
      chipEl(SUBS_DEFS.KE),
      badgeEl("gv"),
      pageChip(167),
      durChip(100, { boxed: true })
    );
    demo.append(identity, chips);
    wrap.appendChild(demo);
    // 「元素」列一律渲染真节点(章 / 字段),不再写纯文本 —— 纯文本既没有章的外形,
    // 也没有 data-tip,tip.ts 的文档级委托命不中 → 表现为「只有 GV 有悬停」。
    const { tbl, tbody } = mkTable(["元素", "含义"]);
    addRow(tbody, [timeField("09:00–10:40"), "放映时间(起–止,KST)。GV 映后场的结束时间 = 正片末 + 映后谈时长(正片 + 映后 N′),该段在卡片上单独可弃:放弃后按正片结束算转场。映后时长可配置:设置里给全局默认(默认 25 分钟),行程行点映后胶囊的数字可逐场覆写(留空 = 跟随默认)。跨午夜场(如通宵马拉松)按 24+ 时制显示为「23:59–次日 05:35」,时间轴同步外扩到次日并在 24:00 处画跨日分隔线"]);
    addRow(tbody, [codeField("004"), "放映 CODE — 本场唯一场次编号;同片多场各异,对表 / 抢票以此为准"]);
    addRow(tbody, [chipEl(RATING_DEFS["15"]), "观影等级 — 未满对应年龄不得入场(下节表)"]);
    addRow(tbody, [chipEl(SUBS_DEFS.KE), "字幕 / 对白标识(下节表);格内空白 = 未标注(英字 + 韩语对白)"]);
    addRow(tbody, [badgeEl("gv"), "Guest Visit — 嘉宾到场映后交流;官方提示可能临时变动"]);
    addRow(tbody, [durChip(100, { boxed: true }), "正片时长(分钟)"]);
    addRow(tbody, [pageChip(167), "官方节目册 Ticket Catalogue 页码 — 翻册找该场信息 / 票务说明"]);
    addRow(tbody, ["片名", "官方排期表原样:英文片名 + 韩文片名(本工具额外附中文名)"]);
    wrap.appendChild(scrollBox(tbl));
    body.appendChild(guideSection("一格怎么读", "SAMPLE", wrap));
  }

  // ---- 2 官方三栏 Schedule Guide(Ratings / Subtitle / Information)----
  //  照搬 biff.kr 排期页「Schedule Guide」的面板结构:三栏并排、每栏「章 + 说明」成行。
  //  原先这里是两张独立表格(观影等级 / 字幕),信息一样但读起来是「两段文档」而不是「一页图例」。
  {
    const cols = el("div", "grid gap-[18px] grid-cols-[repeat(auto-fit,minmax(230px,1fr))]");

    cols.appendChild(
      guideColumn(
        "Ratings",
        RATING_ORDER.map((k) => {
          const d = RATING_DEFS[k];
          return [chipEl(d), `${d.zh} · ${d.en}`] as [HTMLElement, string];
        })
      )
    );

    const subsRows: [HTMLElement, string][] = (Object.keys(SUBS_DEFS) as SubsKey[]).map((k) => {
      const d = SUBS_DEFS[k];
      return [chipEl(d), d.en] as [HTMLElement, string];
    });
    subsRows.push([blankChip(), `(*) 未标注 = ${SUBS_UNMARKED.en}`]);
    cols.appendChild(guideColumn("Subtitle", subsRows));

    const infoRows: [HTMLElement, string][] = [
      [codePlaceholderChip(), "Code — 场次编号(每场唯一,对表 / 抢票以此为准)"],
      [badgeEl("gv"), "Guest Visit — 嘉宾到场映后交流"],
    ];
    for (const d of BADGE_DEFS) {
      if (d.key === "gv") continue;
      infoRows.push([badgeEl(d.key), d.title.split("\n")[0]]);
    }
    cols.appendChild(guideColumn("Information", infoRows));

    body.appendChild(guideSection("Schedule Guide", "官方图例", cols));
  }

  // ---- 4 场次特性徽章 ----
  {
    const wrap = el("div", "grid gap-0");
    const { tbl, tbody } = mkTable(["徽章", "含义"]);
    BADGE_DEFS.forEach((d) => {
      const chip = badgeEl(d.key);
      addRow(tbody, [chip, d.title]);
    });
    wrap.appendChild(scrollBox(tbl));
    wrap.appendChild(note("GV 徽章为实心紫(对齐官方新版 Information 列)。GV 场在网格里拆成「正片 + 映后谈」两张拼接卡:默认一起选中,点映后块或行程行开关可单独放弃(只选正片);放弃后该场按正片结束算转场/冲突/.ics 导出,该段仍留在时间轴上以虚线灰块示意「物理存在但我不参加」。**映后谈时长可配置**:设置里给全局默认(默认 25 分钟,改它 = 谈段长度与有效结束全链路跟着变),行程行点映后胶囊的数字可逐场覆写(留空 = 跟随默认;设 0 = 本场不拆映后段)。"));
    body.appendChild(guideSection("场次特性徽章", "BADGES", wrap));
  }

  // ---- 5 影院与代码 ----
  {
    const wrap = el("div", "grid gap-0");
    const { tbl, tbody } = mkTable(["代码", "影厅(网格行标签 → 官方全名)", "分区"]);
    cat.venues.forEach((v) => {
      const codeCell = v.code
        ? chipEl({
            label: v.code,
            cls: `${CHIP_BASE} text-biff-ink bg-biff-soft border-current`,
            tip: `影院代码 ${v.code} — 与官方排期页 / 现场指示牌对表用`,
          })
        : el("span", "text-meta", "—");
      // 短名 ↔ 全名对照:用户照着网格列里的短名能在这里对回官方全名(否则「BCC Cinema 1」无从溯源)
      const nameCell = el("div", "grid gap-px");
      nameCell.append(
        el("div", "font-semibold text-ink", venueShort(v)),
        el("div", "text-12 text-meta", `${v.name}${v.name_kr ? ` · ${v.name_kr}` : ""}`)
      );
      addRow(tbody, [codeCell, nameCell, GROUP_AREA[v.group] ?? "—"]);
    });
    wrap.appendChild(scrollBox(tbl));

    const det = document.createElement("details");
    det.className = "mt-[10px] border border-line rounded-8 bg-hover overflow-hidden";
    const sum = document.createElement("summary");
    sum.className = "cursor-pointer text-13 font-semibold text-ink-2 select-none hover:text-biff-ink";
    sum.textContent = "按影院归并的代码总表(点击展开)";
    det.appendChild(sum);
    const detBody = el("div", "px-[10px] pb-[8px]");
    venueCodeGroups(cat).forEach((g) => {
      const gHead = el("div", "mt-[6px] mb-[2px] text-12 font-bold text-muted", g.group);
      const { tbl: t2, tbody: tb2 } = mkTable(["代码", "剧场"]);
      g.list.forEach(([code, name]) => addRow(tb2, [code, name]));
      detBody.append(gHead, t2);
    });
    det.appendChild(detBody);
    wrap.appendChild(det);
    body.appendChild(guideSection("影院与官方代码", "VENUES", wrap));
  }

  // ---- 6 网格图例(红绿灯底色:已选 / 时间紧张 / 完全冲突) ----
  {
    // 行首一律真节点:三种底色用网格卡同色色块(色值取自 style.css in-plan / TIGHT_BG / in-conf),
    // GV 用卡面同款徽章,豆瓣用影片库同款章 —— 不写成文字,读图例即读卡面。
    const lines: [string | HTMLElement, string][] = [
      [
        labeled(swatch("color-mix(in srgb, var(--color-ok) 14%, var(--color-card))", "border-ok"), "绿底 · 已选"),
        "已加入行程的场次 — 整卡淡绿底",
      ],
      [
        labeled(swatch("color-mix(in srgb, var(--color-tight) 24%, var(--color-card))", "border-tight"), "黄底 · 时间紧张"),
        "已选场次里相邻两场衔接紧:间隔小于转场缓冲(转场不足)或余量 <15min(偏紧)— 两张卡整卡淡黄底,hover 卡片查看完整算式",
      ],
      [
        labeled(swatch("color-mix(in srgb, var(--color-conf) 14%, var(--color-card))", "border-conf"), "红底 · 完全冲突"),
        "两场放映时间重叠,无法同时观看 — 整卡红底 + 红框 + 右上角红点;两张卡不在相邻影厅时,会有一条红色虚线把重叠时段连起来;hover 联动高亮整个冲突组。**重叠不是错误**:两场都留在行程里,去「我的行程」的**绿框顺位卡**里拖动排出偏好次序即可 —— 工具会把「每个冲突组各取一场」的所有无冲突组合都列出来(见「方案对比」)",
      ],
      [
        badgeEl("gv"),
        "Guest Visit 嘉宾映后 — 默认连映后谈一起选(两张拼接卡同亮),可在映后块/行程单独放弃,放弃后按正片结束算转场;映后时长可配置(设置里改默认值,行程行映后胶囊逐场覆写)",
      ],
      [doubanChip(8.5), "豆瓣用户评分(满分 10 分,仅影片库 / 详情出现)"],
    ];
    const ul = el("ul", "grid gap-[7px]");
    lines.forEach(([k, v]) => {
      // 行首 key 与说明分列(key 不折行、说明左对齐成一条竖线),比「key — 说明」内联更好扫读
      const li = el("li", "flex items-start gap-[8px] text-13 leading-[1.6]");
      if (typeof k === "string") li.appendChild(el("b", "shrink-0 font-semibold", k));
      else li.appendChild(k);
      li.appendChild(el("span", "min-w-0", v));
      ul.appendChild(li);
    });
    body.appendChild(guideSection("网格与行程图例", "GRID LEGEND", ul));
  }

  // ---- 7 我的选片(唯一数据源)----
  {
    const wrap = el("div", "grid gap-0");
    const ul = el("ul", "grid gap-[7px]");
    [
      ["一部片一条记录", "「我的选片」与「我的行程」是同一份数据的两个视图:按片看是选片清单,按场次看是行程。没有第二份拷贝,两边永远一致"],
      ["顺位 = 偏好次序 · 方案 = 所有无冲突组合(2026-09-11 新)", "同一时间带互相重叠的几场在「我的行程」里折叠成一张**绿框顺位卡**(绿框 = 这组已经处理好,不是警报);卡片头第 1 列的 **⠿ 把手**可以**上下拖动**,组内顺序就是**偏好次序**(顺位 1 = 最想要)。\n**顺位不决定分组** —— 它只回答「先保哪一场」。**方案 = 「每个冲突组各取一场」的所有组合**:2 个冲突组各有 2 场 → 4 套方案,每一套都无冲突(工具逐套校验过)。行程顶部的「方案对比」把这些方案**全部**并列摆出来,按**顺位成本**(各组所选顺位之和)排序 —— 都取首选的那套排最前,盖「最优先」章。每张卡只列差异场次。顺位是**场次级**的(同一部片的两场可以分属不同顺位),独立存 `biff.ranks.v1`"],
      ["三步流程:选片 → 挑场次 → 看行程", "**排片只在「我的选片」里挑**(2026-09-11 改):① 在**影片库**选影片,点「＋ 加入我的选片」把片子收进来(这枚按钮随后变成「✓ 已在选片 · 去排场次 ▸」,点它直接带你过去);② 在**我的选片**展开任意一部片,场次行右侧「＋ 加入」挑具体场次(已加入变「✓」,再点即移出),行内「定位 ▸」跳到时间轴;③ **我的行程**按日期看最终结果。影片库那张场次表是**只读**的(只留「定位 ▸」),所以不会「两个地方都能加、跳来跳去」。当然,直接在时间轴上点卡片选场次一样有效 —— 写的是同一份数据"],
      ["冲突怎么取舍", "冲突**不必现在就决定** —— 两场都留在行程里,去「我的行程」的绿框顺位卡拖出偏好次序即可。抢票时按顺位从上往下试:抢到顺位 1 就按成本最低的那套走,售罄就退到下一套。工具不记账「抢到 / 售罄」(那在票务系统里完成),只负责把偏好次序与全部无冲突方案摆清楚。**红只留给真异常**(有的组合内部仍撞车,正常不会发生)"],
      ["顶栏「选片 · 行程」", "一个按钮 = 左侧滑出的**排片面板**(再点一次 / 面板内「收起 ✕」/ Esc 收起):面板**不遮挡网格**,只是把网格挤窄一点 —— 所以点选场次时始终能看到时间轴上的变化。**点开落在「我的选片」**(工作台中段:已收的片 + 每片全部可选场次;要看全部影片点旁边「影片库」tab)。面板内**三个 tab**:**影片库**(全部影片:搜索 / 单元筛选 / 「＋ 加入我的选片」)· **我的选片**(日期导航栏;每行「状态标签 + ⓘ + ✕」;**展开列该片全部可选场次**,按日期分节 —— 挑场次在这里)· **我的行程**(按日期分组的已排场次,2026-09-10 搬入抽屉 —— 常驻可见;**冲突组可拖动排顺位**,顶部有方案对比;卡片头与选片卡同款:**片名在上、影片信息行在下**)。三个 tab 共用同一套影片行 / 场次行,图标完全一致"],
      ["我的行程 ✕", "只移出这一场,选片保留 —— 该片仍留在「我的选片」里并标注「未排场」"],
    ].forEach(([k, v]) => {
      const li = el("li", "text-13 leading-[1.65]");
      li.append(el("b", "font-semibold text-ink", k), document.createTextNode(` — ${v}`));
      ul.appendChild(li);
    });
    wrap.appendChild(ul);
    wrap.appendChild(
      note(
        "行程质量分 = 场次数 + GV 场数 − 紧转场次数(「排了就算数」)。历史上还有过「档位(必看 / 备选 / 随缘)」—— 它已于 2026-09-11 整体删除:冲突决策改由「拖动顺位」承担,非冲突场景里档位只剩排序噪声。"
      )
    );
    body.appendChild(guideSection("我的选片", "MY PICKS", wrap));
  }

  // ---- 8 Notice(官方 Notice 块;2026-09-11 由「红点要点」改为官方素圆点条目)----
  body.appendChild(
    guideSection(
      "Notice",
      "特别提示",
      noticeList([
        "开闭幕:开幕式 + 开幕影片于首日在电影殿堂露天剧场(Roof Theater)举行;闭幕场放映「釜山奖(Busan Award)」获奖作 —— 本工具数据即取自官网 2026 排期页。",
        "GV(Guest Visit):部分韩国影片的映后谈可能不提供英语口译;部分非韩 / 英语影片的映后谈同样可能不提供英语口译。",
        "GV 日程可能在没有提前通知的情况下变更(schedules can be changed without beforehand notice)。",
        "4 岁以下儿童即使有家长陪同也不得入场。",
        "严禁拍照与录像(含预告片与片尾字幕)。",
        "放映开始 15 分钟后禁止入场;迟到者不保证保留座位。",
        "P&I(Press & Industry):面向电影节 / 市场 / 媒体证(badge)持有者的放映,先到先得;普通观众不入。",
        "官网排期会持续变动,场次 / 时间以 biff.kr 与现场公告为准。",
        "咨询电话 1666-9177(BIFF Call Center,工作时间 10:00–17:00,周末与公休日休息)。",
      ])
    )
  );

  return body;
}
