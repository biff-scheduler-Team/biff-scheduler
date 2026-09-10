// 影片库 — 全部影片浏览 + 单元筛选 chips + 搜索 → 反向定位 / 详情豆瓣。
// 全量化:列表 / 行 / 头部 / chip / pill / 场次行 / 智能排片弹层 全部 Tailwind utility。
// 16-B 单元 chip / 评分章 / 选片三选 / 智能排片结果 同源 —— 都读写 store.picks(唯一数据源)。

import type { Catalog, FilmItem, Group, Mapping, PickEntry, Priority, Screening } from "./types";
import { dateInfo, el, filmNodeKey, fmtMinRange } from "./util";
import { codeTip } from "./badges";
import { appendMetaRow, doubanChip, uniformChipEl, venueShort, venueTip } from "./legend";
import { actState, closeModal, openModal } from "./modal";
import { WISH_ORDER, priTag, wishIcon } from "./pick";
import { addGroupPicks, codesOfGroup, removePick, setCurrentGroup, setWish, store, subscribe } from "./state";
// 智能排片 = **AI 单通道**(本地确定性求解引擎已于 2026-09-10 整体下线,见 PLAN-20260910143516)。
// 这里只取「影片 wish + 场次」的入参类型(EngineFilm,名字沿用)与质量分模块无关。
import type { EngineFilm } from "./engine";
import {
  AI_PRESETS,
  AI_TIMEOUT_MS,
  AiError,
  aiErrorText,
  aiReady,
  buildPayload,
  callLLM,
  clearAiCfg,
  defaultAiCfg,
  loadAiCfg,
  loadAiDates,
  maskKey,
  parseAiResult,
  planMerge,
  saveAiCfg,
  saveAiDates,
  type AiCfg,
  type AiPayload,
  type AiPlan,
  type AiPlanDrop,
  type AiPlanOption,
  type AiPlanPick,
  type AiPlanReject,
} from "./ai";

export interface LibraryCtx {
  cat: Catalog;
  /** 唯一数据源:影片 key → 选片记录(档位 / 已选场次 / 备注) */
  picks: Map<string, PickEntry>;
  /** 已选场次投影:code → { 影片 key, 方案 }(与「我的行程」同一份数据) */
  slots: Map<string, { key: string; group: Group }>;
  group: Group;
  mappings: Map<string, Mapping>;
  onLocate: (code: string) => void;
  onFilm: (code: string) => void;
  /** 加入/移出当前方案(唯一场次列表在这里 —— 弹层已不再重复列场次)。
   *  与「网格整卡点选」「我的行程」同一份数据(state.toggleScreening)。 */
  onToggle: (key: string, code: string) => void;
}

/** 目录片 ↔ 排期片合并后的一个影片节点 */
interface FilmNode {
  key: string;
  zh: string;
  names: string[]; // 与 zh 不同的其余片名(原始片名/英文/韩文),去重保序
  meta: string; // 单元 · 国家 · 年份 · 导演(目录信息,空则隐藏)
  cats: FilmItem[]; // 命中的目录条目(一般 1 条)
  shows: Screening[]; // 已发布排期的场次(可能为空)
  map?: Mapping;
}

/** 16-B:脏 unit → 归并键(展示与筛选用同一键) */
export function unitKey(raw: string | undefined | null): string {
  const t = (raw ?? "").trim();
  if (t.startsWith("广角镜")) return "广角镜";
  if (t.startsWith("Vision")) return "Vision";
  if (t.startsWith("Korean Cinema Today")) return "Korean Cinema Today";
  if (t.includes("年度亚洲电影人奖")) return "亚洲电影人奖"; // 2026~2029 四连重复归并
  if (t.startsWith("CARTE BLANCHE")) return "CARTE BLANCHE";
  if (t.startsWith("On Screen")) return "On Screen";
  return t || "未标注单元";
}

interface UnitChip {
  key: string;
  count: number; // 目录片计数(静态,不随搜索变化)
}

/** chips:全部 + 各归并单元,按片数降序 */
function buildUnitChips(films: FilmItem[]): UnitChip[] {
  const m = new Map<string, number>();
  for (const f of films) {
    const k = unitKey(f.unit);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key, "zh"));
}

function catMeta(cat: FilmItem): string {
  const bits = [cat.unit, cat.country];
  if (cat.year) bits.push(String(cat.year));
  if (cat.director) bits.push(cat.director);
  return bits.filter(Boolean).join(" · ");
}

function norm(s: string): string {
  return s.toLowerCase().trim();
}

/** 节点命中搜索:code / 中文名 / 其余片名 / 单元·国家·导演 */
function matchNode(n: FilmNode, kw: string): boolean {
  if (!kw) return true;
  if (norm(n.zh).includes(kw)) return true;
  if (n.names.some((x) => norm(x).includes(kw))) return true;
  if (norm(n.meta).includes(kw)) return true;
  return n.shows.some((s) => s.code.toLowerCase().includes(kw));
}

/** 节点是否属于某归并单元(纯排期片无目录,只在「全部」下出现) */
function inUnit(n: FilmNode, unit: string): boolean {
  return n.cats.some((c) => unitKey(c.unit) === unit);
}

/** 单元 chip 类名(idle / 选中 — 背景/边框色 走 IDLE/ON 各自完整串,避免同类叠加) */
const CHIP_UNIT_BASE =
  "border rounded-full px-[10px] py-[3px] text-[12px] font-semibold whitespace-nowrap hover:border-biff";
const CHIP_UNIT_IDLE = `${CHIP_UNIT_BASE} border-line bg-card text-muted hover:text-ink`;
const CHIP_UNIT_ON = `${CHIP_UNIT_BASE} border-ink bg-ink text-on-brand`;

/** 带行标的 chip 行(「日期」/「档位」)—— 两排 chips 外观相同,靠这枚极小行标区分,
 *  否则两排各有一个「全部」,用户分不清哪个在筛什么。 */
function chipRow(label: string, chips: HTMLElement): HTMLElement {
  const row = el("div", "flex items-start gap-[6px]");
  row.appendChild(el("span", "text-[11px] text-faint font-semibold shrink-0 pt-[4px]", label));
  row.appendChild(chips);
  return row;
}

/** 日期导航栏的「上一天 / 下一天」步进钮(走到头即禁用) */
const NAV_BTN =
  "shrink-0 border border-line bg-card rounded-[6px] px-[7px] py-[2px] text-[13px] font-bold text-ink-2 " +
  "hover:border-line-strong hover:text-ink disabled:opacity-35 disabled:cursor-not-allowed";

/** 影片卡片**右上角的次要图标**(档位星标 / ⓘ 资料 / ✕ 移除)——
 *  常态 45% 淡显,hover 卡片才完全显现(卡片上有 `group`)。
 *  ⚠ 刻意**不用** `opacity-0`:触屏没有 hover,图标会永远看不见;
 *  `45% → 100%` 兼顾「不抢戏」与「找得到」(需求原话是「hover 态才完全显现」)。 */
const ICON_BTN =
  "border-0 bg-transparent p-0 w-[20px] h-[20px] inline-flex items-center justify-center rounded-[5px] " +
  "text-[12px] leading-none text-muted opacity-45 group-hover:opacity-100 " +
  "transition-[opacity,background-color,color] duration-[120ms] hover:bg-[var(--bg-hover-soft)]";

/** 场次行的**主操作**「定位 ▸」—— 去饱和品牌红实底(不再是亮红渐变),
 *  让它明显强于旁边的中性描边「＋ 加入」、又不至于在密集场次行里刺眼(见 --biff-red-muted)。 */
const BTN_GO =
  "border-0 rounded-[6px] px-[10px] py-[3px] text-[11.5px] font-bold whitespace-nowrap " +
  "text-on-brand bg-biff-muted hover:bg-biff-hover transition-colors duration-[120ms] active:translate-y-px";

/** 场次按日期切段(入参已按 日期 → 开始时间 排好,相邻归并即可)—— 「我的选片」tab 的日期分节用。
 *  ⚠ 与文件后半的 `groupByDate()`(AI 结果卡,吃 `AiPlanPick[]`)同名不同物,故另起名。 */
function groupShowsByDate(list: Screening[]): [string, Screening[]][] {
  const out: [string, Screening[]][] = [];
  for (const s of list) {
    const last = out[out.length - 1];
    if (last && last[0] === s.date) last[1].push(s);
    else out.push([s.date, [s]]);
  }
  return out;
}

/** 日期小标题(「10/21 周三 · 2 场」)—— 「我的选片」tab 按日期分节时的节头 */
function dateHead(date: string, count: number): HTMLElement {
  const { label, weekday } = dateInfo(date);
  return el(
    "div",
    "px-3 py-[5px] text-[11px] font-bold text-meta bg-[var(--bg-hover-soft)] border-t border-line-faint",
    `${label} ${weekday} · ${count} 场`
  );
}

/** 影片库 / 我的选片 共用的节点清单(目录 ↔ 排期合并 + 目录全集 + 排序) */
export interface FilmListData {
  filmList: FilmNode[];
  totalShows: number;
  noSchedule: number;
  unitChips: UnitChip[];
}

/** 合并目录与排期为影片节点清单:「影片库」与「我的选片」必须同源,否则选片打标对象会漂移 */
function buildFilmList(ctx: LibraryCtx): FilmListData {
  // ---- 1) 目录索引:中文名精确匹配;其次目录原始片名 == 排期英文名 ----
  const byZh = new Map<string, FilmItem[]>();
  for (const f of ctx.cat.films) {
    const k = f.title_zh || f.title_orig;
    if (!k) continue;
    const arr = byZh.get(k) ?? [];
    arr.push(f);
    byZh.set(k, arr);
  }
  const byOrig = new Map<string, FilmItem[]>();
  for (const f of ctx.cat.films) {
    if (!f.title_orig) continue;
    const arr = byOrig.get(f.title_orig) ?? [];
    arr.push(f);
    byOrig.set(f.title_orig, arr);
  }

  // ---- 2) 排期场次挂到目录节点(命中),未命中者生成"仅排期"节点 ----
  const nodes = new Map<string, FilmNode>();
  const screenings = [...ctx.cat.schedule.screenings].sort(
    (a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time)
  );

  const catFor = (s: Screening): FilmItem[] => {
    const byName = byZh.get(s.title_zh) ?? [];
    if (byName.length) return byName;
    if (s.title_en) return byOrig.get(s.title_en) ?? [];
    return [];
  };

  for (const s of screenings) {
    const cats = catFor(s);
    const cat = cats[0];
    const map = ctx.mappings.get(s.code);
    const zh = cat?.title_zh || s.title_zh || map?.title_cn || s.title_en;
    const key = filmNodeKey(ctx.cat, s); // 全站单一 key 口径(甘特打标 / 详情弹层 / 选片总览同源)
    let n = nodes.get(key);
    if (!n) {
      const names = new Set<string>();
      const pushName = (x: string): void => {
        if (x && norm(x) !== norm(zh)) names.add(x);
      };
      for (const c of cats) pushName(c.title_orig);
      if (cat) {
        // 目录条目无原始片名时,退回排期英文名
        if (!cat.title_orig) pushName(s.title_en);
      } else {
        pushName(s.title_en);
        pushName(s.title_kr);
      }
      n = {
        key,
        zh,
        names: [...names],
        meta: cat ? catMeta(cat) : "",
        cats: cats,
        shows: [],
        map,
      };
      nodes.set(key, n);
    }
    n.shows.push(s);
  }

  // ---- 3) 目录中尚无任何排期的片(250 部全集) ----
  for (const f of ctx.cat.films) {
    const key = `cat:${f.id}`;
    if (nodes.has(key)) continue;
    const zh = f.title_zh || f.title_orig;
    const names = new Set<string>();
    if (f.title_orig && norm(f.title_orig) !== norm(zh)) names.add(f.title_orig);
    nodes.set(key, {
      key,
      zh,
      names: [...names],
      meta: catMeta(f),
      cats: [f],
      shows: [],
    });
  }

  // ---- 目录顺序优先(表序),纯排期片排在最后 ----
  const catOrder = new Map(ctx.cat.films.map((f, i) => [f.id, i]));
  const filmList = [...nodes.values()].sort((a, b) => {
    const ia = a.key.startsWith("cat:") ? catOrder.get(a.key.slice(4)) ?? 1e9 : 1e9;
    const ib = b.key.startsWith("cat:") ? catOrder.get(b.key.slice(4)) ?? 1e9 : 1e9;
    return ia - ib || a.zh.localeCompare(b.zh, "zh");
  });

  const totalShows = screenings.length;
  const noSchedule = filmList.filter((n) => n.shows.length === 0).length;
  const unitChips = buildUnitChips(ctx.cat.films);
  return { filmList, totalShows, noSchedule, unitChips };
}

