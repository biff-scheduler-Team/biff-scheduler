// 影片库 — 全部影片浏览 + 单元筛选 chips + 搜索 → 反向定位 / 详情豆瓣。
// 全量化:列表 / 行 / 头部 / chip / pill / 场次行 全部 Tailwind utility。
// 16-B 单元 chip / 评分章 / 选片三选 同源 —— 都读写 store.picks(唯一数据源)。

import type { Catalog, ExtraProgram, FilmItem, Mapping, PickEntry, Screening, Venue } from "./types";
import { bilingualTitle, catMetaLine, dateInfo, el, filmEnName, filmInfoOf, filmNodeKey, groupByDate, normText, unitLabel } from "./util";
import { doubanChip } from "./legend";
import { cardHead, SHOW_ROW_CLS, screeningRow } from "./row";
import { actState } from "./modal";
import { PILL_IDLE, PILL_ON } from "./chips";
import {
  hasActiveFilter,
  loadFilters,
  LS_FILTERS_LIB,
  makeFilterState,
  matchesFilters,
  renderFilterBar,
  saveFilters,
} from "./filters";
import { extras, KIND_LABEL, programOf } from "./extras";
import { BTN_GO_SM, ICON_BTN, NAV_BTN, TAB_OFF, TAB_ON } from "./ui";
import { addPickFilm, allCodes, removePick, subscribe } from "./state";
import { toast } from "./toast";

export interface LibraryCtx {
  cat: Catalog;
  /** 唯一数据源:影片 key → 选片记录(已选场次 / 备注) */
  picks: Map<string, PickEntry>;
  /** 已选场次投影:code → 影片 key(与「我的行程」同一份数据) */
  slots: Map<string, { key: string }>;
  mappings: Map<string, Mapping>;
  onLocate: (code: string) => void;
  onFilm: (code: string) => void;
  /** 加入/移出当前方案(唯一场次列表在这里 —— 弹层已不再重复列场次)。
   *  与「网格整卡点选」「我的行程」同一份数据(state.toggleScreening)。 */
  onToggle: (key: string, code: string) => void;
}

/** 目录片 ↔ 排期片合并后的一个影片节点。 */
export interface FilmNode {
  key: string;
  /** 卡片头片名 = **英文名 · 中文名**(口径 `util.ts::bilingualTitle`,2026-09-11) */
  title: string;
  /** 中文名(无中文时退化为英文名)—— 排序 / 搜索 / AI 打包用,不直接展示 */
  zh: string;
  /** **官方英文名** —— 豆瓣搜索外链的搜索词(2026-09-11)。
   *  为什么不用中文名:我们的中文名本就是豆瓣回填来的,拿它去搜等于用答案搜问题;
   *  而豆瓣对海外片的**英文条目**收录率最高(`tools/enrich_douban.py` 也是按英文名对齐的)。
   *  取值链与卡片头英文位同源:排期片 = `filmInfoOf().en`;目录片 = `filmEnName()`。 */
  en: string;
  names: string[]; // 与 title 不重复的其余片名(原始片名/韩文),去重保序
  meta: string; // 单元 · 国家 · 年份 · 导演(目录信息,空则隐藏)
  cats: FilmItem[]; // 命中的目录条目(一般 1 条)
  shows: Screening[]; // 已发布排期的场次(可能为空)
  map?: Mapping;
  /** 海报(相对站点根的路径,如 `/posters/36990574-m.jpg`)—— 来自目录片,仅 174/250 有;
   *  缺图是常态,不占位不留白框(见 `filmRow` 的缩略图分支)。 */
  poster?: string;
  /** **仅合集成员**:没有独立场次,只在某个合集块里放映(见 types.ts::FilmItem.block_code)。
   *  有它 → 展开时列出该块场次并标注「收录于合集」,而不是「暂无排期」。 */
  block?: Screening;
}

/** 16-B:脏 unit → 归并键(展示与筛选用同一键)。
 *
 *  2026-09-11 **收窄**:只归并**同义脏写法**,不再跨**真实子单元**归并 ——
 *  旧规则 `startsWith("广角镜")` / `startsWith("Vision")` / `startsWith("Korean Cinema Today")`
 *  会把「广角镜 - 亚洲短片竞赛 / 纪录片放映 / 纪录片竞赛」压成一条、把「Vision–Korea / –Asia」
 *  压成一条。chips 时代为了省横向空间可以接受;但下拉选项与卡片副标题的中英对照一摆出来就露馅:
 *  副标题印「Wide Angle – Asian Short Film Competition · 广角镜 · 亚洲短片竞赛」,
 *  下拉里却只有「Wide Angle · 广角镜」—— 选项与卡片对不上,子单元也无从单独筛。
 *  收窄后选项数 19 → 26,下拉完全放得下,而筛选粒度与卡片文案重新对齐。
 *  ⚠ 与 `tools/build_films_2026.py::unit_key` **必须逐字同口径**(配对在同一归并键内进行)。 */
