// 弹层:通用容器 + 影片资料(片名 / 元信息 / 豆瓣映射管理)。
// 2026-09-10:弹层不再列「同片全部场次」—— 唯一场次列表收敛到「影片库」行内展开
// (library.ts,那里同时给「定位 ▸」与三态「＋ 加入」),避免同一部片出现两份排片列表。
// 全量化:overlay / modal / 资料弹层结构 全部 Tailwind utility。

import type { Catalog, Mapping } from "./types";
import { displayTitle, el, filmNodeKey } from "./util";
import { doubanChip } from "./legend";
import { setWish, slotOf, store } from "./state";
import { wishIcon } from "./pick";
import { hideTip } from "./tip";

/* ---------- 通用容器(弹层栈) ----------
 *  2026-09-10:由「单弹层覆盖」改为「弹层栈」——
 *  原先 openModal 直接 `root.innerHTML = ""`,影片库点「ⓘ」会把整个列表销毁,
 *  用户只能关闭、回不到列表(得重新打开 + 重新搜 + 重新展开)。
 *  现在新弹层**压栈**:被压住的那层留在 DOM 里(display:none),返回时原样恢复 ——
 *  列表滚动位置 / 展开态 / 搜索词都在,零重建;栈深 > 1 时头部给「← 返回」。 */

interface ModalEntry {
  overlay: HTMLElement;
  /** 弹层内容盒(`role="dialog"`)—— 焦点管理 / focus trap 的锚点 */
  box: HTMLElement;
  /** 关闭本层;restore=false 用于 closeAllModals(整栈关闭时不触发下层 onReturn) */
  dismiss: (restore?: boolean) => void;
  /** 从上层返回本层时的回调(刷新被压住的列表:计数 / 已选场次) */
  onReturn?: () => void;
}

const modalStack: ModalEntry[] = [];

function topModal(): ModalEntry | undefined {
  return modalStack[modalStack.length - 1];
}

let modalSeq = 0; // 生成 aria-labelledby 的标题 id

/* ---------- 背景滚动锁(栈计数:只在栈空时解锁) ---------- */
let lockedPrevOverflow = "";

function lockBody(): void {
  if (modalStack.length > 1) return; // 已有层锁过,深层不重复锁
  lockedPrevOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
}

function unlockBody(): void {
  if (modalStack.length > 0) return; // 还有层盖着 → 保持锁定
  document.body.style.overflow = lockedPrevOverflow;
}

/** Escape 只关**栈顶**(模块级单监听:多弹层叠加时不会一按全关) */
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") topModal()?.dismiss();
});

/** Tab 焦点循环:把键盘焦点限制在弹层内(背景页面 / 被压住的下层都不可达)。
 *  列表为空(纯文本弹层)时放行 —— 此时 box 自身可聚焦,不会把焦点丢到背景。 */
function trapTab(box: HTMLElement, ev: KeyboardEvent): void {
  const focusables = box.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement as HTMLElement | null;
  const inside = active ? box.contains(active) : false;
  if (ev.shiftKey) {
    if (!inside || active === first) {
      ev.preventDefault();
      last.focus();
    }
  } else if (!inside || active === last) {
    ev.preventDefault();
    first.focus();
  }
}

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
  hideTip(); // 触屏场景:开层前收掉悬停提示,避免它浮在弹层之上
  const depth = modalStack.length; // 0 = 栈底(没有上一层可回)
  const prev = topModal();
  if (prev) prev.overlay.style.display = "none"; // 压栈:不销毁,返回时原样恢复

  const overlay = el(
    "div",
    "fixed inset-0 z-[100] bg-[var(--overlay-bg)] flex items-start justify-center px-4 py-12 overflow-y-auto"
  );
  const sz: ModalSize = size === true ? "lg" : size === false ? "md" : size;
  const boxCls = `bg-card rounded-12 shadow-[var(--shadow-modal)] ${MODAL_WIDTH[sz]} max-w-full p-[18px] outline-none`;
  const box = el("div", boxCls);
  // ARIA:弹层语义 + 标题关联;tabIndex=-1 让 box 本身可被编程聚焦(focus trap 的落点)
  const titleId = `modal-title-${++modalSeq}`;
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-labelledby", titleId);
  box.tabIndex = -1;
  const head = el("div", "flex items-center gap-2 mb-3");
  const titleEl = el("h3", "m-0 text-16 flex-1 min-w-0", title);
  titleEl.id = titleId;
  head.appendChild(titleEl);
  // 只在有上一层时给「返回」(栈底弹层无处可回,保持原样)
  const back =
    depth > 0
      ? el(
          "button",
          "shrink-0 border border-line bg-card rounded-7 px-[9px] py-[3px] text-12 font-semibold text-ink whitespace-nowrap hover:border-line-strong hover:bg-hover",
          "← 返回"
        )
      : null;
  if (back) {
    back.dataset.tip = "返回上一层(列表状态保留)";
    head.appendChild(back);
  }
  const close = el(
    "button",
    "shrink-0 border-0 bg-raised w-[26px] h-[26px] rounded-7 text-13 text-ink hover:bg-raised-hover",
    "✕"
  );
  close.setAttribute("aria-label", "关闭");
  head.appendChild(close);
  box.append(head, body);
  overlay.appendChild(box);
  root.appendChild(overlay);

  // 记录打开本层的元素,关闭后把焦点还回去(键盘用户不会「焦点失踪」)
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const entry: ModalEntry = { overlay, box, onReturn, dismiss: () => {} };
  const dismiss = (restore = true): void => {
    overlay.remove();
    const i = modalStack.indexOf(entry);
    if (i >= 0) modalStack.splice(i, 1);
    unlockBody();
    if (!restore) return;
    const under = topModal();
    if (under) {
      under.overlay.style.display = ""; // 回到上一层:DOM 原样,不重建
      under.onReturn?.();
      under.box.focus();
      return;
    }
    if (opener?.isConnected) opener.focus();
  };
  entry.dismiss = dismiss;
  modalStack.push(entry);
  lockBody();
  box.focus(); // 初始聚焦弹层本身(而非背景),Tab 从弹层内开始

  close.addEventListener("click", () => dismiss());
  back?.addEventListener("click", () => dismiss());
  overlay.addEventListener("keydown", (ev) => {
    if (ev.key === "Tab") trapTab(box, ev);
  });
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
 *  因为那才是「不在你当前方案里」这条信息本身。
 *  ⚠ `short` = **紧凑标签**(2026-09-11 四改):抽屉里的场次行第 1 行要留宽度给章组,
 *  故那里只渲染一枚符号(文案全走 `data-tip`)。弹层里有的是地方,继续用 `label`。
 *  两者必须**同源**在这里改,否则抽屉与弹层会显示成两种语义。 */