/* ---------- 「影片库 · 我的选片」= 左侧**挤压式抽屉**(2026-09-10 起,原为独立页面 / 更早为 xl 弹窗) ----------
 * 演进:xl 弹窗(太小)→ 独立页面(2026-09-10,`PLAN-20260910182939`)→ 左侧挤压抽屉(本文件当前形态)。
 * 用户对「独立页面」的反馈是「很奇怪」——根因不在宽度,而在**换页打断了因果**:
 *   ① 模态:整页替换,打标时看不见网格与行程,而打标与选场次本是同一件事的两步;
 *   ② 不是路由:URL 不变、浏览器后退失效,占着页面的地方却给不了页面的能力;
 *   ③ 有去无回:打标时想「这部片在时间轴上长什么样」要关页 → 找片 → 重新打开;
 *   ④ 单向:只有「影片库 → 定位 ▸ → 网格」,没有「网格 → 选片」。
 * 现在是**挤压式**(不是覆盖、更不是弹层):`index.html` 的 `<main>` 是 flex 行,
 * `#picker-drawer`(520px,sticky)在左、`#main-col`(flex-1)在右 —— 抽屉打开后网格**完全可见可点**,
 * 打标 → 卡片色点当场出现;点选 → 卡片当场变绿。抽屉内两个 tab(影片库 / 我的选片):
 * 520px 放不下并排双栏,但两 tab 复用同一套 filmRow / showRow,信息密度与原来双栏一致。
 * (520 而非 400:场次行要按需求排成**单行阅读流** `[CODE][时间][章组] → [操作]`,400px 排不下。)
 * ⚠ 抽屉**不进 modal 栈**,也不隐藏网格 —— 故 `main.ts::renderAll` 不再需要早退,
 *   而网格宽度变化由本文件在开 / 收时回调 main 侧(见 setPickerToggleHandler)。
 * ⚠ 窄屏(≤1099px)放不下并排:`#main-col` 由 style.css 的媒体查询暂时隐藏,抽屉退化为全宽面板。 */

/** 抽屉打开期间的 `render()`(由 openFilmPicker 每次打开时刷新 —— ctx 不缓存:
 *  `syncFromCloud` 会整体替换 `store.picks`,持有旧 Map 会读到过期数据) */
let pickerRender: (() => void) | null = null;
/** 抽屉开 / 收时通知 main 侧(网格可用宽度变了,必须重绘并保横向锚点) */
let pickerToggleHandler: (() => void) | null = null;
/** 当前 tab —— 跨开合保持(用户上次在看「我的选片」,再打开还在那儿)。
 *  `"agenda"`(我的行程)于 2026-09-10 加入(`PLAN-20260910190916`):抽屉从"两 tab 选片面板"升为"排片工作台"
 *  —— 影片库(找片) / 我的选片(打标) / 我的行程(结果)三步闭环。 */
let pickerTab: "lib" | "pick" | "agenda" = "lib";
/** 行程 tab 的渲染函数 —— 由 main.ts 注入(它持有 `conflicts` / `gvTalkOf` / `hourFilter` 等状态,
 *  library.ts 不反向依赖)。`render()` 切到 agenda tab 时调用。 */
let agendaRenderer: (() => HTMLElement) | null = null;
let pickerStateBound = false;
let pickerChromeBound = false;

/** main.ts 注入「抽屉开合后重绘网格」:宽度变化会改 `clientWidth`,横向锚点靠 renderGrid 内的
 *  `pendingAnchor` / `gridAnchor` 机制保住,调用方不必各自记得补。 */
export function setPickerToggleHandler(fn: () => void): void {
  pickerToggleHandler = fn;
}

/** main.ts 注入「行程 tab 内容渲染函数」 —— 闭包读 main 的 `conflicts` / `gvTalkOf` / `hourFilter` 等状态;
 *  library.ts 不反向依赖。返回的 DOM 会被塞进抽屉 agenda tab 的滚动面板。 */
export function setAgendaRenderer(fn: () => HTMLElement): void {
  agendaRenderer = fn;
}

/** 选片抽屉当前是否打开 */
export function isPickerDrawerOpen(): boolean {
  return document.getElementById("picker-drawer")?.classList.contains("is-hidden") === false;
}

/** 外部唤起「我的行程」tab(顶栏 `⚠ N` 角标点击 / 其它入口「看行程」用)。
 *  只切 tab + 触发重绘;**打开抽屉** 由调用方负责(`openFilmPicker(libraryCtx())`),
 *  两者解耦:本函数既可用于「抽屉关着时想开并切到 agenda」(调用方先 open),
 *  也可用于「抽屉已开、想切到 agenda」(直接调即可)。 */
export function showAgendaTab(): void {
  pickerTab = "agenda";
  if (pickerRender) pickerRender();
}

/** 直接设置 tab(给 main.ts 在 #conflict-badge 路径里用 —— 先设 tab 再开抽屉,
 *  让 openFilmPicker 的初次 setTab 一步到位,避免一次重渲浪费) */
export function setPickerTab(tab: "lib" | "pick" | "agenda"): void {
  pickerTab = tab;
  if (pickerRender) pickerRender();
}

/** 显示抽屉:给 main 加 `.is-picker-open`(容器上限 1280 → 1680,见 style.css),并通知 main 侧重绘网格 */
function showPickerDrawer(): void {
  document.querySelector("main")?.classList.add("is-picker-open");
  document.getElementById("picker-drawer")?.classList.remove("is-hidden");
  pickerToggleHandler?.();
}

/** 收起抽屉(网格恢复原宽 —— 同样要通知 main 侧重绘) */
export function closePickerDrawer(): void {
  if (!isPickerDrawerOpen()) return;
  pickerRender = null;
  document.querySelector("main")?.classList.remove("is-picker-open");
  document.getElementById("picker-drawer")?.classList.add("is-hidden");
  pickerToggleHandler?.();
}

/** 抽屉骨架的一次性绑定:Esc。
 *  只在**没有弹层**时收抽屉 —— 有弹层时让 modal.ts 的模块级 Esc(只关栈顶)先处理;
 *  ✕ / tab / 搜索等控件随抽屉内容每次重建,故各自的监听在 openFilmPicker 里挂。 */
function bindPickerChrome(): void {
  if (pickerChromeBound) return;
  pickerChromeBound = true;
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (!isPickerDrawerOpen()) return;
    if (document.querySelector("#modal-root > div")) return; // 有弹层 → 交给 modal.ts
    closePickerDrawer();
  });
}

/** 订阅 store 变更 → 抽屉打开时重绘当前 tab。
 *  抽屉不在 `renderAll()` 的重建范围内(它只重建 chips / 网格 / 行程 / 角标),
 *  而弹层那套 `onReturn` 对常驻面板不适用 —— 详情弹层里改档位、网格点选都要让计数当场跟上。 */
function bindPickerState(): void {
  if (pickerStateBound) return;
  pickerStateBound = true;
  subscribe(() => {
    if (pickerRender && isPickerDrawerOpen()) pickerRender();
  });
}

/** 抽屉 tab 按钮(idle / 选中 —— 选中 = 墨底反白,与单元 chip / 日期 chip 同一语言) */
const TAB_BASE = "border rounded-[6px] px-[9px] py-[3px] text-[12px] font-bold whitespace-nowrap transition-colors";
const TAB_ON = `${TAB_BASE} border-ink bg-ink text-on-brand`;
const TAB_OFF = `${TAB_BASE} border-line bg-card text-muted hover:text-ink hover:border-line-strong`;

/** 「影片库」+「我的选片」= **同一抽屉的两个 tab**(2026-09-10 由独立页面改回面板)。
 *  两个 tab 共用同一份 `buildFilmList` 节点清单与**同一套行渲染**(filmRow / showRow),
 *  所以「展示机制 / 图标化」天然一致 —— 不再各写一份行结构。
 *  tab 1 影片库 = 全部影片(搜索 + 单元筛选);tab 2 我的选片 = 档位 / 日期筛选,展开只列**已排场次**。
 *  两 tab 共享一份 `store.picks`:任一 tab 改档位 / 加入移出,另一 tab 同帧同步。 */
