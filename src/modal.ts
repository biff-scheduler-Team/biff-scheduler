// 弹层:通用容器 + 影片详情(含同片场次 / 豆瓣映射管理)。
// 全量化:overlay / modal / 详情弹层结构 全部 Tailwind utility。

import type { Catalog, Mapping, PlanEntry, Screening } from "./types";
import { dateInfo, el, fmtMinRange } from "./util";
import { appendBadges, DOUBAN_CHIP_TITLE } from "./badges";
import { api } from "./api";
import { store } from "./state";

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
  plan: Map<string, PlanEntry>;
  group: string;
  mappings: Map<string, Mapping>;
  toggle: (code: string) => void;
}

/** 同片判定 key:中文/英文名任一同则视为同片 */
export function filmKey(s: Screening): string {
  return (s.title_zh || s.title_en).toLowerCase().trim();
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
  if (rating != null) {
    const rc = el(
      "span",
      "inline-block text-[11px] font-bold text-muted border border-line bg-card rounded px-[6px] leading-[1.7] select-none whitespace-nowrap mt-2",
      `豆 ${rating}`
    );
    rc.dataset.tip = DOUBAN_CHIP_TITLE; // 缩写说明:豆 = 豆瓣评分
    meta.appendChild(rc);
  }
  body.appendChild(meta);

  // ---- 同片全部场次 ----
  const list = el("div", "grid gap-[6px] mb-[14px]");
  for (const s of siblings) {
    const { label, weekday } = dateInfo(s.date);
    const entry = ctx.plan.get(s.code);
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
    appendBadges(where, s); // 16-F:GV(GV hover 说明含 +25min)等特性徽章
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
  body.appendChild(
    buildDoubanBlock(code, ctx, () => {
      // 保存后刷新豆瓣区 + 全局状态已由 store 通知
    })
  );

  openModal(`详情 · ${zh}`, body, true);

  // 事件(每行独立绑定,避免全局委托)
  body.querySelectorAll<HTMLElement>("[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      ctx.toggle(btn.dataset.toggle!);
    });
  });
}

function buildDoubanBlock(
  code: string,
  ctx: FilmModalCtx,
  onSaved: () => void
): HTMLElement {
  const s = ctx.cat.byCode.get(code)!;
  const block = el("div", "border-t border-line pt-3");
  const title = el("div", "text-[13px] font-bold mb-2", "豆瓣");
  block.appendChild(title);

  const map = ctx.mappings.get(code);
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
    const q = encodeURIComponent(`${s.title_zh || ""} ${s.title_en}`.trim());
    const qEn = encodeURIComponent(s.title_en);
    const a1 = document.createElement("a");
    a1.href = `https://www.douban.com/search?q=${q}`;
    a1.target = "_blank";
    a1.rel = "noreferrer";
    a1.textContent = "中文搜索";
    const a2 = document.createElement("a");
    a2.href = `https://www.douban.com/search?q=${qEn}`;
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
    onSaved();
    const old = block.querySelector("[data-db-area]");
    const fresh = buildDoubanBlock(code, ctx, onSaved).querySelector("[data-db-area]")!;
    if (old) old.replaceWith(fresh);
  });
  form.append(urlInput, cnInput, save);
  content.appendChild(form);

  block.appendChild(content);
  return block;
}