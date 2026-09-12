import { writeWorkspaceItem } from "./workspace-storage";
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

import type { Screening, SubsKey, Venue } from "./types";
import { el } from "./util";
import { SUBS_DEFS, subsKeys, venueShort } from "./legend";

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
    writeWorkspaceItem(key, JSON.stringify(data));
  } catch {
    /* 隐私模式 / 禁用存储 */
  }
}

/* ---------------- 控件 ---------------- */

const CHIP =
  "border-0 rounded-6 px-[10px] py-[4px] text-12 font-semibold whitespace-nowrap cursor-pointer transition-colors";
const CHIP_ON = `${CHIP} bg-ink-solid text-on-brand`;
const CHIP_OFF = `${CHIP} bg-transparent text-ink-2 hover:text-ink`;
/** 排除模式下「已被排除」的影厅 chip:品牌红实底 + 删除线 —— 与「已选中」的墨底一眼分得开
 *  (同一个集合两套读法,视觉必须不同,否则用户看不出自己在白名单还是黑名单里)。 */
const CHIP_EXCL = `${CHIP} bg-biff text-on-brand line-through`;
/** 轨道:浅灰圆角矩形(与日期条同一语言,但**不**做圆头 —— 圆头是「单值选择」的形态) */
const TRACK = "flex items-center gap-[3px] flex-wrap bg-[var(--bg-raised)] rounded-8 p-[3px]";
const ROW = "flex items-start gap-[8px]";
const LABEL = "shrink-0 pt-[5px] text-11 font-bold text-faint tracking-[0.04em]";

/** 影厅筛选的语义开关文案(顺序 = 渲染顺序) */
const VENUE_MODE_OPTS: [string, VenueMode, string][] = [
  ["只看", "include", "包含模式:选中的影厅**只看**这些(白名单);一个都没选 = 不筛"],
  ["排除", "exclude", "排除模式:选中的影厅**全部去掉**(黑名单);一个都没选 = 不筛"],
];

/** 分区显示名(region 值 → 中文;未登记的分区原样显示) */
const REGION_LABEL: Record<string, string> = { centum: "主场区", nampo: "南浦洞" };

/** 筛选里**合并成品牌一项**的连锁影院 —— 旗下全是编号影厅,彼此等价、逐厅筛没有意义。
 *  用户反馈(2026-09-11):「CGV 和 LOTTE 还是展示了所有的 123456 所有影厅,合并成一个选项即可」
 *  —— CGV 1–6 + IMAX(7 枚)、LOTTE 2–10(9 枚)一铺开就把整条轨道撑满。
 *  ⚠ 刻意**不含 bcc**:电影殿堂那五个厅是**有专名的独立剧场**(중극장 / 소극장 / 시네마테크 /
 *    하늘연극장 / 야외극장),彼此不等价(资料馆 / 露天场 / 大剧场),逐厅筛有意义,故保留。
 *  ⚠ 只影响**筛选控件**:甘特图纵轴仍逐厅一行 —— 那才是「实际在哪块银幕看」。 */
const COLLAPSED_BRANDS = new Set(["cgv", "lotte"]);

/** 一键整组加 / 减的影厅预设 */
interface VenuePreset {
  label: string;
  ids: string[];
  tip: string;
}

/** 分区快捷预设(「主场区」/「南浦洞」)—— **「只去掉最后几个」的最短路径**:
 *  切「排除」→ 点「南浦洞」→ 只剩主场区的厅(两次点击 vs 逐厅十几次)。 */
function regionPresets(venues: Venue[]): VenuePreset[] {
  const m = new Map<string, string[]>();
  for (const v of venues) {
    const k = v.region ?? "";
    if (!k) continue;
    const arr = m.get(k);
    if (arr) arr.push(v.id);
    else m.set(k, [v.id]);
  }
  return [...m.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([k, ids]) => {
      const label = REGION_LABEL[k] ?? k;
      return { label, ids, tip: `${label} · 共 ${ids.length} 个影厅\n点击整组加入;整组已选中时再点 = 整组取消` };
    });
}

/** 影院品牌预设(BCC / CGV / LOTTE…)—— 只列**有 2 个以上厅**的品牌
 *  (单厅品牌的逐厅 chip 已经够用,再给一枚预设只是噪声)。
 *  对 `COLLAPSED_BRANDS` 里的品牌,这枚 chip 就是它**唯一**的筛选入口(逐厅 chip 不画)。 */
function brandPresets(venues: Venue[]): VenuePreset[] {
  const m = new Map<string, string[]>();
  for (const v of venues) {
    const arr = m.get(v.group);
    if (arr) arr.push(v.id);
    else m.set(v.group, [v.id]);
  }
  return [...m.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([k, ids]) => {
      const label = k.toUpperCase();
      const merged = COLLAPSED_BRANDS.has(k);
      return {
        label,
        ids,
        tip:
          `${label} 旗下 ${ids.length} 个厅` +
          (merged ? " · 编号影厅已并入本项,不再逐厅列出" : "") +
          "\n点击整组加入;整组已选中时再点 = 整组取消",
      };
    });
}

