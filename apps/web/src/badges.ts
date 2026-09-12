import type {Screening} from './types';

export function codeTip(code: string): string {
  return [
    `放映 CODE ${code}`,
    "官方日程表里本场放映的场次编号",
    "同片多场各有独立 CODE — 对表 / 抢票以此为准",
  ].join("\n");
}

export const DOUBAN_CHIP_TITLE = "豆瓣用户评分(满分 10 分)";

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

export const BADGE_DEFS: BadgeDef[] = [
  {
    key: "gv",
    label: "GV",
    title:
      "GV · 嘉宾到场映后对谈\n" +
      "本工具把 GV 场拆成「正片 + 映后谈」两段:默认一起选,可点映后块 / 行程开关单独放弃\n" +
      "放弃后该场按正片结束算转场,后续冲突即时放宽\n" +
      "映后时长可配置:设置里改全局默认,行程行点映后标签的数字逐场覆写\n" +
      "官方提示:场次可能临时变动,部分场次无英文口译",
    // GV 默认外观:实心**紫**底白字(2026-09-11 起对齐官方新版 Schedule Guide 的 Information 列)
    // ⚠ 底走 `gv-solid` 这个专用 token,不再用 `ink-solid` —— 官方把 GV 画成紫色,
    //    而 `bg-ink` 在暗色下会被提亮成近白 → 白底白字。专用 token 两套主题同值。
    cls: "px-1 py-px text-on-brand bg-gv-solid",
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
    cls: "px-[3px] py-px text-biff-ink bg-card border border-biff",
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
    // 官方新版把 묶 画成近黑实底(与 GV 的紫、字幕的彩底都错开),这里照搬
    cls: "px-1 py-px text-on-brand bg-batch-solid",
  },
  // ---- 特别节目(2025 Community BIFF 单元;解析器 tags 直出这三个键)----
  // 配色:青绿族(--ev-teal),与红绿灯(红/黄/绿)、观影等级(绿/橙/深红)两族错开;
  // 三者靠「实心 → 实线描边 → 虚线描边」分权重。
  {
    key: "talk",
    label: "Talk",
    title:
      "Talk · 对谈 / 分享场\n" +
      "官方 Community BIFF 的 토크 单元 — 主题对谈 / 分享(2025 例:커비북스 图书 · 잇츠시네마 饮食)\n" +
      "与 GV 的区别:GV 是「剧组 / 嘉宾到场」,Talk 是「主题对谈节目」;两者可能同场并存",
    // 实心青绿底 + 白字:与 gv 的实心黑同族,表达「有人到场」
    // ⚠ 底走 `ev-teal-solid`(不是 `bg-ev-teal`):后者暗色下提亮成 #5eead4 → 白底白字
    cls: "px-1 py-px text-on-brand bg-ev-teal-solid",
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
    cls: "px-1 py-px text-on-brand bg-ev-teal-solid",
  },
];

const badgeKeysCache = new Map<string, string[]>();

export function screeningBadgeKeys(s: Screening): string[] {
  const key = `${s.code}|${s.midnight_members?.length ?? 0}|${s.is_gv ? 1 : 0}|${s.tags?.join(",") ?? ""}`;
  const hit = badgeKeysCache.get(key);
  if (hit) return hit;
  const keys: string[] = [];
  const push = (k: string): void => {
    if (!defByKey.has(k)) return; // 未注册的键忽略,向前兼容
    if (!keys.includes(k)) keys.push(k);
  };
  if (s.is_gv) push("gv");
  if (s.midnight_members?.length) push("batch");
  for (const t of s.tags ?? []) push(t);
  badgeKeysCache.set(key, keys);
  return keys;
}

const defByKey = new Map(BADGE_DEFS.map(d => [d.key, d]));
