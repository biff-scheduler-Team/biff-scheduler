// 排片表「字段徽章 + 图例总览」单源模块(2025 官方 Schedule Guide 口径;2026 mock/待官方替换)
//  - 等级 / 字幕 / 节目册页码 等小徽章:随卡片/行程/影片库/详情弹层渲染,每枚带 data-tip 即时说明
//  - 「ⓘ 日程表说明」总览弹层内容(字段速读 / 等级 / 字幕 / 徽章 / 影院代码 / 网格图例 / 特别提示)
// 场馆名两层口径:紧凑层(甘特影厅列 / 影片库截断行)走 venues.json 的 `short` 短名,
// 详情层(hover tooltip / 本弹层表 / ICS LOCATION)给英文全名 + 韩名。
// 官方影院代码(BT/B1/C1/L2…)不单独当行标签,放行首 chip + 悬停说明。

import type { Catalog, RatingKey, Screening, SubsKey, Venue } from "./types";
import { el } from "./util";
import { BADGE_DEFS, badgeEl, codeTip, DOUBAN_CHIP_TITLE, screeningBadgeKeys, UNIFORM_CHIP_BASE } from "./badges";

/** 徽章基底(与 badges.ts 同字阶体系;全部字面量 → Tailwind v4 扫描可见) */
const CHIP_BASE =
  "not-italic text-10 font-extrabold rounded-3 px-[3px] py-px border leading-[1.45] " +
  "whitespace-nowrap select-none shrink-0 cursor-help inline-flex items-center";

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
    cls: `${CHIP_BASE} text-rate-all bg-rate-all-soft border-current`,
    zh: "全年龄",
    kr: "전체관람가",
    en: "All ages admitted",
    tip: "观影等级 ALL — 全年龄可观看\n전체관람가 · All ages admitted",
  },
  "12": {
    label: "12",
    cls: `${CHIP_BASE} text-rate-12 bg-rate-12-soft border-current`,
    zh: "12 岁以上",
    kr: "12세이상관람가",
    en: "Under 12 not admitted",
    tip: "观影等级 12(12세이상관람가)\n未满 12 岁不得入场 · Under 12 not admitted",
  },
  "15": {
    label: "15",
    cls: `${CHIP_BASE} text-biff-ink bg-biff-soft border-current`,
    zh: "15 岁以上",
    kr: "15세이상관람가",
    en: "Under 15 not admitted",
    tip: "观影等级 15(15세이상관람가)\n未满 15 岁不得入场 · Under 15 not admitted",
  },
  "19": {
    label: "19",
    cls: `${CHIP_BASE} text-rate-19 bg-rate-19-soft border-current`,
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
    cls: `${CHIP_BASE} text-ink-2 bg-card border-line`,
    en: "Korean Subtitles + English Subtitles or Dialogue",
    zh: "韩文字幕 + 英文字幕或英文对白(最常见)",
    tip: "字幕 KE — Korean Subtitles + English Subtitles or Dialogue\n韩文字幕 + 英文字幕或英文对白",
  },
  KN: {
    label: "KN",
    cls: `${CHIP_BASE} text-rate-12 bg-card border-rate-12 border-dashed`,
    en: "Korean Subtitles + Non-English Dialogue without English Subtitles",
    zh: "韩文字幕 + 非英语外语对白(无英字;外语观众慎选)",
    tip: "字幕 KN — Korean Subtitles + Non-English Dialogue without English Subtitles\n韩文字幕 + 非英语外语对白,不配英文字幕\n多为日 / 中 / 西语对白片,不熟该语言需留意",
  },
  KK: {
    label: "KK",
    cls: `${CHIP_BASE} text-ink bg-raised border-line-strong`,
    en: "Korean Subtitles + Korean Dialogue",
    zh: "韩文字幕 + 韩语对白(无外文字幕)",
    tip: "字幕 KK — Korean Subtitles + Korean Dialogue\n韩文字幕 + 韩语对白(无外文字幕;同时为听障观众提供语音 / 字幕解说)",
  },
  NO: {
    label: "NO",
    cls: `${CHIP_BASE} text-meta bg-card border-line`,
    en: "No Dialogue",
    zh: "无对白(实验 / 纪录 / 纯影像)",
    tip: "字幕 NO — No Dialogue\n无对白影片(实验 / 纪录 / 纯影像)",
  },
};

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
  node.dataset.tip = `片长 ${min} 分钟\n正片时长(不含映后谈)\nGV 场另有映后谈 — 时长可配置(设置里改全局默认,行程行 ⏱ 逐场覆写),可在卡片 / 行程里单独放弃`;
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
    "映后时长可配置:设置里改全局默认,行程行点 ⏱ 逐场覆写\n" +
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

