// 场次特性徽章(16-F)— 单一注册表:grid 卡 / agenda 行 / 影片库 / 详情弹层共用。
// 数据侧:Screening.is_gv 隐含 "gv";Screening.tags 存其余特性键(如 "masterclass")。
// 官方真实排期导入后,只需扩展此注册表 + schedule.json 里的 tags,无需改渲染逻辑。
//
// 缩写/CODE 说明（口径取自 2025 第 30 届 BIFF 官网英文 timetable 的
// Schedule Guide 原文。合理筛选:本工具场馆显示完整英文名,故 2025 影院代码
// (B1/C1/L2…)不收录;Goodwill 捐赠场非场次标记且官网图例未载,不收录。

import type { Screening } from "./types";
import { el } from "./util";

/** 卡片/行程/影片库行内 CODE 数字的 hover 说明(标题 + 分点;tip.ts 渲染) */
export function codeTip(code: string): string {
  return [
    `放映 CODE ${code}`,
    "官方日程表里本场放映的场次编号",
    "同片多场各有独立 CODE — 对表 / 抢票以此为准",
  ].join("\n");
}

/** 「豆 x.x」评分章的 hover 说明(豆 = 豆瓣) */
export const DOUBAN_CHIP_TITLE = "豆瓣用户评分(满分 10 分)";

/** 排片表缩写总览(单源;网格图例「ⓘ 缩写说明」用)。逐行 mark — 中文释义(渲染成标题 + 分点) */
const ABBR_LINES: [string, string][] = [
  ["CODE 001", "场次编号 — 每场放映唯一,同片多场编号不同;对表 / 抢票以此为准"],
  ["评级 ALL / 12 / 15 / 19", "观影年龄分级 — 未满对应年龄不得入场(ALL = 全年龄)"],
  ["字幕 KE / KN / KK / NO", "KE = 韩字 + 英字/英配 · KN = 韩字 + 非英外语 · KK = 韩字 + 韩配 · NO = 无对白 · 无标 = 英字 + 韩配 · **可同时标注多个**(如 KE KK)"],
  ["GV", "Guest Visit 嘉宾到场 — 映后交流(可在卡片 / 行程单独放弃;官方提示:可能临时变动)"],
  ["Talk", "对谈 / 分享场 — 官方 Community BIFF 토크 单元(2025 例:커비북스 图书 · 잇츠시네마 饮食)"],
  ["评论音轨", "Commentary — 实时双向评论音轨场(실시간 양방향 코멘터리 픽쳐 쇼);放映全程叠加人声解说 / 互动"],
  ["Event", "联动活动场 — 官方 연계이벤트(2025 例:907 라이브 드로잉 现场作画)"],
  ["묶", "Batch Screening 连场放映"],
  ["联映", "Midnight Passion 联映块 — 一张票连看 2~3 部(2025 共 4 块 / 10 部);格子只印块名,成员片名见详情弹层;成员片的介绍页会把该块 CODE 列为自己的一场"],
];