export function openFilmPicker(ctx: LibraryCtx): void {
  const host = document.getElementById("picker-drawer");
  if (!host) return;
  const { filmList, totalShows, noSchedule, unitChips } = buildFilmList(ctx);

  // ---- 头部:tab 切换 + 收起(抽屉不是弹层,关闭走 ✕ / Esc / 顶栏按钮) ----
  // 三个 tab(2026-09-10 加 agenda,见 PLAN-20260910190916):影片库(找片) / 我的选片(打标) / 我的行程(结果)。
  const head = el("div", "flex items-center gap-[6px] mb-[10px]");
  const libTab = el("button", TAB_ON, "影片库");
  const pickTab = el("button", TAB_OFF, "我的选片");
  const agendaTab = el("button", TAB_OFF, "我的行程");
  const closeBtn = el(
    "button",
    "ml-auto shrink-0 border border-line rounded-[6px] px-[8px] py-[3px] text-[12px] font-bold bg-card text-ink hover:border-line-strong hover:bg-hover whitespace-nowrap",
    "收起 ✕"
  );
  closeBtn.dataset.tip = "收起选片面板(网格恢复原宽;Esc 同效)";
  head.append(libTab, pickTab, agendaTab, closeBtn);

  // ---- tab 1:影片库 ----
  // 工具行:搜索框吃满剩余宽度(左),「智能排片 ▸」贴右缘。
  // ⚠ 输入框用 `flex-1 min-w-0` 而不是 `w-full`:`w-full` 在 flex 行里靠 shrink 让位,
  //   窄容器会被按钮压到 min-content(≈20 字符)再溢出;`min-w-0` 才允许它真正缩下去。
  const libPane = el("div", "grid gap-[8px] content-start");
  const libTool = el("div", "flex gap-2 items-center");
  const search = el(
    "input",
    "flex-1 min-w-0 border border-line rounded-[8px] px-3 py-[7px] text-[13px] focus:[outline:2px_solid_color-mix(in_srgb,var(--color-biff)_25%,var(--color-card))] focus:border-biff"
  ) as HTMLInputElement;
  search.type = "search";
  search.placeholder = ctx.cat.films.length
    ? `搜 中文片名 / 原始片名 / code / 单元·导演(目录 ${ctx.cat.films.length} 部)`
    : "搜 中文片名 / 英文片名 / code";
  search.autocomplete = "off";
  const aiBtn = el(
    "button",
    "border rounded-[6px] px-[10px] py-[5px] text-[12px] font-bold bg-card text-ink border-line hover:opacity-90 whitespace-nowrap shrink-0",
    "智能排片 ▸"
  );
  aiBtn.id = "lib-ai";
  aiBtn.dataset.tip = "按影片已标「必看/备选/随缘」生成建议行程:填入你自己的模型 API Key,由浏览器直连服务商(本站不经手 Key)";
  libTool.append(search, aiBtn);
  const libChips = el("div", "flex flex-wrap gap-[6px]");
  const libStat = el("div", "text-[12px] text-muted");
  // 列表不再自带宽高(`max-h` + `overflow-y-auto`)—— 统一由抽屉内的 panel 滚动,避免双滚动条
  const libList = el("div", "grid gap-2 content-start pt-[2px] px-[2px] pb-1 @container");
  libPane.append(libTool, libChips, libStat, libList);

  // ---- tab 2:我的选片(档位 / 日期筛选;展开只列已排场次) ----
  const pickPane = el("div", "grid gap-[8px] content-start");
  const pickStat = el("div", "text-[12px] text-muted");
  // 两排筛选:**日期导航栏**(单行横向滚动,‹ / › 滚动 + 各天 chip)+ 档位(必看/备选/随缘/未设)
  // 单行 nowrap + overflow-x-auto:再多的日期也只占一行,不再参差;滚动条隐藏,
  // 鼠标滚轮 / 拖拽 / ‹ › 键都能左右看(NAV_BTN 的语义从「步进过滤」改为「滚动行」)。
  const pickDateChips = el("div", "flex flex-nowrap gap-[6px] min-w-0 flex-1 overflow-x-auto scrollbar-none");
  const pickDatePrev = el("button", NAV_BTN, "‹");
  const pickDateNext = el("button", NAV_BTN, "›");
  // ⚠ 本行是 pickPane(grid) 的网格项,默认 min-width:auto 会取**内容**最小宽度 ——
  // chips 一旦 nowrap,整条日期链的最小宽度就会把行撑爆(实测 1075px ≫ 抽屉 520px),
  // 连带同 tab 的影片行一起超出面板。必须 min-w-0 打断这条 min-content 链,
  // 让收缩发生在 chips 容器自身(它有 min-w-0 + overflow-x-auto,内部滚动)。
  const pickDateRow = el("div", "flex items-start gap-[6px] min-w-0");
  pickDateRow.append(
    el("span", "text-[11px] text-faint font-semibold shrink-0 pt-[4px]", "日期"),
    pickDatePrev,
    pickDateChips,
    pickDateNext
  );
  const pickChips = el("div", "flex flex-wrap gap-[6px] min-w-0 flex-1");
  const pickChipsRow = chipRow("档位", pickChips);
  const pickList = el("div", "grid gap-2 content-start pt-[2px] px-[2px] pb-1 @container");
  pickPane.append(pickStat, pickDateRow, pickChipsRow, pickList);

  /** 滚动面板:抽屉高度固定,当前 tab 的内容在面板内滚动(两个 pane 只有一个是 panel 的子节点) */
  const panel = el("div", "min-h-0 flex-1 overflow-y-auto");

  // ---- 视图状态 ----
  /** 影片库 tab 展开态:默认全折叠(目录 250 部,全展开不可用) */
  const expLib = new Set<string>();
  /** 我的选片 tab 展开态:默认展开(选片通常 < 30 部,展开才看得到「已排场次」这一核心信息) */
  const expPick = new Set<string>([...ctx.picks.keys()]);
  let kw = "";
  let unit: string | null = null;
  /** 我的选片档位筛选:null = 全部;UNSET = 未设档位(只点了场次没定档) */
  const UNSET = "unset";
  let filter: Priority | typeof UNSET | null = null;
  /** 我的选片日期筛选:null = 全部日期;否则只看该日的已排场次 */
  let dateFilter: string | null = null;

  // 挂进抽屉(既不是弹层、也不是页面):每次打开都重建内容 —— ctx 不缓存,
  // `syncFromCloud` 换过 `store.picks` 也不会读到旧 Map。
  // 状态同步走 bindPickerState 的订阅(替代弹层栈的 onReturn)。
  host.replaceChildren(head, panel);
  bindPickerChrome();
  bindPickerState();
  pickerRender = render;
  showPickerDrawer(); // 内部回调 main 侧补一次 renderGrid(网格可用宽度变了)

  /** 影片行 —— 两个 tab **共用**(唯一行构造,「展示机制 / 图标化」由此天然一致)。
   *  `mode` 只决定两件事:① 展开后的场次口径(库 = 全部场次 / 选片 = 已排场次);
   *  ② 右上角是否多一枚「✕ 整片移除」。其余(折叠箭头 / 片名区 / 状态标签 / 图标组 / 资料)完全同款。
   *
   *  **信息层级(2026-09-10 重构,见 PLAN-20260910184745 §8)**:
   *  ```
   *  ▶  片名(15px bold 墨黑)  豆8.5              ☆  ⓘ  ✕   ← 图标组:常态极淡,hover 才完全显现
   *     原始片名 · 单元 · 国家 · 年份 · 导演(#8C8C8C)        ← 副标题:统一次级灰,不与片名抢戏
   *     [共 4 场 / 已排 1 场]                               ← 状态标签(浅红底深红字),非按钮
   *  ```
   *  原设计把「档位徽章 + N 场 + 已排 N 场 + ⓘ + ✕」五枚控件平铺在片名行右侧,把片名挤成 0 宽、
   *  视觉噪声也大 —— 现在功能全部收进右上角图标组,片名拿到整行宽度。 */
  function filmRow(n: FilmNode, mode: "library" | "picks", open: boolean): HTMLElement {
    const rec = ctx.picks.get(n.key);
    const picked = rec?.picks.length ?? 0;
    // `group` 挂在卡片上:右上角图标靠 `group-hover:opacity-100` 做「hover 才完全显现」(见 ICON_BTN)
    const itemCls =
      "group border border-line rounded-[8px] bg-card transition-[border-color,box-shadow] duration-[120ms] " +
      "hover:border-line-strong hover:shadow-[var(--shadow-hover)]";
    const item = el("div", itemCls);
    item.dataset.key = n.key;

    // ---- 片名行(整行可点 = 展开 / 折叠) ----
    // 三列:箭头 / 片名区 / 图标组。片名区用 `minmax(0,1fr)` —— `1fr` 的 min-width:auto
    // 会被长片名撑破,`minmax(0,…)` 才允许它真正缩下去(截断而非溢出)。
    const head = el(
      "div",
      "grid grid-cols-[12px_minmax(0,1fr)_auto] items-start gap-x-[8px] gap-y-[6px] px-3 py-[10px] " +
        "cursor-pointer select-none hover:bg-hover" +
        (open ? " border-b border-line-faint" : "")
    );
    head.dataset[mode === "picks" ? "pickHead" : "libHead"] = n.key;
    head.appendChild(
      el(
        "span",
        "text-muted text-[10px] leading-none pt-[5px] transition-transform duration-150 ease-in-out" +
          (open ? " rotate-90" : ""),
        "▶"
      )
    );

    const cat0 = n.cats[0];
    const titles = el("div", "grid gap-[3px] min-w-0");
    // 片名行:片名(15px 加粗 + 深黑,与副标题拉开层级)+ 豆瓣章
    const zhTop = el("div", "flex items-center gap-2 min-w-0");
    zhTop.appendChild(el("div", "text-[15px] font-bold text-ink truncate flex-1", n.zh));
    if (cat0?.rating != null) {
      zhTop.appendChild(doubanChip(cat0.rating)); // 豆瓣章单一来源(legend.ts;豆 = 豆瓣评分)
    }
    titles.appendChild(zhTop);
    // 副标题:原始片名 + 单元 · 国家 · 年份 · 导演 —— 统一次级灰 `text-meta`,不与片名抢戏。
    // 原先分成两行(names 走 text-muted / meta 走 text-meta),合并成一行既省高度、又只有一个灰阶。
    const subBits = [...n.names, n.meta].filter(Boolean);
    if (subBits.length) {
      const sub = el("div", "text-[11.5px] text-meta leading-[1.5] truncate", subBits.join(" · "));
      sub.dataset.tip = subBits.join(" · "); // 截断时 hover 可读全文
      titles.appendChild(sub);
    }
    // 状态标签:场次计数 + 已排计数**合并成一枚**(原为两枚描边胶囊)——
    // 浅红底深红字 = 「这枚数字和我的行程有关」,而不是又一个可点的按钮。
    const status = el("div", "flex items-center gap-[6px] flex-wrap pt-[1px]");
    if (n.shows.length) {
      const txt =
        picked > 0
          ? `共 ${n.shows.length} 场 / 已排 ${picked} 场`
          : mode === "picks"
            ? `共 ${n.shows.length} 场 / 未排场`
            : `共 ${n.shows.length} 场`;
      status.appendChild(
        el(
          "span",
          "inline-flex items-center rounded-[5px] px-[7px] py-[2px] text-[11px] font-bold leading-[1.4] " +
            "whitespace-nowrap bg-biff-soft text-biff",
          txt
        )
      );
    } else {
      status.appendChild(
        el(
          "span",
          "inline-flex items-center rounded-[5px] px-[7px] py-[2px] text-[11px] font-semibold leading-[1.4] " +
            "whitespace-nowrap bg-raised text-muted",
          "暂无排期"
        )
      );
    }
    // 无排期但有豆瓣关联 → 直链(原是一枚按钮样式的胶囊,挪到状态行做文字链,不再冒充按钮)
    if (!n.shows.length && cat0) {
      const cmap = ctx.mappings.get(cat0.id);
      if (cmap?.douban_url) {
        const a = document.createElement("a");
        a.href = cmap.douban_url;
        a.target = "_blank";
        a.rel = "noreferrer";
        a.className = "text-[11px] font-bold text-biff whitespace-nowrap hover:underline";
        a.textContent = "豆瓣 ↗";
        status.appendChild(a);
      }
    }
    titles.appendChild(status);
    head.appendChild(titles);

    // ---- 右上角图标组(次要操作:常态极淡, hover 卡片才完全显现) ----
    const icons = el("div", "flex items-center gap-[2px] shrink-0");
    // ① 档位星标(★ 已定档按档位着色 / ☆ 未设;文字走 hover 提示,点击弹同一套菜单)
    // **仅「影片库」tab**(2026-09-10,见 PLAN-20260910192230):「我的选片」是已选视图,
    // 档位已由「排序(必看→备选→随缘)+ 档位筛选 chips」表达,不再给每行一枚改档控件;
    // 改档去「影片库」卡片 ★,或任意 tab 点「ⓘ」进资料弹层的档位 seg(行程行的 ★ 同样在)。
    if (mode === "library") {
      icons.appendChild(
        wishIcon({
          cur: rec?.priority ?? null,
          anchor: n.key,
          onPick: (p) => {
            setWish(n.key, p);
            // 新打标的片在「我的选片」tab **默认展开**(与它的初始态一致:选片就要看到已排场次)
            if (p) expPick.add(n.key);
            render();
          },
        })
      );
    }
    // ② 资料(ⓘ)—— 原为一枚带框按钮,挤占片名行宽度
    if (n.shows.length || cat0) {
      const detail = el("button", ICON_BTN + " hover:text-ink", "ⓘ");
      detail.dataset.libDetail = n.shows[0]?.code ?? cat0!.id;
      detail.dataset.tip = n.shows.length
        ? "影片资料 + 豆瓣条目"
        : "暂无排期 — 可先关联豆瓣(点开查条目/粘贴链接回填)";
      icons.appendChild(detail);
    }
    // ③ 整片移除(✕)—— 仅「我的选片」tab(库 tab 没有「移除」语义);hover 转红 = 破坏性操作预告
    if (mode === "picks") {
      const un = el("button", ICON_BTN + " hover:text-conf", "✕");
      un.dataset.pickRemove = n.key;
      un.dataset.tip = picked
        ? `整片移除 —— 连同已排的 ${picked} 场一起删掉(「我的行程」里也会消失)`
        : "从「我的选片」移除(该片没有已排场次)";
      icons.appendChild(un);
    }
    head.appendChild(icons);
    item.appendChild(head);

    if (!open) return item;

    // ---- 场次行 / 占位 ----
    const shows = el("div");
    const rows = mode === "picks" ? pickedShows(n, rec) : n.shows;
    if (rows.length) {
      if (mode === "picks") {
        // 「我的选片」tab:按日期分节 —— 节头给日期,节内场次行不再重复印日期(见 showRow 的 hideDate)
        for (const [date, list] of groupShowsByDate(rows)) {
          shows.appendChild(dateHead(date, list.length));
          list.forEach((s, idx) => shows.appendChild(showRow(s, idx > 0, true)));
        }
      } else {
        rows.forEach((s, idx) => shows.appendChild(showRow(s, idx > 0)));
      }
      // 已排场次里对不上当前排期的(数据换版)—— 如实说明,不静默吞掉(按日期筛时该口径不成立)
      if (mode === "picks" && dateFilter === null && rec && rec.picks.length > rows.length) {
        shows.appendChild(
          el(
            "div",
            "px-3 py-[6px] text-[11.5px] text-tight border-t border-line-faint",
            `另有 ${rec.picks.length - rows.length} 场已不在当前排期里(数据换版)`
          )
        );
      }
    } else {
      shows.appendChild(
        el(
          "div",
          "px-3 py-[8px] text-[11.5px] text-muted border-t border-line-faint",
          mode === "picks"
            ? n.shows.length
              ? `还没排场 — 这部片有 ${n.shows.length} 场可选,去「影片库」tab 或时间轴点选场次,选完这里就会出现(选片意向已保留)`
              : "该片暂无已发布排期"
            : "官方排期未发布 — 可先用行右侧「ⓘ」关联豆瓣条目;Catalogue 排期公布并引入后,这里会自动出现可定位的场次"
        )
      );
    }
    item.appendChild(shows);
    return item;
  }

  /** 场次行 —— 两个 tab **共用**。
   *  `withTopBorder` = 同一节里的第 2 场起画分隔线;
   *  `hideDate` = 「我的选片」tab 按日期分节后日期已由节头给出,行内只留时间(否则「10/21 周三」会连印两行)。
   *
   *  **排版(2026-09-10 重构,见 PLAN-20260910184745 §8)= 单行从左到右的阅读流**:
   *  ```
   *  [006] [17:00–18:31]  [B1][66min][12][KE][GV]        ——→   [定位 ▸] [✓ 已加入]
   *   ↑黑块白字  ↑与代码同字阶   ↑统一描边章组(只等级留强调色)      ↑唯一主操作  ↑纯状态标签
   *  ```
   *  ⚠ 用 `flex flex-wrap` 而**不是固定 grid**:`where` 组可整体换行、`acts` 组 `ml-auto` 恒贴右缘 ——
   *  抽屉宽度变化时自然降级,不再需要旧的容器查询列模板(`style.css` 的
   *  `@container … .show-row` 已随之删除,`show-row` 这个类名也不再是挂钩)。 */
  function showRow(s: Screening, withTopBorder: boolean, hideDate = false): HTMLElement {
    const row = el(
      "div",
      "flex flex-wrap items-center gap-x-[8px] gap-y-[5px] px-3 py-[8px]" +
        (withTopBorder ? " border-t border-line-faint" : "")
    );

    // ---- 左:**身份对**(CODE + 影院) + 时间范围(与 CODE 同字阶) ----
    // 影院贴 CODE:这是「场次在哪」的最小信息对,放一起让眼睛先抓身份再看时间。
    // 影院只出「官方代码」章(B1 / BT / L4)—— 全名 / 韩名 / 分区由 hover tooltip 兜住。
    const { label, weekday } = dateInfo(s.date);
    const venue = ctx.cat.venueById.get(s.venue_id);
    const vCode = venue ? venue.code ?? venue.id.toUpperCase() : s.venue_display;
    const when = el("div", "flex items-center gap-[5px] shrink-0 tabular-nums whitespace-nowrap");
    const codeEl = el(
      "span",
      "font-extrabold text-[11px] leading-[1.5] text-on-brand bg-ink rounded-[4px] px-[6px] py-px",
      s.code
    );
    codeEl.dataset.tip = codeTip(s.code); // 缩写说明:CODE 数字 hover 提示
    when.appendChild(codeEl);
    // 影院章与 CODE 同字阶、加粗(同组唯一加粗,让「在哪看」一眼可辨)
    when.appendChild(
      uniformChipEl(vCode, venue ? venueTip(venue) : s.venue_display, "font-extrabold text-ink-2 bg-card border-line")
    );
    if (!hideDate) when.appendChild(el("span", "text-[11px] text-meta", `${label} ${weekday}`));
    when.appendChild(el("span", "text-[11.5px] font-semibold text-ink", fmtMinRange(s.start_time, s.end_time)));

    // ---- 中:元数据章组 = **固定 3 列网格** ----
    // 之前 `flex flex-wrap` 靠容器宽度自然换行 → 「P.43」孤零零落单,章组参差不齐。
    // 改为 `grid grid-cols-3`:**每三个一行**,章数 4→3+1、5→3+2、6→3+3,规则可预测。
    // `justify-items: start`:短章不强行填满列宽,留出呼吸感(用户原话:「增加呼吸感」);
    // 缺章时空格子留白,不会"看起来少了一行"。
    const where = el("div", "grid grid-cols-3 gap-x-[5px] gap-y-[3px] flex-1 min-w-0 justify-items-start");
    where.appendChild(uniformChipEl(`${s.duration_min}min`, `片长 ${s.duration_min} 分钟(正片,不含映后谈)`));
    appendMetaRow(where, s, { uniform: true }); // 统一描边章:等级(强调色)+ 字幕 + GV/特性 + 页码

    // ---- 右:操作(层级分明 —— 定位 = 唯一主操作;加入/已加入 = 次要 / 状态) ----
    const acts = el("div", "flex items-center gap-[8px] shrink-0 ml-auto");
    const go = el("button", BTN_GO, "定位 ▸");
    go.dataset.libGo = s.code;
    go.dataset.tip = "跳到该影厅时间轴位置";
    // 加入/移出方案 —— 唯一场次列表在这里(弹层已不再重复列场次),与「定位 ▸」并排:
    // 想跳到时间轴看就点定位,想直接排进方案就点右侧三态控件,不必再开弹层。
    // 三态文案/配色由 modal.ts::actState 单源给出(已加入 = 状态标签而非按钮)。
    const act = el("button", "", "");
    act.dataset.libToggle = s.code;
    act.dataset.film = filmNodeKey(ctx.cat, s);
    const st0 = actState(s.code, ctx.group);
    act.textContent = st0.label;
    act.className = st0.cls;
    act.dataset.tip = st0.tip;
    acts.append(go, act);
    row.append(when, where, acts);
    return row;
  }

  /** 「我的选片」tab 展开口径:只列**已排场次**(「我的行程」在这部片上的投影)。
   *  按 日期 → 开始时间 排序(旧版是点选先后顺序,跨天时读起来是乱的);日期筛选生效时只留该日。 */
  function pickedShows(n: FilmNode, rec: PickEntry | undefined): Screening[] {
    if (!rec?.picks.length) return [];
    const byCode = new Map(n.shows.map((s) => [s.code, s]));
    return rec.picks
      .map((p) => byCode.get(p.code))
      .filter((s): s is Screening => Boolean(s))
      .filter((s) => dateFilter === null || s.date === dateFilter)
      .sort((a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time));
  }

  /** 「影片库」tab:全部影片(搜索 + 单元筛选) */
  function paintLib(): void {
    const q = kw.trim().toLowerCase();
    libList.innerHTML = "";

    const matched = filmList.filter((n) => matchNode(n, q) && (!unit || inUnit(n, unit)));

    const filtered = Boolean(q) || unit !== null;
    const prefix = unit ? `${unit} · ` : "";
    libStat.textContent = filtered
      ? `${prefix}匹配 ${matched.length}/${filmList.length} 部影片`
      : `目录共 ${filmList.length} 部(其中 ${totalShows ? `${filmList.length - noSchedule} 部已发布排期` : "排期尚未发布"}) · ${totalShows} 场`;

    // 单元 chips(激活态直接由本次重建给出,不做 className 二次同步)
    libChips.innerHTML = "";
    if (unitChips.length) {
      const allChip = el("button", unit === null ? CHIP_UNIT_ON : CHIP_UNIT_IDLE, `全部 ${ctx.cat.films.length}`);
      allChip.dataset.unit = "";
      allChip.dataset.tip = "取消单元筛选";
      libChips.appendChild(allChip);
      for (const c of unitChips) {
        const b = el("button", unit === c.key ? CHIP_UNIT_ON : CHIP_UNIT_IDLE, `${c.key} ${c.count}`);
        b.dataset.unit = c.key;
        b.dataset.tip = "再次点击取消筛选";
        libChips.appendChild(b);
      }
    }

    if (matched.length === 0) {
      const what = [kw.trim() && `「${kw.trim()}」`, unit && `单元「${unit}」`].filter(Boolean).join(" + ");
      libList.appendChild(el("div", "text-muted text-center py-[26px] text-[13px]", `没有匹配${what ? ` ${what}` : ""}的影片,试试英文/原始片名或切回「全部」`));
      return;
    }

    for (const n of matched) {
      // 搜索时自动展开命中片(与旧版一致:搜到就想看它的场次)
      libList.appendChild(filmRow(n, "library", expLib.has(n.key) || q !== ""));
    }
  }

  /** 「我的选片」tab(档位排序 + 档位筛选) */
  const rankOf = (p: Priority | null | undefined): number =>
    p ? WISH_ORDER.findIndex(([x]) => x === p) : WISH_ORDER.length;
  const pickNodes = (): FilmNode[] =>
    filmList
      // 整部片都没有已发布排期(暂无排期)的不要进「我的选片」——
      // 它是「已选」视图,没有场次可选的片出现在这里没意义;
      // 这类片仍在「影片库」tab 里以档位徽章呈现(选片意向保留),
      // 排期接入后会自动重新出现。已打标但「未排场」(picks:[])且
      // shows>0 的片仍保留(选了片但还没落场 = 合法的选片意向)。
      .filter((n) => ctx.picks.has(n.key) && n.shows.length > 0)
      .sort((a, b) => rankOf(ctx.picks.get(a.key)?.priority) - rankOf(ctx.picks.get(b.key)?.priority));

  function paintPick(): void {
    const rows = pickNodes();
    const counts: Record<Priority, number> = { must: 0, maybe: 0, wild: 0 };
    /** 有已排场次的每个日期 → 当日场次数(日期 chips 的数据源) */
    const dateCount = new Map<string, number>();
    let unset = 0;
    let slots = 0;
    for (const n of rows) {
      const e = ctx.picks.get(n.key)!;
      if (e.priority) counts[e.priority]++;
      else unset++;
      slots += e.picks.length;
      for (const p of e.picks) {
        const s = ctx.cat.byCode.get(p.code);
        if (s) dateCount.set(s.date, (dateCount.get(s.date) ?? 0) + 1);
      }
    }
    pickStat.textContent = rows.length
      ? `选片 ${rows.length} 部 · 必看 ${counts.must} / 备选 ${counts.maybe} / 随缘 ${counts.wild}${
          unset ? ` / 未设 ${unset}` : ""
        } · 已排 ${slots} 场`
      : "还没有任何选片";

    // 日期导航栏(「全部」+ 有已排场次的每一天)。只有 1 天时不渲染 —— 只有一个选项的筛选没有意义
    const dates = [...dateCount.keys()].sort();
    if (dateFilter && !dateCount.has(dateFilter)) dateFilter = null; // 该天的场次被删光了 → 自动回到「全部」
    pickDateRow.classList.toggle("is-hidden", dates.length <= 1);
    pickDatePrev.dataset.tip = "向左滚动";
    pickDateNext.dataset.tip = "向右滚动";
    pickDateChips.innerHTML = "";
    /** 单行可滚动:‹ / › 改语义为「左右滚动」,disabled 由 chips 实际滚动位置决定 */
    const updateDateNavDisabled = (): void => {
      const max = pickDateChips.scrollWidth - pickDateChips.clientWidth;
      pickDatePrev.disabled = pickDateChips.scrollLeft <= 0;
      pickDateNext.disabled = pickDateChips.scrollLeft >= max - 1;
    };
    if (dates.length > 1) {
      const all = el("button", dateFilter === null ? CHIP_UNIT_ON : CHIP_UNIT_IDLE, `全部 ${dates.length} 天`);
      all.dataset.pdate = "";
      all.dataset.tip = "显示全部日期的选片";
      pickDateChips.appendChild(all);
      for (const d of dates) {
        const { label, weekday } = dateInfo(d);
        const b = el("button", dateFilter === d ? CHIP_UNIT_ON : CHIP_UNIT_IDLE, `${label} ${weekday} ${dateCount.get(d)}`);
        b.dataset.pdate = d;
        b.dataset.tip = `只看 ${label} ${weekday} 的选片(再点取消)`;
        pickDateChips.appendChild(b);
      }
    }
    // 滚动事件只挂一次(disabled 跟实际滚动位置走;chips 重渲不重挂)
    if (!(pickDateChips as unknown as { __dateNavBound?: boolean }).__dateNavBound) {
      (pickDateChips as unknown as { __dateNavBound?: boolean }).__dateNavBound = true;
      pickDateChips.addEventListener("scroll", updateDateNavDisabled, { passive: true });
    }
    // 下一帧取 clientWidth(scrollWidth 此时已就绪)再校准 disabled
    requestAnimationFrame(updateDateNavDisabled);

    // 档位筛选 chips(全部 + 三档 + 未设,带实时计数)
    pickChips.innerHTML = "";
    if (rows.length) {
      const defs: [Priority | typeof UNSET | null, string][] = [
        [null, `全部 ${rows.length}`],
        ...WISH_ORDER.map(([p, label]) => [p, `${label} ${counts[p]}`] as [Priority, string]),
      ];
      if (unset) defs.push([UNSET, `未设 ${unset}`]);
      for (const [p, label] of defs) {
        const b = el("button", filter === p ? CHIP_UNIT_ON : CHIP_UNIT_IDLE, label);
        b.dataset.pri = p ?? "";
        b.dataset.tip = p ? "只看该档位(再点取消)" : "显示全部";
        pickChips.appendChild(b);
      }
    }

    pickList.innerHTML = "";
    if (!rows.length) {
      pickList.appendChild(
        el(
          "div",
          "text-[13px] text-muted leading-[1.8] py-[18px] px-[6px] text-center",
          "还没有选片 — 切到「影片库」tab,在片名行右侧点档位徽章(「+ 标记」)选「必看 / 备选 / 随缘」,或直接在时间轴上点选场次。两种操作写的是同一份数据,这里与「我的行程」永远一致。"
        )
      );
      return;
    }
    const shown = rows
      .filter((n) => {
        const p = ctx.picks.get(n.key)!.priority;
        return filter === null || (filter === UNSET ? !p : p === filter);
      })
      .filter((n) => {
        if (dateFilter === null) return true;
        return ctx.picks.get(n.key)!.picks.some((p) => ctx.cat.byCode.get(p.code)?.date === dateFilter);
      });
    if (!shown.length) {
      pickList.appendChild(el("div", "text-muted text-center py-[26px] text-[13px]", "当前筛选下暂无选片"));
      return;
    }
    for (const n of shown) pickList.appendChild(filmRow(n, "picks", expPick.has(n.key)));
  }

  /** 重建**当前 tab**。抽屉会在用户点选网格时持续存活,而 `store` 每次变更都会广播 ——
   *  若照旧两个 tab 都重建,一次网格点选就要顺手重建 250 行影片库。
   *  非当前 tab 不画:切过去时由 setTab() 重画一遍(筛选 / 展开态等状态变量都在闭包里,不丢)。 */
  function render(): void {
    if (pickerTab === "lib") paintLib();
    else if (pickerTab === "pick") paintPick();
    else /* "agenda" */ renderAgenda();
    paintTabCounts();
  }

  /** agenda tab 内容 = main.ts 注入的 agendaRenderer()(它闭包读 conflicts / gvTalkOf / hourFilter)。 */
  function renderAgenda(): void {
    const node = agendaRenderer ? agendaRenderer() : null;
    panel.replaceChildren(
      node ?? el("div", "py-[40px] text-center text-muted", "行程面板尚未挂载")
    );
  }

  /** tab 计数徽章(「我的选片 12」/「我的行程 N」) */
  function paintTabCounts(): void {
    const pn = pickNodes().length;
    pickTab.textContent = pn ? `我的选片 ${pn}` : "我的选片";
    const an = codesOfGroup("A").length + codesOfGroup("B").length;
    agendaTab.textContent = an ? `我的行程 ${an}` : "我的行程";
  }

  /** 切 tab:换面板子节点 → 复位滚动 → 重画。当前 tab 跨开合保持(见 pickerTab) */
  function setTab(which: "lib" | "pick" | "agenda"): void {
    pickerTab = which;
    const tabs = { lib: libTab, pick: pickTab, agenda: agendaTab };
    for (const [k, btn] of Object.entries(tabs)) {
      (btn as HTMLElement).className = k === which ? TAB_ON : TAB_OFF;
    }
    libTab.dataset.tip = which === "lib" ? "当前:影片库(全部影片)" : "切到影片库(全部影片)";
    pickTab.dataset.tip =
      which === "pick"
        ? "当前:我的选片(按档位 / 日期筛选,展开看已排场次)"
        : "切到我的选片(按档位 / 日期筛选,展开看已排场次)";
    agendaTab.dataset.tip =
      which === "agenda"
        ? "当前:我的行程(按日期分组的已排场次;PLAN-20260910190916 搬入)"
        : "切到我的行程(按日期分组的已排场次)";
    // agenda tab 由 renderAgenda() 直接 replaceChildren(因为 panel 是 agendaRenderer 一次性产物)
    if (which === "agenda") renderAgenda();
    else panel.replaceChildren(which === "lib" ? libPane : pickPane);
    panel.scrollTop = 0;
    render();
  }

  libTab.addEventListener("click", () => setTab("lib"));
  pickTab.addEventListener("click", () => setTab("pick"));
  agendaTab.addEventListener("click", () => setTab("agenda"));
  closeBtn.addEventListener("click", () => closePickerDrawer());

  search.addEventListener("input", () => {
    kw = search.value;
    render();
  });

  libChips.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>("[data-unit]");
    if (!btn) return;
    const k = btn.dataset.unit!;
    unit = k === "" ? null : unit === k ? null : k;
    render();
  });

  pickChips.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-pri]");
    if (!b) return;
    const k = b.dataset.pri!;
    const next: Priority | typeof UNSET | null = k === "" ? null : k === UNSET ? UNSET : (k as Priority);
    filter = filter === next ? null : next;
    render();
  });

  pickDateChips.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-pdate]");
    if (!b) return;
    const d = b.dataset.pdate!;
    dateFilter = d === "" || dateFilter === d ? null : d; // 再点当前天 / 点「全部」= 取消
    render();
  });

  /** 日期行左右滚动:单行 nowrap 后‹/› 退化为「滚动按钮」,滚一个 chip 宽度。
   *  到边界靠 paintPick 里的 updateDateNavDisabled() 把按钮置灰。 */
  const scrollDate = (delta: number): void => {
    const step = Math.max(72, pickDateChips.clientWidth - 24) * (delta > 0 ? 1 : -1);
    pickDateChips.scrollBy({ left: step, behavior: "smooth" });
  };
  pickDatePrev.addEventListener("click", () => scrollDate(-1));
  pickDateNext.addEventListener("click", () => scrollDate(1));

  // 两个 tab 共用**一套**委托(行是同一份 filmRow 构造出来的,锚点属性因此也是同一套)。
  // 挂在每次新建的 panel 上 —— 旧 panel 随 host.replaceChildren 一起丢弃,监听不会累积。
  panel.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    // 加入/移出方案 —— 必须最先判:按钮在「场次行」内,否则会冒泡成该行定位(或片名行展开)
    const toggleBtn = target.closest<HTMLElement>("[data-lib-toggle]");
    if (toggleBtn) {
      ctx.onToggle(toggleBtn.dataset.film!, toggleBtn.dataset.libToggle!);
      render(); // 就地重绘:三态按钮 + tab 计数同步
      return;
    }
    const detailBtn = target.closest<HTMLElement>("[data-lib-detail]");
    if (detailBtn) {
      ctx.onFilm(detailBtn.dataset.libDetail!);
      return;
    }
    // 定位只走「定位 ▸」按钮 —— 行本身不再可点(2026-09-10:整行可点易误触,点片名 / 影院名就跳走)
    const goBtn = target.closest<HTMLElement>("[data-lib-go]");
    if (goBtn) {
      ctx.onLocate(goBtn.dataset.libGo!);
      return;
    }
    // 整片移除(仅「我的选片」tab)—— 已排场次带 confirm,避免一键抹掉整片行程
    const rmBtn = target.closest<HTMLElement>("[data-pick-remove]");
    if (rmBtn) {
      const key = rmBtn.dataset.pickRemove!;
      const n = ctx.picks.get(key)?.picks.length ?? 0;
      if (n) {
        const zh = filmList.find((x) => x.key === key)?.zh ?? "";
        if (!window.confirm(`《${zh}》已排 ${n} 场,确定整片移除(含这些场次)?`)) return;
      }
      removePick(key);
      render();
      return;
    }
    // 片名行 = 展开 / 折叠(两 tab 各一份展开态:「影片库」默认全折叠,「我的选片」默认展开)
    const head = target.closest<HTMLElement>("[data-lib-head],[data-pick-head]");
    if (head) {
      const inLib = head.dataset.libHead !== undefined;
      const key = (inLib ? head.dataset.libHead : head.dataset.pickHead)!;
      const set = inLib ? expLib : expPick;
      if (set.has(key)) set.delete(key);
      else set.add(key);
      render();
    }
  });

  /* ---- 智能排片 ▸(AI 排片 → 采纳为 A/B 方案) ----
   * 入口就在「影片库」tab 上 → `fromLibrary = true`:无片单模式提示里的
   * 「← 返回影片库打标」只需关掉排片弹层(抽屉本来就在后面,不再叠一层)。 */
  aiBtn.addEventListener("click", () => openEngineDialog(filmList, ctx, render, true));

  // 首画:画当前 tab(`pickerTab` 跨开合保持 —— 上次在看「我的选片」,再打开还在那儿)
  setTab(pickerTab);
  if (pickerTab === "lib" && window.matchMedia("(pointer: fine)").matches) search.focus();
}