export function unitKey(raw: string | undefined | null): string {
  const t = (raw ?? "").trim();
  // ① 英文 section 名 + 紧随其后的中文注释(如 `On Screen 单元3部·均为剧集首映`、
  //    `CARTE BLANCHE特别企划 自主选择/嘉宾选片`)→ 只留英文段
  const en = t.match(/^([A-Za-z][A-Za-z'&.\- ]*?)\s*(?=[\u4e00-\u9fa5])/);
  if (en?.[1].trim()) return en[1].trim();
  // ② 年度亚洲电影人奖:数据里按年份分了 4 条(2026–2029,含一条笔误)→ 归并成一条
  if (t.includes("年度亚洲电影人奖")) return "亚洲电影人奖";
  return t || "未标注单元";
}

interface UnitChip {
  key: string;
  count: number; // 目录片计数(静态,不随搜索变化);活动单元 = 该形式的场次数
}

/** 活动形式单元的 key 前缀 —— 与目录单元的 `unitKey()` 值域天然不冲突(目录单元不会以 `act:` 开头),
 *  故两者共用同一条 `unit` 状态与 `inUnit` 判定(见该函数)。 */
const ACT_UNIT_PREFIX = "act:";

/** 活动形式在下拉里的固定先后;`Special Talk` 放最后 —— 它多数是**映后谈**,
 *  挂在普通放映场次上,作为「单元」看更像附属信息(见 `inUnit` 注释)。 */
const ACT_KINDS: ExtraProgram["kind"][] = ["actors_house", "master_class", "cine_class", "special_talk"];

/** chips:全部 + 各归并单元(按片数降序)+ 活动形式单元(固定顺序,追加在末尾)。
 *  ⚠ 活动单元**不参与目录单元的排序** —— 两者的「片数」口径不同(目录片数 vs 活动场次数),
 *    混排会让下拉的「按片数降序」读起来自相矛盾;固定摆在末尾,找活动时一眼可见。 */
function buildUnitChips(films: FilmItem[]): UnitChip[] {
  const m = new Map<string, number>();
  for (const f of films) {
    const k = unitKey(f.unit);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  const dirChips = [...m.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key, "zh"));
  return [...dirChips, ...actUnitChips()];
}

/** 活动形式单元(数据源 = `festival-extras.json` 的 programs)—— 排期页不印活动形式,故不来自目录。
 *  count = 该形式的**场次数**(每个活动场次是独立影片节点,故与节点数相同)。
 *  extras 未加载(缺文件 / 旧部署)→ 返回空数组,下拉里这一组整体消失(静默降级)。 */
function actUnitChips(): UnitChip[] {
  const progs = extras()?.programs ?? [];
  const m = new Map<string, number>();
  for (const p of progs) m.set(p.kind, (m.get(p.kind) ?? 0) + 1);
  return ACT_KINDS.filter((k) => m.has(k)).map((k) => ({ key: `${ACT_UNIT_PREFIX}${k}`, count: m.get(k) ?? 0 }));
}

/** 节点命中搜索:code / 片名(英文名 · 中文名)/ 其余片名 / 单元·国家·导演 /
 *  **活动场的中文检索词**(活动形式名 + 嘉宾中英文名)。
 *  ⚠ 活动形式 / 嘉宾只存在于 `festival-extras.json`(排期页不印,见 `extras.ts`),
 *    故这一段单独走 `matchProgram`;extras 未加载(缺文件 / 旧部署)时静默跳过,
 *    其余字段照常匹配 —— 增强字段不能反过来拖垮基础搜索。 */
function matchNode(n: FilmNode, kw: string): boolean {
  if (!kw) return true;
  if (normText(n.title).includes(kw)) return true; // 含英文名与中文名两侧
  if (n.names.some((x) => normText(x).includes(kw))) return true;
  if (normText(n.meta).includes(kw)) return true;
  if (n.shows.some((s) => s.code.toLowerCase().includes(kw))) return true;
  return n.shows.some((s) => matchProgram(s.code, kw));
}

/** 活动场命中:活动形式名(「演员之家」「大师班」「电影课」「特别对谈」)与嘉宾名(中 / 英)。
 *  数据源 = `extras.ts::programOf`(按 code 取 `festival-extras.json` 的 programs 条目);
 *  非活动场 / extras 未加载 → 恒 false。 */
function matchProgram(code: string, kw: string): boolean {
  const p = programOf(code);
  if (!p) return false;
  if (normText(KIND_LABEL[p.kind]).includes(kw)) return true;
  return normText(p.guest ?? "").includes(kw) || normText(p.guestZh ?? "").includes(kw);
}

/** 节点是否属于某单元。两类:
 *  · **目录单元** = 目录条目的归并单元(`unitKey`);纯排期片无目录,只在「全部」下出现。
 *  · **活动单元**(`act:<kind>`,见 `ACT_UNIT_PREFIX`)= 该片的场次里有对应活动形式的场。
 *    ⚠ 与「纯排期片只在全部下出现」不矛盾:活动场本就是纯排期片(无目录条目),
 *      但 extras 按 code 给了它形式,于是能单独归组 —— 这正是「活动也能筛」的由来。
 *    ⚠ `special_talk` 含**映后谈**:如 021《Mother Mary》的场次本身是普通放映,
 *      只因附带映后谈而被归进本单元(搜索口径同此,见 `matchProgram`)。 */
function inUnit(n: FilmNode, unit: string): boolean {
  if (unit.startsWith(ACT_UNIT_PREFIX)) {
    const kind = unit.slice(ACT_UNIT_PREFIX.length);
    return n.shows.some((s) => programOf(s.code)?.kind === kind);
  }
  return n.cats.some((c) => unitKey(c.unit) === unit);
}

/** 单元名(下拉选项 / 命中统计的**唯一**取用口):目录单元走 `unitLabel`(「英文 · 中文」),
 *  活动单元走 `KIND_LABEL`(「Actors' House · 演员之家」)—— 两者同为「英文 · 中文」排版。
 *  key 不在已知值域时原样返回,绝不产出空串。 */
function unitChipLabel(key: string): string {
  if (key.startsWith(ACT_UNIT_PREFIX)) {
    return KIND_LABEL[key.slice(ACT_UNIT_PREFIX.length) as ExtraProgram["kind"]] ?? key;
  }
  return unitLabel(key);
}

/** 单元下拉的一个 `<option>`(标签 = 「英文 · 中文 · N 部」,见 `util.ts::unitLabel`) */
function unitOption(value: string, label: string): HTMLOptionElement {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

/* 日期导航钮 / 卡片图标钮 / 「定位 ▸」的字面量已收敛到 `ui.ts`
   (NAV_BTN / ICON_BTN / BTN_GO_SM;ICON_BTN 带 `ui-icon-btn` 触屏钩子,见 style.css 的 @media (hover:none))。 */

/** 日期小标题(「OCT 21 周三 · 2 场」)—— 「我的选片」tab 按日期分节时的节头 */
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
      n = {
        key,
        title: info.title,
        zh: info.zh,
        en: info.en,
        names: info.names,
        meta: info.meta,
        cats: info.cats,
        shows: [],
        map,
        poster: info.cats[0]?.poster,
      };
      nodes.set(key, n);
    }
    n.shows.push(s);
  }

  // ---- 3) 目录中尚无任何排期的片(250 部全集) ----
  for (const f of ctx.cat.films) {
    const key = `cat:${f.id}`;
    if (nodes.has(key)) continue;
    // 无排期 → 英文位取目录的官方英文名(`filmEnName`:新 schema 的 title_en / 旧 schema 的 title_orig)
    const en = filmEnName(f);
    const zh = f.title_zh || en;
    // 与 `filmInfoOf` 同口径:原始片名(韩/日文)既不是英文位也不是中文名时,留作副标题的「其余片名」
    const names = new Set<string>();
    if (f.title_orig && normText(f.title_orig) !== normText(en) && normText(f.title_orig) !== normText(zh)) {
      names.add(f.title_orig);
    }
    nodes.set(key, {
      key,
      title: bilingualTitle(en, f.title_zh),
      zh,
      en,
      names: [...names],
      meta: catMetaLine(f),
      cats: [f],
      shows: [],
      poster: f.poster,
      // 合集成员确实有放映,只是不单独售票 → 挂到所属块场次上
      block: f.block_code ? ctx.cat.byCode.get(f.block_code) : undefined,
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
 * 打标 → 卡片色点当场出现;点选 → 卡片当场变绿。
 *
 * ★ 三个 tab 的**分工**(2026-09-11 定稿,用户原话「影片库只选影片和想看类型 → 添加到我的选片 →
 *   选片里再选具体排片;现在排片有两个地方要选,跳来跳去」):
 *   ① **影片库** = 选影片 + 「＋ 加入我的选片」——展开的场次表**只读**(只留「定位 ▸」);
 *   ② **我的选片** = **挑具体场次**(展开列该片全部可选场次,每行「＋ / ✓」);
 *   ③ **我的行程** = 按日期看最终结果(只读 + 行内 ✕ / 改映后谈 / **拖顺位**)。
 *   于是「加场次」只有**一个**入口(我的选片)+ 时间轴整卡点选,不再两处并存。
 * 三个 tab 复用同一套 filmRow / showRow(520px 放不下并排双栏,但信息密度与原来一致)。
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
 *    拖拽写 `--picker-w`,宽度落 `biff.pickerw.v1`(独立键,与 `biff.gvtalk.v1` 同口径)。
 *    范围 **520(硬下限,到即卡住)~ 800**,默认 520 —— 见 `PICKER_W_MIN` 注释。
 * ③ **自动常驻**:`ensurePickerOpen()` —— 进界面行程非空 / 甘特图点选场次后由 `main.ts` 调用;
 *    已开则原样返回(**不切 tab、不重建**,用户可能正在「影片库」打标),关着才打开并切到 agenda。 */

/** 抽屉打开期间的 `render()`(由 openFilmPicker 每次打开时刷新 —— ctx 不缓存:
 *  每次打开重建内容,持有旧引用的闭包不会读到过期的 `store.picks`) */
let pickerRender: (() => void) | null = null;
/** 抽屉开 / 收时通知 main 侧(网格可用宽度变了,必须重绘并保横向锚点) */
let pickerToggleHandler: (() => void) | null = null;
/** 当前 tab。
 *  `"agenda"`(我的行程)于 2026-09-10 加入(`PLAN-20260910190916`):抽屉从"两 tab 选片面板"升为"排片工作台"
 *  —— 影片库(找片 + 定档) / 我的选片(挑场次) / 我的行程(看结果)三步闭环。
 *  跨开合保持(用户在面板里切到哪个 tab,收起再点顶栏按钮还回哪儿);
 *  ⚠ 但**顶栏按钮那条入口显式传 `"pick"`**(见 `openFilmPicker` 的 `tab` 参数),
 *    不读这里的初值 —— 否则首开会落到「影片库」,与按钮文案不符(用户反馈)。 */
let pickerTab: "lib" | "pick" | "agenda" = "lib";

/** 抽屉(影片库)自己的排片筛选 —— **与甘特图那套完全独立**(2026-09-11 用户要求「分开才行」)。
 *
 *  为什么必须是两份:甘特图那份回答的是「时间轴上还剩哪些卡、哪些影厅行」,抽屉这份回答的是
 *  「影片库里还剩哪些片」—— 两个界面在回答不同的问题。原先共用一份时,在时间轴上点掉几家影院,
 *  影片库列表会当场跟着收窄(反之亦然),用户没法「时间轴看全部、影片库只看几家」。
 *  现在两套状态、两个持久化键(`biff.filters.v1` / `biff.libfilters.v1`),各筛各的。
 *
 *  ⚠ 放在**模块级**而不是 `openFilmPicker` 的闭包里:抽屉每次打开都重建内容(见 pickerRender
 *    注释),状态放闭包里会「关一次抽屉筛选就没了」。
 *  ⚠ 载入延后到首次打开抽屉(`ensureLibFilters`):要按当前 `venues.json` 校验影厅 id,
 *    而本模块拿不到 cat —— 由调用方从 ctx 传进来。 */
const libFilters = makeFilterState();
let libFiltersLoaded = false;

/** 首次打开抽屉时载入(幂等)—— 顺带按当前 venues.json 剔掉换版后不存在的厅 */
function ensureLibFilters(venues: Venue[]): void {
  if (libFiltersLoaded) return;
  libFiltersLoaded = true;
  loadFilters(libFilters, new Set(venues.map((v) => v.id)), LS_FILTERS_LIB);
}

/** 抽屉筛选变化的唯一收口:落盘(「记住你的选项」)→ 重绘抽屉。
 *  ⚠ **不碰甘特图**:两处状态已分开,那边有自己的筛选条与重绘时机。 */
function onLibFiltersChanged(): void {
  saveFilters(libFilters, LS_FILTERS_LIB);
  pickerRender?.();
}

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

/** 宽度持久化键 —— **独立于** `biff.settings.v1`(与 `biff.gvtalk.v1` 同口径:
 *  视图偏好不混进设置序列化,清 Key / 重置设置不会顺手把宽度带走)。 */
const PICKER_W_KEY = "biff.pickerw.v1";
/** 拖拽的**硬下限** 520 —— 「卡片排版仍然成立」的档位:`row.ts::SHOW_ROW_CLS` 第 1 行要放下
 *  「身份 ≈226 + 章组 ≈163 + 操作组 ≈127 + 间距」≈ 530,加行内距 24 + 抽屉内距 24 ≈ 578;
 *  520 已是最低可用档(再窄章组会明显折行)。
 *  ⚠ 拖到 520 就**卡住**,不再有「继续往左拖 = 收起抽屉」——那条交互用户明确否掉
 *    (「小于 520 就不应该往左再能缩小了 应该卡住」)。
 *    收起抽屉的出口 = 面板内「收起 ✕」/ `Esc` / 顶栏「选片 · 行程」按钮。 */
const PICKER_W_MIN = 520;
/** 拖拽上限 800:再宽就比网格还宽,挤压式布局失去意义 */
const PICKER_W_MAX = 800;

function clampPickerW(w: number): number {
  return Math.min(PICKER_W_MAX, Math.max(PICKER_W_MIN, Math.round(w)));
}

/** 读上次拖拽落盘的宽度;**没拖过 → `null`**(2026-09-11 改)。
 *  ⚠ 旧版这里返回写死的 520,于是「开箱宽度」永远钉在 520px 这个魔数上。
 *    现在**没拖过就不写 `--picker-w`**,宽度交给 style.css 的 `var(--picker-w, clamp(...))`
 *    随视口自适应 —— 见 `#picker-drawer` 块注释。 */
function loadPickerW(): number | null {
  try {
    const n = Number(localStorage.getItem(PICKER_W_KEY));
    return Number.isFinite(n) && n > 0 ? clampPickerW(n) : null;
  } catch {
    return null; // 隐私模式 / 禁用存储 → 回自适应宽度
  }
}

/** 落盘拖拽宽度;`null` = 清除记忆(回到自适应宽度) */
function savePickerW(w: number | null): void {
  try {
    if (w === null) localStorage.removeItem(PICKER_W_KEY);
    else localStorage.setItem(PICKER_W_KEY, String(w));
  } catch {
    // 隐私模式 / 禁用存储:仅本次生效,不落盘
  }
}

/** 把宽度**原样**写到抽屉元素上(仅取整,**不钳制**)—— `--picker-w` 的**唯一写入点**
 *  (style.css 的 `#picker-drawer` 消费它)。`null` = 移除内联值 → 回到 CSS 的自适应宽度。
 *  ⚠ 钳制**不能**放这里:拖拽时要能写到 `PICKER_W_MIN` 以下? —— 不,四改后已无「意图区」,
 *    钳制只发生在「落盘」与「拖拽硬地板」两处(见 clampPickerW / pickerResizer)。 */
function setPickerW(w: number | null): void {
  const drawer = document.getElementById("picker-drawer");
  if (!drawer) return;
  if (w === null) drawer.style.removeProperty("--picker-w");
  else drawer.style.setProperty("--picker-w", `${Math.round(w)}px`);
}

// 模块加载即恢复上次拖拽的宽度:index.html 在 <body> 末尾引入本模块,#picker-drawer 此时已就位。
// 没拖过(null)→ 什么都不写,走 CSS 的自适应默认宽度。
{
  const saved = loadPickerW();
  if (saved !== null) setPickerW(saved);
}

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
  grip.dataset.tip = "拖动调整面板宽度(最小 520px)\n双击 = 复位为自适应宽度(清除记忆)";
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

  // 双击复位:**清掉拖拽记忆**,回到 CSS 的自适应宽度(随视口走,不再钉在一个魔数上)
  grip.addEventListener("dblclick", () => {
    setPickerW(null);
    savePickerW(null);
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
 *  而弹层那套 `onReturn` 对常驻面板不适用 —— 网格点选 / 拖动顺位都要让计数当场跟上。 */
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

/** 打开抽屉(三个 tab 共用一份 `buildFilmList` 节点清单与**同一套行渲染** filmRow / showRow,
 *  所以「展示机制 / 图标化」天然一致 —— 不再各写一份行结构;三个 tab 共享一份 `store.picks`,
 *  任一 tab 加入 / 移出,其余同帧同步)。
 *
 *  `tab` = **落点**。不传 = 沿用 `pickerTab`(「上次停留的 tab」,跨开合保持)。
 *  ⚠ 2026-09-11:顶栏「选片 · 行程」按钮**必须显式传 `"pick"`** —— 它原来走「上次停留的 tab」,
 *    而 `pickerTab` 初值是 `"lib"` → 首开(以及上次停在影片库时)都落到「影片库」,
 *    与按钮文案不符(用户反馈:「行程应该跳我的选片,不要跳到影片库」)。 */
export function openFilmPicker(ctx: LibraryCtx, tab?: "lib" | "pick" | "agenda"): void {
  const host = document.getElementById("picker-drawer");
  if (!host) return;
  if (tab) pickerTab = tab;
  // 首次打开时恢复抽屉自己的筛选(「记住你的选项」);必须在读 libFilters 之前(见 filtersOpen)
  ensureLibFilters(ctx.cat.venues);
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
  // 工具行:搜索框吃满剩余宽度。
  // ⚠ 输入框用 `flex-1 min-w-0` 而不是 `w-full`:`w-full` 在 flex 行里靠 shrink 让位,
  //   窄容器会被按钮压到 min-content(≈20 字符)再溢出;`min-w-0` 才允许它真正缩下去。
  // ⚠ `grid-cols-[minmax(0,1fr)]` **不能省**(2026-09-11,「520px 卡片显示不全」的根因修复):
  //   `grid` 不写列时是一列**隐式 `auto` 轨道**,其最小尺寸 = 子项的最小内容宽度(min-content)。
  //   本行里的 `<select>`(单元下拉)最小内容宽度 = **最长 option 的文本宽**(实测 571px:
  //   「Special Program in Focus – The Good Times: Ahn Sung-ki · 特别企划 · 美好的时代: 安圣基 · 6 部」)
  //   —— 而 `min-w-0` 只解除 flex/grid 子项的「自动最小尺寸」,**不会降低它对父轨道的 min-content 贡献**。
  //   结果:整列被撑到 599px > 抽屉可用 486px,`#picker-drawer` 的 `overflow-hidden` 把卡片右侧裁掉
  //   (用户看到的「卡片显示不全」)。显式 `minmax(0,1fr)` 把轨道最小尺寸钉成 0,
  //   列宽回到容器宽度,下拉自己收缩(原生控件内部裁字,展开列表里仍是全称)。
  const libPane = el("div", "grid gap-[8px] content-start grid-cols-[minmax(0,1fr)]");
  const libTool = el("div", "flex gap-2 items-center");
  const search = el(
    "input",
    "flex-1 min-w-0 border border-line rounded-8 px-3 py-[7px] text-13 focus:[outline:2px_solid_color-mix(in_srgb,var(--color-biff)_25%,var(--color-card))] focus:border-biff"
  ) as HTMLInputElement;
  search.type = "search";
  search.placeholder = ctx.cat.films.length
    ? `搜 中文片名 / 原始片名 / 嘉宾 / code / 单元·导演(目录 ${ctx.cat.films.length} 部)`
    : "搜 中文片名 / 英文片名 / 嘉宾 / code";
  search.autocomplete = "off";
  libTool.append(search);
  // 单元筛选 = **下拉**(2026-09-11 由 chips 改):单元名的长短差极大(「Icons」↔
  // 「Wide Angle – Asian Short Film Competition · 广角镜 · 亚洲短片竞赛」),chip 一行铺不下、
  // 折行后会把抽屉顶部吃掉半屏;下拉一个控件装得下全部,标签也能完整走「英文 · 中文」排版
  // (`util.ts::unitLabel`,与片名同口径),不必再为了塞进 chip 而截断。
  const unitRow = el("div", "flex items-center gap-[6px]");
  const unitSel = document.createElement("select");
  unitSel.id = "lib-unit";
  unitSel.className =
    "flex-1 min-w-0 border border-line rounded-8 px-[8px] py-[5px] text-12 font-semibold bg-card text-ink " +
    "cursor-pointer focus:border-biff focus:[outline:2px_solid_color-mix(in_srgb,var(--color-biff)_25%,var(--color-card))]";
  unitRow.append(el("span", "text-11 text-faint font-semibold shrink-0", "单元"), unitSel);
  // 排片筛选(字幕 / 影厅 / GV)—— 控件与判定同源(`filters.ts`),但状态是**抽屉自己那份**
  // (`libFilters`,与甘特图那套独立;见该常量注释)。
  // 抽屉只有 520px 宽,影厅 chip 铺开会吃掉半屏 → 这里走**可折叠**形态(甘特图侧铺开三行)。
  const libFiltersHost = el("div", "grid gap-[6px]");
  const libStat = el("div", "text-12 text-muted");
  // 列表不再自带宽高(`max-h` + `overflow-y-auto`)—— 统一由抽屉内的 panel 滚动,避免双滚动条
  // 列表容器同理:显式 `minmax(0,1fr)`,否则某一行的长内容会把整列撑宽(见 libPane 注释)
  const libList = el("div", "grid gap-2 content-start pt-[2px] px-[2px] pb-1 @container grid-cols-[minmax(0,1fr)]");
  libPane.append(libTool, unitRow, libFiltersHost, libStat, libList);

  // ---- tab 2:我的选片(日期筛选;展开只列已排场次) ----
  const pickPane = el("div", "grid gap-[8px] content-start grid-cols-[minmax(0,1fr)]");
  const pickStat = el("div", "text-12 text-muted");
  // 筛选行:**日期导航栏**(单行横向滚动,‹ / › 滚动 + 各天 chip)
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
  const pickList = el("div", "grid gap-2 content-start pt-[2px] px-[2px] pb-1 @container grid-cols-[minmax(0,1fr)]");
  pickPane.append(pickStat, pickDateRow, pickList);

  /** 滚动面板:抽屉高度固定,当前 tab 的内容在面板内滚动(两个 pane 只有一个是 panel 的子节点)。
   *  ⚠ 场次行的「单行优先」排版是**纯栅格**实现的(`row.ts::SHOW_ROW_CLS`,外层不换行 + 内层流式),
   *  **不依赖容器查询** —— 三改曾在这里挂 `@container` 做断点,四改已撤(见 row.ts 头部 ②)。
   *  ⚠ **id 给 style.css 定制滚动条**:自定义 `::-webkit-scrollbar` 会让浏览器放弃 macOS 的
   *  overlay 滚动条、改用占位式 —— 滚动条固定占位,不再浮在卡片右缘的 ⓘ ✕ 图标组上
   *  (用户反馈「滚轮遮挡电影卡片」)。 */
  // ⚠ `pr-[8px]` 是**双保险**:即使某个浏览器仍走 overlay 滚动条(浮在内容上),
  //   这 8px 也让卡片右缘躲开它 —— 图标组(ⓘ ✕)永远不会被压住。
  const panel = el("div", "min-h-0 flex-1 overflow-y-auto pr-[8px]");
  panel.id = "picker-panel";

  // ---- 视图状态 ----
  /** 影片库 tab 展开态:默认全折叠(目录 250 部,全展开不可用) */
  const expLib = new Set<string>();
  /** 我的选片 tab 展开态:**默认全收起**(2026-09-11 用户要求「我的选片如果已经添加了选片的 就先收起卡片」)。
   *  旧口径是「把当前每一部选片都放进展开集合」—— 选片一多,打开就是十几屏的场次流水,
   *  想找某部片只能一路滚。现在先给一份**影片清单**(卡片头仍有「共 N 场 / 已排 M 场」),
   *  要看场次再点开那一片;「＋ 加入我的选片」与「✓ 已在选片 · 去排场次 ▸」
   *  这两处**刚动过那一片**仍会写进本集合(见各调用点),不会被这条默认值影响。
   *  ⚠ 本集合是 `openFilmPicker` 的闭包变量,抽屉每次打开都重建 → 初值 = 每次打开时的默认态。 */
  const expPick = new Set<string>();
  let kw = "";
  let unit: string | null = null;
  /** 影片库筛选条的展开态:有筛选生效时默认展开(否则用户看不到自己筛了什么) */
  let filtersOpen = hasActiveFilter(libFilters);
  /** 我的选片日期筛选:**空集 = 全部日期**;否则只看命中这些日期的**可选**场次(2026-09-11 起支持多选) */
  const dateSel = new Set<string>();

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
   *  `mode` 决定**这一步能做什么**(2026-09-11 流程改版:影片库 = 选片;我的选片 = 挑场次):
   *  ```
   *  影片库 ▶ 片名  豆8.5                    ⓘ        ← 展开的场次表**只读**(只有「定位 ▸」)
   *         副标题
   *         [共 4 场] [＋ 加入我的选片]                    ← 收进「我的选片」(已收 → 「✓ 已在选片 · 去排场次 ▸」)
   *
   *  我的选片 ▶ 片名  豆8.5                  ⓘ  ✕        ← 展开的场次表**可挑**(每行「定位 ▸」+「＋/✓」)
   *         副标题
   *         [共 4 场 / 已排 1 场] [豆瓣搜索 ↗]
   *  ```
   *  其余(折叠箭头 / 片名区 / 状态标签 / 图标组 / 资料 / 豆瓣入口)完全同款。
   *  (历史:原先两个 tab 都能加场次 —— 用户反馈「排片有两个地方要选,跳来跳去」。) */
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
    const tagCls =
      "inline-flex items-center rounded-5 px-[7px] py-[2px] text-11 font-bold leading-[1.4] " +
      "whitespace-nowrap bg-biff-soft text-biff-ink";
    if (n.shows.length) {
      const txt =
        picked > 0
          ? `共 ${n.shows.length} 场 / 已排 ${picked} 场`
          : mode === "picks"
            ? `共 ${n.shows.length} 场 / 未排场`
            : `共 ${n.shows.length} 场`;
      status.appendChild(el("span", tagCls, txt));
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
    // ---- 「＋ 加入我的选片」/「✓ 已在选片 · 去排场次 ▸」(**仅影片库**;2026-09-11 流程改版)----
    // 流程(用户原话):「影片库只选影片和想看类型 → 添加到我的选片 → 选片里再选具体排片」。
    // 于是「加入」与「排场次」拆成两步,影片库这张卡只负责第一步;第二步在「我的选片」里做。
    // 两态共用一枚按钮:未加入 = 加进清单;已加入 = 直接切到「我的选片」并展开该片去挑场次。
    if (mode === "library" && n.shows.length) {
      const inList = ctx.picks.has(n.key);
      const b = el(
        "button",
        inList
          ? "border border-line rounded-5 px-[7px] py-[2px] text-11 font-bold leading-[1.4] whitespace-nowrap " +
              "bg-card text-ink-2 cursor-pointer hover:border-biff hover:text-biff-ink"
          : "border border-biff rounded-5 px-[7px] py-[2px] text-11 font-bold leading-[1.4] whitespace-nowrap " +
              "bg-biff-soft text-biff-ink cursor-pointer hover:bg-biff-line",
        inList ? "✓ 已在选片 · 去排场次 ▸" : "＋ 加入我的选片"
      );
      b.dataset.pickAdd = n.key;
      b.dataset.tip = inList
        ? `已在「我的选片」里 — 点这里切过去挑《${n.title}》的场次(共 ${n.shows.length} 场可选)`
        : `把《${n.title}》收进「我的选片」(先不排场次)\n收好后去「我的选片」里挑具体场次`;
      status.appendChild(b);
    }
    // ---- 豆瓣入口(**每张卡都有**,2026-09-11 改)----
    // 历史:这枚入口原先是「**无排期目录片**专属」的兜底(有映射走条目直链,无映射走中文名搜索)——
    // 于是「有排期的片反而点不到豆瓣」。而「这部片豆瓣上有没有条目 / 几分」是看片单时最常做的动作,
    // 不该按有没有排期区分。现在两种卡都挂,落点仍在状态行(不新增行高)。
    // ⚠ 搜索词一律用**官方英文名**(`FilmNode.en`,见该字段注释),不再用中文名。
    {
      const direct = n.map?.douban_url ?? (cat0 ? ctx.mappings.get(cat0.id)?.douban_url : undefined);
      const q = (n.en || n.zh).trim();
      const href = direct || (q ? `https://www.douban.com/search?q=${encodeURIComponent(q)}` : "");
      if (href) {
        const a = document.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noreferrer";
        a.className = "text-11 font-bold text-biff-ink whitespace-nowrap hover:underline";
        a.textContent = direct ? "豆瓣 ↗" : "豆瓣搜索 ↗";
        a.dataset.tip = direct
          ? "打开豆瓣条目页"
          : `在豆瓣搜索「${q}」\n用**官方英文名**搜 —— 豆瓣对海外片的英文条目收录率最高\n(中文名是本工具从豆瓣回填的,拿它去搜等于用答案搜问题)`;
        status.appendChild(a);
      }
    }
    // ---- 右上角图标组(次要操作:常态极淡, hover 卡片才完全显现) ----
    // ⚠ 档位星标(★)已于 2026-09-11 删除(`PLAN-20260911223000`)—— 冲突决策改由
    //   「我的行程」里拖动冲突组场次排顺位承担,选片时不必再回答「多想看」。
    const icons = el("div", "flex items-center gap-[2px] shrink-0");
    // 资料(ⓘ)—— 原为一枚带框按钮,挤占片名行宽度
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
      title: n.title, // 英文名 · 中文名(口径见 util.ts::bilingualTitle)
      titleExtra: cat0?.rating != null ? doubanChip(cat0.rating) : undefined,
      sub: subBits.length ? subBits.join(" · ") : undefined,
      status,
      collapse: { open, attr: mode === "picks" ? "pickHead" : "libHead", value: n.key },
      divider: open,
      trailing: icons,
      poster: n.poster, // 174/250 有;没有就不占列(见 row.ts::cardHead)
    });
    item.appendChild(head);

    if (!open) return item;

    // ---- 场次行 / 占位 ----
    // 两个 tab 列的都是**该片全部场次**(都过抽屉自己的排片筛选 —— 否则点开一部片还会列出已被
    // 筛掉的场,与列表口径打架)。区别只有两点:
    //   · 「我的选片」再多过一道**日期筛选**(那个 chips 只属于这个 tab);
    //   · 只有「我的选片」的场次行带「＋ / ✓」——**排片只在这一处挑**(见 filmRow 状态行注释)。
    const shows = el("div");
    const rows = mode === "picks" ? showsInPicks(n) : showsUnderFilter(n);
    // 合集成员:没有独立场次,但有归属的块场次 —— 一并列出(带「收录于合集」标注),
    // 这样它就不会落进下面的「暂无排期」分支(用户口径:片单里不该出现「有片无排期」)。
    const blockRows = !rows.length && n.block ? [n.block] : [];
    if (rows.length || blockRows.length) {
      if (blockRows.length) {
        shows.appendChild(
          el(
            "div",
            "px-3 py-[6px] text-12 text-ink-2 border-t border-line-faint",
            "收录于合集放映 — 一张票连看多部,本片不单独售票;点下方场次可加入行程"
          )
        );
      }
      rows.push(...blockRows);
      if (mode === "picks") {
        // 「我的选片」tab:按日期分节 —— 节头给日期,节内场次行不再重复印日期(见 showRow 的 hideDate)
        for (const [date, list] of groupByDate(rows, (s) => s.date)) {
          shows.appendChild(dateHead(date, list.length));
          list.forEach((s, idx) => shows.appendChild(showRow(s, idx > 0, true, true)));
        }
      } else {
        // 「影片库」:只读场次表(定位 ▸ 保留 —— 那是「去看它在时间轴哪儿」,不是选场次)
        rows.forEach((s, idx) => shows.appendChild(showRow(s, idx > 0, false, false)));
      }
      // 已排场次里对不上当前排期的(数据换版)—— 如实说明,不静默吞掉
      // ⚠ 口径是「**已排的 code 里有多少不在当前排期**」,与「列了几行」无关(现在列的是全部场次)
      if (mode === "picks" && rec) {
        const inSchedule = new Set(n.shows.map((s) => s.code));
        const gone = rec.picks.filter((p) => !inSchedule.has(p.code)).length;
        if (gone) {
          shows.appendChild(
            el(
              "div",
              "px-3 py-[6px] text-12 text-tight border-t border-line-faint",
              `另有 ${gone} 场已排场次不在当前排期里(数据换版)`
            )
          );
        }
      }
    } else {
      shows.appendChild(
        el(
          "div",
          "px-3 py-[8px] text-12 text-muted border-t border-line-faint",
          mode === "picks"
            ? "当前筛选下这部片没有可选场次 —— 放宽排片筛选或切到别的日期看看"
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
   *  `pickable` = 是否渲染「＋ / ✓」加入三态 —— **只有「我的选片」传 true**(2026-09-11 流程改版:
   *  排片只在这一处挑,影片库那张场次表是只读的,只留「定位 ▸」)。
   *  其余骨架与「我的行程」完全一致。 */
  function showRow(s: Screening, withTopBorder: boolean, hideDate = false, pickable = false): HTMLElement {
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
    acts.appendChild(go);
    if (pickable) {
      // 加入/移出方案 —— 与「定位 ▸」并排:想跳到时间轴看就点定位,想排进方案就点右侧三态控件。
      // 三态文案/配色由 modal.ts::actState 单源给出(已加入 = 与「＋ 加入」等宽的绿描边按钮)。
      const act = el("button", "", "");
      act.dataset.libToggle = s.code;
      act.dataset.film = filmNodeKey(ctx.cat, s);
      const st0 = actState(s.code);
      act.textContent = st0.short; // 紧凑符号(等宽盒子);完整语义在 tip 与卡片底色(已选 = 绿底)上
      act.className = st0.cls;
      act.dataset.tip = st0.tip;
      acts.appendChild(act);
    }
    return screeningRow({
      s,
      cat: ctx.cat,
      hideDate,
      rowCls: SHOW_ROW_CLS + (withTopBorder ? " border-t border-line-faint" : ""),
      acts,
    });
  }

  /** 「我的选片」tab 展开口径:**该片全部可选场次**(2026-09-11 流程改版 —— 挑场次只在这一处)。
   *  - 过抽屉自己的**排片筛选**(字幕 / 影厅 / GV):筛掉的场次不列,与列表口径一致;
   *  - 再多过一道**日期筛选**(那个 chips 只属于这个 tab);
   *  - 按 日期 → 开始时间 排序;已排的场次由 `actState` 画成 ✓ 绿态,一眼分得清「挑了哪些」。
   *  历史:原先是「只列已排场次」(「我的行程」在本片的投影)—— 于是挑场次只能回「影片库」,
   *  两个 tab 都能加场次,用户反馈「排片有两个地方要选,跳来跳去」。 */
  function showsInPicks(n: FilmNode): Screening[] {
    return showsUnderFilter(n)
      .filter((s) => dateSel.size === 0 || dateSel.has(s.date))
      .sort((a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time));
  }

  /** 该片在**当前排片筛选**下还剩几场(筛选未生效时 = 全部场次)。
   *  「影片库」筛的是「这部片还有没有我要看的场」—— 没有就直接不列,而不是列出来再全灰。 */
  const showsUnderFilter = (n: FilmNode): Screening[] =>
    hasActiveFilter(libFilters) ? n.shows.filter((s) => matchesFilters(s, libFilters)) : n.shows;

  /** 「影片库」tab:全部影片(搜索 + 单元筛选 + 排片筛选) */
  function paintLib(): void {
    const q = kw.trim().toLowerCase();
    libList.innerHTML = "";

    const bySearch = filmList.filter((n) => matchNode(n, q) && (!unit || inUnit(n, unit)));
    // 排片筛选生效时,只留「至少有一场符合」的片;无排期的目录片一并出局(它不可能符合)
    const matched = hasActiveFilter(libFilters) ? bySearch.filter((n) => showsUnderFilter(n).length > 0) : bySearch;

    const filtered = Boolean(q) || unit !== null || hasActiveFilter(libFilters);
    const prefix = unit ? `${unitChipLabel(unit)} · ` : "";
    libStat.textContent = filtered
      ? `${prefix}匹配 ${matched.length}/${filmList.length} 部影片${
          hasActiveFilter(libFilters) ? ` · 符合筛选的场次 ${matched.reduce((n, x) => n + showsUnderFilter(x).length, 0)} 场` : ""
        }`
      : `目录共 ${filmList.length} 部(其中 ${totalShows ? `${filmList.length - noSchedule} 部已发布排期` : "排期尚未发布"}) · ${totalShows} 场`;

    // 单元下拉(全部 + 各归并单元 + 活动形式单元)—— 选项标签走「英文 · 中文」(与片名同排版)。
    // 每次 paint 全量重建 options:单元集合由目录 + extras 唯一决定,一次就是一份完整快照,不做 diff。
    unitSel.replaceChildren(
      unitOption("", `全部单元 · ${ctx.cat.films.length} 部`),
      ...unitChips.map((c) => unitOption(c.key, `${unitChipLabel(c.key)} · ${c.count} 部`))
    );
    // 选中项回填:单元集合换版后旧 key 可能已不存在 → 落不到任何 option 时归「全部」
    unitSel.value = unit && unitChips.some((c) => c.key === unit) ? unit : "";
    unitSel.disabled = unitChips.length === 0;

    // 排片筛选条(可折叠)—— 读写的都是**抽屉自己那份** `libFilters`;变化只重画本列表,
    // 不再回给 main(两处状态独立,甘特图那边有它自己的筛选条与重绘时机)。
    renderFilterBar(libFiltersHost, libFilters, {
      venues: ctx.cat.venues,
      collapsed: !filtersOpen,
      onToggle: () => {
        filtersOpen = !filtersOpen;
        paintLib();
      },
      onChange: () => {
        filtersOpen = true;
        onLibFiltersChanged(); // 落盘 + 重绘抽屉(内部走 pickerRender → paintLib)
      },
    });

    if (matched.length === 0) {
      const what = [
        kw.trim() && `「${kw.trim()}」`,
        unit && `单元「${unit}」`,
        hasActiveFilter(libFilters) && "当前排片筛选",
      ]
        .filter(Boolean)
        .join(" + ");
      libList.appendChild(
        el("div", "text-muted text-center py-[26px] text-13", `没有匹配${what ? ` ${what}` : ""}的影片,试试英文/原始片名或放宽筛选`)
      );
      return;
    }

    for (const n of matched) {
      // 搜索时自动展开命中片(与旧版一致:搜到就想看它的场次)
      libList.appendChild(filmRow(n, "library", expLib.has(n.key) || q !== ""));
    }
  }

  /** 「我的选片」tab —— 顺序沿用「影片库」的目录顺序(档位排序已随档位一起删除)。 */
  const pickNodes = (): FilmNode[] =>
    filmList
      // 整部片都没有已发布排期(暂无排期)的不要进「我的选片」——
      // 它是「已选」视图,没有场次可选的片出现在这里没意义(排期接入后会自动重新出现)。
      // 「未排场」(picks:[])且 shows>0 的片仍保留(选了片但还没落场 = 合法的选片意向)。
      .filter((n) => ctx.picks.has(n.key) && n.shows.length > 0);

  function paintPick(): void {
    const rows = pickNodes();
    /** 每个日期 → 当日**可选**场次数(日期 chips 的数据源)。
     *  ⚠ 2026-09-11 改:原先只统计**已排**场次的日期 —— 新流程下「我的选片」列的是全部可选场次,
     *    日期筛选是「我今天要排哪天」的导航,只统计已排的日期会把还没排的那几天直接藏起来
     *    (恰恰是最需要点进去挑的日子)。现在按「选片影片在该日的可选场次」统计。 */
    const dateCount = new Map<string, number>();
    let slots = 0;
    for (const n of rows) {
      slots += ctx.picks.get(n.key)!.picks.length;
      for (const s of showsUnderFilter(n)) {
        dateCount.set(s.date, (dateCount.get(s.date) ?? 0) + 1);
      }
    }
    pickStat.textContent = rows.length ? `选片 ${rows.length} 部 · 已排 ${slots} 场` : "还没有任何选片";

    // 日期导航栏(「全部」+ 选片影片有**可选**场次的每一天)。只有 1 天时不渲染 —— 只有一个选项的筛选没有意义
    const dates = [...dateCount.keys()].sort();
    // 已选日期若不再有任何可选场次(选片被移除 / 换档)→ 从集合里剔除,避免「筛了却是空列表」
    for (const d of [...dateSel]) {
      if (!dateCount.has(d)) dateSel.delete(d);
    }
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
      const all = el("button", dateSel.size === 0 ? PILL_ON : PILL_IDLE, `全部 ${dates.length} 天`);
      all.dataset.pdate = "";
      all.dataset.tip = "显示全部日期";
      pickDateChips.appendChild(all);
      for (const d of dates) {
        const { label, weekday } = dateInfo(d);
        const on = dateSel.has(d);
        const b = el("button", on ? PILL_ON : PILL_IDLE, `${label} ${weekday} ${dateCount.get(d)}`);
        b.dataset.pdate = d;
        b.dataset.tip = on
          ? `${label} ${weekday} 已选 —— 再点取消该天`
          : `加上 ${label} ${weekday} 的场次(可多选)`;
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

    pickList.innerHTML = "";
    if (!rows.length) {
      pickList.appendChild(
        el(
          "div",
          "text-13 text-muted leading-[1.8] py-[18px] px-[6px] text-center",
          "还没有选片 — 切到「影片库」tab,点「＋ 加入我的选片」把片子收进来;**场次在这里挑**(展开任意一部片,点场次行右侧的「＋」)。时间轴上直接点卡片选场次也行,写的是同一份数据。"
        )
      );
      return;
    }
    const shown = rows
      .filter((n) => {
        if (dateSel.size === 0) return true;
        // 「该日有没有**可选**场次」而非「该日有没有已排场次」—— 与日期 chips 的口径一致
        // (新流程下选片 tab 列的是全部可选场次,日期筛选是「今天排哪天」的导航)
        return showsUnderFilter(n).some((s) => dateSel.has(s.date));
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
    // 重建内容时**保住滚动位置**(2026-09-11):旧写法直接 `libList.innerHTML = ""`,
    // 内容瞬间归零 → 浏览器把 `panel.scrollTop` 钳到 0 → 用户滚了很久、点了一部片
    // (打标 / 展开 → store 广播 → 本函数重建),刚点的那一行就飞出视野
    // (用户反馈「拉了很长后点了片子,刚才点的片子就消失在视野之外」)。
    // 记 + 还原放在这里而不是各个 paint* 里:三条分支(库 / 选片 / 行程)共用同一份语义。
    const keepTop = panel.scrollTop;
    if (pickerTab === "lib") paintLib();
    else if (pickerTab === "pick") paintPick();
    else /* "agenda" */ renderAgenda();
    panel.scrollTop = keepTop;
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
    const an = allCodes().length;
    agendaTab.textContent = an ? `我的行程 ${an}` : "我的行程";
  }

  /** 切 tab:换面板子节点 → 复位滚动 → 重画。当前 tab 跨开合保持(见 pickerTab) */
  function setTab(which: "lib" | "pick" | "agenda"): void {
    pickerTab = which;
    const tabs = { lib: libTab, pick: pickTab, agenda: agendaTab };
    for (const [k, btn] of Object.entries(tabs)) {
      (btn as HTMLElement).className = k === which ? TAB_ON : TAB_OFF;
    }
    // ⚠ 三步流程写进 tip(2026-09-11):影片库 = 选片;我的选片 = 挑场次;我的行程 = 看结果
    libTab.dataset.tip =
      which === "lib"
        ? "当前:影片库 — 选影片、加入我的选片"
        : "切到影片库 — 选影片、加入我的选片";
    pickTab.dataset.tip =
      which === "pick"
        ? "当前:我的选片 — 展开影片挑**具体场次**(可按日期筛选)"
        : "切到我的选片 — 展开影片挑**具体场次**(可按日期筛选)";
    agendaTab.dataset.tip =
      which === "agenda"
        ? "当前:我的行程 — 按日期分组看结果,冲突组可**拖动排顺位**(顺位 = 方案)"
        : "切到我的行程 — 按日期分组看结果,冲突组可**拖动排顺位**(顺位 = 方案)";
    // agenda tab 由 renderAgenda() 直接 replaceChildren(因为 panel 是 agendaRenderer 一次性产物)
    if (which === "agenda") renderAgenda();
    else panel.replaceChildren(which === "lib" ? libPane : pickPane);
    panel.scrollTop = 0;
    render();
  }

  /** 「✓ 已在选片 · 去排场次 ▸」→ 切到「我的选片」并**展开该片**挑场次(2026-09-11 流程改版)。
   *  这是新流程的**第二步落点**(第一步 = 影片库的「＋ 加入我的选片」)。
   *  ① 清掉「我的选片」自己的日期筛选 —— 目标片被筛掉时跳过去是一片空白,
   *     与「跳空 = 等于没跳」同一条口径(用户自己设的筛选在这儿让位于「带我去看这部片」);
   *  ② 展开态写 `expPick`,滚动 + `flash` 闪烁作落点回执 —— 与网格侧「定位 ▸」同一套动画语言。 */
  /** 把面板内的某一行滚到**面板顶边** —— 只写 `panel.scrollTop`,页面一动不动。
   *
   *  ⚠ **不能用 `scrollIntoView`**:它的语义是「把元素滚进视野」,会从内到外把**每一个**可滚动
   *    祖先都滚一遍,其中包含 `document`。于是「去排场次」会把整页顶到最大滚动位置(用户反馈
   *    「最外层浏览器滚动条定位到最底下」);而窄屏(≤1099px)抽屉是 `static`(`style.css` 里
   *    `#main-col` 隐藏、抽屉全宽),页面一滚抽屉就跟着移出视口 —— 落点当场失准。两个症状同源。
   *    口径与甘特图侧 `main.ts::scrollTargetFor` 一致:**量出目标在容器内容坐标系里的位置,
   *    只改这一个容器的滚动量**。
   *  `behavior:"auto"` 直接到位:setTab 刚把 `scrollTop` 复位为 0,平滑滚过去等于让用户先看一帧
   *    「列表顶部」再滑到目标(与甘特图侧「容器刚重建 → instant」同一条口径)。
   *  ⚠ 调用点仍在 rAF 里:要等 setTab 的 DOM 落地后量尺寸(`getBoundingClientRect` 会强制布局)。 */
  function scrollRowToTop(node: HTMLElement): void {
    const pRect = panel.getBoundingClientRect();
    const nRect = node.getBoundingClientRect();
    panel.scrollTo({ top: Math.max(0, nRect.top - pRect.top + panel.scrollTop), behavior: "auto" });
  }

  function goPickShows(key: string): void {
    dateSel.clear();
    expPick.add(key);
    setTab("pick");
    // setTab 会把 scrollTop 复位为 0,须等它渲染完再滚动定位
    requestAnimationFrame(() => {
      const card = panel.querySelector<HTMLElement>(`[data-key="${key}"]`);
      if (!card) return;
      scrollRowToTop(card); // 只滚面板(见函数注释:scrollIntoView 会把整页一起滚)
      card.classList.remove("flash"); // 同一片连点两次也要重播动画(先摘类 + 强制回流)
      void card.offsetWidth;
      card.classList.add("flash");
    });
  }

  libTab.addEventListener("click", () => setTab("lib"));
  pickTab.addEventListener("click", () => setTab("pick"));
  agendaTab.addEventListener("click", () => setTab("agenda"));
  closeBtn.addEventListener("click", () => closePickerDrawer());

  search.addEventListener("input", () => {
    kw = search.value;
    render();
  });

  // 单元下拉:选中即筛,「全部单元」= 取消(单选控件,没有「再点一次取消」的语义)
  unitSel.addEventListener("change", () => {
    unit = unitSel.value === "" ? null : unitSel.value;
    render();
  });

  pickDateChips.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-pdate]");
    if (!b) return;
    const d = b.dataset.pdate!;
    if (d === "") dateSel.clear(); // 「全部」= 清空筛选
    else if (dateSel.has(d)) dateSel.delete(d); // 再点已选天 = 取消该天(其余天保留)
    else dateSel.add(d); // 多选:点一天就累加一天
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
    // 「＋ 加入我的选片」/「✓ 已在选片 · 去排场次 ▸」—— 必须最先判:它在**卡片头内**
    // (状态行属于片名区),否则会冒泡成该卡的展开 / 折叠
    const addBtn = target.closest<HTMLElement>("[data-pick-add]");
    if (addBtn) {
      const key = addBtn.dataset.pickAdd!;
      if (ctx.picks.has(key)) {
        goPickShows(key); // 已在清单 → 直接带去挑场次(新流程第二步)
      } else {
        addPickFilm(key); // 只收影片,不排场次(记录为空 —— 场次去「我的选片」里挑)
        expPick.add(key); // 刚加入的这一片在「我的选片」里展开(其余仍默认收起)—— toast 正引导去挑场次
        toast(`已加入「我的选片」— 去那里挑场次`);
        render();
      }
      return;
    }
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
        const title = filmList.find((x) => x.key === key)?.title ?? "";
        if (!window.confirm(`《${title}》已排 ${n} 场,确定整片移除(含这些场次)?`)) return;
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

  // 首画:画当前 tab(`pickerTab` 跨开合保持 —— 上次在看「我的选片」,再打开还在那儿)
  setTab(pickerTab);
  if (pickerTab === "lib" && window.matchMedia("(pointer: fine)").matches) search.focus();
}
