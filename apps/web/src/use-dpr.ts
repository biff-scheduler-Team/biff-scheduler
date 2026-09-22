/**
 * 当前 `devicePixelRatio`(2026-09-22,PLAN-20260922145815)。
 *
 * 为什么不能只靠 `resize`:把窗口从 MacBook 主屏(DPR=2)拖到外接屏(DPR=1)、
 * 或浏览器里 Cmd/Ctrl +/- 缩放网页,**都不会触发 `resize`** —— ResizeObserver 同样捕不到
 * (元素的 CSS 尺寸没变)。不重算 dpr,canvas 的 backing store 就还是旧倍率,贴纸会发糊。
 *
 * ⚠ 坑:`matchMedia("(resolution: 2dppx)")` **只在 DPR 恰好等于该值时匹配**,
 *   所以 `change` 只会触发一次。修法是把 effect 的依赖设成 `dpr` —— dpr 一变就重新
 *   用新值建查询、旧监听由 cleanup 摘掉,天然「重挂」。
 */

import { useEffect, useState } from "react";

function readDpr(): number {
  if (typeof window === "undefined") return 1;
  return window.devicePixelRatio || 1;
}

export function useDpr(): number {
  const [dpr, setDpr] = useState(readDpr);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = () => setDpr(readDpr());
    const cleanups: Array<() => void> = [];

    if (typeof window.matchMedia === "function") {
      const query = window.matchMedia(`(resolution: ${dpr}dppx)`);
      query.addEventListener("change", sync);
      cleanups.push(() => query.removeEventListener("change", sync));
    }
    // `matchMedia` 兜不到的情况(部分浏览器的显示缩放)拿 resize 补一刀:
    // 值没变时 setState 会被 React 直接跳过,所以这里不会有额外渲染
    window.addEventListener("resize", sync);
    cleanups.push(() => window.removeEventListener("resize", sync));

    return () => {
      for (const off of cleanups) off();
    };
  }, [dpr]);

  return dpr;
}