/* ---- 智能排片弹层 —— 「影片库」与「我的选片」共用入口(同源 picks,避免两处各写一份) ----
 *  **AI 单通道**:2026-09-10 起本地确定性求解引擎整体下线(PLAN-20260910143516)——
 *  弹层不再有「本地引擎 / AI 排片」分段控件,打开即是 AI 面板(未配 Key 时先展开配置表单)。
 *  **无片单模式**(2026-09-10 加):一部片都没打标也能排 —— 候选池退化为「全部**有排期**的影片」,
 *  档位一律按 `wild`(只是「可自由挑选」的传输标记),怎么排**完全由偏好文字决定**
 *  (如「下午三点看到晚上七点」)。见 PLAN-20260910143929 §9。
 *  **强制无片单开关**(2026-09-10 加,见 PLAN-20260910145749 §8):`tagged` 非空时按现状走
 *  「有片单模式」(只送已打标影片给 AI),但用户可能想「已打标的只是参考,主要让 AI 自由选」——
 *  这时勾选面板里的「强制无片单模式」开关 → 候选池退化为「全部有排期影片」,已打标档位忽略
 *  (采纳时仍记 `null = 未设`)。
 *  onReturn:返回上一层(影片库 / 我的选片)时刷新其列表 —— 并入方案后「已选 N 场」计数要跟上。
 *  `fromLibrary` = 本弹层是从**影片库**开出来的(而非「我的选片」)—— 只影响无片单模式里
 *  「去影片库打标」按钮的落点(见 `modeBar`)。 */
