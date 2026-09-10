// 弹层:通用容器 + 影片详情(含同片场次 / 豆瓣映射管理)。
// 全量化:overlay / modal / 详情弹层结构 全部 Tailwind utility。

import type { Catalog, Mapping, Screening } from "./types";
import { dateInfo, el, filmNodeKey, fmtMinRange } from "./util";
import { appendMetaRow, doubanChip } from "./legend";
import { api } from "./api";
import { setWish, slotOf, store } from "./state";
import { buildWishSeg } from "./pick";

/* ---------- 通用容器(弹层栈) ----------
 *  2026-09-10:由「单弹层覆盖」改为「弹层栈」——
 *  原先 openModal 直接 `root.innerHTML = ""`,影片库点「详情 ⓘ」会把整个列表销毁,
 *  用户只能关闭、回不到列表(得重新打开 + 重新搜 + 重新展开)。
 *  现在新弹层**压栈**:被压住的那层留在 DOM 里(display:none),返回时原样恢复 ——
 *  列表滚动位置 / 展开态 / 搜索词都在,零重建;栈深 > 1 时头部给「← 返回」。 */

interface ModalEntry {
  overlay: HTMLElement;
  /** 关闭本层;restore=false 用于 closeAllModals(整栈关闭时不触发下层 onReturn) */
  dismiss: (restore?: boolean) => void;
  /** 从上层返回本层时的回调(刷新被压住的列表:计数 / 已选场次) */
  onReturn?: () => void;
}

const modalStack: ModalEntry[] = [];

function topModal(): ModalEntry | undefined {
  return modalStack[modalStack.length - 1];
}

/** Escape 只关**栈顶**(模块级单监听:多弹层叠加时不会一按全关) */
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") topModal()?.dismiss();
});

export function openModal(title: string, body: HTMLElement, wide = false, onReturn?: () => void): void {
  const root = document.getElementById("modal-root");
  if (!root) return;
  const depth = modalStack.length; // 0 = 栈底(没有上一层可回)
  const prev = topModal();
  if (prev) prev.overlay.style.display = "none"; // 压栈:不销毁,返回时原样恢复

  const overlay = el(
    "div",
    "fixed inset-0 z-[100] bg-[var(--overlay-bg)] flex items-start justify-center px-4 py-12 overflow-y-auto"
  );
  const boxCls = wide
    ? "bg-card rounded-[12px] shadow-[var(--shadow-modal)] w-[640px] max-w-full p-[18px]"
    : "bg-card rounded-[12px] shadow-[var(--shadow-modal)] w-[520px] max-w-full p-[18px]";
  const box = el("div", boxCls);
  const head = el("div", "flex items-center gap-2 mb-3");
  head.appendChild(el("h3", "m-0 text-[16px] flex-1 min-w-0", title));
  // 只在有上一层时给「返回」(栈底弹层无处可回,保持原样)
  const back =
    depth > 0
      ? el(
          "button",
          "shrink-0 border border-line bg-card rounded-[7px] px-[9px] py-[3px] text-[12px] font-semibold text-ink whitespace-nowrap hover:border-line-strong hover:bg-hover",
          "← 返回"
        )
      : null;
  if (back) {
    back.title = "返回上一层(列表状态保留)";
    head.appendChild(back);
  }
  const close = el(
    "button",
    "shrink-0 border-0 bg-raised w-[26px] h-[26px] rounded-[7px] text-[13px] text-ink hover:bg-raised-hover",
    "✕"
  );
  head.appendChild(close);
  box.append(head, body);
  overlay.appendChild(box);
  root.appendChild(overlay);

  const entry: ModalEntry = { overlay, onReturn, dismiss: () => {} };
  const dismiss = (restore = true): void => {
    overlay.remove();
    const i = modalStack.indexOf(entry);
    if (i >= 0) modalStack.splice(i, 1);
    if (!restore) return;
    const under = topModal();
    if (under) {
      under.overlay.style.display = ""; // 回到上一层:DOM 原样,不重建
      under.onReturn?.();
    }
  };
  entry.dismiss = dismiss;
  modalStack.push(entry);

  close.addEventListener("click", () => dismiss());
  back?.addEventListener("click", () => dismiss());
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) dismiss();
  });
}

/** 关闭栈顶弹层(有下层则自动恢复) */
export function closeModal(): void {
  topModal()?.dismiss();
}

/** 关闭整栈 —— 「定位 ▸」这类要跳到页面主体的出口必须整栈关掉,否则列表还盖着网格 */
export function closeAllModals(): void {
  while (modalStack.length) topModal()!.dismiss(false);
}

/* ---------- 影片详情 ---------- */
interface FilmModalCtx {
  cat: Catalog;
  group: string;
  mappings: Map<string, Mapping>;
  /** 加入/移出当前方案(按影片 key + 场次 code;档位是影片级的,新记录档位未设) */
  toggle: (key: string, code: string) => void;
}

