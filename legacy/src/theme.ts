// 外观主题:跟随系统 / 亮色(普通)/ 暗色 —— 顶栏三段选择器,点哪段就是哪段(不做循环)。
//
// 实现口径(2026-09-11):
//   · CSS 只认 `<html data-theme="dark" | "light">` —— style.css 的暗色 token 覆盖块由原先的
//     `@media (prefers-color-scheme: dark)` 改为 `:root[data-theme="dark"]`,**零重复**;
//   · 「跟随系统」**不在 CSS 里判**:本模块用 matchMedia 把系统深浅色解析成 light / dark 再落到
//     `data-theme` —— 三态共用同一套选择器,不必把整块暗色 token 抄两遍;系统外观变化时若仍是
//     「跟随系统」则即时重绘(见 bindSystem);
//   · 首屏防闪白:index.html 的 <head> 内联脚本在样式表之前先落一次 data-theme;本模块 boot 时再落
//     一次(兜住脚本被禁 / 旧缓存的场景)并接管系统变化监听;
//   · 持久化:并入 store.settings(LS `biff.settings.v1`,与其它设置同一份),键 = `theme`。

import type { ThemePref } from "./types";
import { setSettings, store } from "./state";

const MEDIA = "(prefers-color-scheme: dark)";

/** 三段的文案 / 图标 / tooltip 是**静态**的,直接写在 index.html 的 `#theme-switch` 上 ——
 *  这里不再复刻一份(否则改文案要改两处,且 renderThemeSeg 重建节点会让悬停 tooltip 闪)。
 *  本模块只负责:偏好 → data-theme 的落盘、持久化、系统变化监听,以及下面的输入校验。 */

/** 外部输入(data-* 属性)收口校验 —— 不信任字符串,避免拼错值静默落到「未设」 */
export function isThemePref(v: unknown): v is ThemePref {
  return v === "system" || v === "light" || v === "dark";
}

function prefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(MEDIA).matches
    : false;
}

/** 偏好 → **字面**主题(「跟随系统」在此就地解析成亮 / 暗) */
function resolve(pref: ThemePref): "light" | "dark" {
  if (pref === "system") return prefersDark() ? "dark" : "light";
  return pref;
}

/** 落盘到 <html>:data-theme 是 CSS 唯一入口;data-theme-pref 只作调试 / 无头验收锚点 */
function paint(pref: ThemePref): void {
  const root = document.documentElement;
  root.dataset.theme = resolve(pref);
  root.dataset.themePref = pref;
}

/** 当前偏好(未设过 → 跟随系统) */
export function themePref(): ThemePref {
  return store.settings.theme ?? "system";
}

let mediaBound = false;

/** 系统外观变化 → 仅在「跟随系统」时重绘(显式亮 / 暗不该被系统覆盖) */
function bindSystem(): void {
  if (mediaBound || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  mediaBound = true;
  window.matchMedia(MEDIA).addEventListener("change", () => {
    if (themePref() === "system") paint("system");
  });
}

/** 设偏好并持久化(走 store.settings —— 与其它设置同一份,刷新 / 重开都记得)。
 *  setSettings 会广播 → main 侧重绘顶栏分段选中态。 */
export function setThemePref(pref: ThemePref): void {
  paint(pref);
  setSettings({ theme: pref });
}

/** boot 时调用:落一次 data-theme(内联脚本已落过,这里兜住旧缓存)并接管系统变化监听 */
export function initTheme(): void {
  paint(themePref());
  bindSystem();
}
