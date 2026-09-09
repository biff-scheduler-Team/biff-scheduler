// 影片库 — 全部影片浏览 + 单元筛选 chips + 搜索 → 反向定位 / 详情豆瓣。
// 全量化:列表 / 行 / 头部 / chip / pill / 场次行 / 智能排片弹层 全部 Tailwind utility。
// 16-B 单元 chip / 评分章 / wish 三选 / 智能排片结果 同源。

import type { Catalog, FilmItem, Group, Mapping, PlanEntry, Priority, Screening } from "./types";
import { dateInfo, el } from "./util";
import { codeTip } from "./badges";
import { appendMetaRow } from "./legend";
import { filmKey, openModal } from "./modal";
import { replaceGroup, setCurrentGroup, setWish, store, wish } from "./state";
import { suggestPlans, type EnginePick, type EnginePlan } from "./engine";

export interface LibraryCtx {
  cat: Catalog;
  plan: Map<string, PlanEntry>;
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

/** M2.5 wish 三选顺序(与行程优先级同语义) */
const WISH_ORDER: [Priority, string][] = [
  ["must", "必看"],
  ["maybe", "备选"],
  ["wild", "随缘"],
];

const PRI_LABEL: Record<Priority, string> = { must: "必看", maybe: "备选", wild: "随缘" };
/** seg/wish on 态完整字面量(Tailwind v4 只生成源码完整出现的类,勿改回动态拼接) */
const PRI_BG_ON: Record<Priority, string> = {
  must: "bg-must text-on-brand",
  maybe: "bg-maybe text-on-brand",
  wild: "bg-wild text-on-brand",
};

/** 单元 chip 类名(idle / 选中 — 背景/边框色 走 IDLE/ON 各自完整串,避免同类叠加) */
const CHIP_UNIT_BASE =
  "border rounded-full px-[10px] py-[3px] text-[12px] font-semibold whitespace-nowrap hover:border-biff";
const CHIP_UNIT_IDLE = `${CHIP_UNIT_BASE} border-line bg-card text-muted hover:text-ink`;
const CHIP_UNIT_ON = `${CHIP_UNIT_BASE} border-ink bg-ink text-on-brand`;

export function openLibrary(ctx: LibraryCtx): void {
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
    const key = cat ? `cat:${cat.id}` : `sched:${filmKey(s)}`;
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

  openModal("影片库 · 全部影片", body, true);
  if (window.matchMedia("(pointer: fine)").matches) search.focus();

  // ---- 渲染 ----
  const expanded = new Set<string>();
  let kw = "";
  let unit: string | null = null;

  function render(): void {
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
        const rc = el(
          "span",
          "inline-block text-[11px] font-bold text-muted border border-line bg-card rounded px-[6px] leading-[1.7] select-none whitespace-nowrap",
          `豆 ${cat0.rating}`
        );
        rc.dataset.tip = "豆瓣用户评分(满分 10 分)"; // 缩写说明:豆 = 豆瓣评分
        zhTop.appendChild(rc);
      }
      titles.appendChild(zhTop);
      if (n.names.length) titles.appendChild(el("div", "text-[11.5px] text-muted truncate", n.names.join(" · ")));
      if (n.meta) titles.appendChild(el("div", "text-[11px] text-meta truncate", n.meta));
      head.appendChild(titles);

      const ops = el("div", "flex flex-wrap gap-[6px] items-center justify-end row-gap-1");
      // M2.5:行内想看三选(必看/备选/随缘);再点同档取消
      const curWish = wish.get(n.key);
      const wishSeg = el("div", "inline-flex border border-line rounded-full overflow-hidden bg-card");
      WISH_ORDER.forEach(([p, label], i) => {
        const on = curWish === p;
        const stateCls = on ? PRI_BG_ON[p] : "bg-card text-muted hover:text-ink";
        const sepCls = i > 0 ? " border-l border-line" : "";
        const b = el(
          "button",
          `border-0 px-2 py-[2px] text-[11px] font-semibold transition-[background,color] duration-[120ms] ${stateCls}${sepCls}`,
          label
        );
        b.dataset.wish = n.key;
        b.dataset.pri = p;
        b.title = `标为「${label}」— 供「智能排片」生成行程(再点取消)`;
        wishSeg.appendChild(b);
      });
      ops.appendChild(wishSeg);
      if (n.shows.length) {
        ops.appendChild(el("span", "text-[11px] font-bold text-ink border border-line bg-card rounded-full px-2 py-px whitespace-nowrap", `${n.shows.length} 场`));
        const pick = n.shows.reduce(
          (m, s) => m + (ctx.plan.get(s.code)?.group === ctx.group ? 1 : 0),
          0
        );
        if (pick > 0) ops.appendChild(el("span", "text-[11px] font-bold text-on-brand bg-must rounded-full px-2 py-px whitespace-nowrap", `${ctx.group} 已选 ${pick}`));
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
            when.appendChild(el("span", "", `${label} ${weekday} ${s.start_time}–${s.end_time}`));
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
              "px-[14px] py-[10px] text-[12px] text-muted border-t border-dashed border-line",
              "官方排期未发布 — 可先用行右侧「详情 ⓘ」关联豆瓣条目;Catalogue 排期公布并引入后,这里会自动出现可定位的场次"
            )
          );
        }
        item.appendChild(shows);
      }
      list.appendChild(item);
    }
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
    // M2.5:行内 wish 三选(拦截,避免触发整行展开)
    const wishBtn = target.closest<HTMLElement>("[data-wish]");
    if (wishBtn) {
      const k = wishBtn.dataset.wish!;
      const p = wishBtn.dataset.pri as Priority;
      setWish(k, wish.get(k) === p ? null : p);
      render();
      return;
    }
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
  aiBtn.addEventListener("click", openEngine);

  function openEngine(): void {
    const wanted = filmList
      .filter((n) => wish.has(n.key))
      .map((n) => ({
        key: n.key,
        zh: n.zh,
        priority: wish.get(n.key)!,
        rating: n.cats[0]?.rating ?? null,
        shows: n.shows,
      }));
    const box = el("div", "grid gap-3");
    if (wanted.length === 0) {
      box.appendChild(
        el(
          "div",
          "text-[13px] text-muted py-[10px] px-[2px] leading-[1.7]",
          "还没有给任何影片打标 — 在片名行右侧点「必看 / 备选 / 随缘」;打标后再点「智能排片」即可生成建议行程。"
        )
      );
      openModal("智能排片 · AI 建议行程", box);
      return;
    }
    const transitMin = store.settings.transitMin;
    const plans = suggestPlans({ films: wanted, transitMin });
    box.appendChild(
      el(
        "div",
        "text-[12.5px] text-muted",
        `基于 ${wanted.length} 部已打标影片:同一天不重叠 + 跨馆缓冲 ${transitMin}min;必看尽量全覆盖(冲突时给牺牲说明),备选按评分/GV 权重填空,随缘不进自动单。`
      )
    );
    const list = el("div", "grid gap-3");
    for (const plan of plans) list.appendChild(enginePlanBox(plan));
    box.appendChild(list);
    openModal("智能排片 · 建议行程", box, true);
  }

  function enginePlanBox(plan: EnginePlan): HTMLElement {
    const s = plan.stats;
    const box = el("div", "border border-line rounded-[10px] px-3 py-[10px] bg-card");
    const head = el("div", "flex items-center gap-[10px] flex-wrap mb-[6px]");
    const badgeCls =
      plan.name === "A"
        ? "text-[12px] font-extrabold text-on-brand rounded-[5px] px-2 py-[2px] bg-biff"
        : "text-[12px] font-extrabold text-on-brand rounded-[5px] px-2 py-[2px] bg-ink";
    head.appendChild(el("span", badgeCls, `${plan.name} 方案`));
    // P0-2:评分徽章(must×3/maybe×2 + GV+1 − 紧转场×1;hover 看分项)
    if (plan.score) {
      const p = plan.score.parts;
      const chip = el(
        "span",
        "inline-flex items-center border border-line rounded-full bg-card py-px px-[9px] text-[12px] font-extrabold tabular-nums text-ink whitespace-nowrap cursor-default hover:border-biff hover:text-biff",
        `评分 ${plan.score.total}`
      );
      chip.title =
        `必看 ${p.must.in}/${p.must.total}(+${p.must.pts}) · 备选 ${p.maybe.in}/${p.maybe.total}(+${p.maybe.pts})` +
        (p.wild.total ? ` · 随缘 ${p.wild.in}/${p.wild.total}(+${p.wild.pts})` : "") +
        (p.gv.total ? ` · GV ${p.gv.in}/${p.gv.total}(+${p.gv.pts})` : "") +
        (p.tight.count ? ` · 紧转场 ${p.tight.count}(${p.tight.pts})` : "") +
        ` = ${plan.score.total}`;
      head.appendChild(chip);
    }
    head.appendChild(
      el(
        "span",
        "text-[12px] text-muted flex-1 min-w-0",
        `必看 ${s.mustIn}/${s.must} · 备选 ${s.maybeIn}/${s.maybe}${s.wild ? ` · 随缘 ${s.wild}(不自动排)` : ""}`
      )
    );
    const adopt = el(
      "button",
      "border-0 rounded-[6px] px-[10px] py-1 text-[12px] font-bold text-on-brand bg-[linear-gradient(135deg,var(--biff-red)_0%,var(--biff-red-2)_100%)] hover:brightness-[1.05]",
      `采纳为 ${plan.name} 方案`
    );
    adopt.addEventListener("click", () => adoptPlan(plan, adopt));
    head.appendChild(adopt);
    box.appendChild(head);

    if (plan.picks.length === 0) box.appendChild(el("div", "text-[12.5px] text-muted py-[6px] px-[2px]", "该方案无可用场次(见下方未纳入原因)"));
    const rows = el("div", "grid gap-px max-h-[300px] overflow-y-auto");
    for (const p of plan.picks) rows.appendChild(enginePickRow(p));
    box.appendChild(rows);

    if (plan.unscheduled.length) {
      const drop = el("div", "mt-[6px] border-t border-dashed border-line pt-2 grid gap-[3px]");
      drop.appendChild(el("div", "text-[11px] font-bold text-muted", "未纳入与原因"));
      for (const d of plan.unscheduled) {
        const line = el("div", "text-[12px] flex gap-[6px] items-baseline text-muted");
        line.append(
          el("span", `text-[10.5px] font-extrabold ${d.priority === "must" ? "text-must" : d.priority === "maybe" ? "text-maybe" : "text-wild"}`, PRI_LABEL[d.priority]),
          el("span", "", `${d.zh} — ${d.reason}`)
        );
        drop.appendChild(line);
      }
      box.appendChild(drop);
    }
    return box;
  }

  function enginePickRow(p: EnginePick): HTMLElement {
    const row = el("div", "flex gap-2 items-center border-b border-dashed border-line-faint py-[5px] px-[2px]");
    const { label, weekday } = dateInfo(p.show.date);
    const main = el("div", "min-w-0");
    const t = el("div", "flex items-center gap-2 text-[13px] font-semibold flex-wrap");
    t.append(
      el("span", "font-extrabold text-[10.5px] text-on-brand bg-ink rounded px-1 py-px", p.show.code),
      el("span", "", p.zh),
      el("span", `text-[10.5px] font-extrabold ${p.priority === "must" ? "text-must" : p.priority === "maybe" ? "text-maybe" : "text-wild"}`, PRI_LABEL[p.priority])
    );
    main.appendChild(t);
    main.appendChild(
      el("div", "text-[11.5px] text-muted", `${label} ${weekday} ${p.show.start_time}–${p.show.end_time} · ${p.show.venue_display}`)
    );
    row.appendChild(main);
    return row;
  }

  function adoptPlan(plan: EnginePlan, btn: HTMLButtonElement): void {
    const g = plan.name as Group;
    const existing = [...store.plan.values()].filter((e) => e.group === g).length;
    if (existing > 0 && !window.confirm(`将覆盖 ${g} 方案现有 ${existing} 场(建议 ${plan.picks.length} 场),继续?`)) return;
    replaceGroup(g, plan.picks.map((p) => ({ code: p.code, priority: p.priority })));
    if (store.group !== g) setCurrentGroup(g);
    btn.textContent = `✓ 已采纳为 ${g} 方案`;
    btn.disabled = true;
  }

  render();
}