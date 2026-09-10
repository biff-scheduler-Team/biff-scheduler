// 弹层:通用容器 + 影片资料(片名 / 元信息 / 豆瓣映射管理)。
// 2026-09-10:弹层不再列「同片全部场次」—— 唯一场次列表收敛到「影片库」行内展开
// (library.ts,那里同时给「定位 ▸」与三态「＋ 加入」),避免同一部片出现两份排片列表。
// 全量化:overlay / modal / 资料弹层结构 全部 Tailwind utility。

import type { Catalog, Mapping } from "./types";
import { el, filmNodeKey } from "./util";
import { doubanChip } from "./legend";
import { api } from "./api";
import { setWish, slotOf, store } from "./state";
import { buildWishSeg } from "./pick";

/* ---------- 通用容器(弹层栈) ----------
 *  2026-09-10:由「单弹层覆盖」改为「弹层栈」——
 *  原先 openModal 直接 `root.innerHTML = ""`,影片库点「ⓘ」会把整个列表销毁,
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

/** 弹层宽度档:`md` 520 / `lg` 640。
 *  **`xl`(1280)已删**(2026-09-10,`PLAN-20260910184745`):它当初只为「影片库 · 我的选片」
 *  的左右双栏弹窗存在,而那块已改为 `<main>` 内的挤压式抽屉 —— 弹层里再无调用点,留着就是死档。
 *  兼容旧的布尔第三参 —— `true → lg`、`false / 省略 → md`(存量调用点不必改)。 */
export type ModalSize = "md" | "lg";

const MODAL_WIDTH: Record<ModalSize, string> = {
  md: "w-[520px]",
  lg: "w-[640px]",
};

