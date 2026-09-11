// 影片库 — 全部影片浏览 + 单元筛选 chips + 搜索 → 反向定位 / 详情豆瓣。
// 全量化:列表 / 行 / 头部 / chip / pill / 场次行 / 智能排片弹层 全部 Tailwind utility。
// 16-B 单元 chip / 评分章 / 选片三选 / 智能排片结果 同源 —— 都读写 store.picks(唯一数据源)。

import type { Catalog, FilmItem, Group, Mapping, PickEntry, Priority, Screening } from "./types";
import { catMetaLine, dateInfo, el, filmInfoOf, filmNodeKey, groupByDate, normText } from "./util";
import { doubanChip } from "./legend";
import { cardHead, SHOW_ROW_CLS, screeningRow } from "./row";
import { actState } from "./modal";
import { PILL_IDLE, PILL_ON } from "./chips";
import { BTN_GO_SM, ICON_BTN, NAV_BTN, TAB_OFF, TAB_ON } from "./ui";
import { WISH_ORDER, wishIcon } from "./pick";
import { codesOfGroup, removePick, setWish, subscribe } from "./state";
// 智能排片 = **AI 单通道**;UI 全部在 `ai-panel.ts`(本文件只负责挂入口)。
import { openEngineDialog } from "./ai-panel";

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

/** 目录片 ↔ 排期片合并后的一个影片节点。
 *  **导出**给 `ai-panel.ts`(只作 `import type`,不构成运行时依赖)。 */
