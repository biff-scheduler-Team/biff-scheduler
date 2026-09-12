// 弹层:通用容器 + 影片资料(片名 / 元信息 / 豆瓣映射管理)。
// 2026-09-10:弹层不再列「同片全部场次」—— 唯一场次列表收敛到「影片库」行内展开
// (library.ts,那里同时给「定位 ▸」与三态「＋ 加入」),避免同一部片出现两份排片列表。
// 全量化:overlay / modal / 资料弹层结构 全部 Tailwind utility。

import type { Catalog, DoubanRec, FestRef, FilmItem, Mapping } from "./types";
import { bilingualTitle, displayTitle, doubanScoreOf, el, filmEnName, filmInfoOf } from "./util";
import { doubanChip } from "./legend";
import { introOf } from "./intros";
import { KIND_LABEL, formatKrw, programOf } from "./extras";
import { indexFestival, recsOf, splitRelated } from "./related";
import { slotOf, store } from "./state";
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

/** 弹层宽度档:`md` 520 / `lg` 640 / `xl` 880。
 *  `xl` 是**说明类长文档**专用(2026-09-11 重排「日程表说明」时加回 —— 旧的那个 1280 双栏档
 *  已随「影片库 · 我的选片」改成挤压式抽屉而删除,这里是新语义、新宽度):字段表 / 影院表
 *  在 640 下三列挤成一团,880 才让每行有呼吸位。
 *  兼容旧的布尔第三参 —— `true → lg`、`false / 省略 → md`(存量调用点不必改)。 */
export type ModalSize = "md" | "lg" | "xl";

