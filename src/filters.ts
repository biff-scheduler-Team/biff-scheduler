// 排片筛选(字幕 / 影厅 / GV)—— **同一套判定与控件,两份独立状态**。
//
// 为什么抽成独立模块
// ------------------
// 2026-09-11 起两处都要筛:甘特图筛「时间轴上还剩哪些卡 / 哪些影厅行」,影片库筛「哪些片还有
// 符合的场」。若各写一份,「字幕键怎么归一」「未标注算不算命中」「GV 三态怎么互斥」会立刻漂成
// 两套口径 —— 判定收口在本文件(`matchesFilters` / `venueAllowed`),UI 也收口在 `renderFilterBar()`。
//
// ⚠ **状态是两份,不是一份**(2026-09-11 用户要求「分开」):
//   · 甘特图那份 = `main.ts` 的 `filters`,持久化 `biff.filters.v1`;
//   · 影片库那份 = `library.ts` 的 `libFilters`,持久化 `biff.libfilters.v1`。
//   两者**互不影响** —— 在时间轴上点掉几家影院,影片库列表不会跟着收窄(反之亦然)。
//   原先共用一份时,用户没法「时间轴看全部、影片库只看几家」,一处动另一处当场变,
//   两个界面明明在回答不同的问题。
//
// 形态:**圆角矩形**
// ---------------------------
// 2026-09-12 起全站统一为圆角矩形(日期条也已由胶囊改为圆角矩形),此处沿用同一口径:
// 一律圆角矩形(rounded-6),轨道也只给 rounded-8。
//
// 影厅那道为什么有两套语义(2026-09-11 优化)
// ------------------------------------------
// 用户诉求:常去的厅集中在 BCC / CGV / LOTTE,白名单要一个一个点十几次;
// 而真正要「去掉」的往往只有最后几个(南浦洞那几家)—— 于是:
//   ① 「只看 / 排除」语义开关(同一个选中集合,白名单 ↔ 黑名单);
//   ② 分区预设(主场区 / 南浦洞)+ 影院预设(BCC / CGV / LOTTE)一键整组加 / 减;
//   ③ 「反选」—— 白名单下「只去掉少数几家」的另一种走法;
//   ④ 编号连锁影院(CGV 1–6 + IMAX / LOTTE 2–10)**不逐厅列**,合并成品牌一枚
//      (见 COLLAPSED_BRANDS)—— 16 枚编号 chip 铺开只会把轨道撑成两行、读不出重点;
//   ⑤ 选项**持久化**(见 loadFilters / saveFilters),下次打开还是这套厅;
//   ⑥ 影厅筛选同时决定甘特图**纵轴整行**的去留(见 grid.ts::buildGrid)。

import type { Screening } from "./types";
import { SUBS_DEFS, subsKeys } from "./legend";

/** 字幕里的**特殊键**:命中「官方未标注」的场次(缺省 = 英文字幕 + 韩语对白)。
 *  它不是 `SubsKey`,故单列一个常量,避免各调用点各写一个字面量。 */
export const SUBS_NONE = "none";

/** 影厅筛选的**语义方向**:
 *  - `include`(白名单):选中的厅**只看**这些;
 *  - `exclude`(黑名单):选中的厅**全部去掉**。
 *  两者共用同一个 `venues` 集合,只是读法相反 —— 空集永远是「不过滤」。 */
export type VenueMode = "include" | "exclude";

export interface FilterState {
  /** 字幕键(`KE`/`KN`/`KK`/`NO`)+ `SUBS_NONE`。空集 = 不过滤 */
  subs: Set<string>;
  /** 影厅 id(venues.json 口径)。空集 = 不过滤;非空时按 `venueMode` 解读 */
  venues: Set<string>;
  /** 影厅集合的读法:白名单 / 黑名单(见 `VenueMode`) */
  venueMode: VenueMode;
  /** GV:`"gv"` 只看嘉宾场 / `"plain"` 只看非嘉宾场 / `null` 全部 */
  gv: "gv" | "plain" | null;
}

export function makeFilterState(): FilterState {
  return { subs: new Set<string>(), venues: new Set<string>(), venueMode: "include", gv: null };
}

export function hasActiveFilter(f: FilterState): boolean {
  return f.subs.size > 0 || f.venues.size > 0 || f.gv !== null;
}

export function clearFilter(f: FilterState): void {
  f.subs.clear();
  f.venues.clear();
  f.venueMode = "include";
  f.gv = null;
}

/** 某影厅是否通过影厅这一道筛选(纯函数)。
 *  ⚠ 网格**纵轴整行**的显隐也读它(见 grid.ts::buildGrid)—— 判定必须只有这一处。 */
export function venueAllowed(venueId: string, f: FilterState): boolean {
  if (f.venues.size === 0) return true;
  const hit = f.venues.has(venueId);
  return f.venueMode === "exclude" ? !hit : hit;
}

/** 影厅筛选的**签名** —— 进网格几何签名(行数会变 ⇒ 必须全量重建,不能走 patch)。
 *  空串 = 无影厅筛选(几何签名与旧行为逐字一致)。 */
