// 排片表「字段徽章 + 图例总览」单源模块(2025 官方 Schedule Guide 口径;2026 mock/待官方替换)
//  - 等级 / 字幕 / 节目册页码 等小徽章:随卡片/行程/影片库/详情弹层渲染,每枚带 data-tip 即时说明
//  - 「ⓘ 日程表说明」总览弹层内容(字段速读 / 等级 / 字幕 / 徽章 / 影院代码 / 网格图例 / 特别提示)
// 场馆行与弹层只显示英文全名 → 官方影院代码(BT/B1/C1/L2…) 不直接当行标签用,改放图例与悬停说明。

import type { Catalog, RatingKey, Screening, SubsKey, Venue } from "./types";
import { el } from "./util";
import { BADGE_DEFS, badgeEl, screeningBadgeKeys } from "./badges";

/** 徽章基底(与 badges.ts 同字阶体系;全部字面量 → Tailwind v4 扫描可见) */
const CHIP_BASE =
  "not-italic text-[9.5px] font-extrabold rounded-[3px] px-[3px] py-px border leading-[1.45] " +
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
    cls: `${CHIP_BASE} text-biff bg-biff-soft border-current`,
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

/** 单个徽章 DOM(label + data-tip) */
function chipEl(def: { label: string; cls: string; tip: string }): HTMLElement {
  const node = el("i", def.cls, def.label);
  node.dataset.tip = def.tip;
  return node;
}

/** 节目册页码徽章:P.167 */
export function pageChip(page: number): HTMLElement {
  return chipEl({
    label: `P.${page}`,
    cls: `${CHIP_BASE} text-meta bg-card border-line`,
    tip: `节目册页码 P.${page}\n该场在官方 Ticket Catalogue(节目册)中的页码;购票 / 翻册对表用`,
  });
}

/** 片长徽章:100'(仅供排片网格;行程/弹层已有片长文本) */
export function durChip(min: number): HTMLElement {
  const node = el("i", `${CHIP_BASE} text-meta bg-transparent border-transparent px-[2px]`, `${min}'`);
  node.dataset.tip = `片长 ${min} 分钟(正片时长;GV 映后已把 +25min 计入结束时间)`;
  return node;
}

/**
 * 场次完整字段徽章流,按官方格序追加到 host:
 * 等级 → 字幕 → 场次特性(GV/首映/大师班…) → 节目册页码。
 * host 应为 flex/flex-wrap 容器(grid 卡 chips 行 / 行程标题行 / 弹层 when 行 / 影片库行)。
 */
export function appendMetaRow(host: HTMLElement, s: Screening): void {
  const rate = s.rating ? RATING_DEFS[s.rating] : null;
  if (rate) host.appendChild(chipEl(rate));
  const subs = s.subs ? SUBS_DEFS[s.subs] : null;
  if (subs) host.appendChild(chipEl(subs));
  for (const k of screeningBadgeKeys(s)) host.appendChild(badgeEl(k));
  if (typeof s.page === "number" && s.page > 0) host.appendChild(pageChip(s.page));
}

/* ---------------- 影院代码 / 分区 ---------------- */
const GROUP_AREA: Record<string, string> = {
  bcc: "CENTUM 主场 · 电影殿堂(Busan Cinema Center)",
  centum: "CENTUM 主场区(电影殿堂 / CGV / LOTTE / KOFIC / Sohyang / Community Media Center)",
  haeundae: "海云台区 — 非本届官方 8 馆名单(仅 mock 跨馆演示)",
};

/** 场馆行悬停说明(全名 + 韩文名 + 分区 + 官方代码) */
export function venueTip(v: Venue): string {
  const lines = [v.name];
  if (v.name_kr) lines.push(v.name_kr);
  lines.push(GROUP_AREA[v.group] ?? "—");
  if (v.code) {
    lines.push(`官方日程表影院代码 ${v.code} — 按此与官方 Catalogue 对表(mock 演示,2026 以官网为准)`);
  }
  return lines.join("\n");
}

/* ================================================================
 * 「ⓘ 日程表说明」总览弹层内容
 * ================================================================ */

/** 2025 官方代码总表(参考口径;2026 以 9/11 官网为准) */
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
    "flex items-center gap-[6px] text-[13.5px] font-bold tracking-[0.01em] mb-[6px] " +
      "before:content-[''] before:w-[8px] before:h-[8px] before:border-[2.5px] before:border-biff before:rounded-[2px] before:box-border",
    t
  );
}

function mkTable(heads: string[]): { tbl: HTMLTableElement; tbody: HTMLTableSectionElement } {
  const tbl = el("table", "w-full border-collapse") as HTMLTableElement;
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  hr.className = "text-muted text-[11.5px] font-semibold text-left";
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
    td.className = "py-[5px] pr-[10px] text-[12.5px] leading-[1.55]";
    if (typeof c === "string") td.textContent = c;
    else td.appendChild(c);
    tr.appendChild(td);
  });
  tbody.appendChild(tr);
}

function note(text: string): HTMLElement {
  return el("div", "text-muted text-[12px] leading-[1.6]", text);
}

