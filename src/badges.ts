// 场次特性徽章(16-F)— 单一注册表:grid 卡 / agenda 行 / 影片库 / 详情弹层共用。
// 数据侧:Screening.is_gv 隐含 "gv";Screening.tags 存其余特性键(如 "masterclass")。
// 官方真实排期导入后,只需扩展此注册表 + schedule.json 里的 tags,无需改渲染逻辑。
//
// 缩写/CODE 说明（口径取自 2025 第 30 届 BIFF 官网英文 timetable 的
// Schedule Guide 原文。合理筛选:本工具场馆显示完整英文名,故 2025 影院代码
// (B1/C1/L2…)不收录;Goodwill 捐赠场非场次标记且官网图例未载,不收录。

import type { Screening } from "./types";
import { el } from "./util";

/** 卡片/行程/影片库行内 CODE 数字的 hover 说明 */
export function codeTip(code: string): string {
  return `放映 CODE ${code} — 官方日程表里本场放映的场次编号(同片多场各有独立 CODE;对表/抢票以此为准)`;
}

/** 「豆 x.x」评分章的 hover 说明(豆 = 豆瓣) */
export const DOUBAN_CHIP_TITLE = "豆瓣用户评分(满分 10 分)";

/** 排片表缩写总览(单源;网格图例「ⓘ 缩写说明」用)。逐行 mark — 中文释义 */
const ABBR_LINES: [string, string][] = [
  ["CODE 001", "场次编号 — 每场放映唯一,同片多场编号不同;对表/抢票以此为准"],
  ["评级 ALL / 12 / 15 / 19", "观影年龄分级 — 未满对应年龄不得入场(ALL=全年龄)"],
  ["字幕 KE / KN / KK / NO", "KE=韩字+英字/英配 · KN=韩字+非英外语 · KK=韩字+韩配 · NO=无对白 · 无标=英字+韩配"],
  ["GV", "Guest Visit 嘉宾到场 — 映后交流(可在卡片/行程单独放弃:放弃后该场按正片结束算转场;官方提示:可能临时变动,部分场次无英文口译)"],
  ["묶", "Batch Screening 连场放映"],
];

/** 图例悬停用的多行说明文本 */
export function abbrTooltip(): string {
  return "排片表标记说明(官方口径)\n" + ABBR_LINES.map(([m, zh]) => `${m} — ${zh}`).join("\n");
}

export interface BadgeDef {
  key: string;
  label: string;
  title: string; // hover 解释
  /** 徽章变体对应的 Tailwind utility 组合(不含基础字阶/圆角);key=gv 时作为默认 */
  cls: string;
}

/** 注册表 — 新增样式只改这里 */
export const BADGE_DEFS: BadgeDef[] = [
  {
    key: "gv",
    label: "GV",
    title: "Guest Visit · 嘉宾到场映后对谈(本工具把 GV 场拆成「正片 + 映后谈」两段:默认一起选,可点映后块/行程开关单独放弃;放弃后该场按正片结束算转场。官方提示:场次可能临时变动)",
    // GV 默认外观:实心黑底白字(与历史 .gv-tag 等价)
    cls: "px-1 py-px text-on-brand bg-ink",
  },
  {
    key: "masterclass",
    label: "大师班",
    title: "Masterclass · 大师班 / 特别讲座",
    cls: "px-1 py-px text-on-brand bg-biff",
  },
  {
    key: "premiere",
    label: "首映",
    title: "Premiere · 首映场",
    // 描边 chip 与等级/字幕(KE)同 padding 口径(px-[3px] py-px),文字不压边框
    cls: "px-[3px] py-px text-biff bg-card border border-biff",
  },
  {
    key: "open_talk",
    label: "Open Talk",
    title: "Open Talk · 映后公开对谈",
    cls: "px-[3px] py-px text-ink bg-card border border-ink",
  },
  {
    key: "batch",
    label: "묶",
    title: "Batch Screening · 连场连续放映(官方偶用;显示即以此为义)",
    // 虚线描边 = 「成组/连场」;与 premiere/open_talk 的实线描边区分,不与 KN 的虚线撞(那是等级色虚线)
    cls: "px-[3px] py-px text-ink-2 bg-card border border-line-strong border-dashed",
  },
];

/** 徽章基础字阶 / 排版(所有变体共享) */
const BADGE_BASE =
  "not-italic text-[9.5px] font-extrabold rounded-[3px] leading-[1.4] whitespace-nowrap select-none shrink-0 cursor-help";

const defByKey = new Map(BADGE_DEFS.map((d) => [d.key, d]));

/** 该场次的特性键列表(去重保序:gv 恒在首位,其后按 tags 原序) */
export function screeningBadgeKeys(s: Screening): string[] {
  const keys: string[] = [];
  const push = (k: string): void => {
    if (!defByKey.has(k)) return; // 未注册的键忽略,向前兼容
    if (!keys.includes(k)) keys.push(k);
  };
  if (s.is_gv) push("gv");
  for (const t of s.tags ?? []) push(t);
  return keys;
}

/** 单个徽章 DOM — gv 走 BADGE_DEFS 中 cls(gv 默认实心黑),其它走各自变体 */
export function badgeEl(key: string): HTMLElement {
  const def = defByKey.get(key);
  const cls = `${BADGE_BASE} ${def?.cls ?? BADGE_DEFS[0].cls}`;
  const node = el("i", cls, def?.label ?? key);
  if (def?.title) node.dataset.tip = def.title; // 缩写说明:悬停即时解释(经 tip.ts)
  return node;
}

/** 把某场次的全部特性徽章 append 到容器(保持内联流式布局) */
export function appendBadges(host: HTMLElement, s: Screening): void {
  for (const k of screeningBadgeKeys(s)) host.appendChild(badgeEl(k));
}