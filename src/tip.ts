// 即时悬停说明(tooltip)— 替代浏览器原生 title 的延迟与不可控样式。
// 触发:任意带 data-tip 的元素。内容为**纯文本**(不渲染 HTML/Markdown → 无 XSS 面),
// 用 \n 分行,约定极简结构:
//   · 第 1 行 = 标题(加粗 + 底部细分隔线);
//   · 其余行 = 分点条目(自动加 · 悬挂缩进;行内首段含 " — " 时加粗前段,便于扫读缩写表);
//   · 只有 1 行 = 直接作正文段落 —— 靠 tip-card 的窄宽自然折行(不再被拉成「一整条」)。
// 单例 DOM + 文档级事件委托;对卡片/行程重建安全(元素重建无需重新绑定)。
// 外观全 Tailwind utility(宽度上限用 style.css 的 @utility tip-card);显隐走 is-hidden。

import { el } from "./util";

const TIP_DELAY = 80; // ms,扫过不闪
const TIP_GAP = 14; // 距光标偏移 px
const EDGE = 8; // 距视口边缘留白 px

const TIP_CLS =
  "fixed z-[300] tip-card px-[11px] py-[9px] rounded-9 text-12 leading-[1.55] " +
  "bg-[var(--toast-bg)] text-on-brand pointer-events-none " +
  "shadow-[var(--shadow-modal)] is-hidden";

let tipEl: HTMLDivElement | null = null;
let cur: HTMLElement | null = null; // 当前触发元素
let timer: number | undefined;
let bound = false;
/** 最近一次指针坐标 —— 延迟显示时用的是「最新」位置,而不是事件快照(80ms 内光标会移动) */
let lastX = 0;
let lastY = 0;

function ensure(): HTMLDivElement {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = TIP_CLS;
    tipEl.setAttribute("role", "tooltip");
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

/** 一条分点:· + 正文(首段含 " — " 时前段加粗,如「CODE 001 — 场次编号…」) */
function bulletRow(text: string): HTMLElement {
  const row = el("div", "flex gap-[6px]");
  row.appendChild(el("span", "shrink-0 text-on-brand/55", "·"));
  const body = el("span", "min-w-0");
  const dash = text.indexOf(" — ");
  if (dash > 0) {
    body.append(el("b", "font-semibold", text.slice(0, dash)), document.createTextNode(text.slice(dash)));
  } else {
    body.textContent = text;
  }
  row.appendChild(body);
  return row;
}

/** 把 data-tip 文本渲染成「标题 + 分点」结构(单行则退化为纯段落) */
function paint(node: HTMLDivElement, text: string): void {
  node.replaceChildren();
  const lines = text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length <= 1) {
    node.textContent = lines[0] ?? "";
    return;
  }
  node.appendChild(el("div", "font-semibold mb-[6px] pb-[5px] border-b border-white/20", lines[0]));
  const list = el("div", "flex flex-col gap-[4px]");
  for (const line of lines.slice(1)) list.appendChild(bulletRow(line));
  node.appendChild(list);
}

function hide(): void {
  window.clearTimeout(timer);
  timer = undefined;
  cur = null;
  tipEl?.classList.add("is-hidden");
}

/** 供外部主动收起(如打开弹层时)—— 触屏点带 data-tip 的元素会显示提示,
 *  若该元素同时打开弹层,提示会浮在弹层之上,故开层前先收掉。 */
export function hideTip(): void {
  hide();
}

/** 为某元素显示提示(延迟 TIP_DELAY;坐标取 `lastX/lastY`,调用方负责先更新) */
function showAt(host: HTMLElement): void {
  if (cur === host && tipEl && !tipEl.classList.contains("is-hidden")) return; // 已在显示,仅挪位置
  cur = host;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    const el = ensure();
    paint(el, host.dataset.tip ?? "");
    el.classList.remove("is-hidden"); // 先显示再量尺寸(offsetWidth/Height 需要可见)
    place(el, lastX, lastY);
  }, TIP_DELAY);
}

/** 指针进入带 data-tip 的元素:记坐标 + 请求显示 */
function show(e: PointerEvent): void {
  const host = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-tip]");
  if (!host) return;
  lastX = e.clientX;
  lastY = e.clientY;
  showAt(host);
}

function place(el: HTMLDivElement, x: number, y: number): void {
  el.style.left = "0px";
  el.style.top = "0px";
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = x + TIP_GAP;
  if (left + w > vw - EDGE) left = Math.max(EDGE, x - w - TIP_GAP); // 右侧放不下 → 放左侧
  let top = y + TIP_GAP;
  if (top + h > vh - EDGE) top = Math.max(EDGE, y - h - TIP_GAP); // 下方放不下 → 翻到上方
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function move(e: PointerEvent): void {
  lastX = e.clientX;
  lastY = e.clientY;
  if (cur && tipEl && !tipEl.classList.contains("is-hidden")) place(tipEl, e.clientX, e.clientY);
}

function onOver(e: PointerEvent): void {
  if ((e.target as HTMLElement | null)?.closest?.("[data-tip]")) show(e);
}

function onOut(e: PointerEvent): void {
  const rel = e.relatedTarget instanceof Node ? (e.relatedTarget as HTMLElement) : null;
  // 移到另一个(或同一 host 内子元素)data-tip 区 → 交给 pointerover 接管更新文本,避免连续徽章间闪烁
  if (rel?.closest?.("[data-tip]")) return;
  hide();
}

/** pointerdown 兜底:
 *  · 鼠标 → 收起(点击 / 拖动前不让提示残留);
 *  · 触屏 → 没有 hover,点一下带 data-tip 的元素就**显示**提示(再点别处收起),
 *    否则全站只存在于 data-tip 的信息(场次数 / 转场算式 / 徽章含义)在触屏上完全不可达。 */
function onDown(e: PointerEvent): void {
  if (e.pointerType === "touch") {
    const host = (e.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-tip]");
    if (host) {
      lastX = e.clientX;
      lastY = e.clientY;
      showAt(host);
      return;
    }
  }
  hide();
}

/** 键盘可达:focus 到带 data-tip 的元素时同样显示(锚在元素左下角) */
function onFocusIn(e: FocusEvent): void {
  const host = (e.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-tip]");
  if (!host) return;
  const r = host.getBoundingClientRect();
  lastX = r.left;
  lastY = r.bottom;
  showAt(host);
}

function onFocusOut(e: FocusEvent): void {
  const rel = e.relatedTarget instanceof Node ? (e.relatedTarget as HTMLElement) : null;
  if (rel?.closest?.("[data-tip]")) return;
  hide();
}

function onScroll(): void {
  hide(); // 滚动/拖动平移时收起,避免悬空
}

/** 模块启动时绑定一次(文档级委托,渲染重建无需重绑) */
export function attachTip(): void {
  if (bound) return;
  bound = true;
  document.addEventListener("pointerover", onOver);
  document.addEventListener("pointerout", onOut);
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  document.addEventListener("scroll", onScroll, true);
}
