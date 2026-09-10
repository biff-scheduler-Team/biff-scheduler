// 弹层:通用容器 + 影片详情(含同片场次 / 豆瓣映射管理)。
// 全量化:overlay / modal / 详情弹层结构 全部 Tailwind utility。

import type { Catalog, Group, Mapping, Screening } from "./types";
import { dateInfo, el, filmNodeKey, fmtMinRange } from "./util";
import { appendMetaRow, doubanChip } from "./legend";
import { api } from "./api";
import { setWish, store } from "./state";
import { buildWishSeg } from "./pick";

/* ---------- 通用容器 ---------- */
let dismissCurrent: (() => void) | undefined;

export function openModal(title: string, body: HTMLElement, wide = false): void {
  const root = document.getElementById("modal-root");
  if (!root) return;
  root.innerHTML = "";
  const overlay = el(
    "div",
    "fixed inset-0 z-[100] bg-[var(--overlay-bg)] flex items-start justify-center px-4 py-12 overflow-y-auto"
  );
  const boxCls = wide
    ? "bg-card rounded-[12px] shadow-[var(--shadow-modal)] w-[640px] max-w-full p-[18px]"
    : "bg-card rounded-[12px] shadow-[var(--shadow-modal)] w-[520px] max-w-full p-[18px]";
  const box = el("div", boxCls);
  const head = el("div", "flex items-center justify-between mb-3");
  head.appendChild(el("h3", "m-0 text-[16px]", title));
  const close = el(
    "button",
    "border-0 bg-raised w-[26px] h-[26px] rounded-[7px] text-[13px] text-ink hover:bg-raised-hover",
    "✕"
  );
  head.appendChild(close);
  box.append(head, body);
  overlay.appendChild(box);
  root.appendChild(overlay);

  const dismiss = (): void => {
    root.innerHTML = "";
    document.removeEventListener("keydown", onKey);
    if (dismissCurrent === dismiss) dismissCurrent = undefined;
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") dismiss();
  };
  dismissCurrent = dismiss;
  close.addEventListener("click", dismiss);
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) dismiss();
  });
  document.addEventListener("keydown", onKey);
}

export function closeModal(): void {
  dismissCurrent?.();
}

/* ---------- 影片详情 ---------- */
interface FilmModalCtx {
  cat: Catalog;
  /** 已选场次投影:code → { 影片 key, 方案 } */
  slots: Map<string, { key: string; group: Group }>;
  group: string;
  mappings: Map<string, Mapping>;
  /** 加入/移出当前方案(按影片 key + 场次 code;档位是影片级的,新记录档位未设) */
  toggle: (key: string, code: string) => void;
}

/** 同片判定 key:中文/英文名任一同则视为同片 */
export function filmKey(s: Screening): string {
  return (s.title_zh || s.title_en).toLowerCase().trim();
}

/** 「我的选片」档位行(详情弹层内直接改档位)—— key 走 filmNodeKey 单一口径,与影片库/甘特色点同源。
 *  档位是影片级的:这里改 = 「我的选片」与「我的行程」里该片所有场次同步。 */
function buildWishRow(key: string): HTMLElement {
  const row = el("div", "flex items-center gap-[10px] flex-wrap mb-[14px] border-t border-line pt-3");
  row.appendChild(el("span", "text-[13px] font-bold whitespace-nowrap", "我的选片"));
  const slot = el("div", "inline-flex");
  const hint = el("span", "text-[12px] text-muted");
  const draw = (): void => {
    slot.innerHTML = "";
    slot.appendChild(
      buildWishSeg({
        cur: store.picks.get(key)?.priority ?? undefined,
        onPick: (p) => {
          setWish(key, p);
          draw(); // 弹层不在 renderAll 重建范围内 → 就地重画 seg 反映当前档
        },
        size: "md",
        tipPrefix: "我的选片 · ",
      })
    );
    const n = store.picks.get(key)?.picks.length ?? 0;
    hint.textContent = n
      ? `已选 ${n} 场 · 档位为影片级,改这里全片同步;场次增删在网格 / 行程`
      : "打标后可在顶栏「我的选片」总览;甘特图对应场次标题前显示档位色点";
  };
  draw();
  row.append(slot, hint);
  return row;
}

/** 该片全部场次(跨日期/跨影院),按日期时间排序 */
export function siblingCodes(cat: Catalog, code: string): Screening[] {
  const anchor = cat.byCode.get(code);
  if (!anchor) return [];
  const key = filmKey(anchor);
  return cat.schedule.screenings
    .filter((s) => filmKey(s) === key)
    .sort((a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time));
}

/** 目录评分查询(中文名精确 → 原始片名==排期英文名),无则 null */
function ratingOf(cat: Catalog, code: string): number | null {
  const s = cat.byCode.get(code);
  if (!s) return null;
  const hit = cat.films.find((f) => f.title_zh === s.title_zh) ?? cat.films.find((f) => f.title_orig === s.title_en);
  return hit?.rating ?? null;
}

