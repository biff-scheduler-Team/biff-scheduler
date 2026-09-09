// 即时悬停说明(tooltip)— 替代浏览器原生 title 的延迟与不可控样式。
// 触发:任意带 data-tip 的元素;纯文本,支持 \n 换行(pre-line 渲染)。
// 单例 DOM + 文档级事件委托;对卡片/行程重建安全(元素重建无需重新绑定)。
// 全量化:外观全 Tailwind utility;显隐走 is-hidden(@utility,style.css 定义)。

const TIP_DELAY = 80; // ms,扫过不闪
const TIP_GAP = 14; // 距光标偏移 px

const TIP_CLS =
  "fixed z-[300] max-w-[70vw] px-[10px] py-[7px] rounded-[8px] text-[12px] leading-[1.5] " +
  "bg-[var(--toast-bg)] text-on-brand whitespace-pre-line pointer-events-none " +
  "shadow-[var(--shadow-modal)] is-hidden";

let tipEl: HTMLDivElement | null = null;
let cur: HTMLElement | null = null; // 当前触发元素
let timer: number | undefined;
let bound = false;

function ensure(): HTMLDivElement {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = TIP_CLS;
    tipEl.setAttribute("role", "tooltip");
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

function hide(): void {
  window.clearTimeout(timer);
  timer = undefined;
  cur = null;
  tipEl?.classList.add("is-hidden");
}

function show(e: PointerEvent): void {
  const host = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-tip]");
  if (!host) return;
  if (cur === host && tipEl && !tipEl.classList.contains("is-hidden")) return; // 已在显示,仅挪位置
  cur = host;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    const el = ensure();
    el.textContent = host.dataset.tip ?? "";
    el.classList.remove("is-hidden");
    place(el, e.clientX, e.clientY);
  }, TIP_DELAY);
}

function place(el: HTMLDivElement, x: number, y: number): void {
  el.style.left = "0px";
  el.style.top = "0px";
  const w = el.offsetWidth;
  const vw = window.innerWidth;
  let left = x + TIP_GAP;
  if (left + w > vw - 8) left = Math.max(8, x - w - TIP_GAP); // 右侧放不下 → 放左侧
  el.style.left = `${left}px`;
  el.style.top = `${y + TIP_GAP}px`; // 下方溢出交给滚动,通常卡片在中上部
}

function move(e: PointerEvent): void {
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
  document.addEventListener("pointerdown", hide, true); // 点击/拖动前收起,避免弹层打开后残留
  document.addEventListener("scroll", onScroll, true);
}