export interface FilmNode {
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

/** 节点命中搜索:code / 中文名 / 其余片名 / 单元·国家·导演 */
function matchNode(n: FilmNode, kw: string): boolean {
  if (!kw) return true;
  if (normText(n.zh).includes(kw)) return true;
  if (n.names.some((x) => normText(x).includes(kw))) return true;
  if (normText(n.meta).includes(kw)) return true;
  return n.shows.some((s) => s.code.toLowerCase().includes(kw));
}

/** 节点是否属于某归并单元(纯排期片无目录,只在「全部」下出现) */
function inUnit(n: FilmNode, unit: string): boolean {
  return n.cats.some((c) => unitKey(c.unit) === unit);
}

/** 带行标的 chip 行(「日期」/「档位」)—— 两排 chips 外观相同,靠这枚极小行标区分,
 *  否则两排各有一个「全部」,用户分不清哪个在筛什么。 */
function chipRow(label: string, chips: HTMLElement): HTMLElement {
  const row = el("div", "flex items-start gap-[6px]");
  row.appendChild(el("span", "text-11 text-faint font-semibold shrink-0 pt-[4px]", label));
  row.appendChild(chips);
  return row;
}

/* 日期导航钮 / 卡片图标钮 / 「定位 ▸」的字面量已收敛到 `ui.ts`
   (NAV_BTN / ICON_BTN / BTN_GO_SM;ICON_BTN 带 `ui-icon-btn` 触屏钩子,见 style.css 的 @media (hover:none))。 */

/** 日期小标题(「10/21 周三 · 2 场」)—— 「我的选片」tab 按日期分节时的节头 */
function dateHead(date: string, count: number): HTMLElement {
  const { label, weekday } = dateInfo(date);
  return el(
    "div",
    "px-3 py-[5px] text-11 font-bold text-meta bg-[var(--bg-hover-soft)] border-t border-line-faint",
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
  // ---- 1) 排期场次挂到目录节点(命中),未命中者生成"仅排期"节点 ----
  // 目录命中 + 片名 / 其余片名 / 元信息的拼装全部收口在 `util.ts::filmInfoOf`
  // (与「我的行程」卡片同一口径,见该处注释;原先这段只活在这里,行程卡无从取用)。
  const nodes = new Map<string, FilmNode>();
  const screenings = [...ctx.cat.schedule.screenings].sort(
    (a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time)
  );

  for (const s of screenings) {
    const key = filmNodeKey(ctx.cat, s); // 全站单一 key 口径(甘特打标 / 详情弹层 / 选片总览同源)
    let n = nodes.get(key);
    if (!n) {
      const map = ctx.mappings.get(s.code);
      const info = filmInfoOf(ctx.cat, s, map);
      n = { key, zh: info.zh, names: info.names, meta: info.meta, cats: info.cats, shows: [], map };
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
    if (f.title_orig && normText(f.title_orig) !== normText(zh)) names.add(f.title_orig);
    nodes.set(key, {
      key,
      zh,
      names: [...names],
      meta: catMetaLine(f),
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
 * ⚠ 窄屏(≤1099px)放不下并排:`#main-col` 由 style.css 的媒体查询暂时隐藏,抽屉退化为全宽面板。
 *
 * ---- 2026-09-11 增补(PLAN-20260911140342):滑出动画 / 可拖拽调宽 / 行程非空自动常驻 ----
 * ① **滑出**:折叠类由 `is-hidden`(display:none)换成 `is-collapsed`(width:0)—— 宽度可过渡,
 *    抽屉从**左缘向右**长出来,收起时缩回;挤压式布局下网格同步变窄(见 style.css 的 `#picker-drawer` 块)。
 * ② **调宽**:抓手 `#picker-resizer` 挂在 **`#main-col` 左缘** —— 骑在抽屉与网格之间那条 16px 缝的中央,
 *    也就是两块卡片的**分割线**上(抽屉带 `overflow-hidden`,挂在抽屉里会被裁到缝外,画不到线上)。
 *    拖拽写 `--picker-w`,宽度落 `biff.pickerw.v1`(独立键,与 `biff.ai.v1` / `biff.gvtalk.v1` 同口径)。
 *    范围 **520(硬下限,到即卡住)~ 800**,默认 520 —— 见 `PICKER_W_MIN` 注释。
 * ③ **自动常驻**:`ensurePickerOpen()` —— 进界面行程非空 / 甘特图点选场次后由 `main.ts` 调用;
 *    已开则原样返回(**不切 tab、不重建**,用户可能正在「影片库」打标),关着才打开并切到 agenda。 */

/** 抽屉打开期间的 `render()`(由 openFilmPicker 每次打开时刷新 —— ctx 不缓存:
 *  每次打开重建内容,持有旧引用的闭包不会读到过期的 `store.picks`) */
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

/* ---------- 抽屉宽度:可拖拽调宽 + 持久化(2026-09-11,PLAN-20260911140342) ---------- */

/** 宽度持久化键 —— **独立于** `biff.settings.v1`(与 `biff.ai.v1` / `biff.gvtalk.v1` 同口径:
 *  视图偏好不混进设置序列化,清 Key / 重置设置不会顺手把宽度带走)。 */
const PICKER_W_KEY = "biff.pickerw.v1";
/** 最小宽度 **= 默认宽度 = 520**(2026-09-11 四改:400 → 520)。
 *  520 是「卡片排版仍然成立」的档位:`row.ts::SHOW_ROW_CLS` 第 1 行要放下
 *  「身份 ≈226 + 章组 ≈163 + 操作组 ≈127 + 间距」≈ 530,加行内距 24 + 抽屉内距 24 ≈ 578 ——
 *  520 已是最低可用档(再窄章组会明显折行),也是用户认可的开箱宽度。
 *  ⚠ 它是**硬下限**:拖到 520 就**卡住**,不再有「继续往左拖 = 收起抽屉」——
 *    那条交互用户明确否掉(「小于 520 就不应该往左再能缩小了 应该卡住」)。
 *    收起抽屉的出口 = 面板内「收起 ✕」/ `Esc` / 顶栏「选片 · 行程」按钮。 */
const PICKER_W_MIN = 520;
/** 上限 800:再宽就比网格还宽,挤压式布局失去意义 */
const PICKER_W_MAX = 800;
const PICKER_W_DEFAULT = 520;

function clampPickerW(w: number): number {
  return Math.min(PICKER_W_MAX, Math.max(PICKER_W_MIN, Math.round(w)));
}

function loadPickerW(): number {
  try {
    const n = Number(localStorage.getItem(PICKER_W_KEY));
    return Number.isFinite(n) && n > 0 ? clampPickerW(n) : PICKER_W_DEFAULT;
  } catch {
    return PICKER_W_DEFAULT; // 隐私模式 / 禁用存储 → 回默认宽度
  }
}

function savePickerW(w: number): void {
  try {
    localStorage.setItem(PICKER_W_KEY, String(w));
  } catch {
    // 隐私模式 / 禁用存储:仅本次生效,不落盘
  }
}

/** 把宽度**原样**写到抽屉元素上(仅取整,**不钳制**)—— `--picker-w` 的**唯一写入点**
 *  (style.css 的 `#picker-drawer` 消费它)。
 *  ⚠ 钳制**不能**放这里:拖拽时要能写到 `PICKER_W_MIN` 以下(那段是「松手即收起」的意图区),
 *    钳制只发生在「落盘」与「拖拽硬地板」两处(见 clampPickerW / pickerResizer)。 */
function setPickerW(w: number): void {
  document.getElementById("picker-drawer")?.style.setProperty("--picker-w", `${Math.round(w)}px`);
}

// 模块加载即恢复上次宽度:index.html 在 <body> 末尾引入本模块,#picker-drawer 此时已就位。
setPickerW(loadPickerW());

/** 选片抽屉当前是否打开 —— 折叠类 `is-collapsed` 的反面(见 style.css 的 `#picker-drawer` 块) */
export function isPickerDrawerOpen(): boolean {
  return document.getElementById("picker-drawer")?.classList.contains("is-collapsed") === false;
}

/** 自动滑出(2026-09-11):进界面行程非空 / 甘特图点选场次后由 `main.ts` 调用。
 *  **已开 → 原样返回**:既不切 tab 也不重建 —— 用户可能正在「影片库」打标,
 *  每次点选都把他弹到「我的行程」会很烦;只有「关着 → 打开」这一次才切到 `tab`(默认行程)。
 *  ⚠ 与顶栏「选片 · 行程」按钮的区别:那是**开关**(开着再点 = 收起),本函数**只开不收**。 */
export function ensurePickerOpen(ctx: LibraryCtx, tab: "lib" | "pick" | "agenda" = "agenda"): void {
  if (isPickerDrawerOpen()) return;
  pickerTab = tab;
  openFilmPicker(ctx);
}

/** 窄屏(≤768px)判定 —— 断点必须与 `style.css` 的 `@media (max-width: 768px)` **逐字一致**。
 *  窄屏下走「**列表优先**」(2026-09-10,PLAN-20260910235000):抽屉是主视图、网格降级为次级入口 ——
 *  手机竖屏看二维甘特(29 厅 × 时间轴)在缩放下限下几乎不可用,而排片的核心动作(打标 / 选场次 /
 *  看行程)在抽屉三个 tab 里都能完成。`main.ts::boot()` 据此默认打开抽屉。 */
export function isMobileDrawer(): boolean {
  return window.matchMedia("(max-width: 768px)").matches;
}

/** 直接设置 tab(给 main.ts 在 #conflict-badge 路径里用 —— 先设 tab 再开抽屉,
 *  让 openFilmPicker 的初次 setTab 一步到位,避免一次重渲浪费) */
export function setPickerTab(tab: "lib" | "pick" | "agenda"): void {
  pickerTab = tab;
  if (pickerRender) pickerRender();
}

/** 抽屉宽度过渡结束后的挂起点(见 notifyAfterWidthTransition) */
let toggleEndHandler: ((ev: TransitionEvent) => void) | null = null;
let toggleNotifyTimer: number | undefined;

/** 真正执行「开 / 收之后的重绘」:摘监听 + 清兜底定时器 + 回调 main 侧 */
function fireToggleNotify(): void {
  const drawer = document.getElementById("picker-drawer");
  if (drawer && toggleEndHandler) drawer.removeEventListener("transitionend", toggleEndHandler);
  toggleEndHandler = null;
  if (toggleNotifyTimer !== undefined) {
    window.clearTimeout(toggleNotifyTimer);
    toggleNotifyTimer = undefined;
  }
  pickerToggleHandler?.();
}

/** 等**宽度过渡结束**再通知 main 侧重绘网格(2026-09-11,PLAN-20260911140342)。
 *  旧版在开 / 收的**当帧**就 `pickerToggleHandler()`,而 `renderGrid` 里的横向锚点读的是那一刻的
 *  `clientWidth` —— 动画结束时视口宽度已经变了,「保持视口 / 居中」就会偏一点(拖动调宽尤其明显)。
 *  ⚠ 必须有兜底定时器:`transitionend` 在「宽度恰好没变 / 元素不可见 / 系统开了减少动效」时**不会触发**。
 *  ⚠ 连续开 / 收:每次调用都摘掉上一次的监听与定时器,只认最后一次。 */
function notifyAfterWidthTransition(): void {
  const drawer = document.getElementById("picker-drawer");
  if (!drawer) {
    pickerToggleHandler?.();
    return;
  }
  if (toggleEndHandler) drawer.removeEventListener("transitionend", toggleEndHandler);
  toggleEndHandler = (ev: TransitionEvent): void => {
    // 过渡含 width / margin-right / padding / border-width / opacity —— 只认 width
    if (ev.target === drawer && ev.propertyName === "width") fireToggleNotify();
  };
  drawer.addEventListener("transitionend", toggleEndHandler);
  if (toggleNotifyTimer !== undefined) window.clearTimeout(toggleNotifyTimer);
  toggleNotifyTimer = window.setTimeout(fireToggleNotify, 400); // 过渡 240ms + 余量
}

/** 显示抽屉:给 main 加 `.is-picker-open`(容器上限 1280 → 1680,见 style.css),
 *  再摘掉 `is-collapsed`(宽度 0 → `--picker-w`,即**从左缘向右滑出**);
 *  网格等过渡结束再重绘(见 notifyAfterWidthTransition)。 */
function showPickerDrawer(): void {
  document.querySelector("main")?.classList.add("is-picker-open");
  document.getElementById("picker-drawer")?.classList.remove("is-collapsed");
  notifyAfterWidthTransition();
}

/** 收起抽屉(宽度缩回 0 —— 网格恢复原宽,同样等过渡结束再重绘) */
export function closePickerDrawer(): void {
  if (!isPickerDrawerOpen()) return;
  pickerRender = null;
  document.querySelector("main")?.classList.remove("is-picker-open");
  document.getElementById("picker-drawer")?.classList.add("is-collapsed");
  notifyAfterWidthTransition();
}

/* ---------- 拖拽调宽(抓手样式见 style.css 的 `#picker-resizer`) ---------- */

/** 抓手挂载 —— **挂点 = `#main-col` 的左缘**,骑在抽屉与网格之间那条 16px 缝的中央(即两块卡片的分割线)。
 *  ⚠ 不能挂在抽屉里:抽屉带 `overflow-hidden`,伸到盒外的部分会被裁掉,画不到分割线上。
 *  只建一次(`#main-col` 不随抽屉重建);抽屉收起时由 style.css 的
 *  `main:not(.is-picker-open) #picker-resizer` 隐藏(此时 `#main-col` 顶到最左,抓手会有一半在视口外)。 */
function ensurePickerResizer(): void {
  const mainCol = document.getElementById("main-col");
  if (!mainCol || document.getElementById("picker-resizer")) return;

  const grip = el("div");
  grip.id = "picker-resizer";
  grip.dataset.tip = "拖动调整面板宽度\n· 最小 520px\n· 双击复位为 520px";
  grip.setAttribute("role", "separator");
  grip.setAttribute("aria-label", "拖动调整选片面板宽度");
  grip.setAttribute("aria-orientation", "vertical");
  grip.appendChild(el("span", "picker-knob")); // 视觉抓手(三枚圆点,纯 CSS 画的)

  grip.addEventListener("pointerdown", (ev: PointerEvent) => {
    ev.preventDefault();
    const drawer = document.getElementById("picker-drawer");
    if (!drawer) return;
    // 抽屉左缘在拖拽期间固定(挤压式:main 总宽不变,变的是抽屉 / 网格的宽度分配),量一次即可
    const left = drawer.getBoundingClientRect().left;
    const widthAt = (e: PointerEvent): number => e.clientX - left;
    grip.setPointerCapture(ev.pointerId);
    grip.classList.add("is-dragging");
    drawer.classList.add("is-resizing"); // 关过渡 → 宽度严格跟手

    // 拖拽**逐帧就钳制**:到 `PICKER_W_MIN`(520)立刻卡住 —— 用户明确要求
    // 「小于 520 就不应该往左再能缩小了 应该卡住」,不再有「拖到底 = 收起」那套意图区。
    const onMove = (e: PointerEvent): void => setPickerW(clampPickerW(widthAt(e)));
    const onUp = (e: PointerEvent): void => {
      if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      // ⚠ 先把最终宽度落定(**仍在 is-resizing 里 → 无过渡**),再摘类:否则松手瞬间会补一段
      //   从「拖拽中的值」到「钳制后的值」的动画,手感像被弹一下。
      const w = clampPickerW(widthAt(e));
      setPickerW(w);
      savePickerW(w);
      grip.classList.remove("is-dragging");
      drawer.classList.remove("is-resizing");
      // 宽度定了才通知 main 侧重绘一次网格(拖拽中逐帧重绘代价高;网格内部画布是定宽,
      // 只有外层 `overflow-x-auto` 视口在变,不重排也不会有渲染错误)。此处**不必**等 transitionend
      // —— 上面已在「关过渡」状态下把宽度定死,不会再有过渡发生。
      pickerToggleHandler?.();
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
  });

  // 双击复位默认宽度(拖窄了 / 拖宽了想回到基准)
  grip.addEventListener("dblclick", () => {
    setPickerW(PICKER_W_DEFAULT);
    savePickerW(PICKER_W_DEFAULT);
    pickerToggleHandler?.();
  });

  mainCol.appendChild(grip);
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
  subscribe((domain) => {
    // 外观切换**不重绘抽屉**:抽屉配色全走 CSS token,结构不依赖主题。
    // 这是订阅分域的主要收益 —— 旧版切一次主题会把最多 250 行的影片库整表重建。
    if (domain === "theme") return;
    if (pickerRender && isPickerDrawerOpen()) pickerRender();
  });
}

/* 抽屉 tab 按钮(idle / 选中 —— 选中 = 墨底反白)的字面量已收敛到 `ui.ts`(TAB_ON / TAB_OFF)。 */

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
  // ⚠ `flex-wrap` 不能省:抽屉可拖到 150px(远窄于「三个 tab + 收起 ✕」的 min-content ≈300px),
  //   不换行时这一行会横向溢出、被抽屉的 `overflow-hidden` 裁掉(用户报的「被抽屉截断」)。
  const head = el("div", "flex items-center gap-[6px] mb-[10px] flex-wrap");
  const libTab = el("button", TAB_ON, "影片库");
  const pickTab = el("button", TAB_OFF, "我的选片");
  const agendaTab = el("button", TAB_OFF, "我的行程");
  const closeBtn = el(
    "button",
    "ml-auto shrink-0 border border-line rounded-6 px-[8px] py-[3px] text-12 font-bold bg-card text-ink hover:border-line-strong hover:bg-hover whitespace-nowrap",
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
    "flex-1 min-w-0 border border-line rounded-8 px-3 py-[7px] text-13 focus:[outline:2px_solid_color-mix(in_srgb,var(--color-biff)_25%,var(--color-card))] focus:border-biff"
  ) as HTMLInputElement;
  search.type = "search";
  search.placeholder = ctx.cat.films.length
    ? `搜 中文片名 / 原始片名 / code / 单元·导演(目录 ${ctx.cat.films.length} 部)`
    : "搜 中文片名 / 英文片名 / code";
  search.autocomplete = "off";
  const aiBtn = el(
    "button",
    "border rounded-6 px-[10px] py-[5px] text-12 font-bold bg-card text-ink border-line hover:opacity-90 whitespace-nowrap shrink-0",
    "智能排片 ▸"
  );
  aiBtn.id = "lib-ai";
  aiBtn.dataset.tip = "按影片已标「必看/备选/随缘」生成建议行程:填入你自己的模型 API Key,由浏览器直连服务商(本站不经手 Key)";
  libTool.append(search, aiBtn);
  const libChips = el("div", "flex flex-wrap gap-[6px]");
  const libStat = el("div", "text-12 text-muted");
  // 列表不再自带宽高(`max-h` + `overflow-y-auto`)—— 统一由抽屉内的 panel 滚动,避免双滚动条
  const libList = el("div", "grid gap-2 content-start pt-[2px] px-[2px] pb-1 @container");
  libPane.append(libTool, libChips, libStat, libList);

  // ---- tab 2:我的选片(档位 / 日期筛选;展开只列已排场次) ----
  const pickPane = el("div", "grid gap-[8px] content-start");
  const pickStat = el("div", "text-12 text-muted");
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
    el("span", "text-11 text-faint font-semibold shrink-0 pt-[4px]", "日期"),
    pickDatePrev,
    pickDateChips,
    pickDateNext
  );
  const pickChips = el("div", "flex flex-wrap gap-[6px] min-w-0 flex-1");
  const pickChipsRow = chipRow("档位", pickChips);
  const pickList = el("div", "grid gap-2 content-start pt-[2px] px-[2px] pb-1 @container");
  pickPane.append(pickStat, pickDateRow, pickChipsRow, pickList);

  /** 滚动面板:抽屉高度固定,当前 tab 的内容在面板内滚动(两个 pane 只有一个是 panel 的子节点)。
   *  ⚠ 场次行的「单行优先」排版是**纯栅格**实现的(`row.ts::SHOW_ROW_CLS`,外层不换行 + 内层流式),
   *  **不依赖容器查询** —— 三改曾在这里挂 `@container` 做断点,四改已撤(见 row.ts 头部 ②)。 */
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
  // 故永远读到最新的 `store.picks`。
  // 状态同步走 bindPickerState 的订阅(替代弹层栈的 onReturn)。
  ensurePickerResizer(); // 抓手挂在 `#main-col` 左缘(骑在抽屉与网格的分割线上);已存在则不重复挂
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
      "group border border-line rounded-8 bg-card transition-[border-color,box-shadow] duration-[120ms] " +
      "hover:border-line-strong hover:shadow-[var(--shadow-hover)]";
    const item = el("div", itemCls);
    item.dataset.key = n.key;

    // ---- 卡片头(整块可点 = 展开 / 折叠)----
    // ⚠ 骨架走 `row.ts::cardHead` —— **三处卡片头唯一构造**,与「我的行程」同一套设计语言:
    //   `[箭头列 12px][片名 + 副标题 + 状态行][右缘图标组]`。
    //   原先这里自写一份三列栅格、行程卡另写一份,只靠字号 / 灰阶人工对齐 —— 用户反馈
    //   「电影卡片都是同一个设计语言,不要三套去增加用户的阅读成本」。
    const cat0 = n.cats[0];
    // 副标题:原始片名 + 单元 · 国家 · 年份 · 导演(排版走共享常量 `CARD_SUB_CLS`)
    const subBits = [...n.names, n.meta].filter(Boolean);
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
          "inline-flex items-center rounded-5 px-[7px] py-[2px] text-11 font-bold leading-[1.4] " +
            "whitespace-nowrap bg-biff-soft text-biff-ink",
          txt
        )
      );
    } else {
      status.appendChild(
        el(
          "span",
          "inline-flex items-center rounded-5 px-[7px] py-[2px] text-11 font-semibold leading-[1.4] " +
            "whitespace-nowrap bg-raised text-muted",
          "暂无排期"
        )
      );
    }
    // 无排期目录片:有映射 → 豆瓣条目直链;无映射 → 豆瓣搜索(兜底;2026-09-11 起映射只读、常为空)
    if (!n.shows.length && cat0) {
      const cmap = ctx.mappings.get(cat0.id);
      const q = encodeURIComponent((cat0.title_zh || cat0.title_orig || "").trim());
      const href = cmap?.douban_url || (q ? `https://www.douban.com/search?q=${q}` : "");
      if (href) {
        const a = document.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noreferrer";
        a.className = "text-11 font-bold text-biff-ink whitespace-nowrap hover:underline";
        a.textContent = cmap?.douban_url ? "豆瓣 ↗" : "豆瓣搜索 ↗";
        status.appendChild(a);
      }
    }
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
    // 三处共用的卡片头:箭头 / 片名 + 副标题 + 状态行 / 右缘图标组
    const head = cardHead({
      title: n.zh,
      titleExtra: cat0?.rating != null ? doubanChip(cat0.rating) : undefined,
      sub: subBits.length ? subBits.join(" · ") : undefined,
      status,
      collapse: { open, attr: mode === "picks" ? "pickHead" : "libHead", value: n.key },
      divider: open,
      trailing: icons,
    });
    item.appendChild(head);

    if (!open) return item;

    // ---- 场次行 / 占位 ----
    const shows = el("div");
    const rows = mode === "picks" ? pickedShows(n, rec) : n.shows;
    if (rows.length) {
      if (mode === "picks") {
        // 「我的选片」tab:按日期分节 —— 节头给日期,节内场次行不再重复印日期(见 showRow 的 hideDate)
        for (const [date, list] of groupByDate(rows, (s) => s.date)) {
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
            "px-3 py-[6px] text-12 text-tight border-t border-line-faint",
            `另有 ${rec.picks.length - rows.length} 场已不在当前排期里(数据换版)`
          )
        );
      }
    } else {
      shows.appendChild(
        el(
          "div",
          "px-3 py-[8px] text-12 text-muted border-t border-line-faint",
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

  /** 场次行 —— 三个 tab(影片库 / 我的选片 / 我的行程)**共用同一套排版与顺序**
   *  (2026-09-10 统一,见 PLAN-20260910193000;骨架收口在 `row.ts::screeningRow`)。
   *  `withTopBorder` = 同一节里的第 2 场起画分隔线;
   *  `hideDate` = 「我的选片」tab 按日期分节后日期已由节头给出,行内只留时间。
   *  本 tab 只注入右侧**操作组**(定位 ▸ + 加入三态),其余骨架与「我的行程」完全一致。 */
  function showRow(s: Screening, withTopBorder: boolean, hideDate = false): HTMLElement {
    // ---- 右:操作(层级分明 —— 定位 = 唯一主操作;加入/已加入 = 次要 / 状态) ----
    // ⚠ 2026-09-11 四改:抽屉里的场次行第 1 行要**把宽度留给章组**(用户原话:「图标换行太多了
    //   明明右边有空间也不往右延展」),故这两枚都收窄:定位走 `BTN_GO_SM`(紧凑档),
    //   加入态只渲染**符号**(`actState().short`,文案全走 `data-tip`)—— 两枚合计省 ≈40px。
    // ⚠ 2026-09-11 五改:加入态三态**等宽**(`actState().short` 自带 `min-w` + 内容居中)——
    //   否则「＋ 加入 → ✓ 已加入」按钮变窄,会把这枚「定位 ▸」往右顶,用户刚点完就得重新找。
    const acts = el("div", "flex items-center gap-[6px] shrink-0");
    const go = el("button", BTN_GO_SM, "定位 ▸");
    go.dataset.libGo = s.code;
    go.dataset.tip = "跳到该影厅时间轴位置";
    // 加入/移出方案 —— 唯一场次列表在这里(弹层已不再重复列场次),与「定位 ▸」并排:
    // 想跳到时间轴看就点定位,想直接排进方案就点右侧三态控件,不必再开弹层。
    // 三态文案/配色由 modal.ts::actState 单源给出(已加入 = 与「＋ 加入」等宽的绿描边按钮)。
    const act = el("button", "", "");
    act.dataset.libToggle = s.code;
    act.dataset.film = filmNodeKey(ctx.cat, s);
    const st0 = actState(s.code, ctx.group);
    act.textContent = st0.short; // 紧凑符号(等宽盒子);完整语义在 tip 与卡片底色(已选 = 绿底)上
    act.className = st0.cls;
    act.dataset.tip = st0.tip;
    acts.append(go, act);
    return screeningRow({
      s,
      cat: ctx.cat,
      hideDate,
      rowCls: SHOW_ROW_CLS + (withTopBorder ? " border-t border-line-faint" : ""),
      acts,
    });
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
      const allChip = el("button", unit === null ? PILL_ON : PILL_IDLE, `全部 ${ctx.cat.films.length}`);
      allChip.dataset.unit = "";
      allChip.dataset.tip = "取消单元筛选";
      libChips.appendChild(allChip);
      for (const c of unitChips) {
        const b = el("button", unit === c.key ? PILL_ON : PILL_IDLE, `${c.key} ${c.count}`);
        b.dataset.unit = c.key;
        b.dataset.tip = "再次点击取消筛选";
        libChips.appendChild(b);
      }
    }

    if (matched.length === 0) {
      const what = [kw.trim() && `「${kw.trim()}」`, unit && `单元「${unit}」`].filter(Boolean).join(" + ");
      libList.appendChild(el("div", "text-muted text-center py-[26px] text-13", `没有匹配${what ? ` ${what}` : ""}的影片,试试英文/原始片名或切回「全部」`));
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
      const all = el("button", dateFilter === null ? PILL_ON : PILL_IDLE, `全部 ${dates.length} 天`);
      all.dataset.pdate = "";
      all.dataset.tip = "显示全部日期的选片";
      pickDateChips.appendChild(all);
      for (const d of dates) {
        const { label, weekday } = dateInfo(d);
        const b = el("button", dateFilter === d ? PILL_ON : PILL_IDLE, `${label} ${weekday} ${dateCount.get(d)}`);
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
        const b = el("button", filter === p ? PILL_ON : PILL_IDLE, label);
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
          "text-13 text-muted leading-[1.8] py-[18px] px-[6px] text-center",
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
      pickList.appendChild(el("div", "text-muted text-center py-[26px] text-13", "当前筛选下暂无选片"));
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
        ? "当前:我的行程(按日期分组的已排场次)"
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
   * 入口就在「影片库」tab 上 → `fromLibrary: true`:无片单模式提示里的
   * 「← 返回影片库打标」只需关掉排片弹层(抽屉本来就在后面,不再叠一层)。
   * 面板 UI 全部在 `ai-panel.ts`(本文件只负责挂入口与刷新回执)。 */
  aiBtn.addEventListener("click", () =>
    openEngineDialog(filmList, ctx, {
      onReturn: render,
      fromLibrary: true,
      onGoTag: () => {
        /* 恒从影片库开出 → 只关本层即可(closeModal 已在面板内调用) */
      },
    })
  );

  // 首画:画当前 tab(`pickerTab` 跨开合保持 —— 上次在看「我的选片」,再打开还在那儿)
  setTab(pickerTab);
  if (pickerTab === "lib" && window.matchMedia("(pointer: fine)").matches) search.focus();
}
