// Toast 单例(固定节点 #toast,见 index.html)—— main / settings / share 共用。
// 独立成模块,避免 settings / share 反向依赖 main。

let toastTimer: number | undefined;

export function toast(msg: string): void {
  const node = document.getElementById("toast");
  if (!node) return;
  node.textContent = msg;
  node.classList.remove("is-hidden");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.classList.add("is-hidden"), 3600);
}