export function actState(
  code: string,
  group: string
): { label: string; short: string; cls: string; tip: string } {
  const btn =
    "border rounded-6 px-[9px] py-[3px] text-12 font-bold whitespace-nowrap " +
    "transition-[background-color,border-color,color] duration-[120ms] active:translate-y-px ";
  const hit = slotOf(code);
  if (hit?.group === group) {
    return {
      label: "✓ 已加入",
      short: "✓",
      cls:
        "border-0 bg-transparent p-0 text-12 font-bold whitespace-nowrap text-ok " +
        "cursor-pointer underline-offset-2 hover:underline",
      tip: "该场已在当前方案 — 点击移出(影片的选片意向 / 档位不受影响)",
    };
  }
  if (hit) {
    return {
      label: `⇄ 已在 ${hit.group}`,
      short: `⇄${hit.group}`,
      cls: btn + "border-line bg-card text-ink-2 hover:border-biff hover:text-biff-ink",
      tip: `该场在 ${hit.group} 方案(不是当前方案)— 一场只能属于一个方案:点击先移出,按钮会翻成「＋ 加入」,再点一次即改入当前方案`,
    };
  }
  return {
    label: "＋ 加入",
    short: "＋",
    cls: btn + "border-line bg-card text-ink hover:border-biff hover:text-biff-ink",
    tip: "把该场加入当前方案",
  };
}

/** 「我的选片」档位行(详情弹层内直接改档位)—— key 走 filmNodeKey 单一口径,与影片库 / 甘特 ★ 同源。
 *  档位是影片级的:这里改 = 「我的选片」与「我的行程」里该片所有场次同步。
 *  ⚠ **控件 = ★ 星标(2026-09-10 改,与行程卡 / 影片库卡完全同款)**:原为「必看|备选|随缘」三段 seg,
 *  需求原话「不要在影片资料中标记必看/备选/随缘,需要和我的行程里面一样,直接在卡片上标记等级」——
 *  三段文字换成一枚 ★(已定档按档位着色 / 未设定 ☆),三档文案收进 hover 提示与点击菜单;
 *  弹层里没有卡片底衬托,故用 `size: "lg"`(26px 盒 / 18px 星)让它像个可点的档位控件。
 *  返回 `{ row, draw }`:场次增删后外部调 `draw()` 刷新 ★ 与「已选 N 场」计数(弹层不在 renderAll 重建范围内)。 */