/** 行内主操作按钮的三态(文案 + 完整类名 + 悬停说明)—— 初渲与「点击后就地重绘」共用的唯一来源。
 *  ⚠ 状态必须走 slotOf() 实时查询,不能缓存开弹层那一刻的 Map:commit() 里 rebuildIndex() 是
 *  `store.slotIndex = idx`(整体换新 Map),持有旧引用会读到点选前的快照 → 连重绘都会画错。
 *  三态:未加入 = 红渐变主按钮;已加入当前方案 = `act-on`(浅绿底 + 绿边 + 绿字,与网格「已选」
 *  同一套绿)且 hover 转红(= 「点了就是移除」的意图预告);已在另一组 = 中性白底,hover 转红。
 *  ⚠ 文案必须与 toggleScreening() 的真实语义一致:一场只属于一个方案,点「已在 B 组」的按钮
 *  是**移出**(不是搬运)—— 重绘修好之后按钮会当场翻成「加入 A 方案」,再点一次才是改入,
 *  所以不能写成「改入 A」(写了两步的事就变成一步的承诺)。 */
function actState(code: string, group: string): { label: string; cls: string; tip: string } {
  const base =
    "border rounded-[6px] px-[10px] py-1 text-[12px] font-bold whitespace-nowrap " +
    "transition-[background-color,border-color,color,filter] duration-[120ms] active:translate-y-px ";
  const hit = slotOf(code);
  if (hit?.group === group) {
    return {
      label: "已加入 · 点击移除",
      cls: base + "act-on",
      tip: `该场已在 ${group} 方案 — 点击移出(影片的选片意向 / 档位不受影响)`,
    };
  }
  if (hit) {
    return {
      label: `已在 ${hit.group} 组 · 点击移出`,
      cls: base + "border-line bg-card text-ink-2 hover:border-biff hover:text-biff",
      tip: `该场在 ${hit.group} 方案 — 一场只能属于一个方案:点击先移出,按钮会翻成「加入 ${group} 方案」,再点一次即改入 ${group}`,
    };
  }
  return {
    label: `加入 ${group} 方案`,
    cls:
      base +
      "border-0 text-on-brand bg-[linear-gradient(135deg,var(--biff-red)_0%,var(--biff-red-2)_100%)] hover:brightness-110",
    tip: `把该场加入当前 ${group} 方案`,
  };
}

/** 同片判定 key:中文/英文名任一同则视为同片 */
export function filmKey(s: Screening): string {
  return (s.title_zh || s.title_en).toLowerCase().trim();
}

/** 「我的选片」档位行(详情弹层内直接改档位)—— key 走 filmNodeKey 单一口径,与影片库/甘特色点同源。
 *  档位是影片级的:这里改 = 「我的选片」与「我的行程」里该片所有场次同步。
 *  返回 `{ row, draw }`:场次增删后外部调 `draw()` 刷新 seg 与「已选 N 场」计数(弹层不在 renderAll 重建范围内)。 */
function buildWishRow(key: string): { row: HTMLElement; draw: () => void } {
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
  return { row, draw };
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
  const wish = buildWishRow(filmNodeKey(ctx.cat, anchor));
  body.appendChild(wish.row);

  // ---- 同片全部场次 ----
  const list = el("div", "grid gap-[6px] mb-[14px]");
  /** 行内主操作按钮登记表:paintRows() 据此就地重绘(弹层不在 renderAll 重建范围内) */
  const acts: { code: string; btn: HTMLElement }[] = [];
  for (const s of siblings) {
    const { label, weekday } = dateInfo(s.date);
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

    // 主操作按钮:三态文案 / 配色由 actState() 统一给(初渲与点击后重绘同一份口径)
    const act = el("button", "", "");
    act.dataset.toggle = s.code;
    acts.push({ code: s.code, btn: act });
    row.append(info, act);
    list.appendChild(row);
  }
  body.appendChild(list);

  /** 就地重绘全部行按钮 —— 弹层挂在 #modal-root 下,不在 renderAll() 的重建范围里;
   *  不重绘就表现为「点完按钮文字/配色一动不动,只有背后的网格变了」= 像点了没反应。 */
  const paintRows = (): void => {
    for (const a of acts) {
      const st = actState(a.code, ctx.group);
      a.btn.textContent = st.label;
      a.btn.className = st.cls;
      a.btn.title = st.tip;
    }
  };
  paintRows();

  // ---- 豆瓣区 ----
  body.appendChild(buildDoubanBlock(code, anchor.title_zh || "", anchor.title_en));

  openModal(`详情 · ${zh}`, body, true);

  // 事件(每行独立绑定,避免全局委托)。点完三件事:① 就地重绘按钮三态 ② 刷新「已选 N 场」
  // ③ 该行闪一下(biff-flash)—— 按钮自身给出回执,不必关掉弹层才知道点到了。
  body.querySelectorAll<HTMLElement>("[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = btn.dataset.toggle!;
      const s = ctx.cat.byCode.get(c);
      if (!s) return;
      ctx.toggle(filmNodeKey(ctx.cat, s), c);
      paintRows();
      wish.draw();
      const row = btn.closest<HTMLElement>("[data-code]");
      if (row) {
        row.classList.remove("flash");
        void row.offsetWidth; // 强制回流:同一行连点也能重启动画
        row.classList.add("flash");
        window.setTimeout(() => row.classList.remove("flash"), 1200);
      }
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
  body.appendChild(buildWishRow(`cat:${film.id}`).row);

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