export function showFilmModal(code: string, ctx: FilmModalCtx): void {
  const anchor = ctx.cat.byCode.get(code);
  if (!anchor) return;
  const siblings = siblingCodes(ctx.cat, code);
  const body = el("div", "film-modal");

  // ---- 片名区(16-A:有组评价则显示「豆 x.x」)----
  const meta = el("div", "mb-3");
  const zh = anchor.title_zh || ctx.mappings.get(code)?.title_cn || anchor.title_en;
  meta.appendChild(el("div", "text-[18px] font-bold", zh));
  const enLine = el("div", "text-muted text-[13px]", anchor.title_en);
  if (anchor.title_en !== zh) meta.appendChild(enLine);
  if (anchor.title_kr) meta.appendChild(el("div", "text-muted text-[12.5px]", anchor.title_kr));
  const rating = ratingOf(ctx.cat, code);
  if (rating != null) meta.appendChild(doubanChip(rating, "mt-2")); // 豆瓣章单一来源(legend.ts)
  body.appendChild(meta);

  // ---- 我的选片(打标:必看/备选/随缘)----
  body.appendChild(buildWishRow(filmNodeKey(ctx.cat, anchor)));

  // ---- 同片全部场次 ----
  const list = el("div", "grid gap-[6px] mb-[14px]");
  for (const s of siblings) {
    const { label, weekday } = dateInfo(s.date);
    const entry = ctx.slots.get(s.code);
    const rowCls = s.code === code
      ? "flex items-center justify-between gap-2 border border-biff rounded-[9px] px-[10px] py-2 bg-biff-tint-2"
      : "flex items-center justify-between gap-2 border border-line rounded-[9px] px-[10px] py-2";
    const row = el("div", rowCls);
    row.dataset.code = s.code;

    const when = el("div", "font-semibold tabular-nums", `${label} ${weekday}`);
    const time = el("div", "tabular-nums", fmtMinRange(s.start_time, s.end_time));
    const where = el(
      "div",
      "text-muted text-[12px] inline-flex items-center gap-[5px] min-w-0",
      `${s.venue_display} · ${s.duration_min}min`
    );
    appendMetaRow(where, s); // 16-F:GV + 特性 + 等级/字幕/页码 徽章(hover 即示义)
    const info = el("div", "flex gap-2 items-baseline flex-wrap text-[12.5px]");
    info.append(when, time, where);

    // 主操作按钮:三态(已在 / 在另一组 / 未加),base 样式在 btn-sm 上 + 变体叠加
    const inGroup = entry && entry.group === ctx.group;
    const inOther = entry && !inGroup;
    const variantCls = inGroup || inOther
      ? "border border-line bg-card text-ink hover:opacity-90"
      : "border-0 text-on-brand bg-[linear-gradient(135deg,var(--biff-red)_0%,var(--biff-red-2)_100%)] hover:brightness-[1.05]";
    const act = el(
      "button",
      `border rounded-[6px] px-[10px] py-1 text-[12px] font-bold ${variantCls}`,
      inGroup
        ? "已加入 · 点击移除"
        : inOther
          ? `已在 ${entry!.group} 组 · 改入 ${ctx.group}`
          : `加入 ${ctx.group} 方案`
    );
    act.dataset.toggle = s.code;
    row.append(info, act);
    list.appendChild(row);
  }
  body.appendChild(list);

  // ---- 豆瓣区 ----
  body.appendChild(buildDoubanBlock(code, anchor.title_zh || "", anchor.title_en));

  openModal(`详情 · ${zh}`, body, true);

  // 事件(每行独立绑定,避免全局委托)
  body.querySelectorAll<HTMLElement>("[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = btn.dataset.toggle!;
      const s = ctx.cat.byCode.get(code);
      if (!s) return;
      ctx.toggle(filmNodeKey(ctx.cat, s), code);
    });
  });
}

/** 目录片详情(暂无排期):元信息 + 评分 + 豆瓣区(先关联,Catalogue 排期接入后同片自动带出) */
export function showCatalogFilmModal(
  filmId: string,
  ctx: Pick<FilmModalCtx, "cat" | "mappings">
): void {
  const film = ctx.cat.films.find((f) => f.id === filmId);
  if (!film) return;
  const body = el("div", "film-modal");
  const zh = film.title_zh || film.title_orig || film.id;

  // ---- 片名 / 元信息区 ----
  const meta = el("div", "mb-3");
  meta.appendChild(el("div", "text-[18px] font-bold", zh));
  if (film.title_orig && film.title_orig !== zh) {
    meta.appendChild(el("div", "text-muted text-[13px]", film.title_orig));
  }
  const infoBits = [
    film.unit,
    film.country,
    film.year ? String(film.year) : "",
    film.director,
    film.remark ? `备注 · ${film.remark}` : "",
  ].filter(Boolean);
  if (infoBits.length) {
    meta.appendChild(el("div", "text-muted text-[12.5px]", infoBits.join(" · ")));
  }
  if (film.rating != null) meta.appendChild(doubanChip(film.rating, "mt-2")); // 豆瓣章单一来源(legend.ts)
  body.appendChild(meta);

  // ---- 我的选片(目录片 key = cat:<id>,与排期后同片打标同源)----
  body.appendChild(buildWishRow(`cat:${film.id}`));

  body.appendChild(
    el(
      "div",
      "text-[12px] text-muted leading-[1.6] mb-[10px]",
      "该片暂无已发布排期 — 可先关联豆瓣条目,Catalogue 排期(预计 9/11)公布接入后,同片会自动带出该关联。"
    )
  );

  // ---- 豆瓣区(code = 目录片 id,如 f001)----
  body.appendChild(buildDoubanBlock(film.id, film.title_zh || "", film.title_orig || ""));
  openModal(`详情 · ${zh}`, body, true);
}