/** 网格底色小色块(与顶栏图例条同款:10px 圆角色块 + 同色描边) */
function swatch(bg: string, borderCls: string): HTMLElement {
  const i = el("i", `inline-block w-[10px] h-[10px] rounded-3 mr-[5px] align-[-1px] border ${borderCls}`);
  i.style.background = bg;
  return i;
}

/** 图例行左键:色块 / 徽章 + 文字标签(整块作 key,行尾统一接「 — 说明」) */
function labeled(icon: HTMLElement, text: string): HTMLElement {
  const span = el("span", "inline-flex items-center");
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

/** 官方影院代码总表(按影院汇总;与上一张逐厅表互补 —— 这张按「影院」归并,
 *  便于与册子封底的影院代码页对表) */
const VENUE_CODES_2025: { group: string; list: [string, string][] }[] = [
  {
    group: "电影殿堂 Busan Cinema Center",
    list: [
      ["BT", "BIFF Theatre · 露天剧场"],
      ["BH", "Haneulyeon Theatre · 天空剧场"],
      ["B1", "Cinema 1 · 中剧场"],
      ["B2", "Cinema 2 · 小剧场"],
      ["B3", "Cinematheque"],
      ["BD", "Indieplus"],
    ],
  },
  {
    group: "CGV Centum City",
    list: [
      ["C1–C7", "CGV Centum City 1–7 号厅"],
      ["CX", "CGV Centum City IMAX"],
    ],
  },
  {
    group: "LOTTE CINEMA Centum City",
    list: [
      ["L2–L7", "LOTTE CINEMA Centum City 2–7 号厅"],
      ["L9 / L10", "LOTTE CINEMA Centum City 9 / 10 号厅"],
    ],
  },
  {
    group: "其他剧场",
    list: [
      ["KT", "KOFIC Theater · 韩国电影振兴委员会剧场"],
      ["SH", "Sohyang Theatre ShinhanCard Hall(东西大学)"],
      ["BCM", "Busan Community Media Center Open Hall"],
      ["M1–M4", "MEGABOX Busan Theater 1–4 号厅(南浦洞)"],
    ],
  },
];

/** 小标题(红方块标记,与面板 h2 同一视觉语言) */
function guideH(t: string): HTMLElement {
  return el(
    "div",
    "flex items-center gap-[6px] text-14 font-bold tracking-[0.01em] mb-[6px] " +
      "before:content-[''] before:w-[8px] before:h-[8px] before:border-[2.5px] before:border-biff before:rounded-2 before:box-border",
    t
  );
}

function mkTable(heads: string[]): { tbl: HTMLTableElement; tbody: HTMLTableSectionElement } {
  const tbl = el("table", "w-full border-collapse") as HTMLTableElement;
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  hr.className = "text-muted text-12 font-semibold text-left";
  heads.forEach((hd) => {
    const th = document.createElement("th");
    th.className = "py-[4px] pr-2 font-semibold whitespace-nowrap";
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
  tr.className = "border-b border-line-faint align-top";
  cells.forEach((c) => {
    const td = document.createElement("td");
    td.className = "py-[5px] pr-[10px] text-13 leading-[1.55]";
    if (typeof c === "string") td.textContent = c;
    else td.appendChild(c);
    tr.appendChild(td);
  });
  tbody.appendChild(tr);
}

function note(text: string): HTMLElement {
  return el("div", "text-muted text-12 leading-[1.6]", text);
}

function bullet(text: string): HTMLElement {
  return el(
    "li",
    "pl-[14px] relative text-13 leading-[1.6] before:content-[''] before:absolute before:left-0 before:top-[7px] before:w-[6px] before:h-[6px] before:bg-biff before:rounded-2",
    text
  );
}

/** 总览弹层主体(点击「ⓘ 日程表说明」打开;main.ts 装配) */
export function buildGuideBody(cat: Catalog): HTMLElement {
  const body = el("div", "grid gap-[16px]");

  // ---- 顶部提示 ----
  body.appendChild(
    note(
      "字段与代码口径参考 2025 第 30 届 BIFF 官网 Schedule Guide;本排期仍为 MOCK,2026 真实排期(9/11 发布)接入后内容自动更新。悬停任意小徽章即看即时解释;本页为总览。"
    )
  );

  // ---- 1 字段速读 ----
  body.appendChild(guideH("一格怎么读(示例)"));
  const demo = el("div", "flex flex-wrap items-center gap-[5px] bg-hover border border-line rounded-7 px-[10px] py-[7px]");
  demo.appendChild(timeField("09:00–10:40"));
  demo.appendChild(codeField("004"));
  demo.appendChild(chipEl(RATING_DEFS["15"]));
  demo.appendChild(chipEl(SUBS_DEFS.KE));
  demo.appendChild(badgeEl("gv"));
  demo.appendChild(pageChip(167));
  demo.appendChild(durChip(100, { boxed: true }));
  demo.appendChild(el("span", "text-13 text-muted", "Last Samurai Standing · 이쿠사가미: 전쟁의 신"));
  const sec1 = el("div", "grid gap-1");
  sec1.appendChild(demo);
  {
    // 「元素」列一律渲染真节点(章 / 字段),不再写纯文本 —— 纯文本既没有章的外形,
    // 也没有 data-tip,tip.ts 的文档级委托命不中 → 表现为「只有 GV 有悬停」。
    const { tbl, tbody } = mkTable(["元素", "含义"]);
    addRow(tbody, [timeField("09:00–10:40"), "放映时间(起–止,KST)。GV 映后场的结束时间 = 正片末 + 映后谈时长(正片 + 映后 N′),该段在卡片上单独可弃:放弃后按正片结束算转场。映后时长可配置:设置里给全局默认(默认 25 分钟),行程行点 ⏱ 可逐场覆写(留空 = 跟随默认)。跨午夜场(如通宵马拉松)按 24+ 时制显示为「23:59–次日 05:35」,时间轴同步外扩到次日并在 24:00 处画跨日分隔线"]);
    addRow(tbody, [codeField("004"), "放映 CODE — 本场唯一场次编号;同片多场各异,对表 / 抢票以此为准"]);
    addRow(tbody, [chipEl(RATING_DEFS["15"]), "观影等级 — 未满对应年龄不得入场(下节表)"]);
    addRow(tbody, [chipEl(SUBS_DEFS.KE), "字幕 / 对白标识(下节表);格内空白 = 未标注(英字 + 韩语对白)"]);
    addRow(tbody, [badgeEl("gv"), "Guest Visit — 嘉宾到场映后交流;官方提示可能临时变动"]);
    addRow(tbody, [durChip(100, { boxed: true }), "正片时长(分钟)"]);
    addRow(tbody, [pageChip(167), "官方节目册 Ticket Catalogue 页码 — 翻册找该场信息 / 票务说明"]);
    addRow(tbody, ["片名", "官方排期表原样:英文片名 + 韩文片名(本工具额外附中文名)"]);
    sec1.appendChild(tbl);
  }
  body.appendChild(sec1);

  // ---- 2 观影等级 ----
  body.appendChild(guideH("观影等级 Ratings"));
  {
    const { tbl, tbody } = mkTable(["标识", "中文", "한국어", "准入"]);
    (Object.keys(RATING_DEFS) as RatingKey[]).forEach((k) => {
      const d = RATING_DEFS[k];
      addRow(tbody, [chipEl(d), d.zh, d.kr, d.en]);
    });
    body.appendChild(tbl);
  }

  // ---- 3 字幕 / 对白标识 ----
  body.appendChild(guideH("字幕 / 对白标识 Subtitles"));
  {
    const { tbl, tbody } = mkTable(["标识", "官方英文(2025)", "中文"]);
    (Object.keys(SUBS_DEFS) as SubsKey[]).forEach((k) => {
      const d = SUBS_DEFS[k];
      addRow(tbody, [chipEl(d), d.en, d.zh]);
    });
    addRow(tbody, [blankChip(), SUBS_UNMARKED.en, SUBS_UNMARKED.zh]);
    body.appendChild(tbl);
  }

  // ---- 4 场次特性徽章 ----
  body.appendChild(guideH("场次特性徽章"));
  {
    const { tbl, tbody } = mkTable(["徽章", "含义"]);
    BADGE_DEFS.forEach((d) => {
      const chip = badgeEl(d.key);
      addRow(tbody, [chip, d.title]);
    });
    body.appendChild(tbl);
    body.appendChild(note("GV 徽章为实心黑(默认)。GV 场在网格里拆成「正片 + 映后谈」两张拼接卡:默认一起选中,点映后块或行程行开关可单独放弃(只选正片);放弃后该场按正片结束算转场/冲突/.ics 导出,该段仍留在时间轴上以虚线灰块示意「物理存在但我不参加」。**映后谈时长可配置**:设置里给全局默认(默认 25 分钟,改它 = 谈段长度与有效结束全链路跟着变),行程行点 ⏱ 可逐场覆写(留空 = 跟随默认;设 0 = 本场不拆映后段)。"));
  }

  // ---- 5 影院与代码 ----
  body.appendChild(guideH("影院与官方代码"));
  {
    const { tbl, tbody } = mkTable(["代码", "影厅(网格行标签 → 官方全名)", "分区"]);
    cat.venues.forEach((v) => {
      const codeCell = v.code ? chipEl({ label: v.code, cls: `${CHIP_BASE} text-biff-ink bg-biff-soft border-current`, tip: `影院代码 ${v.code} — 2025 届同馆口径(mock),2026 以官网为准` }) : el("span", "text-meta", "—");
      // 短名 ↔ 全名对照:用户照着网格列里的短名能在这里对回官方全名(否则「BCC Cinema 1」无从溯源)
      const nameCell = el("div", "grid gap-px");
      nameCell.append(
        el("div", "font-semibold text-ink", venueShort(v)),
        el("div", "text-12 text-meta", `${v.name}${v.name_kr ? ` · ${v.name_kr}` : ""}`)
      );
      addRow(tbody, [codeCell, nameCell, GROUP_AREA[v.group] ?? "—"]);
    });
    body.appendChild(tbl);

    const det = document.createElement("details");
    det.className = "mt-[4px] border border-line rounded-8 px-[10px] py-[6px]";
    const sum = document.createElement("summary");
    sum.className = "cursor-pointer text-13 font-semibold text-ink-2 select-none hover:text-biff-ink";
    sum.textContent = "官方日程表代码总表(2025 口径参考 — 点击展开)";
    det.appendChild(sum);
    VENUE_CODES_2025.forEach((g) => {
      const gHead = el("div", "mt-[6px] mb-[2px] text-12 font-bold text-muted", g.group);
      const { tbl: t2, tbody: tb2 } = mkTable(["代码", "剧场"]);
      g.list.forEach(([code, name]) => addRow(tb2, [code, name]));
      det.append(gHead, t2);
    });
    body.appendChild(det);
  }

  // ---- 6 网格图例(红绿灯底色:已选 / 时间紧张 / 完全冲突) ----
  body.appendChild(guideH("网格与行程图例"));
  {
    // 行首一律真节点:三种底色用网格卡同色色块(色值取自 style.css in-plan / TIGHT_BG / in-conf),
    // GV 用卡面同款徽章,豆瓣用影片库同款章 —— 不写成文字,读图例即读卡面。
    const lines: [string | HTMLElement, string][] = [
      [
        labeled(swatch("color-mix(in srgb, var(--color-ok) 14%, var(--color-card))", "border-ok"), "绿底 · 已选"),
        "已加入当前方案(A/B)的场次 — 整卡淡绿底。档位不染网格卡:请在「影片库」卡片 / 行程卡 / 影片资料弹层点 ★ 设置(蓝 = 必看 / 品红 = 备选 / 灰蓝 = 随缘),冲突取舍与抢票顺位按此排",
      ],
      [
        labeled(swatch("color-mix(in srgb, var(--color-tight) 24%, var(--color-card))", "border-tight"), "黄底 · 时间紧张"),
        "同方案相邻两场衔接紧:间隔小于转场缓冲(转场不足)或余量 <15min(偏紧)— 两张卡整卡淡黄底,hover 卡片查看完整算式",
      ],
      [
        labeled(swatch("color-mix(in srgb, var(--color-conf) 14%, var(--color-card))", "border-conf"), "红底 · 完全冲突"),
        "同方案(A 或 B)内两场放映时间重叠,无法同时观看 — 整卡红底 + 红框 + ⚠;hover 联动高亮整个冲突组",
      ],
      [
        badgeEl("gv"),
        "Guest Visit 嘉宾映后 — 默认连映后谈一起选(两张拼接卡同亮),可在映后块/行程单独放弃,放弃后按正片结束算转场;映后时长可配置(设置里改默认值,行程行 ⏱ 逐场覆写)",
      ],
      [doubanChip(8.5), "豆瓣用户评分(满分 10 分,仅影片库 / 详情出现)"],
    ];
    const ul = el("ul", "grid gap-[3px]");
    lines.forEach(([k, v]) => {
      const li = el("li", "text-13 leading-[1.6]");
      if (typeof k === "string") li.textContent = `${k} — ${v}`;
      else li.append(k, document.createTextNode(` — ${v}`));
      ul.appendChild(li);
    });
    body.appendChild(ul);
  }

  // ---- 7 我的选片(唯一数据源)----
  body.appendChild(guideH("我的选片"));
  {
    const ul = el("ul", "grid gap-[3px]");
    [
      ["一部片一条记录", "「我的选片」与「我的行程」是同一份数据的两个视图:按片看是选片清单,按场次看是行程。没有第二份拷贝,两边永远一致"],
      ["必看 / 备选 / 随缘", "档位由**一枚 ★ 星标**表达(★ = 已定档,按档位着色;**蓝 = 必看 / 品红 = 备选 / 灰蓝 = 随缘**;☆ = 未设),点击弹出「必看 / 备选 / 随缘 / 清除档位」菜单 —— 三处完全同款:「影片库」卡片右上角、「我的行程」行程卡、影片资料弹层(2026-09-10 起弹层也由三段文字 seg 改为同一枚 ★)。档位是「影片级」的:改一处,该片所有场次同步"],
      ["场次只在一处选", "影片行展开 = 唯一场次列表(两个 tab 同款):每场并排「定位 ▸」(跳到时间轴)与「＋ 加入」(加入后变「✓ 已加入」,再点即移出;这场在另一方案时显示「⇄ 已在 B」);「ⓘ」只开影片资料 + 豆瓣,不再重复列排片"],
      ["甘特 ★ 档位", "定档后,甘特卡标题行前出现一枚 ★(**蓝=必看 / 品红=备选 / 灰蓝=随缘**,2026-09-10 由 7px 色点改为 15px 星标)——与整卡红绿灯底色相互独立:底色说「排得怎么样」,★ 说「是不是我想看的」。档位刻意用冷色系,避开底色的红/黄/绿;备选由「紫」改「品红」是因为蓝紫只差 48° 色相,小尺寸下分不出。同一枚 ★ 也出现在「影片库」卡片右上角、行程卡与影片资料弹层"],
      ["顶栏「选片 · 行程」", "一个按钮 = 左侧滑出的**排片面板**(再点一次 / 面板内「收起 ✕」/ Esc 收起):面板**不遮挡网格**,只是把网格挤窄一点 —— 所以打标、点选场次时始终能看到时间轴上的变化。面板内**三个 tab**:· **影片库**(全部影片:搜索 / 单元筛选)· **我的选片**(日期导航栏 + 档位 chips;每行只剩「状态标签 + ⓘ + ✕」;展开只列**已排场次**并按日期分节)· **我的行程**(按日期分组的已排场次,原在主页面下方,2026-09-10 搬入 —— 常驻可见;卡片头与选片卡同款:**片名在上、影片信息行在下**)。三个 tab 共用同一套影片行 / 场次行,打标与图标完全一致"],
      ["我的行程 ✕", "只移出这一场,选片意向保留 —— 该片仍留在「我的选片」里并标注「未排场」,「智能排片」照样会把它排进去"],
      ["智能排片", "**唯一排片通道**(原「本地引擎」已下线)。需你自己填入模型 API Key(DeepSeek / OpenAI / Moonshot / 硅基流动 / 自定义均可),由浏览器直连服务商生成一版建议行程,再选「并入 A / B 方案」(已有场次保留,只追加不冲突的新场次)。可先在「② 排哪几天」收窄日期;一部片都没打标也能排 —— 走「无片单模式」,怎么排看偏好文字。返回结果会本地复检:无效 code、同片多场、时段冲突一律剔除并明示,不信任模型的自我约束"],
      ["API Key 只在本机", "Key 只写入本机浏览器的 localStorage,不上传本站服务器、也不进任何发往本站的请求;排片请求由浏览器直连你填写的服务商。本站不提供也不转售模型服务(用你自己的额度),因此也读不到你的 Key。浏览器本地为明文存储 —— 公用电脑请勿保存,随时可在「设置」或弹层里点「清除 Key」"],
    ].forEach(([k, v]) => ul.appendChild(el("li", "text-13 leading-[1.6]", `${k} — ${v}`)));
    body.appendChild(ul);
    body.appendChild(
      note(
        "档位只有一份,且在影片级 —— 行程卡里的 ★ 改的就是该片的档位(同片多场同步,提示里会写明「本片共 N 场」)。「未设」= 只点了场次还没定档:不参与质量分与抢票顺位,也不进智能排片;去「影片库」或弹层点 ★ 补一个档位即可。"
      )
    );
  }

  // ---- 8 特别提示 ----
  body.appendChild(guideH("特别提示"));
  {
    const ul = el("ul", "grid gap-[5px]");
    ul.appendChild(
      bullet("开闭幕:开幕式 + 开幕影片通常在首日于 BIFF Theatre(露天剧场)举行;闭幕场放映「釜山奖(Busan Award)」获奖作 — 均为 2025 届口径,2026 以官网为准。")
    );
    ul.appendChild(
      bullet("GV:Guest Visit 嘉宾到场安排可能在没有提前通知的情况下发生变化(subject to change without notice)。")
    );
    ul.appendChild(
      bullet("P&I(Press & Industry):面向电影节 / 市场 / 媒体证(badge)持有者的放映,先到先得(first come, first served),提供韩文字幕;普通观众不入 — 若参加以当届官方解释为准。")
    );
    ul.appendChild(
      bullet("节目册 Ticket Catalogue 于排期发布时印刷;其后场次 / 时间变动以 biff.kr 官网为准。")
    );
    ul.appendChild(
      bullet("咨询电话 1666-9177(2025 届官方客服;2026 以官网更新为准)。")
    );
    body.appendChild(ul);
  }

  return body;
}