function openEngineDialog(
  filmList: FilmNode[],
  ctx: LibraryCtx,
  onReturn?: () => void,
  fromLibrary = false
): void {
  // 检查是否有任何有排期的影片(无论是否打标)—— 若整个 festival 都没排期则早退
  const anyHasShow = filmList.some((n) => n.shows.length > 0);
  const box = el("div", "grid gap-3");
  if (!anyHasShow) {
    box.appendChild(
      el(
        "div",
        "text-[13px] text-muted py-[10px] px-[2px] leading-[1.7]",
        "当前没有任何已发布排期,无法排片 —— 排期数据就绪后再来。"
      )
    );
    openModal("智能排片 · AI 建议行程", box, false, onReturn);
    return;
  }
  // wanted / noFilmList 计算搬到 aiPanel 内 —— 因为「强制无片单」是面板内的 toggle,
  // 切换时必须重新计算 wanted 并刷新整个面板。openEngineDialog 只负责早退 + 弹层挂载。
  box.appendChild(aiPanel(filmList, ctx, store.settings.transitMin, fromLibrary));
  openModal("智能排片 · AI 建议行程", box, true, onReturn);
}

/* ---- 按钮字面量(Tailwind v4 只生成源码里完整出现的类,勿拼) ---- */
const BTN_PRIMARY =
  "border-0 rounded-[6px] px-[14px] py-[6px] text-[13px] font-bold text-on-brand bg-[linear-gradient(135deg,var(--biff-red)_0%,var(--biff-red-2)_100%)] hover:brightness-[1.05] whitespace-nowrap";
const BTN_ABORT =
  "border border-line rounded-[6px] px-[14px] py-[6px] text-[13px] font-bold bg-raised text-ink hover:bg-raised-hover whitespace-nowrap";
const BTN_MINI =
  "border border-line rounded-[7px] px-[8px] py-[3px] text-[11.5px] font-semibold bg-card text-ink hover:border-line-strong hover:bg-hover whitespace-nowrap";
const BTN_DISABLED =
  "border-0 rounded-[6px] px-[14px] py-[6px] text-[13px] font-bold text-muted bg-raised cursor-not-allowed whitespace-nowrap";
/** AI 面板「排哪几天」日期 chip —— 与单元 chip 同构(选中 = 墨底反白) */
const CHIP_DATE_BASE =
  "border rounded-full px-[10px] py-[3px] text-[12px] font-semibold whitespace-nowrap tabular-nums hover:border-biff";
const CHIP_DATE_IDLE = `${CHIP_DATE_BASE} border-line bg-card text-muted hover:text-ink`;
const CHIP_DATE_ON = `${CHIP_DATE_BASE} border-ink bg-ink text-on-brand`;

/** 配置表单的一行(标签 + 控件同行,提示另起一行)—— 与 main.ts::settingsField 同构 */
function aiField(label: string, hint: string): { box: HTMLElement; row: HTMLElement } {
  const box = el("label", "grid gap-1");
  const row = el("div", "flex items-center gap-[10px] flex-wrap");
  row.appendChild(el("span", "font-semibold text-[12.5px] shrink-0", label));
  box.append(row, el("div", "text-muted text-[11.5px]", hint));
  return { box, row };
}

/** `tag` 落到 `data-ai`,给无头验收脚本做稳定锚点(文案选择器易受改字影响) */
function aiInput(type: string, value: string, ph: string, tag: string): HTMLInputElement {
  const i = el("input", "border border-line rounded-[8px] px-2 py-[5px] text-[13px] w-[250px] max-w-full bg-card") as HTMLInputElement;
  i.type = type;
  i.value = value;
  i.placeholder = ph;
  i.autocomplete = "off";
  i.spellcheck = false;
  i.dataset.ai = tag;
  return i;
}