function bullet(text: string): HTMLElement {
  return el(
    "li",
    "pl-[14px] relative text-[12.5px] leading-[1.6] before:content-[''] before:absolute before:left-0 before:top-[7px] before:w-[6px] before:h-[6px] before:bg-biff before:rounded-[1.5px]",
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
  const demo = el("div", "flex flex-wrap items-center gap-[5px] bg-hover border border-line rounded-[7px] px-[10px] py-[7px]");
  demo.appendChild(el("b", "text-[12.5px] tabular-nums", "09:00–10:40"));
  demo.appendChild(el("b", "text-[12.5px] text-biff", "004"));
  demo.appendChild(chipEl(RATING_DEFS["15"]));
  demo.appendChild(chipEl(SUBS_DEFS.KE));
  demo.appendChild(badgeEl("gv"));
  demo.appendChild(pageChip(167));
  demo.appendChild(durChip(100));
  demo.appendChild(el("span", "text-[12.5px] text-muted", "Last Samurai Standing · 이쿠사가미: 전쟁의 신"));
  const sec1 = el("div", "grid gap-1");
  sec1.appendChild(demo);
  {
    const { tbl, tbody } = mkTable(["元素", "含义"]);
    addRow(tbody, ["09:00–10:40", "放映时间(起–止,当地 KST);GV 映后场官方把结束时间已含 +25min"]);
    addRow(tbody, ["004", "放映 CODE — 本场唯一场次编号;同片多场各异,对表 / 抢票以此为准"]);
    addRow(tbody, ["15", "观影等级 — 未满对应年龄不得入场(下节表)"]);
    addRow(tbody, ["KE", "字幕 / 对白标识(下节表);格内空白 = 未标注(英字 + 韩语对白)"]);
    addRow(tbody, ["GV", "Guest Visit — 嘉宾到场映后交流;官方提示可能临时变动"]);
    addRow(tbody, ["100'", "正片时长(分钟)"]);
    addRow(tbody, ["P.167", "官方节目册 Ticket Catalogue 页码 — 翻册找该场信息 / 票务说明"]);
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
    addRow(tbody, ["(空白)", SUBS_UNMARKED.en, SUBS_UNMARKED.zh]);
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
    addRow(tbody, ["묶", "Batch Screening — 连场连续放映(官方偶用,显示即以此为义)"]);
    body.appendChild(tbl);
    body.appendChild(note("GV 徽章为实心黑(默认);本工具里 GV 场次的结束时间已含 +25min 映后时长,冲突判定与 .ics 导出同口径。"));
  }

  // ---- 5 影院与代码 ----
  body.appendChild(guideH("影院与官方代码"));
  {
    const { tbl, tbody } = mkTable(["代码", "影厅(本工具行标签)", "分区"]);
    cat.venues.forEach((v) => {
      const codeCell = v.code ? chipEl({ label: v.code, cls: `${CHIP_BASE} text-biff bg-biff-soft border-current`, tip: `影院代码 ${v.code} — 2025 届同馆口径(mock),2026 以官网为准` }) : el("span", "text-meta", "—");
      addRow(tbody, [codeCell, `${v.name}${v.name_kr ? `\n${v.name_kr}` : ""}`, GROUP_AREA[v.group] ?? "—"]);
    });
    body.appendChild(tbl);

    const det = document.createElement("details");
    det.className = "mt-[4px] border border-line rounded-[8px] px-[10px] py-[6px]";
    const sum = document.createElement("summary");
    sum.className = "cursor-pointer text-[12.5px] font-semibold text-ink-2 select-none hover:text-biff";
    sum.textContent = "官方日程表代码总表(2025 口径参考 — 点击展开)";
    det.appendChild(sum);
    VENUE_CODES_2025.forEach((g) => {
      const gHead = el("div", "mt-[6px] mb-[2px] text-[12px] font-bold text-muted", g.group);
      const { tbl: t2, tbody: tb2 } = mkTable(["代码", "剧场"]);
      g.list.forEach(([code, name]) => addRow(tb2, [code, name]));
      det.append(gHead, t2);
    });
    body.appendChild(det);
  }

  // ---- 6 网格图例(优先级 / 冲突 / 转场) ----
  body.appendChild(guideH("网格与行程图例"));
  {
    const lines: [string, string][] = [
      ["必看 / 备选 / 随缘", "优先级:红 / 琥珀 / 灰 — 冲突时按序取舍,抢票顺位亦按此排"],
      ["⚠ 同方案冲突", "同一方案(A 或 B)内两场时间重叠 — 卡片红框斜纹"],
      ["▌紧转场(琥珀边)", "同方案相邻两场间隔偏紧(余量 <15min),两卡衔接侧描边"],
      ["▌转场不足(红边)", "扣除跨馆缓冲后赶不上(余量 <0),衔接侧描边 + 行程内「需缓冲」"],
      ["GV(实心黑标)", "Guest Visit 嘉宾映后(本工具已把结束时间含 +25min)"],
      ["豆 x.x", "豆瓣用户评分(满分 10 分,仅影片库 / 详情出现)"],
    ];
    const ul = el("ul", "grid gap-[3px]");
    lines.forEach(([k, v]) => {
      ul.appendChild(el("li", "text-[12.5px] leading-[1.6]", `${k} — ${v}`));
    });
    body.appendChild(ul);
  }

  // ---- 7 特别提示 ----
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