export function openModal(
  title: string,
  body: HTMLElement,
  size: ModalSize | boolean = "md",
  onReturn?: () => void
): void {
  const root = document.getElementById("modal-root");
  if (!root) return;
  const depth = modalStack.length; // 0 = 栈底(没有上一层可回)
  const prev = topModal();
  if (prev) prev.overlay.style.display = "none"; // 压栈:不销毁,返回时原样恢复

  const overlay = el(
    "div",
    "fixed inset-0 z-[100] bg-[var(--overlay-bg)] flex items-start justify-center px-4 py-12 overflow-y-auto"
  );
  const sz: ModalSize = size === true ? "lg" : size === false ? "md" : size;
  const boxCls = `bg-card rounded-[12px] shadow-[var(--shadow-modal)] ${MODAL_WIDTH[sz]} max-w-full p-[18px]`;
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
    back.dataset.tip = "返回上一层(列表状态保留)";
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

/* ---------- 影片资料(唯一场次列表在「影片库」行内展开,这里不再重复) ---------- */
interface FilmModalCtx {
  cat: Catalog;
  mappings: Map<string, Mapping>;
}

/** 行内主操作按钮的三态(文案 + 完整类名 + 悬停说明)—— 初渲与「点击后就地重绘」共用的唯一来源。
 *  ⚠ 状态必须走 slotOf() 实时查询,不能缓存开弹层那一刻的 Map:commit() 里 rebuildIndex() 是
 *  `store.slotIndex = idx`(整体换新 Map),持有旧引用会读到点选前的快照 → 连重绘都会画错。
 *  三态(2026-09-10 重排层级,见 PLAN-20260910184745 §8):
 *    ① 未加入 = **中性描边次要按钮**(原为红渐变主按钮 —— 红色实底现在让给「定位 ▸」这唯一主操作,
 *       两枚红按钮并排会互相抢眼,分不出主次);
 *    ② 已加入当前方案 = **纯状态标签**(绿勾 + 绿字,无底无框)—— 它表达的是「这场已在方案里」这个
 *       **状态**,用按钮外形会让人以为是待点的操作。⚠ 但仍**保留可点 = 移出**(否则这里就失去了
 *       移除入口),故留 `cursor-pointer` + hover 下划线 + tooltip 明说「点击移出」;
 *    ③ 已在另一方案 = 中性描边,hover 转红。
 *  ⚠ 文案必须与 toggleScreening() 的真实语义一致:一场只属于一个方案,点「已在 B 方案」的按钮
 *  是**移出**(不是搬运)—— 重绘修好之后按钮会当场翻成「＋ 加入」,再点一次才是改入,
 *  所以不能写成「改入 B」(写了两步的事就变成一步的承诺)。
 *  ⚠ **「加入」不写方案名**(2026-09-10):列表 / 网格整个就是当前方案(A/B 由顶栏切换),
 *  「加入 A 方案」把「你正在看的那一个」重复了一遍 —— 只在**跨方案**那态才点名(「已在 B 方案」),
 *  因为那才是「不在你当前方案里」这条信息本身。 */
export function actState(code: string, group: string): { label: string; cls: string; tip: string } {
  const btn =
    "border rounded-[6px] px-[9px] py-[3px] text-[11.5px] font-bold whitespace-nowrap " +
    "transition-[background-color,border-color,color] duration-[120ms] active:translate-y-px ";
  const hit = slotOf(code);
  if (hit?.group === group) {
    return {
      label: "✓ 已加入",
      cls:
        "border-0 bg-transparent p-0 text-[11.5px] font-bold whitespace-nowrap text-ok " +
        "cursor-pointer underline-offset-2 hover:underline",
      tip: "该场已在当前方案 — 点击移出(影片的选片意向 / 档位不受影响)",
    };
  }
  if (hit) {
    return {
      label: `⇄ 已在 ${hit.group}`,
      cls: btn + "border-line bg-card text-ink-2 hover:border-biff hover:text-biff",
      tip: `该场在 ${hit.group} 方案(不是当前方案)— 一场只能属于一个方案:点击先移出,按钮会翻成「＋ 加入」,再点一次即改入当前方案`,
    };
  }
  return {
    label: "＋ 加入",
    cls: btn + "border-line bg-card text-ink hover:border-biff hover:text-biff",
    tip: "把该场加入当前方案",
  };
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
      ? `已选 ${n} 场 · 档位为影片级,改这里全片同步;场次增删在网格 / 影片库`
      : "打标后可在顶栏「我的选片」总览;甘特图对应场次标题前显示档位色点";
  };
  draw();
  row.append(slot, hint);
  return { row, draw };
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

  // ---- 午夜场联映块:块名不是片名,这里把块内成员片列出来 ----
  // 联映块 = 「一张票连看 2~3 部」,册子格子里只有块名 + 页码列表;成员片名由解析器
  // 从单元扉页对照表抽出(midnight_members,见 types.ts)。不给出来的话,弹层就只剩
  // 一条「Midnight Passion 1」,用户根本不知道买的是哪几部。
  const members = anchor.midnight_members ?? [];
  if (members.length) {
    const box = el("div", "mb-[14px] border border-ev-teal rounded-[9px] bg-ev-teal-soft px-[10px] py-2");
    box.appendChild(el("div", "text-[12.5px] font-bold text-ev-teal", `午夜联映 · 一块 ${members.length} 部`));
    box.appendChild(el("div", "text-[13px] font-semibold mt-[3px]", members.join(" / ")));
    box.appendChild(
      el(
        "div",
        "text-[11.5px] text-muted mt-[3px]",
        "本场是联映块票:一张票连看完全部影片,不单独售票;成员片的详情里会把本块 CODE 列为自己的一场"
      )
    );
    body.appendChild(box);
  }

  // ---- 我的选片(打标:必看/备选/随缘)----
  const wish = buildWishRow(filmNodeKey(ctx.cat, anchor));
  body.appendChild(wish.row);

  // ---- 豆瓣区 ----
  body.appendChild(buildDoubanBlock(code, anchor.title_zh || "", anchor.title_en));

  openModal(`资料 · ${zh}`, body, "lg");
}

/** 目录片资料(暂无排期):元信息 + 评分 + 豆瓣区(先关联,Catalogue 排期接入后同片自动带出) */
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
  openModal(`资料 · ${zh}`, body, "lg");
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
  // 主按钮 `ml-auto`:窄屏两个输入框折行后,保存按钮不会孤零零落在左下角(仍贴右缘)
  const save = el(
    "button",
    "ml-auto border-0 rounded-[6px] px-[10px] py-1 text-[12px] font-bold text-on-brand bg-[linear-gradient(135deg,var(--biff-red)_0%,var(--biff-red-2)_100%)] hover:brightness-[1.05]",
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