export function venueFilterKey(f: FilterState): string {
  if (f.venues.size === 0) return "";
  return `${f.venueMode}:${[...f.venues].sort().join(",")}`;
}

/** 场次是否通过三道筛选(纯函数;三道之间是**与**,每道内部是**或**)。
 *  与 `hourFilter` 的淡化口径一致:不通过者只是淡出,不改变几何、不隐藏 DOM。
 *  ⚠ 唯一例外是**影厅**:它同时决定网格纵轴**整行**的去留(见 grid.ts::buildGrid)——
 *    「不去的影院」留在轴上只是白占一行高,而字幕 / GV 说的是「这场我不想要」,
 *    留着才能看清「当天还有什么」。 */
export function matchesFilters(s: Screening, f: FilterState): boolean {
  if (f.subs.size > 0) {
    const keys = subsKeys(s.subs);
    const hit = keys.some((k) => f.subs.has(k)) || (keys.length === 0 && f.subs.has(SUBS_NONE));
    if (!hit) return false;
  }
  if (!venueAllowed(s.venue_id, f)) return false;
  if (f.gv === "gv" && !s.is_gv) return false;
  if (f.gv === "plain" && s.is_gv) return false;
  return true;
}

/** 生效中的筛选摘要(折叠态标题行用;如「字幕 KE/KN · 影厅 排除 2 个 · 仅 GV」) */
export function filterSummary(f: FilterState): string {
  const bits: string[] = [];
  if (f.subs.size) {
    const names = [...f.subs].map((k) => (k === SUBS_NONE ? "未标注" : k));
    bits.push(`字幕 ${names.join("/")}`);
  }
  if (f.venues.size) {
    bits.push(f.venueMode === "exclude" ? `影厅 排除 ${f.venues.size} 个` : `影厅 ${f.venues.size} 个`);
  }
  if (f.gv === "gv") bits.push("仅 GV");
  if (f.gv === "plain") bits.push("非 GV");
  return bits.join(" · ");
}

/* ---------------- 持久化(「记住你的选项」) ----------------
 * 筛选说的是「我想看什么样的场」,跨日 / 跨会话都成立 —— 故落 localStorage **独立键**
 * (与 `biff.pickerw.v1` 同口径:视图偏好不混进 `biff.settings.v1`,
 *  重置设置不会顺手把筛选带走)。
 * ⚠ 两处状态**分开**后是两个键:甘特图 `biff.filters.v1` / 影片库 `biff.libfilters.v1`
 *   (见 `LS_FILTERS_GRID` / `LS_FILTERS_LIB` 注释)。
 * ⚠ 读取时对影厅 id 做**白名单校验**:数据换版后旧 id 不再存在,留着会让「空集 = 不过滤」
 *   的判定失效(表现为「筛选看着没开,但当天什么都没有」)。 */
export const LS_FILTERS_GRID = "biff.filters.v1";
/** 影片库抽屉那套筛选的键 —— 与甘特图那套**互相独立**(2026-09-11 用户要求「分开」)。 */
export const LS_FILTERS_LIB = "biff.libfilters.v1";

interface StoredFilters {
  subs?: unknown;
  venues?: unknown;
  venueMode?: unknown;
  gv?: unknown;
}

/** 载入筛选(启动时一次)。`validVenueIds` 传了就顺带剔掉换版后不存在的厅;
 *  `key` 区分甘特图 / 影片库两套(缺省 = 甘特图)。 */
export function loadFilters(f: FilterState, validVenueIds?: Set<string>, key: string = LS_FILTERS_GRID): void {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return; // 隐私模式 / 禁用存储 → 用默认(不过滤)
  }
  if (!raw) return;
  let data: StoredFilters;
  try {
    data = JSON.parse(raw) as StoredFilters;
  } catch {
    return; // 脏数据 → 忽略,绝不抛
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  f.subs.clear();
  f.venues.clear();
  f.venueMode = data.venueMode === "exclude" ? "exclude" : "include";
  f.gv = data.gv === "gv" || data.gv === "plain" ? data.gv : null;
  const subsOk = new Set<string>([...Object.keys(SUBS_DEFS), SUBS_NONE]);
  if (Array.isArray(data.subs)) {
    for (const k of data.subs) {
      if (typeof k === "string" && subsOk.has(k)) f.subs.add(k);
    }
  }
  if (Array.isArray(data.venues)) {
    for (const id of data.venues) {
      if (typeof id !== "string") continue;
      if (validVenueIds && !validVenueIds.has(id)) continue;
      f.venues.add(id);
    }
  }
}

/** 落盘筛选(每次变更后调用一次;写失败静默 —— 仅本次生效)。
 *  `key` 区分甘特图 / 影片库两套(缺省 = 甘特图)。 */
export function saveFilters(f: FilterState, key: string = LS_FILTERS_GRID): void {
  try {
    const data: StoredFilters = { subs: [...f.subs], venues: [...f.venues], venueMode: f.venueMode, gv: f.gv };
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    /* 隐私模式 / 禁用存储 */
  }
}