/** 豆瓣区:已关联→直链;未关联→搜索链接 + 粘贴回填。code 可为排期 code(3 位)或目录片 id(f###) */
function buildDoubanBlock(code: string, qZh: string, qEn: string): HTMLElement {
  const block = el("div", "border-t border-line pt-3");
  const title = el("div", "text-[13px] font-bold mb-2", "豆瓣");
  block.appendChild(title);

  const map = store.mappings.get(code);
  const content = el("div", "grid gap-2");
  content.dataset.dbArea = "";

  if (map?.douban_url) {
    const linked = el("div");
    const a = document.createElement("a");
    a.href = map.douban_url;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.className = "font-semibold";
    a.textContent = `豆瓣条目 ↗ ${map.title_cn ? "· " + map.title_cn : ""}`;
    linked.appendChild(a);
    content.appendChild(linked);
  } else {
    const search = el("div", "flex gap-3 items-center flex-wrap text-[13px]");
    search.appendChild(el("span", "text-muted text-[12.5px]", "未关联 — 点这里查豆瓣:"));
    const q = encodeURIComponent(`${qZh} ${qEn}`.trim());
    const qEn2 = encodeURIComponent(qEn);
    const a1 = document.createElement("a");
    a1.href = `https://www.douban.com/search?q=${q}`;
    a1.target = "_blank";
    a1.rel = "noreferrer";
    a1.textContent = "中文搜索";
    const a2 = document.createElement("a");
    a2.href = `https://www.douban.com/search?q=${qEn2}`;
    a2.target = "_blank";
    a2.rel = "noreferrer";
    a2.textContent = "英文搜索";
    search.append(a1, a2);
    content.appendChild(search);
  }

  // 粘贴回填表单
  const form = el("div", "flex gap-[6px] flex-wrap");
  const urlInput = el(
    "input",
    "flex-[1_1_220px] border border-line rounded-[8px] px-[10px] py-[7px] text-[13px] min-w-0 focus:[outline:2px_solid_color-mix(in_srgb,var(--color-biff)_30%,var(--color-card))] focus:border-biff"
  ) as HTMLInputElement;
  urlInput.type = "url";
  urlInput.placeholder = "粘贴豆瓣链接,如 https://movie.douban.com/subject/37233337/";
  urlInput.value = map?.douban_url ?? "";
  const cnInput = el(
    "input",
    "flex-[1_1_220px] border border-line rounded-[8px] px-[10px] py-[7px] text-[13px] min-w-0 focus:[outline:2px_solid_color-mix(in_srgb,var(--color-biff)_30%,var(--color-card))] focus:border-biff"
  ) as HTMLInputElement;
  cnInput.placeholder = "中文片名(可选,排期缺中文名时展示用)";
  cnInput.value = map?.title_cn ?? "";
  const save = el(
    "button",
    "border-0 rounded-[6px] px-[10px] py-1 text-[12px] font-bold text-on-brand bg-[linear-gradient(135deg,var(--biff-red)_0%,var(--biff-red-2)_100%)] hover:brightness-[1.05]",
    "保存映射"
  );
  save.addEventListener("click", async () => {
    const douban_url = urlInput.value.trim();
    const title_cn = cnInput.value.trim();
    if (!douban_url && !title_cn) {
      save.textContent = "至少填一项";
      return;
    }
    const data = await api.putMapping(code, { douban_url: douban_url || undefined, title_cn: title_cn || undefined });
    if (!data) {
      save.textContent = "保存失败(离线?)";
      return;
    }
    store.mappings.set(code, { code, subject_id: data.subject_id, title_cn: data.title_cn, douban_url: data.douban_url });
    const old = block.querySelector("[data-db-area]");
    const fresh = buildDoubanBlock(code, qZh, qEn).querySelector("[data-db-area]")!;
    if (old) old.replaceWith(fresh);
  });
  form.append(urlInput, cnInput, save);
  content.appendChild(form);

  block.appendChild(content);
  return block;
}