// 影片库 — 全部影片浏览 + 单元筛选 chips + 搜索 → 反向定位 / 详情豆瓣。
// 全量化:列表 / 行 / 头部 / chip / pill / 场次行 / 智能排片弹层 全部 Tailwind utility。
// 16-B 单元 chip / 评分章 / 选片三选 / 智能排片结果 同源 —— 都读写 store.picks(唯一数据源)。

import type { Catalog, FilmItem, Group, Mapping, PickEntry, Priority, Screening } from "./types";
import { dateInfo, el, filmNodeKey, fmtMinRange } from "./util";
import { codeTip } from "./badges";
import { appendMetaRow, doubanChip, venueShort, venueTip } from "./legend";
import { actState, closeModal, openModal } from "./modal";
import { PRI_BG_ON, PRI_LABEL, WISH_ORDER, buildWishSeg, priTag } from "./pick";
import { addGroupPicks, codesOfGroup, removePick, setCurrentGroup, setWish, store } from "./state";
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

export function openLibrary(ctx: LibraryCtx): void {
  const { filmList, totalShows, noSchedule, unitChips } = buildFilmList(ctx);

  // ---- DOM 骨架:搜索(+智能排片) → chips(16-B) → 计数 → 列表 ----
  const body = el("div", "grid gap-[10px]");
  // 工具行:搜索框吃满剩余宽度(左),「智能排片 ▸」贴右缘 —— 与「我的选片」工具行同构。
  // ⚠ 输入框用 `flex-1 min-w-0` 而不是 `w-full`:`w-full` 在 flex 行里靠 shrink 让位,
  //   窄屏会被按钮压到 min-content(≈20 字符)再溢出;`min-w-0` 才允许它真正缩下去。
  const tool = el("div", "flex gap-2 items-center");
  const search = el(
    "input",
    "flex-1 min-w-0 border border-line rounded-[8px] px-3 py-[9px] text-[14px] focus:[outline:2px_solid_color-mix(in_srgb,var(--color-biff)_25%,var(--color-card))] focus:border-biff"
  ) as HTMLInputElement;
  search.type = "search";
  search.placeholder = ctx.cat.films.length
    ? `搜 中文片名 / 原始片名 / code / 单元·导演(目录 ${ctx.cat.films.length} 部)`
    : "搜 中文片名 / 英文片名 / code";
  search.autocomplete = "off";
  tool.appendChild(search);
  const aiBtn = el(
    "button",
    "border rounded-[6px] px-[14px] py-[6px] text-[13px] font-bold bg-card text-ink border-line hover:opacity-90 whitespace-nowrap",
    "智能排片 ▸"
  );
  aiBtn.id = "lib-ai";
  aiBtn.title = "按影片已标「必看/备选/随缘」生成建议行程:填入你自己的模型 API Key,由浏览器直连服务商(本站不经手 Key)";
  tool.appendChild(aiBtn);
  body.appendChild(tool);

  const chipsBar = el("div", "flex flex-wrap gap-[6px]");
  if (unitChips.length) {
    const allChip = el(
      "button",
      CHIP_UNIT_ON,
      `全部 ${ctx.cat.films.length}`
    );
    allChip.dataset.unit = "";
    allChip.title = "取消单元筛选";
    chipsBar.appendChild(allChip);
    for (const c of unitChips) {
      const b = el("button", CHIP_UNIT_BASE, `${c.key} ${c.count}`);
      b.dataset.unit = c.key;
      b.title = "再次点击取消筛选";
      chipsBar.appendChild(b);
    }
  }
  body.appendChild(chipsBar);

  const stat = el("div", "text-[12px] text-muted");
  body.appendChild(stat);
  const list = el("div", "grid gap-2 max-h-[min(62vh,560px)] overflow-y-auto pt-[2px] px-[2px] pb-1");
  body.appendChild(list);

  // 返回本层时刷新列表(详情里改过档位/场次 → 「已选 N」计数要跟上);弹层栈保留 DOM,滚动位置不丢
  openModal("影片库 · 全部影片", body, true, () => render());
  if (window.matchMedia("(pointer: fine)").matches) search.focus();

  // ---- 渲染 ----
  const expanded = new Set<string>();
  let kw = "";
  let unit: string | null = null;

  /** 重建列表;外层 render() 负责保住滚动位置(点行内档位 / 从详情返回后不跳回顶部) */
  function paint(): void {
    const q = kw.trim().toLowerCase();
    list.innerHTML = "";

    const matched = filmList.filter((n) => matchNode(n, q) && (!unit || inUnit(n, unit)));

    const filtered = Boolean(q) || unit !== null;
    const prefix = unit ? `${unit} · ` : "";
    stat.textContent = filtered
      ? `${prefix}匹配 ${matched.length}/${filmList.length} 部影片`
      : `目录共 ${filmList.length} 部(其中 ${totalShows ? `${filmList.length - noSchedule} 部已发布排期` : "排期尚未发布"}) · ${totalShows} 场`;

    // chips 激活态同步(full className 重写)
    chipsBar.querySelectorAll<HTMLElement>("[data-unit]").forEach((b) => {
      const on = b.dataset.unit === (unit ?? "");
      b.className = on ? CHIP_UNIT_ON : CHIP_UNIT_IDLE;
    });

    if (matched.length === 0) {
      const what = [kw.trim() && `「${kw.trim()}」`, unit && `单元「${unit}」`].filter(Boolean).join(" + ");
      list.appendChild(el("div", "text-muted text-center py-[26px] text-[13px]", `没有匹配${what ? ` ${what}` : ""}的影片,试试英文/原始片名或切回「全部」`));
      return;
    }

    for (const n of matched) {
      const open = expanded.has(n.key) || q !== "";
      const itemCls = "border border-line rounded-[8px] bg-card transition-[border-color,box-shadow] duration-[120ms] hover:border-line-strong hover:shadow-[var(--shadow-hover)]";
      const item = el("div", itemCls);
      item.dataset.key = n.key;

      // ---- 片名行 ----
      const headCls = open
        ? "flex items-center gap-[10px] px-3 py-[9px] cursor-pointer select-none hover:bg-hover border-b border-line-faint"
        : "flex items-center gap-[10px] px-3 py-[9px] cursor-pointer select-none hover:bg-hover";
      const head = el("div", headCls);
      head.dataset.libHead = n.key;
      const chevCls = open
        ? "text-muted text-[10px] transition-transform duration-150 ease-in-out rotate-90"
        : "text-muted text-[10px] transition-transform duration-150 ease-in-out";
      head.appendChild(el("span", chevCls, "▶"));
      const titles = el("div", "flex-1 min-w-0 grid gap-px");
      // 16-A:片名行首放「豆 x.x」评分徽章(仅目录有分时显示)
      const zhTop = el("div", "flex items-center gap-2 min-w-0");
      zhTop.appendChild(el("div", "text-[14px] font-bold truncate flex-1", n.zh));
      const cat0 = n.cats[0];
      if (cat0?.rating != null) {
        zhTop.appendChild(doubanChip(cat0.rating)); // 豆瓣章单一来源(legend.ts;豆 = 豆瓣评分)
      }
      titles.appendChild(zhTop);
      if (n.names.length) titles.appendChild(el("div", "text-[11.5px] text-muted truncate", n.names.join(" · ")));
      if (n.meta) titles.appendChild(el("div", "text-[11px] text-meta truncate", n.meta));
      head.appendChild(titles);

      const ops = el("div", "flex flex-wrap gap-[6px] items-center justify-end row-gap-1");
      // M2.5:行内想看三选(必看/备选/随缘);再点同档取消 —— 与「我的选片」/详情弹层同源(见 pick.ts)
      ops.appendChild(
        buildWishSeg({
          cur: ctx.picks.get(n.key)?.priority ?? undefined,
          onPick: (p) => {
            setWish(n.key, p);
            render();
          },
          size: "sm",
        })
      );
      if (n.shows.length) {
        ops.appendChild(el("span", "text-[11px] font-bold text-ink border border-line bg-card rounded-full px-2 py-px whitespace-nowrap", `${n.shows.length} 场`));
        const pick = n.shows.reduce(
          (m, s) => m + (ctx.slots.get(s.code)?.group === ctx.group ? 1 : 0),
          0
        );
        if (pick > 0) ops.appendChild(el("span", "text-[11px] font-bold text-on-brand bg-biff rounded-full px-2 py-px whitespace-nowrap", `${ctx.group} 已选 ${pick}`));
        const detail = el(
          "button",
          "border rounded-[6px] px-[10px] py-1 text-[12px] font-bold bg-card text-ink border-line hover:opacity-90",
          "资料 ⓘ"
        );
        detail.dataset.libDetail = n.shows[0].code;
        ops.appendChild(detail);
      } else {
        ops.appendChild(el("span", "text-[11px] font-bold text-muted font-semibold border border-line bg-card rounded-full px-2 py-px whitespace-nowrap", "暂无排期"));
        // 目录片无排期也可先关联豆瓣(资料 ⓘ → 目录片弹层,code=f###)
        const cat0 = n.cats[0];
        const cmap = cat0 ? ctx.mappings.get(cat0.id) : undefined;
        if (cmap?.douban_url) {
          const a = document.createElement("a");
          a.href = cmap.douban_url;
          a.target = "_blank";
          a.rel = "noreferrer";
          a.className = "text-[11px] font-bold text-biff border border-line bg-card rounded-full px-2 py-px whitespace-nowrap hover:underline";
          a.textContent = "豆瓣 ↗";
          ops.appendChild(a);
        }
        if (cat0) {
          const detail = el(
            "button",
            "border rounded-[6px] px-[10px] py-1 text-[12px] font-bold bg-card text-ink border-line hover:opacity-90",
            "资料 ⓘ"
          );
          detail.dataset.libDetail = cat0.id;
          detail.title = "暂无排期 — 可先关联豆瓣(点开查条目/粘贴链接回填)";
          ops.appendChild(detail);
        }
      }
      head.appendChild(ops);
      item.appendChild(head);

      // ---- 场次行 / 无排期占位 ----
      if (open) {
        const shows = el("div");
        if (n.shows.length) {
          n.shows.forEach((s, idx) => {
            const rowCls = idx > 0
              ? "grid grid-cols-[176px_minmax(0,1fr)_auto_auto] gap-[10px] items-center px-3 py-[7px] border-t border-line-faint max-[720px]:grid-cols-[minmax(0,1fr)_auto_auto]"
              : "grid grid-cols-[176px_minmax(0,1fr)_auto_auto] gap-[10px] items-center px-3 py-[7px] max-[720px]:grid-cols-[minmax(0,1fr)_auto_auto]";
            const row = el("div", rowCls);
            const { label, weekday } = dateInfo(s.date);
            const when = el("div", "flex items-center gap-[7px] text-[12.5px] tabular-nums whitespace-nowrap max-[720px]:col-start-1 max-[720px]:row-start-1");
            const codeEl = el(
              "span",
              "font-extrabold text-[10.5px] text-on-brand bg-ink rounded px-1 py-px",
              s.code
            );
            codeEl.dataset.tip = codeTip(s.code); // 缩写说明:CODE 数字 hover 提示
            when.appendChild(codeEl);
            when.appendChild(el("span", "", `${label} ${weekday} ${fmtMinRange(s.start_time, s.end_time)}`));
            // 影院只出「官方代码」徽章(B1 / BT / L4)—— 窄列放不下全名;全名 / 韩名 / 分区由 hover tooltip 兜住
            const venue = ctx.cat.venueById.get(s.venue_id);
            const vCode = venue ? venue.code ?? venue.id.toUpperCase() : s.venue_display;
            const where = el(
              "div",
              "text-[12px] text-muted min-w-0 flex gap-[6px] items-center truncate max-[720px]:col-span-full max-[720px]:row-start-2"
            );
            const venueChip = el(
              "span",
              "not-italic font-extrabold text-biff bg-biff-soft border border-biff-line rounded-[3px] px-[5px] py-px text-[10.5px] whitespace-nowrap shrink-0",
              vCode
            );
            venueChip.dataset.tip = venue ? venueTip(venue) : s.venue_display;
            where.appendChild(venueChip);
            where.appendChild(el("span", "shrink-0", `${s.duration_min}min`));
            appendMetaRow(where, s); // 16-F:GV + 特性 + 等级/字幕/页码 徽章(hover 即示义)
            const go = el(
              "button",
              "border-0 rounded-[6px] px-[10px] py-1 text-[12px] font-bold text-on-brand bg-[linear-gradient(135deg,var(--biff-red)_0%,var(--biff-red-2)_100%)] hover:brightness-[1.05] max-[720px]:col-start-2 max-[720px]:row-start-1",
              "定位 ▸"
            );
            go.dataset.libGo = s.code;
            go.dataset.tip = "跳到该影厅时间轴位置";
            // 加入/移出方案 —— 唯一场次列表在这里(弹层已不再重复列场次),与「定位 ▸」并排:
            // 想跳到时间轴看就点定位,想直接排进方案就点右侧三态按钮,不必再开弹层。
            // 三态文案/配色与网格整卡点选同一口径(modal.ts::actState)。
            const act = el("button", "", "");
            act.dataset.libToggle = s.code;
            act.dataset.code = s.code;
            const st0 = actState(s.code, ctx.group);
            act.textContent = st0.label;
            act.className = st0.cls + " max-[720px]:col-start-3 max-[720px]:row-start-1";
            act.title = st0.tip;
            row.append(when, where, go, act);
            shows.appendChild(row);
          });
        } else {
          shows.appendChild(
            el(
              "div",
              "px-[14px] py-[10px] text-[12px] text-muted border-t border-line-faint",
              "官方排期未发布 — 可先用行右侧「资料 ⓘ」关联豆瓣条目;Catalogue 排期公布并引入后,这里会自动出现可定位的场次"
            )
          );
        }
        item.appendChild(shows);
      }
      list.appendChild(item);
    }
  }

  function render(): void {
    const keepTop = list.scrollTop;
    paint();
    list.scrollTop = keepTop;
  }

  search.addEventListener("input", () => {
    kw = search.value;
    render();
  });

  chipsBar.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>("[data-unit]");
    if (!btn) return;
    const k = btn.dataset.unit!;
    unit = k === "" ? null : unit === k ? null : k;
    render();
  });

  list.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    // 加入/移出方案 —— 必须最先判:按钮在「场次行」内,否则会冒泡成该行定位(或片名行展开)
    const toggleBtn = target.closest<HTMLElement>("[data-lib-toggle]");
    if (toggleBtn) {
      const code = toggleBtn.dataset.code!;
      const s = ctx.cat.byCode.get(code);
      if (s) {
        ctx.onToggle(filmNodeKey(ctx.cat, s), code);
        render(); // 就地重绘:三态按钮 + 行头「已选 N 场」计数同步
      }
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
    const head = target.closest<HTMLElement>("[data-lib-head]");
    if (head) {
      const key = head.closest<HTMLElement>("[data-key]")!.dataset.key!;
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      render();
    }
  });

  /* ---- 智能排片 ▸(AI 排片 → 采纳为 A/B 方案) ----
   * 从**影片库**进来 → 无片单模式提示里的「返回影片库打标」只需关掉排片弹层(不再叠一层)。 */
  aiBtn.addEventListener("click", () => openEngineDialog(filmList, ctx, render, true));

  render();
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
      go.title = "在「影片库」给想看的片点「必看 / 备选 / 随缘」,再回来排片 —— 候选更少、请求更快、结果更准";
      go.addEventListener("click", () => {
        closeModal();
        if (!fromLibrary) openLibrary(ctx);
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
    edit.title = "改 Base URL / 模型 / Key";
    edit.addEventListener("click", () => {
      editing = true;
      paint();
    });
    const clr = el("button", BTN_MINI, "清除 Key");
    clr.dataset.ai = "clear";
    clr.title = "删掉本机保存的 API Key(其它设置不受影响)";
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
      b.title = on ? "点击取消这一天" : "点击加入这一天";
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
    b.title = `把「方案 ${idx + 1}」里不冲突的场次追加到 ${g} 方案 —— 现有场次一律保留,不会覆盖`;
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
    head.title = open ? "收起该方案的场次清单" : "展开该方案的场次清单";
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
    rawBtn.title = "模型返回的原文(排查解析失败 / 换模型时用)";
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
    c.title = `${r.code} — ${r.why}`;
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
    c.title = d.why ? `${d.zh} — ${d.why}` : d.zh;
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
  row.title = "跳到该场在时间轴上的位置";
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

/* ---- 「我的选片」总览 —— 唯一数据源(store.picks)的**按片视图** ----
 *  「我的行程」是同一份数据的按场次视图:这里改档位 = 行程行同步(档位是影片级的),
 *  这里移场次 = 行程少一场但该片仍在清单里(标注「未排场」)。筛选 / 改档 / 逐场定位 / 整片移除。 */
export function openMyPicks(ctx: LibraryCtx): void {
  const { filmList } = buildFilmList(ctx);

  // 档位顺序优先(必看 → 备选 → 随缘 → 未设),档内保持影片库表序(sort 稳定)。
  // 每次 render 重算(改档 / 移场后就地刷新 → 计数 / chips / 列表 三者始终一致,不做增量维护)
  const rankOf = (p: Priority | null | undefined): number =>
    p ? WISH_ORDER.findIndex(([x]) => x === p) : WISH_ORDER.length;
  const rowsNow = (): FilmNode[] =>
    filmList
      .filter((n) => ctx.picks.has(n.key))
      .sort((a, b) => rankOf(ctx.picks.get(a.key)?.priority) - rankOf(ctx.picks.get(b.key)?.priority));

  const body = el("div", "grid gap-[10px]");

  const tool = el("div", "flex gap-2 items-center");
  const stat = el("div", "text-[12px] text-muted flex-1 min-w-0");
  tool.appendChild(stat);
  const aiBtn = el(
    "button",
    "border rounded-[6px] px-[14px] py-[6px] text-[13px] font-bold bg-card text-ink border-line hover:opacity-90 whitespace-nowrap",
    "智能排片 ▸"
  );
  aiBtn.title = "按已定档「必看/备选/随缘」生成建议行程:填入你自己的模型 API Key,由浏览器直连服务商(本站不经手 Key)";
  aiBtn.addEventListener("click", () => openEngineDialog(filmList, ctx, render));
  tool.appendChild(aiBtn);
  body.appendChild(tool);

  const chipsBar = el("div", "flex flex-wrap gap-[6px]");
  body.appendChild(chipsBar);
  const list = el("div", "grid gap-2 max-h-[min(62vh,560px)] overflow-y-auto pt-[2px] px-[2px] pb-1");
  body.appendChild(list);

  /** 档位筛选:null = 全部;UNSET = 未设档位(只点了场次没定档) */
  const UNSET = "unset";
  let filter: Priority | typeof UNSET | null = null;

  /** 重建清单;外层 render() 保住滚动位置(改档 / 从详情返回后不跳回顶部) */
  function paint(): void {
    const rows = rowsNow();
    const counts: Record<Priority, number> = { must: 0, maybe: 0, wild: 0 };
    let unset = 0;
    let slots = 0;
    for (const n of rows) {
      const e = ctx.picks.get(n.key)!;
      if (e.priority) counts[e.priority]++;
      else unset++;
      slots += e.picks.length;
    }
    stat.textContent = rows.length
      ? `选片 ${rows.length} 部 · 必看 ${counts.must} / 备选 ${counts.maybe} / 随缘 ${counts.wild}${
          unset ? ` / 未设 ${unset}` : ""
        } · 已排 ${slots} 场`
      : "还没有任何选片";

    // 档位筛选 chips(全部 + 三档 + 未设,带实时计数)
    chipsBar.innerHTML = "";
    if (rows.length) {
      const defs: [Priority | typeof UNSET | null, string][] = [
        [null, `全部 ${rows.length}`],
        ...WISH_ORDER.map(([p, label]) => [p, `${label} ${counts[p]}`] as [Priority, string]),
      ];
      if (unset) defs.push([UNSET, `未设 ${unset}`]);
      for (const [p, label] of defs) {
        const on = filter === p;
        const b = el("button", on ? CHIP_UNIT_ON : CHIP_UNIT_IDLE, label);
        b.dataset.pri = p ?? "";
        b.title = p ? "只看该档位(再点取消)" : "显示全部";
        chipsBar.appendChild(b);
      }
    }

    list.innerHTML = "";
    if (!rows.length) {
      list.appendChild(
        el(
          "div",
          "text-[13px] text-muted leading-[1.8] py-[18px] px-[6px] text-center",
          "还没有选片 — 去「影片库」在片名行右侧点「必看 / 备选 / 随缘」定档,或直接在时间轴上点选场次。两种操作写的是同一份数据,这里与「我的行程」永远一致。"
        )
      );
      return;
    }
    const shown =
      filter === null
        ? rows
        : rows.filter((n) => {
            const p = ctx.picks.get(n.key)!.priority;
            return filter === UNSET ? !p : p === filter;
          });
    if (!shown.length) {
      list.appendChild(el("div", "text-muted text-center py-[26px] text-[13px]", "该档位下暂无选片"));
      return;
    }
    for (const n of shown) list.appendChild(pickRow(n));
  }

  function render(): void {
    const keepTop = list.scrollTop;
    paint();
    list.scrollTop = keepTop;
  }

  function pickRow(n: FilmNode): HTMLElement {
    const rec = ctx.picks.get(n.key)!;
    const p = rec.priority;
    const item = el(
      "div",
      "border border-line rounded-[8px] bg-card transition-[border-color,box-shadow] duration-[120ms] hover:border-line-strong hover:shadow-[var(--shadow-hover)]"
    );
    const head = el("div", "flex items-center gap-[10px] px-3 py-[9px]");
    // 档位章(与影片库三选 on 态同色);未设 = 中性虚线章(只点了场次没定档)
    head.appendChild(
      p
        ? el(
            "span",
            `text-[11px] font-extrabold rounded-full px-[9px] py-[2px] whitespace-nowrap ${PRI_BG_ON[p]}`,
            PRI_LABEL[p]
          )
        : el(
            "span",
            "text-[11px] font-extrabold rounded-full px-[9px] py-[2px] whitespace-nowrap border border-dashed border-line text-muted",
            "未设"
          )
    );

    const titles = el("div", "flex-1 min-w-0 grid gap-px");
    const zhTop = el("div", "flex items-center gap-2 min-w-0");
    zhTop.appendChild(el("div", "text-[14px] font-bold truncate flex-1", n.zh));
    const cat0 = n.cats[0];
    if (cat0?.rating != null) {
      zhTop.appendChild(doubanChip(cat0.rating)); // 豆瓣章单一来源(legend.ts)
    }
    titles.appendChild(zhTop);
    if (n.names.length) titles.appendChild(el("div", "text-[11.5px] text-muted truncate", n.names.join(" · ")));
    if (n.meta) titles.appendChild(el("div", "text-[11px] text-meta truncate", n.meta));
    head.appendChild(titles);

    const ops = el("div", "flex flex-wrap gap-[6px] items-center justify-end row-gap-1");
    // 已排场次状态(来自唯一数据源的 picks)——「未排场」= 选了片但还没在时间轴上落场
    ops.appendChild(
      rec.picks.length
        ? el(
            "span",
            "text-[11px] font-bold text-on-brand bg-biff rounded-full px-2 py-px whitespace-nowrap",
            `已排 ${rec.picks.length} 场`
          )
        : el(
            "span",
            "text-[11px] font-bold text-tight border border-dashed border-tight rounded-full px-2 py-px whitespace-nowrap",
            "未排场"
          )
    );
    ops.appendChild(
      el(
        "span",
        "text-[11px] font-bold text-ink border border-line bg-card rounded-full px-2 py-px whitespace-nowrap",
        n.shows.length ? `可选 ${n.shows.length} 场` : "暂无排期"
      )
    );
    // 定位下放到场次行(逐场一个按钮):head 不再放"整片级"定位,避免"点了不知道跳哪场"
    const detail = el(
      "button",
      "border rounded-[6px] px-[10px] py-1 text-[12px] font-bold bg-card text-ink border-line hover:opacity-90",
      "资料 ⓘ"
    );
    detail.addEventListener("click", () => ctx.onFilm(n.shows[0]?.code ?? n.cats[0]?.id ?? ""));
    ops.appendChild(detail);
    const un = el(
      "button",
      "border rounded-[6px] px-[10px] py-1 text-[12px] font-bold bg-card text-muted border-line hover:text-ink hover:opacity-90",
      rec.picks.length ? `✕ 整片移除(${rec.picks.length} 场)` : "✕ 取消选片"
    );
    un.title = rec.picks.length
      ? `从选片清单移除该片,连同已排的 ${rec.picks.length} 场一起删掉(「我的行程」里也会消失)`
      : "从「我的选片」移除(该片没有已排场次)";
    un.addEventListener("click", () => {
      if (rec.picks.length && !window.confirm(`《${n.zh}》已排 ${rec.picks.length} 场,确定整片移除(含这些场次)?`)) return;
      removePick(n.key);
      render();
    });
    ops.appendChild(un);
    head.appendChild(ops);
    item.appendChild(head);

    // 场次摘要:只列**已排**场次(rec.picks)—— 这是「我的行程」在这部片上的投影。
    // 还没排场的片在这里给出下一步(去影片库 / 时间轴挑),不再把「可选但没选」的场次混进来。
    if (rec.picks.length) {
      const showByCode = new Map(n.shows.map((s) => [s.code, s]));
      const rows = el("div", "border-t border-line-faint");
      rec.picks.forEach((pk, idx) => {
        // 行本身可点(与「影片库」场次行同款交互);按钮点击冒泡到行 → 同一个定位出口
        const row = el(
          "div",
          `grid grid-cols-[minmax(0,1fr)_auto] gap-[8px] items-center px-3 py-[6px] text-[12px] text-muted cursor-pointer hover:bg-hover${
            idx > 0 ? " border-t border-line-faint" : ""
          }`
        );
        row.dataset.libRow = "1";
        row.dataset.code = pk.code;
        const left = el("div", "flex items-center gap-[8px] min-w-0");
        left.append(
          el("span", "font-extrabold text-[10.5px] text-on-brand bg-ink rounded px-1 py-px shrink-0", pk.code),
          // 方案章:选片总览跨 A/B 展示,标明这场落在哪个方案(行程页只显示当前方案)
          el(
            "span",
            "text-[10.5px] font-extrabold text-biff border border-[color-mix(in_srgb,var(--color-biff)_40%,var(--color-card))] bg-card rounded-full px-[7px] shrink-0",
            pk.group
          )
        );
        const s = showByCode.get(pk.code);
        if (s) {
          const { label, weekday } = dateInfo(s.date);
          left.append(
            el("span", "tabular-nums whitespace-nowrap shrink-0", `${label} ${weekday} ${fmtMinRange(s.start_time, s.end_time)}`),
            el("span", "truncate", venueLabelOf(ctx, s))
          );
        } else {
          left.appendChild(el("span", "text-tight truncate", "该场已不在当前排期里(数据换版)"));
        }
        const go = el(
          "button",
          "border-0 rounded-[6px] px-[9px] py-[3px] text-[11.5px] font-bold text-on-brand bg-[linear-gradient(135deg,var(--biff-red)_0%,var(--biff-red-2)_100%)] hover:brightness-[1.05] whitespace-nowrap",
          "定位 ▸"
        );
        go.dataset.tip = "跳到该场在时间轴上的位置";
        row.append(left, go);
        rows.appendChild(row);
      });
      item.appendChild(rows);
    } else if (n.shows.length) {
      item.appendChild(
        el(
          "div",
          "px-3 py-[7px] text-[11.5px] text-muted border-t border-line-faint",
          `还没排场 — 这部片有 ${n.shows.length} 场可选,去「影片库」或时间轴点选场次,选完这里就会出现(选片意向已保留)`
        )
      );
    }
    return item;
  }

  // 场次行定位(逐场):委托在 list 上挂一次,render() 重建行无需重绑
  list.addEventListener("click", (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>("[data-lib-row]");
    if (row?.dataset.code) ctx.onLocate(row.dataset.code);
  });

  chipsBar.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-pri]");
    if (!b) return;
    const k = b.dataset.pri!;
    const next: Priority | typeof UNSET | null = k === "" ? null : k === UNSET ? UNSET : (k as Priority);
    filter = filter === next ? null : next;
    render();
  });

  // 返回本层时刷新清单(详情里加/减场次 → 「已排 N 场」要跟上);弹层栈保留 DOM,滚动位置不丢
  openModal("我的选片", body, true, () => render());
  render();
}