function buildWishRow(key: string): { row: HTMLElement; draw: () => void } {
  const row = el("div", "flex items-center gap-[8px] flex-wrap mb-[14px] border-t border-line pt-3");
  row.appendChild(el("span", "text-13 font-bold whitespace-nowrap", "我的选片"));
  const slot = el("div", "inline-flex");
  const hint = el("span", "text-12 text-muted");
  const draw = (): void => {
    slot.innerHTML = "";
    slot.appendChild(
      wishIcon({
        cur: store.picks.get(key)?.priority ?? null,
        anchor: key,
        onPick: (p) => {
          setWish(key, p);
          draw(); // 弹层不在 renderAll 重建范围内 → 就地重画 ★ 反映当前档
        },
        size: "lg",
        tipPrefix: "我的选片 · ",
      })
    );
    const n = store.picks.get(key)?.picks.length ?? 0;
    hint.textContent = n
      ? `已选 ${n} 场 · 档位为影片级,改这里全片同步;场次增删在网格 / 影片库`
      : "点 ★ 打标后可在顶栏「我的选片」总览;甘特图对应场次标题前显示同一枚 ★";
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
  const zh = displayTitle(anchor, ctx.mappings.get(code)?.title_cn);
  meta.appendChild(el("div", "text-18 font-bold", zh));
  const enLine = el("div", "text-muted text-13", anchor.title_en);
  if (anchor.title_en !== zh) meta.appendChild(enLine);
  if (anchor.title_kr) meta.appendChild(el("div", "text-muted text-13", anchor.title_kr));
  const rating = ratingOf(ctx.cat, code);
  if (rating != null) meta.appendChild(doubanChip(rating, "mt-2")); // 豆瓣章单一来源(legend.ts)
  body.appendChild(meta);

  // ---- 午夜场联映块:块名不是片名,这里把块内成员片列出来 ----
  // 联映块 = 「一张票连看 2~3 部」,册子格子里只有块名 + 页码列表;成员片名由解析器
  // 从单元扉页对照表抽出(midnight_members,见 types.ts)。不给出来的话,弹层就只剩
  // 一条「Midnight Passion 1」,用户根本不知道买的是哪几部。
  const members = anchor.midnight_members ?? [];
  if (members.length) {
    const box = el("div", "mb-[14px] border border-ev-teal rounded-9 bg-ev-teal-soft px-[10px] py-2");
    box.appendChild(el("div", "text-13 font-bold text-ev-teal", `午夜联映 · 一块 ${members.length} 部`));
    box.appendChild(el("div", "text-13 font-semibold mt-[3px]", members.join(" / ")));
    box.appendChild(
      el(
        "div",
        "text-12 text-muted mt-[3px]",
        "本场是联映块票:一张票连看完全部影片,不单独售票;成员片的详情里会把本块 CODE 列为自己的一场"
      )
    );
    body.appendChild(box);
  }

  // ---- 我的选片(档位 ★ —— 与行程卡 / 影片库卡同款;文案走 hover 提示,不铺三段文字)----
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
  meta.appendChild(el("div", "text-18 font-bold", zh));
  if (film.title_orig && film.title_orig !== zh) {
    meta.appendChild(el("div", "text-muted text-13", film.title_orig));
  }
  const infoBits = [
    film.unit,
    film.country,
    film.year ? String(film.year) : "",
    film.director,
    film.remark ? `备注 · ${film.remark}` : "",
  ].filter(Boolean);
  if (infoBits.length) {
    meta.appendChild(el("div", "text-muted text-13", infoBits.join(" · ")));
  }
  if (film.rating != null) meta.appendChild(doubanChip(film.rating, "mt-2")); // 豆瓣章单一来源(legend.ts)
  body.appendChild(meta);

  // ---- 我的选片(目录片 key = cat:<id>,与排期后同片打标同源)----
  body.appendChild(buildWishRow(`cat:${film.id}`).row);

  body.appendChild(
    el(
      "div",
      "text-12 text-muted leading-[1.6] mb-[10px]",
      "该片暂无已发布排期 — 可先关联豆瓣条目,Catalogue 排期(预计 9/11)公布接入后,同片会自动带出该关联。"
    )
  );

  // ---- 豆瓣区(code = 目录片 id,如 f001)----
  body.appendChild(buildDoubanBlock(film.id, film.title_zh || "", film.title_orig || ""));
  openModal(`资料 · ${zh}`, body, "lg");
}

/** 豆瓣区:有映射 → 条目直链;无映射 → 中英文搜索外链(兜底)。
 *  映射来自静态 `public/douban.json`(2026-09-11 起,D1 退役)—— **只读,无回填入口**。
 *  code 可为排期 code(3 位)或目录片 id(f###)。 */
function buildDoubanBlock(code: string, qZh: string, qEn: string): HTMLElement {
  const block = el("div", "border-t border-line pt-3");
  block.appendChild(el("div", "text-13 font-bold mb-2", "豆瓣"));

  const map = store.mappings.get(code);
  if (map?.douban_url) {
    const a = document.createElement("a");
    a.href = map.douban_url;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.className = "font-semibold";
    a.textContent = `豆瓣条目 ↗ ${map.title_cn ? "· " + map.title_cn : ""}`;
    block.appendChild(a);
    return block;
  }

  const search = el("div", "flex gap-3 items-center flex-wrap text-13");
  search.appendChild(el("span", "text-muted text-13", "未关联 — 点这里查豆瓣:"));
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
  block.appendChild(search);
  return block;
}