/** 预设的整组加 / 减:整组已在集合里 → 整组移除(再点一次 = 撤销);否则整组加入。
 *  ⚠ **并集而非替换** —— 点 BCC 再点 CGV = 两家都要(白名单下这是最常见的用法)。 */
function toggleVenueGroup(f: FilterState, ids: string[], onChange: () => void): void {
  const all = ids.length > 0 && ids.every((id) => f.venues.has(id));
  for (const id of ids) {
    if (all) f.venues.delete(id);
    else f.venues.add(id);
  }
  onChange();
}

/** 轨道内的分组分隔线 —— 让「语义开关 / 快捷预设 / 逐厅」三段一眼分得开 */
function sep(): HTMLElement {
  return el("span", "shrink-0 w-px h-[16px] bg-line mx-[1px]");
}

function chip(
  text: string,
  on: boolean,
  tip: string,
  onClick: () => void,
  onCls: string = CHIP_ON
): HTMLButtonElement {
  const b = el("button", on ? onCls : CHIP_OFF, text);
  b.dataset.tip = tip;
  b.addEventListener("click", onClick);
  return b;
}

function row(label: string, track: HTMLElement): HTMLElement {
  const r = el("div", ROW);
  r.appendChild(el("span", LABEL, label));
  r.appendChild(track);
  return r;
}

export interface FilterBarOpts {
  venues: Venue[];
  /** 任何一道筛选变化后回调 —— 调用方负责**落盘 + 重绘自己那侧**
   *  (两处状态已分开,不存在「对端视图」需要同步) */
  onChange: () => void;
  /** 折叠态:只画标题行。**不传 `onToggle` 时忽略**(甘特图侧永远展开三行) */
  collapsed?: boolean;
  /** 传了 = 标题行可点、可折叠(影片库窄抽屉用;甘特图侧不传,直接铺开三行) */
  onToggle?: () => void;
}

/** 把筛选控件渲染进 `host`(全量重建 —— 10 个日期 × 26 个厅的节点量不值得做 diff)。
 *  `f` 是调用方**自己那套**状态(甘特图 / 影片库各一份,见文件头)。 */