const MODAL_WIDTH: Record<ModalSize, string> = {
  md: "w-[520px]",
  lg: "w-[640px]",
  xl: "w-[880px]",
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
 *    ② 已加入 = **绿描边按钮**(绿勾 + 绿字,与「＋ 加入」**等宽**)—— 原先做成无底无框的
 *       纯状态标签,但那样按钮一窄就把左侧「定位 ▸」顶走(见 `short` 的等宽注释);现改为同宽按钮,
 *       hover 转红 = 移出。⚠ 仍**保留可点 = 移出**(否则这里就失去了移除入口),
 *       tooltip 明说「点击移出」。
 *  ⚠ 2026-09-11 起**方案(A/B)已移除**(`PLAN-20260911190000` D7)—— 原「⇄ 已在 B 方案」那态随方案
 *  概念一起删掉:一场不再有归属歧义,「已加入 / 未加入」两态即全部语义。
 *  ⚠ `short` = **紧凑档**(2026-09-11 四改):抽屉里的场次行第 1 行要留宽度给章组,
 *  故那里只渲染一枚符号(文案全走 `data-tip`)。弹层里有的是地方,继续用 `label`。
 *  两者必须**同源**在这里改,否则抽屉与弹层会显示成两种语义。
 *  ⚠ **两态必须等宽**(2026-09-11 五改):原先「已加入」是无底无框的纯状态标签,宽度从 ≈32px 掉到
 *  ≈7px —— 按钮一窄,左侧「定位 ▸」整枚右移,用户刚点完「＋ 加入」就得重新找定位按钮
 *  (用户原话:「加入方案按钮点击后会变小,然后定位按钮会偏移,请你把对钩也放到按钮里面,
 *  和 + 号一样大小」)。现在两态共用同一个盒子 + `min-w` + 内容居中,宽度恒定。 */
export function actState(code: string): { label: string; short: string; cls: string; tip: string } {
  const btn =
    "border rounded-6 px-[9px] py-[3px] text-12 font-bold whitespace-nowrap " +
    "transition-[background-color,border-color,color] duration-[120ms] active:translate-y-px ";
  /** 抽屉里的**紧凑档** = 同一个盒子 + `min-w` + 内容居中 —— 三态宽度恒定,
   *  「＋ 加入 ↔ ✓ 已加入」切换时按钮不缩放,左侧「定位 ▸」也就不会偏移。 */
  const shortCls = btn + "min-w-[36px] inline-flex items-center justify-center ";
  const hit = slotOf(code);
  if (hit) {
    return {
      label: "✓ 已加入",
      short: "✓",
      cls: shortCls + "border-ok bg-card text-ok hover:border-conf hover:text-conf",
      tip: "该场已在行程里 — 点击移出(影片仍留在「我的选片」,标注「未排场」)",
    };
  }
  return {
    label: "＋ 加入",
    short: "＋",
    cls: shortCls + "border-line bg-card text-ink hover:border-biff hover:text-biff-ink",
    tip: "把该场加入行程",
  };
}

/** 排期 code → 命中的目录条目(走 `filmInfoOf` 的**同一套命中口径**,不再自写一份)。 */
function filmOf(cat: Catalog, code: string): FilmItem | null {
  const s = cat.byCode.get(code);
  if (!s) return null;
  return filmInfoOf(cat, s).cats[0] ?? null;
}

/** 海报图(弹层大图档)—— 缺图返回 null,调用方据此不留空位 */
function posterEl(src: string | undefined): HTMLElement | null {
  if (!src) return null;
  const img = document.createElement("img");
  img.src = src;
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  img.className = "w-[124px] h-[175px] object-cover rounded-8 border border-line bg-raised shrink-0";
  return img;
}

export function showFilmModal(code: string, ctx: FilmModalCtx): void {
  const anchor = ctx.cat.byCode.get(code);
  if (!anchor) return;
  const body = el("div", "film-modal");
  const film = filmOf(ctx.cat, code);

  // ---- 片名区(16-A:有组评价则显示「豆 x.x」)----
  // 有海报 → 左图右文;没有则维持原来的整行文本(不占空位,见 row.ts::cardHead 同一条理由)
  const poster = posterEl(film?.poster);
  const head = el("div", poster ? "flex gap-[14px] items-start mb-3" : "mb-3");
  if (poster) head.appendChild(poster);
  const meta = el("div", poster ? "min-w-0 flex-1" : "");
  // 片名口径:「英文名 · 中文名」(见 util.ts::bilingualTitle)—— 英文名已含在首行,不再另起一行
  const title = displayTitle(anchor, ctx.mappings.get(code)?.title_cn);
  meta.appendChild(el("div", "text-18 font-bold", title));
  if (anchor.title_kr && anchor.title_kr !== anchor.title_en) {
    meta.appendChild(el("div", "text-muted text-13", anchor.title_kr));
  }
  if (film) {
    const bits = [film.unit, film.country, film.year ? String(film.year) : "", film.director].filter(Boolean);
    if (bits.length) meta.appendChild(el("div", "text-muted text-13", bits.join(" · ")));
  }
  const score = doubanScoreOf(film, ctx.mappings.get(code));
  if (score) meta.appendChild(doubanChip(score.rating, "mt-2", score.count));
  head.appendChild(meta);
  body.appendChild(head);
  const intro = appendIntro(ctx.mappings.get(code)?.subject_id);
  if (intro) body.appendChild(intro);

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

  // ---- 活动节目区(仅 Master Class / Actors' House / Cine Class / Special Talk)----
  //  排期页只印「时间 + 厅 + 片名」,嘉宾 / 简介 / 票价只在官网活动页上 —— 见 tools/scrape_biff_extras.py。
  const prog = programOf(code);
  if (prog) body.appendChild(buildProgramBlock(prog));

  // ---- 豆瓣区(条目直链 + 相关电影)----
  body.appendChild(buildDoubanBlock(code, anchor.title_zh || "", anchor.title_en, ctx));

  openModal(`资料 · ${title}`, body, "lg");
}

/** 活动节目块:形式 + 嘉宾 + 语言 + 票价 + 简介(排期页不印的都在这里)。 */
function buildProgramBlock(prog: NonNullable<ReturnType<typeof programOf>>): HTMLElement {
  const box = el(
    "div",
    "mb-[14px] border border-biff-line rounded-9 bg-biff-soft px-[10px] py-2 grid gap-[3px]"
  );
  box.appendChild(el("div", "text-13 font-bold text-biff-ink", KIND_LABEL[prog.kind]));
  const bits: string[] = [];
  if (prog.guest) bits.push(prog.guestZh ? `${prog.guestZh} ${prog.guest}` : prog.guest);
  if (prog.language) bits.push(prog.language);
  if (prog.priceKrw) bits.push(formatKrw(prog.priceKrw));
  if (bits.length) box.appendChild(el("div", "text-13 font-semibold text-ink", bits.join(" · ")));
  if (prog.bio) box.appendChild(el("div", "text-12 text-ink-2 leading-[1.6]", prog.bio));
  if (prog.dateText) box.appendChild(el("div", "text-11 text-muted", `官网原文 · ${prog.dateText}`));
  return box;
}

/** 目录片资料(暂无排期):元信息 + 评分 + 豆瓣区(先关联,Catalogue 排期接入后同片自动带出) */
export function showCatalogFilmModal(
  filmId: string,
  ctx: Pick<FilmModalCtx, "cat" | "mappings">
): void {
  const film = ctx.cat.films.find((f) => f.id === filmId);
  if (!film) return;
  const body = el("div", "film-modal");
  // 片名口径:「英文名 · 中文名」(无排期 → 英文位取目录官方英文名,见 util.ts::filmEnName);
  // 两者皆缺时退回目录 id(不印空标题)
  const title = bilingualTitle(filmEnName(film), film.title_zh) || film.id;

  // ---- 片名 / 元信息区(有海报 → 左图右文) ----
  const poster = posterEl(film.poster);
  const head = el("div", poster ? "flex gap-[14px] items-start mb-3" : "mb-3");
  if (poster) head.appendChild(poster);
  const meta = el("div", poster ? "min-w-0 flex-1" : "");
  meta.appendChild(el("div", "text-18 font-bold", title));
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
  const score = doubanScoreOf(film, ctx.mappings.get(filmId));
  if (score) meta.appendChild(doubanChip(score.rating, "mt-2", score.count));
  head.appendChild(meta);
  body.appendChild(head);
  const intro = appendIntro(ctx.mappings.get(filmId)?.subject_id);
  if (intro) body.appendChild(intro);

  body.appendChild(
    el(
      "div",
      "text-12 text-muted leading-[1.6] mb-[10px]",
      "该片暂无已发布排期 — 可先关联豆瓣条目,Catalogue 排期(预计 9/11)公布接入后,同片会自动带出该关联。"
    )
  );

  // ---- 豆瓣区(code = 目录片 id,如 f001)----
  // 英文搜索用**官方英文名**(`filmEnName`);`title_orig` 在新 schema 里是原始韩/日文名,拿去搜豆瓣必空
  body.appendChild(buildDoubanBlock(film.id, film.title_zh || "", filmEnName(film), ctx));
  openModal(`资料 · ${title}`, body, "lg");
}

/** 豆瓣简介:有才占位。`whitespace-pre-wrap` 保留原文换行。 */
function appendIntro(subjectId: number | null | undefined): HTMLElement | null {
  const text = introOf(subjectId ?? null);
  if (!text) return null;
  const p = el("div", "text-13 text-ink-2 leading-[1.7] mb-[14px] whitespace-pre-wrap");
  p.dataset.intro = "1";
  p.textContent = text;
  return p;
}

/** 豆瓣区:有映射 → 条目直链;无映射 → 中英文搜索外链(兜底)。
 *  映射来自静态 `public/douban.json`(2026-09-11 起,D1 退役)—— **只读,无回填入口**。
 *  有推荐产物时在直链下方追加「本届也在放 / 豆瓣也推荐」(见 `related.ts`)。
 *  code 可为排期 code(3 位)或目录片 id(f###)。 */
function buildDoubanBlock(code: string, qZh: string, qEn: string, ctx: FilmModalCtx): HTMLElement {
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
    const related = buildRelatedList(map.subject_id, ctx);
    if (related) block.appendChild(related);
    return block;
  }

  const search = el("div", "flex gap-3 items-center flex-wrap text-13");
  search.appendChild(el("span", "text-muted text-13", "未关联 — 点这里查豆瓣:"));
  // ⚠ 「中文搜索」只送**中文名** —— 曾经拼成 `${qZh} ${qEn}`,豆瓣会把整串当片名去匹配,
  //    中英混排(如「Satoko总是这样 Satoko Always」)反而一条都搜不到。
  //    无中文名(纯英文片)时退回英文名,否则链接会搜空白。
  const q = encodeURIComponent(qZh.trim() || qEn.trim());
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

const REL_ROW_CLS =
  "w-full flex items-center gap-2 text-left py-[6px] px-1 -mx-1 rounded-6 hover:bg-hover border-0 bg-transparent text-ink no-underline cursor-pointer";

/** 推荐列表:本届命中整行压栈打开资料;站外最多 6 条外链。两段都空 → null(不占位)。 */
function buildRelatedList(subjectId: number | null, ctx: FilmModalCtx): HTMLElement | null {
  if (subjectId == null) return null;
  const sid = String(subjectId);
  const fest = indexFestival(store.mappings);
  const split = splitRelated(recsOf(sid), sid, fest);
  if (!split.festival.length && !split.more.length) return null;

  const box = el("div", "mt-3 grid gap-2");
  box.dataset.related = "1";
  if (split.festival.length) {
    box.appendChild(relatedSection("本届也在放", "festival", split.festival.map((rec) => {
      const ref = fest.get(rec.id);
      const film = ref?.filmId ? ctx.cat.films.find((f) => f.id === ref.filmId) : undefined;
      return relatedRow(rec, {
        badge: "本届",
        poster: film?.poster,
        onOpen: ref ? () => openRelatedFilm(ref, ctx) : undefined,
      });
    })));
  }
  if (split.more.length) {
    box.appendChild(relatedSection("豆瓣也推荐", "more", split.more.map((rec) => relatedRow(rec, {}))));
  }
  return box;
}

function relatedSection(title: string, kind: string, rows: HTMLElement[]): HTMLElement {
  const box = el("div", "grid gap-[2px]");
  box.dataset.relatedKind = kind;
  box.appendChild(el("div", "text-12 font-bold text-muted", title));
  for (const row of rows) box.appendChild(row);
  return box;
}

function openRelatedFilm(ref: FestRef, ctx: FilmModalCtx): void {
  hideTip();
  if (ref.code) showFilmModal(ref.code, ctx);
  else if (ref.filmId) showCatalogFilmModal(ref.filmId, ctx);
}

function relatedRow(
  rec: DoubanRec,
  opts: { badge?: string; poster?: string; onOpen?: () => void }
): HTMLElement {
  const isFest = Boolean(opts.onOpen);
  const row = isFest ? el("button", REL_ROW_CLS) : document.createElement("a");
  row.className = REL_ROW_CLS;
  if (isFest) {
    (row as HTMLButtonElement).type = "button";
    row.addEventListener("click", () => opts.onOpen?.());
    row.dataset.tip = "打开这部片的资料";
    row.dataset.relatedOpen = rec.id;
  } else {
    const a = row as HTMLAnchorElement;
    a.href = rec.url;
    a.target = "_blank";
    a.rel = "noreferrer";
  }
  if (opts.poster) {
    const img = document.createElement("img");
    img.src = opts.poster;
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.className = "w-9 h-[51px] object-cover rounded-5 border border-line bg-raised shrink-0";
    row.appendChild(img);
  }
  const text = el("div", "min-w-0 flex-1");
  text.appendChild(el("div", "text-13 font-semibold truncate", rec.title));
  const bits = [rec.year, rec.rating != null ? `豆 ${rec.rating}` : ""].filter(Boolean);
  if (bits.length) text.appendChild(el("div", "text-11 text-muted", bits.join("  ")));
  row.appendChild(text);
  if (opts.badge) row.appendChild(el("span", "text-11 font-bold text-biff shrink-0", opts.badge));
  else if (!isFest) row.appendChild(el("span", "text-12 text-muted shrink-0", "↗"));
  return row;
}