/* ---- AI 排片面板 ----
 * 隐私承诺的落点(见 ai.ts 文件头):
 *   · 三件套(baseUrl / model / key)与用户偏好只落 `localStorage["biff.ai.v1"]`;
 *   · 请求由浏览器直连用户填的 baseURL,本站 /api/* 一行不改、不新增任何代理;
 *   · UI 只显示掩码 key(maskKey),完整 key 不出现在任何 title / 文本节点里。
 * 弹层内改状态必须**就地重绘**(renderAll 不管 #modal-root,见 CONVENTIONS §二)。
 *  `noFilmList` = 无片单模式(一部都没打标 **或** 用户手动勾了「强制无片单」开关;
 *  候选池 = 全部有排期的影片,怎么排看偏好文字)。
 *  **wanted 与 noFilmList 都在本面板内重算** —— 因为「强制无片单」开关 / 档位变化都会影响
 *  候选池,搬出本函数就要么用全局 store(又多一个状态)、要么传引用,都不如闭包内重算直接。
 *  **多方案**(2026-09-10 加,见 PLAN-20260910162000):模型返回 1~3 个候选方案(按用户优先级
 *  排序),`resultCard` 每个方案一张**可折叠卡** + 独立「并入 A/B」—— 用户自己挑一个采用;
 *  日期 chips 的**上次选择**落 `biff.ai.dates.v1`(收窄日期 = 减少上下文)。 */