export function renderFilterBar(host: HTMLElement, f: FilterState, opts: FilterBarOpts): void {
  host.replaceChildren();
  const { venues, onChange } = opts;
  const collapsible = Boolean(opts.onToggle);
  const collapsed = collapsible && Boolean(opts.collapsed);

  // ---- 标题行:折叠开关 + 摘要 + 清除(折叠时这是**唯一**一行) ----
  if (collapsible) {
    const head = el("div", "flex items-center gap-[6px] flex-wrap");
    const toggle = el(
      "button",
      "border-0 rounded-6 px-[8px] py-[3px] text-12 font-bold bg-transparent text-ink-2 hover:text-ink cursor-pointer whitespace-nowrap",
      `${collapsed ? "▸" : "▾"} 筛选`
    );
    // 折叠形态**只有影片库在用**(甘特图侧永远铺开三行、不传 onToggle),故这里直接写列表口径。
    // ⚠ 必须写明「与时间轴独立」—— 两处状态已分开,不写用户会以为时间轴那边也跟着变了。
    toggle.dataset.tip = "按 字幕 / 影厅 / 是否 GV 过滤**左侧影片列表**\n与时间轴上的筛选相互独立,各筛各的";
    toggle.addEventListener("click", () => opts.onToggle?.());
    head.appendChild(toggle);
    const sum = filterSummary(f);
    if (sum) {
      head.appendChild(
        el("span", "text-11 font-bold text-biff-ink bg-biff-soft rounded-5 px-[6px] py-[2px] whitespace-nowrap", sum)
      );
    }
    if (hasActiveFilter(f)) {
      const clear = el(
        "button",
        "border border-biff bg-biff-soft text-biff-ink rounded-6 px-[8px] py-[2px] text-11 font-bold cursor-pointer whitespace-nowrap hover:bg-biff-line",
        "清除"
      );
      clear.dataset.tip = "清空字幕 / 影厅 / GV 三道筛选";
      clear.addEventListener("click", () => {
        clearFilter(f);
        onChange();
      });
      head.appendChild(clear);
    }
    host.appendChild(head);
    if (collapsed) return;
  }

  // ---- 字幕(多选;`未标注` = 官方缺省「英文字幕 + 韩语对白」)----
  const subsTrack = el("div", TRACK);
  subsTrack.appendChild(
    chip("全部", f.subs.size === 0, "显示全部字幕类型的场次", () => {
      f.subs.clear();
      onChange();
    })
  );
  for (const k of Object.keys(SUBS_DEFS) as SubsKey[]) {
    const def = SUBS_DEFS[k];
    const on = f.subs.has(k);
    subsTrack.appendChild(
      chip(def.label, on, `${def.tip}\n点击${on ? "取消" : "只看"}该字幕类型(可多选)`, () => {
        if (on) f.subs.delete(k);
        else f.subs.add(k);
        onChange();
      })
    );
  }
  const noneOn = f.subs.has(SUBS_NONE);
  subsTrack.appendChild(
    chip("未标注", noneOn, `格内未印字幕标识 = 官方缺省「英文字幕 + 韩语对白」\n点击${noneOn ? "取消" : "只看"}未标注场次`, () => {
      if (noneOn) f.subs.delete(SUBS_NONE);
      else f.subs.add(SUBS_NONE);
      onChange();
    })
  );
  host.appendChild(row("字幕", subsTrack));

  // ---- 影厅(多选 + **只看 / 排除**双语义 + 分区 / 影院快捷预设;按 venues.json 泳道顺序)----
  // 分段:① 语义开关 ② 全部 / 反选 ③ 分区预设 ④ 影院预设 ⑤ 逐厅 —— 分隔线把五段隔开。
  const venueTrack = el("div", TRACK);
  const modeSeg = el("div", "inline-flex items-center gap-[3px]");
  for (const [label, mode, tip] of VENUE_MODE_OPTS) {
    modeSeg.appendChild(
      chip(label, f.venueMode === mode, tip, () => {
        if (f.venueMode === mode) return; // 点当前模式 = 无变化(不做循环)
        f.venueMode = mode;
        onChange();
      })
    );
  }
  venueTrack.appendChild(modeSeg);
  venueTrack.appendChild(sep());

  venueTrack.appendChild(
    chip("全部", f.venues.size === 0, "清空影厅筛选(显示全部影厅的场次)", () => {
      f.venues.clear();
      onChange();
    })
  );
  if (venues.length) {
    const rest = venues.length - f.venues.size;
    venueTrack.appendChild(
      chip("反选", false, `反选 —— 把已选的 ${f.venues.size} 个厅换成其余 ${rest} 个`, () => {
        const next = venues.map((v) => v.id).filter((id) => !f.venues.has(id));
        f.venues.clear();
        for (const id of next) f.venues.add(id);
        onChange();
      })
    );
  }

  const excl = f.venueMode === "exclude";
  const onCls = excl ? CHIP_EXCL : CHIP_ON; // 预设与逐厅共用同一套「已选」配色(黑名单下是红删除线)
  const regions = regionPresets(venues);
  const brands = brandPresets(venues);
  if (regions.length || brands.length) venueTrack.appendChild(sep());
  for (const p of regions) {
    venueTrack.appendChild(
      chip(p.label, p.ids.every((id) => f.venues.has(id)), p.tip, () => toggleVenueGroup(f, p.ids, onChange), onCls)
    );
  }
  for (const p of brands) {
    venueTrack.appendChild(
      chip(p.label, p.ids.every((id) => f.venues.has(id)), p.tip, () => toggleVenueGroup(f, p.ids, onChange), onCls)
    );
  }
  venueTrack.appendChild(sep());

  for (const v of venues) {
    // 编号连锁影院不逐厅列(见 COLLAPSED_BRANDS):它们的筛选项 = 上面那枚品牌 chip。
    // 全量列出 CGV 1–6 + IMAX / LOTTE 2–10 共 16 枚,轨道直接撑成两行还读不出重点。
    if (COLLAPSED_BRANDS.has(v.group)) continue;
    const on = f.venues.has(v.id);
    venueTrack.appendChild(
      chip(
        venueShort(v),
        on,
        `${v.name}${v.name_kr ? ` · ${v.name_kr}` : ""}\n点击${on ? "取消" : excl ? "排除" : "只看"}该影厅(可多选)`,
        () => {
          if (on) f.venues.delete(v.id);
          else f.venues.add(v.id);
          onChange();
        },
        onCls
      )
    );
  }
  host.appendChild(row("影厅", venueTrack));

  // ---- GV(三态单选:全部 / 仅 GV / 非 GV)----
  const gvTrack = el("div", TRACK);
  const gvOpts: [string, "gv" | "plain" | null, string][] = [
    ["全部", null, "不过滤 GV"],
    ["仅 GV", "gv", "只看有嘉宾映后交流的场次(Guest Visit)"],
    ["非 GV", "plain", "只看没有嘉宾到场的常规放映"],
  ];
  for (const [label, key, tip] of gvOpts) {
    gvTrack.appendChild(
      chip(label, f.gv === key, `${tip}\n官方提示:GV 场次可能临时变动`, () => {
        f.gv = f.gv === key ? null : key; // 再点同一档 = 取消
        onChange();
      })
    );
  }
  const gvRow = row("场次", gvTrack);
  // 网格侧(不可折叠):把「清除」缀在最后一行,不另起一行占高度
  if (!collapsible && hasActiveFilter(f)) {
    const clear = el(
      "button",
      "border border-biff bg-biff-soft text-biff-ink rounded-6 px-[10px] py-[4px] text-12 font-bold cursor-pointer whitespace-nowrap hover:bg-biff-line",
      "清除筛选"
    );
    clear.dataset.tip = "清空字幕 / 影厅 / GV 三道筛选";
    clear.addEventListener("click", () => {
      clearFilter(f);
      onChange();
    });
    gvRow.appendChild(clear);
  }
  host.appendChild(gvRow);
}