/** 图例悬停用的多行说明文本(第 1 行标题,其余为分点) */
export function abbrTooltip(): string {
  return ["排片表标记说明(官方口径)", ...ABBR_LINES.map(([m, zh]) => `${m} — ${zh}`)].join("\n");
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
    title:
      "GV · 嘉宾到场映后对谈\n" +
      "本工具把 GV 场拆成「正片 + 映后谈」两段:默认一起选,可点映后块 / 行程开关单独放弃\n" +
      "放弃后该场按正片结束算转场,后续冲突即时放宽\n" +
      "映后时长可配置:设置里改全局默认,行程行点 ⏱ 逐场覆写\n" +
      "官方提示:场次可能临时变动,部分场次无英文口译",
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
  // ---- 特别节目(2025 Community BIFF 单元;解析器 tags 直出这三个键)----
  // 配色:青绿族(--ev-teal),与档位色(蓝/紫/灰蓝)、红绿灯(红/黄/绿)、
  // 观影等级(绿/橙/深红)三族全部错开;三者靠「实心 → 实线描边 → 虚线描边」分权重。
  {
    key: "talk",
    label: "Talk",
    title:
      "Talk · 对谈 / 分享场\n" +
      "官方 Community BIFF 的 토크 单元 — 主题对谈 / 分享(2025 例:커비북스 图书 · 잇츠시네마 饮食)\n" +
      "与 GV 的区别:GV 是「剧组 / 嘉宾到场」,Talk 是「主题对谈节目」;两者可能同场并存",
    // 实心青绿底 + 白字:与 gv 的实心黑同族,表达「有人到场」
    cls: "px-1 py-px text-on-brand bg-ev-teal",
  },
  {
    key: "commentary",
    label: "评论音轨",
    title:
      "Commentary · 实时双向评论音轨场\n" +
      "官方原文 실시간 양방향 코멘터리 픽쳐 쇼 — 放映全程叠加实时双向评论音轨\n" +
      "观影体验与常规场不同:全程有人声解说 / 互动",
    // 实线描边:表达「额外挂了一条音轨」(不是到场、也不是活动)
    cls: "px-[3px] py-px text-ev-teal bg-card border border-ev-teal",
  },
  {
    key: "event",
    label: "Event",
    title:
      "Event · 联动活动场\n" +
      "官方 Community BIFF 的 연계이벤트 — 与放映联动的现场演出 / 活动(2025 例:907 라이브 드로잉 现场作画)",
    // 虚线描边 + 浅底:表达「非正式节目 / 临时活动」;与 batch 的虚线区分在色相
    cls: "px-[3px] py-px text-ev-teal bg-ev-teal-soft border border-ev-teal border-dashed",
  },
  // ---- 午夜场联映块(2025 Midnight Passion 单元;解析器 tags 直出 "midnight")----
  // 实心青绿与 talk 同款:两者都表示「这不是一场普通放映」,但语义不重叠 ——
  // talk 是主题对谈节目,midnight 是「一块多片」的售票结构;两者都按标题关键词判定,
  // 同一场不会同时命中,视觉撞色无实际影响,靠 label 文案区分。
  {
    key: "midnight",
    label: "联映",
    title:
      "联映 · Midnight Passion 联映块\n" +
      "官方午夜场单元:一个块 = 一张票连看 2~3 部(2025 共 4 块 / 10 部)\n" +
      "格子里只印块名(如 Midnight Passion 1),块内成员片名见详情弹层\n" +
      "注意:成员片的介绍页会把该块 CODE 列为自己的一场 —— 那一条就是这张块票",
    cls: "px-1 py-px text-on-brand bg-ev-teal",
  },
];

/** 徽章基础字阶 / 排版(所有变体共享) */
const BADGE_BASE =
  "not-italic text-[9.5px] font-extrabold rounded-[3px] leading-[1.4] whitespace-nowrap select-none shrink-0 cursor-help";

/* ---------- 统一章(uniform)—— 影片行「场次行」的元数据标签组专用 ----------
 * 需求(PLAN-20260910184745 §8):标签组要**统一高度 / 圆角 / 描边 / 字色(灰)**,只给
 * 「观影等级」留一点强调色边框;GV 等原先的黑底 / 红底实心章在密集的场次行里太吵,统一降为中性描边。
 * ⚠ 只作用于 `appendMetaRow(..., { uniform: true })`(影片行场次行),**网格卡 / 行程行不受影响** ——
 *   那两处的实心 GV 是「扫一眼看到有映后谈」的主信号,不能一起抹平。
 * 字阶 9.5 → 10.5px 并统一 `rounded-[4px] px-[5px] py-[2px]`:原各变体的 padding / 圆角 / 字阶
 * 互不相同,并排时高度参差(那正是「统一高度和圆角」要修的东西)。 */
export const UNIFORM_CHIP_BASE =
  "not-italic text-[10.5px] rounded-[4px] px-[5px] py-[2px] border leading-[1.35] " +
  "whitespace-nowrap select-none shrink-0 cursor-help inline-flex items-center";
/** 中性描边(默认;等级章另走 legend.ts 的强调色描边) */
export const UNIFORM_CHIP = `${UNIFORM_CHIP_BASE} font-semibold text-ink-2 bg-card border-line`;

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

/** 单个徽章 DOM — gv 走 BADGE_DEFS 中 cls(gv 默认实心黑),其它走各自变体。
 *  `opts.uniform` = 忽略该键自己的配色改走中性描边(label / tooltip 不变),见 UNIFORM_CHIP_BASE。 */
export function badgeEl(key: string, opts?: { uniform?: boolean }): HTMLElement {
  const def = defByKey.get(key);
  const cls = opts?.uniform ? UNIFORM_CHIP : `${BADGE_BASE} ${def?.cls ?? BADGE_DEFS[0].cls}`;
  const node = el("i", cls, def?.label ?? key);
  if (def?.title) node.dataset.tip = def.title; // 缩写说明:悬停即时解释(经 tip.ts)
  return node;
}

/** 把某场次的全部特性徽章 append 到容器(保持内联流式布局) */
export function appendBadges(host: HTMLElement, s: Screening, opts?: { uniform?: boolean }): void {
  for (const k of screeningBadgeKeys(s)) host.appendChild(badgeEl(k, opts));
}