function aiPanel(
  filmList: FilmNode[],
  ctx: LibraryCtx,
  transitMin: number,
  fromLibrary = false
): HTMLElement {
  const wrap = el("div", "grid gap-[10px]");
  let cfg = loadAiCfg();
  let editing = false; // 「更换」= 已配置也展开表单
  let running = false;
  let plan: AiPlan | null = null;
  let errText = "";
  let showRaw = false;
  /** 每个候选方案(下标)已并入的方案 —— 用户自己挑,各方案互不影响 */
  const adopted = new Map<number, Group>();
  /** 每个候选方案的采纳回执 —— 并入是非破坏性操作,故不弹确认,改在结果卡上写清「加了 / 跳过了」几场 */
  const adoptNotes = new Map<number, string>();
  /** 结果卡里展开的候选方案下标 —— 默认只展开第一个(3 份完整场次清单一次性铺开太长) */
  const openOpts = new Set<number>([0]);
  let ctl: AbortController | null = null;
  let promptTa: HTMLTextAreaElement | null = null;
  /** 「强制无片单模式」开关 —— 默认 off,on 时忽略已打标影片,候选池 = 全部有排期影片。
   *  (PLAN-20260910145749 §8:tagged 非空时按现状是「有片单模式」,但用户可能希望 AI 完全自由选 —— 这时切到 on) */
  let forceNoFilmList = false;
  /** 日期范围:**记住上次选择**(2026-09-10 改,见 PLAN-20260910162000)—— 落 `biff.ai.dates.v1`;
   *  首次(无存档)仍为**全不选**(防误操作:开弹层直接点「开始」会把 10 天 700 场全量送给 LLM 白烧 token,
   *  空选时 `runBar` 按钮禁用 + 状态红字「至少要选一天」)。只送所选日期的场次 → 收窄日期 = 直接减少上下文。
   *  存档里已不存在的日期(数据换版)自动丢弃。 */
  const selDates = new Set<string>(loadAiDates().filter((d) => ctx.cat.dates.includes(d)));
  /** 日期选择变更的统一出口:落盘(记住) → 重绘(按钮态 / 计数 / 下一次 payload 一起跟上) */
  const commitDates = (): void => {
    saveAiDates(selDates);
    paint();
  };

  /** 重算「已定档」影片(`tagged`)—— 与 `openEngineDialog` 原口径一致:
   *  只收 priority ≠ null 的影片;`null`(= 未设 / 只点了场次)不参与。 */
  const taggedNow = (): EngineFilm[] => {
    const out: EngineFilm[] = [];
    for (const n of filmList) {
      const p = ctx.picks.get(n.key)?.priority;
      if (!p) continue;
      out.push({
        key: n.key,
        zh: n.zh,
        priority: p,
        rating: n.cats[0]?.rating ?? null,
        shows: n.shows,
      });
    }
    return out;
  };
  /** 重算候选池 —— paint 每次都跑,所以开关切换能即时反映到面板与后续 buildPayload。 */
  const wantedNow = (): { wanted: EngineFilm[]; noFilmList: boolean } => {
    const tagged = taggedNow();
    const noFilmList = tagged.length === 0 || forceNoFilmList;
    if (noFilmList) {
      return {
        wanted: filmList
          .filter((n) => n.shows.length > 0)
          .map((n) => ({
            key: n.key,
            zh: n.zh,
            priority: "wild" as Priority,
            rating: n.cats[0]?.rating ?? null,
            shows: n.shows,
          })),
        noFilmList: true,
      };
    }
    return { wanted: tagged, noFilmList: false };
  };

  /** 打包 —— 每次重算(日期选择或「强制无片单」切换都会变)。`dates` 同时是过滤条件与 `env.dates`:
   *  所选日期内一场都没有的影片整条不送(送过去模型也排不了)。 */
  const buildNow = (): AiPayload => {
    const { wanted } = wantedNow();
    return buildPayload(wanted, ctx.cat, transitMin, store.settings.gvTalkMin, ctx.cat.dates.filter((d) => selDates.has(d)));
  };

  /** 实际送出去的影片清单(与 payload.films 同源)—— `parseAiResult` 取中文名 / 补「未纳入」都用它 */
  const sentFilmsOf = (p: AiPayload): EngineFilm[] => {
    const keys = new Set(p.films.map((f) => f.key));
    return wantedNow().wanted.filter((f) => keys.has(f.key));
  };

  /* ---- 隐私说明(恒显,配置前后都在) ---- */
  const privacyBar = (): HTMLElement => {
    const card = el("div", "rounded-[8px] border border-line-faint bg-hover px-3 py-[10px] grid gap-[5px]");
    card.appendChild(el("div", "text-[12px] font-bold text-ok", "API Key 只存在本地 · 不上传、不经手服务器"));
    const ul = el("div", "grid gap-[3px] text-[11.5px] text-ink-2 leading-[1.6]");
    for (const t of [
      "Key 只保存在你这台设备的浏览器里,不存在本站服务器,也不会进入任何发往本站的请求",
      "排片请求由浏览器直连你填写的模型服务商 —— 本站不经手,也无法看到你的 Key",
      "本站不提供、不转售模型服务:用你自己的额度,本站既不花你的钱也不赚你的钱",
      "浏览器本地为明文存储:公用电脑请勿保存;随时可点「清除 Key」",
    ]) {
      ul.appendChild(el("div", "", `· ${t}`));
    }
    card.appendChild(ul);
    return card;
  };

  /* ---- 无片单模式提示(仅 noFilmList 时渲染)----
   * 必须明说四件事:① 没打标也能排;② 候选池有多大(= 直接的成本);③ **先选片能显著收窄候选**;
   * ④ 并入后这些片在「我的选片」里是「未设」档位。
   * **引导先选片**(2026-09-10 加,见 PLAN-20260910163000):候选 270+ 部 / 700 场一次性送给 LLM
   * 又慢又贵,而用户在「影片库」打标十来部就能把上下文压到十分之一 —— 故给一个**直达按钮**,
   * 而不是只把「建议收窄日期」写成小字。 */
  const modeBar = (): HTMLElement => {
    const card = el("div", "rounded-[8px] border border-biff-line bg-biff-soft px-3 py-[10px] grid gap-[5px]");
    const { wanted } = wantedNow();
    const taggedCount = taggedNow().length;
    const headText =
      taggedCount === 0
        ? "还没有选片 —— 不打标也能排,但先打标更快更准"
        : "强制无片单模式:忽略已打标的影片";
    card.appendChild(el("div", "text-[12px] font-bold text-biff", headText));
    const ul = el("div", "grid gap-[3px] text-[11.5px] text-ink-2 leading-[1.6]");
    for (const t of [
      taggedCount === 0
        ? `你还没给任何影片打「必看 / 备选 / 随缘」→ 本次把全部 ${wanted.length} 部有排期的影片都作为候选`
        : `你的「我的选片」里有 ${taggedCount} 部已打标的影片 → 本次**忽略这些**,把全部 ${wanted.length} 部有排期的影片都作为候选`,
      taggedCount === 0
        ? `**先选片更划算**:去「影片库」给想看的片点「必看 / 备选 / 随缘」,候选池会从 ${wanted.length} 部缩到你打标的那几部 —— 请求更快更省,排出来也更贴你的口味`
        : "想更省 token:取消上面的「强制无片单」开关,只把已打标的影片交给 AI",
      "怎么排**完全看下面「③ 你的排片偏好」** —— 例如「下午三点开始、晚上七点结束」「只看 BCC 的场」「每天最多 3 场」",
      "不填偏好也可以:会按评分与 GV(映后谈)优先挑一份紧凑行程",
      "并入方案后,这些片在「我的选片」里显示为「未设」档位(你没给它们打标,不会替你编一个)",
      "候选多 → 单次请求又慢又贵:至少先在「② 排哪几天」里收窄到你要的那几天",
    ]) {
      ul.appendChild(el("div", "", `· ${t}`));
    }
    card.appendChild(ul);
    // 直达打标入口:先关掉排片弹层(回到影片库 / 我的选片),再开影片库。
    // 从影片库进来的话**只关本层** —— 否则会在栈里叠出第二层一模一样的影片库。
    if (taggedCount === 0) {
      const go = el("button", BTN_PRIMARY, fromLibrary ? "← 返回影片库打标" : "去影片库打标 ▸");
      go.dataset.ai = "go-tag";
      go.dataset.tip = "在「影片库」给想看的片点「必看 / 备选 / 随缘」,再回来排片 —— 候选更少、请求更快、结果更准";
      go.addEventListener("click", () => {
        closeModal();
        if (!fromLibrary) openFilmPicker(ctx);
      });
      card.appendChild(go);
    }
    return card;
  };

  /* ---- 「强制无片单」开关(仅 tagged 非空时显示)----
   * 让用户在「已打标的影片作强约束」」与「AI 自由选」之间切换,默认 off(尊重用户已打的档位)。
   * 切换时 wanted 重算,paint 立即反映到 modeBar / runBar / payload 计数(PLAN-20260910145749 §8)。
   * tagged 为 0 时返回 null —— 此时已是「真·无片单模式」,开关无意义。 */
  const forceToggleRow = (): HTMLElement | null => {
    const taggedCount = taggedNow().length;
    if (taggedCount === 0) return null;
    const row = el(
      "label",
      "flex items-center gap-[8px] cursor-pointer select-none rounded-[8px] border border-line bg-card px-3 py-[8px]"
    );
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = forceNoFilmList;
    cb.dataset.ai = "force-no-film-list";
    cb.className = "accent-biff w-[14px] h-[14px] cursor-pointer";
    cb.addEventListener("change", () => {
      forceNoFilmList = cb.checked;
      // 已有结果也作废:候选池已变,旧 picks/drops/rejected 都失去上下文
      plan = null;
      errText = "";
      adopted.clear();
      adoptNotes.clear();
      openOpts.clear();
      openOpts.add(0);
      paint();
    });
    const txt = el(
      "span",
      "text-[12.5px] text-ink-2",
      `强制无片单模式(忽略「我的选片」里已打标的 ${taggedCount} 部影片)`
    );
    row.append(cb, txt);
    return row;
  };

  /* ---- 态 A:未配置(或点了「更换」)---- */
  const cfgForm = (): HTMLElement => {
    const box = el("div", "grid gap-[10px] border border-line rounded-[10px] p-3");
    box.appendChild(el("div", "text-[13px] font-bold text-ink", "① 填入你自己的模型 API Key"));

    const f0 = aiField("服务商", "选中只预填 Base URL 与模型名,两项都可改;「自定义」留空自填");
    const sel = document.createElement("select");
    sel.className = "border border-line rounded-[8px] px-2 py-[5px] text-[13px] bg-card";
    for (const p of AI_PRESETS) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.label;
      sel.appendChild(o);
    }
    sel.value = AI_PRESETS.find((p) => p.baseUrl === cfg.baseUrl && p.model === cfg.model)?.id ?? "custom";
    sel.dataset.ai = "preset";
    f0.row.appendChild(sel);
    box.appendChild(f0.box);

    const f1 = aiField("Base URL", "OpenAI 兼容接口地址,通常以 /v1 结尾");
    const urlInp = aiInput("text", cfg.baseUrl, "https://api.deepseek.com/v1", "url");
    f1.row.appendChild(urlInp);
    box.appendChild(f1.box);

    const f2 = aiField("模型名", "服务商文档里的模型 ID");
    const modelInp = aiInput("text", cfg.model, "deepseek-chat", "model");
    f2.row.appendChild(modelInp);
    box.appendChild(f2.box);

    const f3 = aiField("API Key", "只写入本机浏览器;不会发往本站服务器,本站也读不到");
    const keyInp = aiInput("password", cfg.key, "sk-…", "key");
    const eye = el("button", BTN_MINI, "显示");
    eye.dataset.ai = "eye";
    eye.addEventListener("click", () => {
      const show = keyInp.type === "password";
      keyInp.type = show ? "text" : "password";
      eye.textContent = show ? "隐藏" : "显示";
    });
    f3.row.append(keyInp, eye);
    box.appendChild(f3.box);

    sel.addEventListener("change", () => {
      const p = AI_PRESETS.find((x) => x.id === sel.value);
      if (p && p.id !== "custom") {
        urlInp.value = p.baseUrl;
        modelInp.value = p.model;
      }
    });

    // 操作行:校验提示靠左、按钮组贴右(次要「取消」在左,主「保存到本机」贴右下角)——
    // 与设置弹层底部主按钮同一落位语言(PLAN-20260910135532 §二 态 A 草图即右对齐)。
    const actions = el("div", "flex gap-[10px] items-center flex-wrap");
    const save = el("button", BTN_PRIMARY, "保存到本机");
    save.dataset.ai = "save";
    const hint = el("span", "text-[12px] text-conf flex-1 min-w-0", "");
    save.addEventListener("click", () => {
      const next: AiCfg = {
        baseUrl: urlInp.value.trim(),
        model: modelInp.value.trim(),
        key: keyInp.value.trim(),
        userPrompt: cfg.userPrompt,
      };
      if (!aiReady(next)) {
        hint.textContent = "三项都要填:Base URL / 模型名 / API Key";
        return;
      }
      cfg = next;
      saveAiCfg(cfg);
      editing = false;
      paint();
    });
    const btns = el("div", "flex items-center gap-[10px] ml-auto");
    if (aiReady(cfg)) {
      const cancel = el("button", BTN_MINI, "取消");
      cancel.dataset.ai = "cancel";
      cancel.addEventListener("click", () => {
        editing = false;
        paint();
      });
      btns.appendChild(cancel);
    }
    btns.appendChild(save);
    actions.append(hint, btns);
    box.appendChild(actions);
    return box;
  };

  /* ---- 态 B:已配置 ---- */
  const readyBar = (): HTMLElement => {
    const bar = el("div", "flex items-center gap-[8px] flex-wrap rounded-[8px] border border-line-faint bg-hover px-3 py-[9px]");
    bar.appendChild(el("span", "text-[12.5px] font-bold text-ok", "✓ 已配置"));
    const preset = AI_PRESETS.find((p) => p.baseUrl === cfg.baseUrl && p.model === cfg.model);
    bar.appendChild(
      el("span", "text-[12px] text-ink-2 min-w-0 truncate", `${preset ? preset.label + " · " : ""}${cfg.model} · ${maskKey(cfg.key)}`)
    );
    bar.appendChild(el("span", "flex-1"));
    const edit = el("button", BTN_MINI, "更换");
    edit.dataset.ai = "edit";
    edit.dataset.tip = "改 Base URL / 模型 / Key";
    edit.addEventListener("click", () => {
      editing = true;
      paint();
    });
    const clr = el("button", BTN_MINI, "清除 Key");
    clr.dataset.ai = "clear";
    clr.dataset.tip = "删掉本机保存的 API Key(其它设置不受影响)";
    clr.addEventListener("click", () => {
      if (!window.confirm("清除本机保存的 API Key?(只删 Key;偏好文字与本次 AI 结果保留,仍可采纳)")) return;
      clearAiCfg();
      cfg = { ...defaultAiCfg(), userPrompt: cfg.userPrompt };
      // 结果与错误**不清**:那是已经花掉的额度换来的会话状态,与凭据无关 ——
      // 清 Key 之后照样可以「并入 A/B 方案」。
      editing = false;
      paint();
    });
    bar.append(edit, clr);
    return bar;
  };

  /* ---- ② 日期范围(记住上次选择;首次全不选)----
   * 只把选中日期的场次送给模型(收窄日期 = 直接减少上下文与费用)→ 配合「并入」可逐天排片、
   * 累积到同一方案。选择落 `biff.ai.dates.v1`,下次开弹层自动带回(见 PLAN-20260910162000)。 */
  const dateBar = (): HTMLElement => {
    const box = el("div", "grid gap-[6px]");
    const head = el("div", "flex items-baseline gap-[8px] flex-wrap");
    head.append(
      el("span", "text-[13px] font-bold text-ink", "② 排哪几天(记住上次选择)"),
      el("span", "text-[11.5px] text-muted", "只送选中日期的场次 —— 配合「并入」可一天天排,累积进同一方案")
    );
    box.appendChild(head);

    const row = el("div", "flex flex-wrap gap-[6px]");
    for (const d of ctx.cat.dates) {
      const { label, weekday } = dateInfo(d);
      const on = selDates.has(d);
      const b = el("button", on ? CHIP_DATE_ON : CHIP_DATE_IDLE, `${label} ${weekday}`);
      b.dataset.ai = `date-${d}`;
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.dataset.tip = on ? "点击取消这一天" : "点击加入这一天";
      b.addEventListener("click", () => {
        if (selDates.has(d)) selDates.delete(d);
        else selDates.add(d);
        commitDates();
      });
      row.appendChild(b);
    }
    box.appendChild(row);

    const foot = el("div", "flex items-center gap-[8px] flex-wrap");
    const all = el("button", BTN_MINI, "全选");
    all.dataset.ai = "date-all";
    all.addEventListener("click", () => {
      for (const d of ctx.cat.dates) selDates.add(d);
      commitDates();
    });
    const none = el("button", BTN_MINI, "全不选");
    none.dataset.ai = "date-none";
    none.addEventListener("click", () => {
      selDates.clear();
      commitDates();
    });
    // 状态靠左、操作靠右(与同面板 readyBar / resultCard 同一语言);操作组整体 ml-auto,
    // 窄屏 flex-wrap 折行后仍贴右缘。
    foot.appendChild(
      el(
        "span",
        selDates.size === 0 ? "text-[11.5px] font-semibold text-conf" : "text-[11.5px] text-muted",
        selDates.size === 0 ? "至少要选一天才能排片" : `已选 ${selDates.size} / ${ctx.cat.dates.length} 天`
      )
    );
    const btns = el("div", "flex items-center gap-[8px] ml-auto");
    btns.append(all, none);
    foot.appendChild(btns);
    box.appendChild(foot);
    return box;
  };

  const promptArea = (): HTMLElement => {
    const box = el("div", "grid gap-[6px]");
    const head = el("div", "flex items-baseline gap-[8px] flex-wrap");
    head.append(
      el("span", "text-[13px] font-bold text-ink", "③ 你的排片偏好(可选)"),
      el("span", "text-[11.5px] text-muted", "不重叠 / 跨馆转场 / 每片一场 / 你写明的时间限定 均不可违背")
    );
    box.appendChild(head);
    const ta = el(
      "textarea",
      "border border-line rounded-[8px] px-2 py-[7px] text-[12.5px] leading-[1.6] w-full min-h-[76px] resize-y bg-card focus:border-biff"
    ) as HTMLTextAreaElement;
    ta.value = cfg.userPrompt;
    ta.maxLength = 500;
    ta.dataset.ai = "prompt";
    ta.placeholder =
      "例:21 号 17:00 开始看、看到最晚那场(含跨午夜);上午不看;只看 BCC;每部片优先选带 GV 的场";
    promptTa = ta;
    const count = el("span", "text-[11px] text-meta tabular-nums");
    const upd = (): void => {
      count.textContent = `${ta.value.length}/500 字`;
    };
    ta.addEventListener("input", upd);
    upd();
    // 口语化时间会被模型归一到 24h 数字(下午五点 = 17:00)。为避免误读,推荐写「17:00 开始看」这种结构化形式 —— 见 PLAN-20260910145749
    const tip = el(
      "div",
      "text-[11.5px] text-meta leading-[1.55]",
      "口语化时间(如「下午五点」)会被自动归一到 24h;为避免误读,推荐写「17:00 开始看」这种结构化形式。"
    );
    tip.dataset.ai = "prompt-tip";
    // 字数计数靠左、操作靠右 —— 与日期条底部同一语言(状态左 / 操作右)
    const foot = el("div", "flex items-center gap-[8px]");
    foot.appendChild(count);
    foot.appendChild(el("span", "flex-1"));
    const reset = el("button", BTN_MINI, "清空");
    reset.dataset.ai = "prompt-reset";
    reset.addEventListener("click", () => {
      ta.value = "";
      upd();
    });
    foot.appendChild(reset);
    box.append(ta, tip, foot);
    return box;
  };

  const runBar = (): HTMLElement => {
    const bar = el("div", "flex items-center gap-[10px] flex-wrap");
    const p = buildNow();
    const noDate = selDates.size === 0;
    const btn = el(
      "button",
      running ? BTN_ABORT : noDate ? BTN_DISABLED : BTN_PRIMARY,
      running ? "生成中… 点击中断" : "④ 开始 AI 排片"
    );
    btn.dataset.ai = "run";
    btn.disabled = noDate && !running;
    if (running) btn.addEventListener("click", () => ctl?.abort());
    else if (!noDate) btn.addEventListener("click", () => void run());
    bar.appendChild(btn);
    const info = el("span", "text-[11.5px] text-muted min-w-0");
    const scope = selDates.size === ctx.cat.dates.length ? "" : `(仅所选 ${selDates.size} 天)`;
    // 所选日期内无场次的影片不送 → 必须说出来,不能静默(与 truncated 分开计)
    const excluded = wantedNow().wanted.length - p.films.length - p.truncated;
    info.textContent = noDate
      ? "请至少选择一天"
      : p.truncated > 0
        ? `本次仅送 ${p.films.length} 部 / ${p.screenings.length} 场${scope}(超出长度上限,已按 随缘→备选 截断 ${p.truncated} 部,必看未丢)`
        : `本次送 ${p.films.length} 部 / ${p.screenings.length} 场${scope}${
            excluded > 0 ? ` · 另有 ${excluded} 部在所选日期无场次` : ""
          } · 最多等 ${Math.round(AI_TIMEOUT_MS / 1000)} 秒`;
    bar.appendChild(info);
    return bar;
  };

  const errBox = (): HTMLElement => {
    const box = el("div", "rounded-[8px] border border-biff-line bg-biff-soft px-3 py-[10px] grid gap-[5px]");
    box.appendChild(el("div", "text-[12px] font-bold text-biff", "AI 排片失败"));
    box.appendChild(el("div", "text-[12px] text-ink-2 leading-[1.6]", errText));
    return box;
  };

  /** 采纳按钮:把某个候选方案里不冲突的场次**追加**进 A / B(现有场次一律保留,不会覆盖)。 */
  const mkAdopt = (g: Group, idx: number, picks: AiPlanPick[]): HTMLElement => {
    const done = adopted.get(idx) === g;
    const b = el(
      "button",
      "border-0 rounded-[7px] px-[12px] py-[5px] text-[12px] font-bold whitespace-nowrap " +
        (done
          ? "text-muted bg-raised cursor-default"
          : "text-on-brand bg-[linear-gradient(135deg,var(--biff-red)_0%,var(--biff-red-2)_100%)] hover:brightness-[1.05]"),
      done ? `✓ 已并入 ${g} 方案` : `并入 ${g} 方案`
    );
    b.dataset.ai = `adopt-${g}`;
    b.dataset.aiAdopt = "1"; // 让方案头知道这一下是「采纳」而不是「折叠」
    b.dataset.tip = `把「方案 ${idx + 1}」里不冲突的场次追加到 ${g} 方案 —— 现有场次一律保留,不会覆盖`;
    if (done) b.disabled = true;
    else
      b.addEventListener("click", () => {
        // 用**实时**数据(codesOfGroup),不用 ctx.slots —— 后者是开弹层那一刻的快照。
        // 追加而非替换:planMerge 按网格同口径(effEndMin + 转场)剔掉重复/冲突的,其余才落库。
        const { add, skipped } = planMerge(ctx.cat, codesOfGroup(g), picks, store.settings.transitMin);
        if (add.length === 0) {
          adoptNotes.set(
            idx,
            skipped > 0
              ? `${g} 方案没有可加入的场次:${skipped} 场与现有行程重复或时段冲突`
              : `${g} 方案没有可加入的场次`
          );
          paint();
          return;
        }
        // 无片单模式(含「强制无片单」):用户从没给这些片打标 → 落库写「未设」,不替他编一个「随缘」
        const { noFilmList: isNF } = wantedNow();
        addGroupPicks(
          g,
          add.map((x) => ({ key: x.filmKey, code: x.code, priority: isNF ? null : x.priority }))
        );
        if (store.group !== g) setCurrentGroup(g);
        adopted.set(idx, g);
        adoptNotes.set(
          idx,
          `已并入 ${g} 方案 ${add.length} 场${skipped > 0 ? ` · 跳过 ${skipped} 场(与现有行程重复或冲突)` : ""}(原有场次未动)${
            isNF ? " · 档位记为「未设」" : ""
          }`
        );
        paint();
      });
    return b;
  };

  /** 一个候选方案:可折叠头(方案 N + 标题 + 计数 + 并入 A/B)+ 场次清单 + 剔除 / 未纳入明细。
   *  多方案时各自独立 —— 采纳其中一个不影响其它,用户自己挑(见 PLAN-20260910162000)。 */
  const optionCard = (opt: AiPlanOption, idx: number): HTMLElement => {
    const card = el("div", idx > 0 ? "border-t border-line-faint" : "");
    const open = openOpts.has(idx);
    const head = el(
      "div",
      "flex items-center gap-[8px] flex-wrap px-3 py-[10px] cursor-pointer select-none hover:bg-hover"
    );
    head.dataset.ai = `opt-${idx}`;
    head.dataset.tip = open ? "收起该方案的场次清单" : "展开该方案的场次清单";
    head.appendChild(el("span", "text-[10px] text-muted shrink-0", open ? "▼" : "▶"));
    head.appendChild(
      el("span", "text-[11px] font-extrabold text-on-brand bg-ink rounded px-[7px] py-px whitespace-nowrap", `方案 ${idx + 1}`)
    );
    head.appendChild(el("div", "text-[12.5px] font-bold text-ink min-w-0 truncate", opt.title || `候选 ${idx + 1}`));
    head.appendChild(
      el(
        "div",
        "text-[11.5px] text-muted whitespace-nowrap tabular-nums",
        `${opt.picks.length} 场${opt.drops.length ? ` · 未纳入 ${opt.drops.length} 部` : ""}${
          opt.rejected.length ? ` · 剔除 ${opt.rejected.length} 场` : ""
        }`
      )
    );
    const acts = el("div", "flex items-center gap-[8px] ml-auto");
    acts.append(mkAdopt("A", idx, opt.picks), mkAdopt("B", idx, opt.picks));
    head.appendChild(acts);
    head.addEventListener("click", (ev) => {
      // 「并入 A/B」自带点击语义 —— 别让点采纳顺手把方案折起来
      if ((ev.target as HTMLElement).closest("[data-ai-adopt]")) return;
      if (openOpts.has(idx)) openOpts.delete(idx);
      else openOpts.add(idx);
      paint();
    });
    card.appendChild(head);

    const note = adoptNotes.get(idx);
    if (note) card.appendChild(el("div", "px-3 pb-[8px] text-[12px] font-semibold text-ok leading-[1.6]", note));
    if (opt.note) card.appendChild(el("div", "px-3 pb-[8px] text-[12px] text-ink-2 leading-[1.6]", `模型说明:${opt.note}`));

    if (open) {
      const list = el("div", "px-2 pb-1 max-h-[320px] overflow-y-auto");
      if (opt.picks.length === 0) {
        list.appendChild(el("div", "text-[12.5px] text-muted py-[10px] px-2", "该方案没有可用场次(见下方原因)"));
      }
      for (const [date, picks] of groupByDate(opt.picks)) {
        const { label, weekday } = dateInfo(date);
        list.appendChild(el("div", "text-[11px] font-bold text-meta pt-[9px] pb-[2px] px-2", `${label} ${weekday}`));
        for (const pk of picks) list.appendChild(aiPickRow(pk, ctx));
      }
      card.appendChild(list);
      const rej = aiRejectSection(opt.rejected);
      if (rej) card.appendChild(rej);
      const dr = aiDropSection(opt.drops);
      if (dr) card.appendChild(dr);
    }
    return card;
  };

  const resultCard = (): HTMLElement => {
    const p = plan!;
    const box = el("div", "border border-line-faint rounded-[12px] bg-card overflow-hidden");
    const head = el("div", "flex items-center gap-[10px] flex-wrap px-3 py-[10px] bg-hover");
    head.appendChild(
      el(
        "div",
        "text-[12px] text-ink-2 flex-1 min-w-0",
        p.options.length > 1
          ? `AI 给出 ${p.options.length} 个候选方案(按你的优先级排序)· 挑一个点「并入 A/B」`
          : "AI 给出 1 个建议方案 · 点「并入 A/B」采用"
      )
    );
    box.appendChild(head);
    if (p.note) box.appendChild(el("div", "px-3 pt-[9px] text-[12px] text-ink-2 leading-[1.6]", `模型说明:${p.note}`));
    p.options.forEach((opt, idx) => box.appendChild(optionCard(opt, idx)));

    const rawWrap = el("div", "border-t border-line-faint px-3 py-[8px]");
    const rawBtn = el("button", BTN_MINI, showRaw ? "收起原始返回" : "查看原始返回");
    rawBtn.dataset.ai = "raw";
    rawBtn.dataset.tip = "模型返回的原文(排查解析失败 / 换模型时用)";
    rawBtn.addEventListener("click", () => {
      showRaw = !showRaw;
      paint();
    });
    rawWrap.appendChild(rawBtn);
    if (showRaw) {
      const pre = el("pre", "mt-[8px] max-h-[200px] overflow-auto rounded-[8px] bg-hover p-[10px] text-[11px] leading-[1.5] whitespace-pre-wrap break-all text-ink-2 m-0");
      pre.textContent = p.raw;
      rawWrap.appendChild(pre);
    }
    box.appendChild(rawWrap);
    return box;
  };

  const paint = (): void => {
    const { noFilmList: isNF } = wantedNow();
    const parts: HTMLElement[] = isNF ? [privacyBar(), modeBar()] : [privacyBar()];
    if (!aiReady(cfg) || editing) {
      parts.push(cfgForm());
    } else {
      // 「强制无片单」开关:仅当 tagged 非空时显示(已是「真·无片单」时不显示)
      const ft = forceToggleRow();
      if (ft) parts.push(ft);
      parts.push(readyBar(), dateBar(), promptArea(), runBar());
    }
    if (errText) parts.push(errBox());
    if (plan) parts.push(resultCard());
    wrap.replaceChildren(...parts);
  };

  const run = async (): Promise<void> => {
    if (running || selDates.size === 0) return; // 一天都没选 → 不送空清单给模型
    if (promptTa) {
      cfg = { ...cfg, userPrompt: promptTa.value }; // 以输入框现值落盘,不依赖 blur 时序
      saveAiCfg(cfg);
    }
    const { noFilmList: isNF } = wantedNow();
    const payload = buildNow(); // 每次按当前日期选择重算
    running = true;
    errText = "";
    plan = null;
    adopted.clear();
    adoptNotes.clear();
    openOpts.clear();
    openOpts.add(0);
    showRaw = false;
    ctl = new AbortController();
    paint();
    try {
      const raw = await callLLM(cfg, payload, ctl.signal, { noFilmList: isNF });
      plan = parseAiResult(raw, ctx.cat, sentFilmsOf(payload), transitMin);
    } catch (e) {
      if (!(e instanceof AiError && e.kind === "aborted")) errText = aiErrorText(e);
    } finally {
      running = false;
      ctl = null;
      paint();
    }
  };

  paint();
  return wrap;
}

