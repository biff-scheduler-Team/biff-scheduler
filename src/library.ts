// 影片库 — 全部影片浏览 + 单元筛选 chips + 搜索 → 反向定位 / 详情豆瓣。
// 全量化:列表 / 行 / 头部 / chip / pill / 场次行 / 智能排片弹层 全部 Tailwind utility。
// 16-B 单元 chip / 评分章 / 选片三选 / 智能排片结果 同源 —— 都读写 store.picks(唯一数据源)。

import type { Catalog, FilmItem, Group, Mapping, PickEntry, Priority, Screening } from "./types";
import { dateInfo, el, filmNodeKey, fmtMinRange } from "./util";
import { codeTip } from "./badges";
import { appendMetaRow, doubanChip } from "./legend";
import { openModal } from "./modal";
import { PRI_BG_ON, PRI_LABEL, WISH_ORDER, buildWishSeg, priTag } from "./pick";
import { removePick, replaceGroup, setCurrentGroup, setWish, store } from "./state";
import {
  DROP_LABEL,
  suggestPlans,
  type EngineDrop,
  type EngineFilm,
  type EnginePick,
  type EnginePlan,
} from "./engine";

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
  const tool = el("div", "flex gap-2 items-center");
  const search = el(
    "input",
    "border border-line rounded-[8px] px-3 py-[9px] text-[14px] w-full focus:[outline:2px_solid_color-mix(in_srgb,var(--color-biff)_25%,var(--color-card))] focus:border-biff"
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
  aiBtn.title = "M2.5:按影片已标「必看/备选/随缘」本地求解生成建议行程(零联网、可解释)";
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
          "详情 ⓘ"
        );
        detail.dataset.libDetail = n.shows[0].code;
        ops.appendChild(detail);
      } else {
        ops.appendChild(el("span", "text-[11px] font-bold text-muted font-semibold border border-line bg-card rounded-full px-2 py-px whitespace-nowrap", "暂无排期"));
        // 目录片无排期也可先关联豆瓣(详情 ⓘ → 目录片弹层,code=f###)
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
            "详情 ⓘ"
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
              ? "grid grid-cols-[176px_minmax(0,1fr)_auto] gap-[10px] items-center px-3 py-[7px] cursor-pointer hover:bg-hover border-t border-line-faint max-[720px]:grid-cols-[minmax(0,1fr)_auto]"
              : "grid grid-cols-[176px_minmax(0,1fr)_auto] gap-[10px] items-center px-3 py-[7px] cursor-pointer hover:bg-hover max-[720px]:grid-cols-[minmax(0,1fr)_auto]";
            const row = el("div", rowCls);
            row.dataset.libRow = "1";
            row.dataset.code = s.code;
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
            const where = el(
              "div",
              "text-[12px] text-muted min-w-0 flex gap-[6px] items-center truncate max-[720px]:col-span-full max-[720px]:row-start-2",
              `${s.venue_display} · ${s.duration_min}min`
            );
            appendMetaRow(where, s); // 16-F:GV + 特性 + 等级/字幕/页码 徽章(hover 即示义)
            const go = el(
              "button",
              "border-0 rounded-[6px] px-[10px] py-1 text-[12px] font-bold text-on-brand bg-[linear-gradient(135deg,var(--biff-red)_0%,var(--biff-red-2)_100%)] hover:brightness-[1.05] max-[720px]:col-start-2 max-[720px]:row-start-1",
              "定位 ▸"
            );
            go.dataset.tip = "跳到该影厅时间轴位置";
            row.append(when, where, go);
            shows.appendChild(row);
          });
        } else {
          shows.appendChild(
            el(
              "div",
              "px-[14px] py-[10px] text-[12px] text-muted border-t border-line-faint",
              "官方排期未发布 — 可先用行右侧「详情 ⓘ」关联豆瓣条目;Catalogue 排期公布并引入后,这里会自动出现可定位的场次"
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
    const detailBtn = target.closest<HTMLElement>("[data-lib-detail]");
    if (detailBtn) {
      ctx.onFilm(detailBtn.dataset.libDetail!);
      return;
    }
    const row = target.closest<HTMLElement>("[data-lib-row]");
    if (row) {
      ctx.onLocate(row.dataset.code!);
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

  /* ---- M2.5:智能排片 ▸(AI 按钮 → 引擎建议 → 一键采纳) ---- */
  aiBtn.addEventListener("click", () => openEngineDialog(filmList, ctx, render));

  render();
}

/* ---- M2.5:智能排片弹层 —— 「影片库」与「我的选片」共用入口(同源 picks,避免两处各写一份) ----
 *  2026-09-10 视觉重排(降噪):
 *   · 顶部只留一行短标签 + `i` 悬停看完整规则,不再铺一段小字长句;
 *   · A / B 改分段控件 + **共用一张卡** —— 原先是两张各自完整的卡,「未纳入原因」在 A、B 各印一遍,
 *     这正是「多条重复文案占满视觉空间」的根因,合并后天然消失;
 *   · 卡内按日期分组(组头 `10/8 周四` 只出现一次);行内「时间」深色半加粗、「影院」降为第二行次级灰;
 *   · 分隔靠留白 + hover 底色,不再用虚线把每一行切成一格;
 *   · 未纳入按 (kind, reason) 合并同类项,每组一张浅色 Card(浅灰 = 等排期,浅红 = 需取舍)。
 *  onReturn:返回上一层(影片库 / 我的选片)时刷新其列表 —— 采纳方案后「已选 N 场」计数要跟上。 */
function openEngineDialog(filmList: FilmNode[], ctx: LibraryCtx, onReturn?: () => void): void {
  // 只有「已定档」的片进引擎:未设档位(只点了场次)无法参与质量分,与 SCORE_W 口径一致
  const wanted: EngineFilm[] = [];
  for (const n of filmList) {
    const p = ctx.picks.get(n.key)?.priority;
    if (!p) continue;
    wanted.push({
      key: n.key,
      zh: n.zh,
      priority: p,
      rating: n.cats[0]?.rating ?? null,
      shows: n.shows,
    });
  }
  const box = el("div", "grid gap-3");
  if (wanted.length === 0) {
    box.appendChild(
      el(
        "div",
        "text-[13px] text-muted py-[10px] px-[2px] leading-[1.7]",
        "还没有给任何影片打标 — 在片名行右侧点「必看 / 备选 / 随缘」;打标后再点「智能排片」即可生成建议行程。"
      )
    );
    openModal("智能排片 · AI 建议行程", box, false, onReturn);
    return;
  }
  const transitMin = store.settings.transitMin;
  const plans = suggestPlans({ films: wanted, transitMin });
  box.appendChild(engineRuleBar(wanted.length, transitMin));
  if (plans.length === 0) {
    box.appendChild(el("div", "text-[12.5px] text-muted py-[6px] px-[2px]", "没有可排的场次。"));
  } else {
    box.appendChild(enginePlansPanel(plans, ctx));
  }
  openModal("智能排片 · 建议行程", box, true, onReturn);
}

/** 顶部规则区:一行短标签 + `i` 悬停看完整规则(替代原来 12.5px 未分段的整句) */
function engineRuleBar(n: number, transitMin: number): HTMLElement {
  const bar = el("div", "flex items-center gap-[6px] flex-wrap");
  bar.appendChild(el("span", "text-[12.5px] font-semibold text-ink-2 mr-[2px]", `基于 ${n} 部已打标影片`));
  const chip = (t: string): HTMLElement =>
    el(
      "span",
      "inline-flex items-center rounded-full border border-line-faint bg-hover px-[8px] py-px text-[11px] text-ink-2 whitespace-nowrap",
      t
    );
  bar.appendChild(chip(transitMin > 0 ? `跨馆缓冲 ${transitMin}min` : "跨馆无缓冲"));
  bar.appendChild(chip("必看优先覆盖"));
  bar.appendChild(chip("随缘不自动排"));
  const info = el(
    "button",
    "shrink-0 border border-line rounded-full w-[17px] h-[17px] p-0 text-[10px] font-bold leading-none text-muted bg-card hover:text-ink hover:border-line-strong",
    "i"
  );
  info.dataset.tip = [
    "智能排片规则",
    "同一天不重叠 — 两场时间相撞时只保留其一",
    transitMin > 0
      ? `跨馆缓冲 ${transitMin}min — 换影院时额外预留的转场时间`
      : "跨馆缓冲 0min — 当前不留转场余量,换影院直接接场(可在「设置」里调)",
    "必看优先 — 尽量全覆盖,实在排不下时给出牺牲说明",
    "备选填空 — 按豆瓣评分 / GV 权重排序补空档",
    "随缘不排 — 需手动加入行程",
    "评分只是排序参考 — 不是「好片指数」",
  ].join("\n");
  bar.appendChild(info);
  return bar;
}

/** A / B 分段控件 + 单张方案卡:切换只重绘卡体 —— 两个方案共用一处「未纳入原因」,不再各印一遍 */
function enginePlansPanel(plans: EnginePlan[], ctx: LibraryCtx): HTMLElement {
  const panel = el("div", "grid gap-[10px]");
  const seg = el("div", "inline-flex border border-line rounded-full overflow-hidden bg-card justify-self-start");
  const body = el("div", "");
  const adopted = new Set<string>(); // 已采纳过的方案名(切回来仍显示 ✓,不会重复可点)
  let cur = 0;

  const render = (): void => {
    seg.replaceChildren();
    plans.forEach((plan, i) => {
      const on = i === cur;
      const b = el(
        "button",
        "border-0 px-[14px] py-[4px] text-[12px] font-bold transition-[background,color] duration-[120ms] ease-in-out " +
          (on ? "bg-biff text-on-brand" : "bg-card text-muted hover:text-ink") +
          (i > 0 ? " border-l border-line" : ""),
        `${plan.name} 方案`
      );
      b.title = `查看 ${plan.name} 方案(${plan.picks.length} 场)`;
      b.addEventListener("click", () => {
        if (cur === i) return;
        cur = i;
        render();
      });
      seg.appendChild(b);
    });
    body.replaceChildren(enginePlanBox(plans[cur], ctx, adopted, render));
  };

  panel.append(seg, body);
  render();
  return panel;
}

function enginePlanBox(
  plan: EnginePlan,
  ctx: LibraryCtx,
  adopted: Set<string>,
  refresh: () => void
): HTMLElement {
  const s = plan.stats;
  // 极浅实线描边(替代原来的灰实框 + 行间虚线):靠留白与 hover 底色分组,不把每行切成一格
  const box = el("div", "border border-line-faint rounded-[12px] bg-card overflow-hidden");

  /* 头:统计 + 评分 + 采纳(方案名已由上方分段控件表达,这里不重复占位) */
  const head = el("div", "flex items-center gap-[10px] flex-wrap px-3 py-[10px] bg-hover");
  head.appendChild(
    el(
      "div",
      "text-[12px] text-ink-2 flex-1 min-w-0",
      `必看 ${s.mustIn}/${s.must} · 备选 ${s.maybeIn}/${s.maybe}${s.wild ? ` · 随缘 ${s.wild}(不自动排)` : ""}`
    )
  );
  if (plan.score) {
    const p = plan.score.parts;
    const chip = el(
      "span",
      "inline-flex items-center border border-line rounded-full bg-card py-px px-[9px] text-[12px] font-extrabold tabular-nums text-ink whitespace-nowrap cursor-help hover:border-biff hover:text-biff",
      `评分 ${plan.score.total}`
    );
    const lines = [
      `评分 ${plan.score.total}`,
      `必看 ${p.must.in}/${p.must.total} — +${p.must.pts}`,
      `备选 ${p.maybe.in}/${p.maybe.total} — +${p.maybe.pts}`,
    ];
    if (p.wild.total) lines.push(`随缘 ${p.wild.in}/${p.wild.total} — +${p.wild.pts}`);
    if (p.gv.total) lines.push(`GV ${p.gv.in}/${p.gv.total} — +${p.gv.pts}`);
    if (p.tight.count) lines.push(`紧转场 ${p.tight.count} — ${p.tight.pts}`);
    lines.push("档位权重 — 必看×3 / 备选×2 / 随缘×1");
    chip.dataset.tip = lines.join("\n");
    head.appendChild(chip);
  }
  const done = adopted.has(plan.name);
  const adopt = el(
    "button",
    "border-0 rounded-[7px] px-[12px] py-[5px] text-[12px] font-bold whitespace-nowrap " +
      (done
        ? "text-muted bg-raised cursor-default"
        : "text-on-brand bg-[linear-gradient(135deg,var(--biff-red)_0%,var(--biff-red-2)_100%)] hover:brightness-[1.05]"),
    done ? `✓ 已采纳为 ${plan.name} 方案` : `采纳为 ${plan.name} 方案`
  );
  if (done) adopt.disabled = true;
  else adopt.addEventListener("click", () => adoptPlan(plan, ctx, adopted, refresh));
  head.appendChild(adopt);
  box.appendChild(head);

  /* 主体:按日期分组 —— 组头只出现一次,行内不再重复日期 */
  const list = el("div", "px-2 py-1 max-h-[320px] overflow-y-auto");
  if (plan.picks.length === 0) {
    list.appendChild(el("div", "text-[12.5px] text-muted py-[10px] px-2", "该方案无可用场次(见下方未纳入原因)"));
  }
  for (const [date, picks] of groupByDate(plan.picks)) {
    const { label, weekday } = dateInfo(date);
    list.appendChild(el("div", "text-[11px] font-bold text-meta pt-[9px] pb-[2px] px-2", `${label} ${weekday}`));
    for (const p of picks) list.appendChild(enginePickRow(p, ctx));
  }
  box.appendChild(list);

  const drops = engineDropSection(plan.unscheduled);
  if (drops) box.appendChild(drops);
  return box;
}

/** 按日期切段(plan.picks 已按 日期 → 开始时间 排序,相邻归并即可) */
function groupByDate(picks: EnginePick[]): [string, EnginePick[]][] {
  const out: [string, EnginePick[]][] = [];
  for (const p of picks) {
    const last = out[out.length - 1];
    if (last && last[0] === p.show.date) last[1].push(p);
    else out.push([p.show.date, [p]]);
  }
  return out;
}

/** 未纳入与原因 —— 同因合并成一张浅色 Card(浅灰 = 等排期,浅红 = 需取舍),不再一条一行地刷屏 */
function engineDropSection(drops: EngineDrop[]): HTMLElement | null {
  if (!drops.length) return null;
  const wrap = el("div", "border-t border-line-faint px-3 py-[10px] grid gap-[8px]");
  wrap.appendChild(el("div", "text-[11px] font-bold text-meta", `未纳入 ${drops.length} 部`));

  const groups = new Map<string, EngineDrop[]>();
  for (const d of drops) {
    const k = `${d.kind}\u0000${d.reason}`; // kind + reason 同时相同才合并
    const arr = groups.get(k);
    if (arr) arr.push(d);
    else groups.set(k, [d]);
  }
  for (const arr of groups.values()) {
    const soft = arr[0].kind === "noshow"; // 等官方排期 = 中性信息;其余 = 需要取舍
    const card = el("div", `rounded-[8px] px-3 py-[9px] grid gap-[7px] ${soft ? "bg-hover" : "bg-biff-soft"}`);
    const labelCls = soft ? "text-meta" : "text-biff";
    const head = el("div", "flex items-baseline gap-[7px] flex-wrap");
    head.append(
      el("span", `text-[11px] font-extrabold whitespace-nowrap ${labelCls}`, DROP_LABEL[arr[0].kind]),
      el("span", `text-[11px] font-bold whitespace-nowrap ${labelCls}`, `${arr.length} 部`),
      el("span", "text-[11.5px] text-ink-2 min-w-0", arr[0].reason)
    );
    card.appendChild(head);
    const chips = el("div", "flex flex-wrap gap-[6px]");
    for (const d of arr) {
      const c = el(
        "span",
        "inline-flex items-center gap-[5px] min-w-0 max-w-full rounded-[6px] bg-card border border-line-faint px-[7px] py-[3px]"
      );
      c.append(priTag(d.priority), el("span", "text-[12px] text-ink truncate", d.zh));
      chips.appendChild(c);
    }
    card.appendChild(chips);
    wrap.appendChild(card);
  }
  return wrap;
}

/** 一场建议:左列「时间」深色半加粗(扫日程用),右列片名 + 档位 Tag + code / 影院(次级灰,第二行)。
 *  整行可点 → 跳到该场在时间轴上的位置(与影片库场次行同一个出口)。 */
function enginePickRow(p: EnginePick, ctx: LibraryCtx): HTMLElement {
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
  main.append(top, el("div", "text-[11.5px] text-meta truncate", p.show.venue_display));
  row.appendChild(main);
  row.addEventListener("click", () => ctx.onLocate(p.code));
  return row;
}

function adoptPlan(plan: EnginePlan, ctx: LibraryCtx, adopted: Set<string>, refresh: () => void): void {
  const g = plan.name as Group;
  const existing = [...ctx.slots.values()].filter((s) => s.group === g).length;
  if (existing > 0 && !window.confirm(`将覆盖 ${g} 方案现有 ${existing} 场(建议 ${plan.picks.length} 场),继续?`)) return;
  replaceGroup(
    g,
    plan.picks.map((p) => ({ key: p.filmKey, code: p.code, priority: p.priority }))
  );
  if (store.group !== g) setCurrentGroup(g);
  adopted.add(plan.name);
  refresh();
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
  aiBtn.title = "按已定档「必看/备选/随缘」本地求解生成建议行程(零联网、可解释)";
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
      "详情 ⓘ"
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
            el("span", "truncate", s.venue_display)
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