/** AI 结果的「本地复检剔除」区 —— 模型给的场次里无效/重复/冲突的部分,必须明示(不静默吞) */
function aiRejectSection(rej: AiPlanReject[]): HTMLElement | null {
  if (!rej.length) return null;
  const wrap = el("div", "border-t border-line-faint px-3 py-[10px] grid gap-[6px]");
  wrap.appendChild(el("div", "text-[11px] font-bold text-conf", `本地复检剔除 ${rej.length} 场(模型建议不可用)`));
  const chips = el("div", "flex flex-wrap gap-[6px]");
  for (const r of rej) {
    const c = el("span", "inline-flex items-center gap-[5px] min-w-0 rounded-[6px] bg-card border border-line-faint px-[7px] py-[3px]");
    c.append(
      el("span", "text-[10.5px] font-bold text-faint tabular-nums shrink-0", r.code),
      el("span", "text-[11.5px] text-ink-2 truncate", r.why)
    );
    c.dataset.tip = `${r.code} — ${r.why}`;
    chips.appendChild(c);
  }
  wrap.appendChild(chips);
  return wrap;
}

/** AI 结果的「未纳入」区 —— 原因来自模型自述 + 本地补齐(「AI 未排入」),故不用 DROP_LABEL 的三分类 */
function aiDropSection(drops: AiPlanDrop[]): HTMLElement | null {
  if (!drops.length) return null;
  const wrap = el("div", "border-t border-line-faint px-3 py-[10px] grid gap-[7px]");
  wrap.appendChild(el("div", "text-[11px] font-bold text-meta", `未纳入 ${drops.length} 部`));
  const chips = el("div", "flex flex-wrap gap-[6px]");
  for (const d of drops) {
    const c = el("span", "inline-flex items-center gap-[5px] min-w-0 max-w-full rounded-[6px] bg-card border border-line-faint px-[7px] py-[3px]");
    c.appendChild(el("span", "text-[12px] text-ink shrink-0", d.zh));
    if (d.why) c.appendChild(el("span", "text-[11px] text-meta truncate", `· ${d.why}`));
    c.dataset.tip = d.why ? `${d.zh} — ${d.why}` : d.zh;
    chips.appendChild(c);
  }
  wrap.appendChild(chips);
  return wrap;
}

/** 按日期切段(picks 已按 日期 → 开始时间 排序,相邻归并即可)—— AI 结果卡用 */
function groupByDate(picks: AiPlanPick[]): [string, AiPlanPick[]][] {
  const out: [string, AiPlanPick[]][] = [];
  for (const p of picks) {
    const last = out[out.length - 1];
    if (last && last[0] === p.show.date) last[1].push(p);
    else out.push([p.show.date, [p]]);
  }
  return out;
}

/** 紧凑行里的影院名 —— 走 `venues.json` 的短名(`legend.ts::venueShort`)。
 *  这些行都带 `truncate` 且列窄,全名会被裁成「Busan Cinema …」,同一影院各厅糊成一串。
 *  查不到场馆(未登记厅 / 旧 JSON)时回退 `venue_display` 全名。 */
function venueLabelOf(ctx: LibraryCtx, s: Screening): string {
  const v = ctx.cat.venueById.get(s.venue_id);
  return v ? venueShort(v) : s.venue_display;
}

/** 一场 AI 建议:左列「时间」深色半加粗(扫日程用),右列片名 + 档位 Tag + code / 影院(次级灰,第二行)。
 *  整行可点 → 跳到该场在时间轴上的位置(与影片库场次行同一个出口)。 */
function aiPickRow(p: AiPlanPick, ctx: LibraryCtx): HTMLElement {
  const row = el(
    "div",
    "grid grid-cols-[84px_minmax(0,1fr)] gap-[10px] items-start px-2 py-[7px] rounded-[7px] cursor-pointer hover:bg-hover"
  );
  row.dataset.tip = "跳到该场在时间轴上的位置";
  row.appendChild(
    el(
      "div",
      "tabular-nums whitespace-nowrap text-[12.5px] font-semibold text-ink pt-px",
      `${fmtMinRange(p.show.start_time, p.show.end_time)}`
    )
  );
  const main = el("div", "min-w-0 grid gap-[2px]");
  const top = el("div", "flex items-center gap-[6px] min-w-0");
  top.append(
    el("span", "text-[13px] font-semibold text-ink truncate", p.zh),
    priTag(p.priority, "shrink-0"),
    el("span", "ml-auto shrink-0 tabular-nums text-[10.5px] font-bold text-faint", p.show.code)
  );
  main.append(top, el("div", "text-[11.5px] text-meta truncate", venueLabelOf(ctx, p.show)));
  row.appendChild(main);
  row.addEventListener("click", () => ctx.onLocate(p.code));
  return row;
}

