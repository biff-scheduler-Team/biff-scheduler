/**
 * 元素「离视口够近吗」(2026-09-22,PLAN-20260922145815)。
 *
 * 红黑榜有近 300 张卡,而人一次只看得到 4~6 张 —— 为全部 300 张都画贴纸是纯浪费。
 * 这里只回答「这张卡在不在视口附近」,由调用方决定画什么(画布分配、贴纸绘制)。
 *
 * ⚠ 单独成文件而不是塞进 `redblack.ts`:本模块**碰 DOM**,而 `redblack.ts` 被 node 环境的
 *   单测 import,import 期禁止碰 DOM(见 `apps/web/vitest.config.ts`)。
 */

import { useEffect, useState } from "react";

/** 预取边距:比视口再往外一屏。滚动时等这张卡真的露出来,它上一帧就已经画好了 ——
 *  边距取 0 会看到「空画布 → 突然满贴纸」,快速滚动时尤其明显。 */
export const VIEW_MARGIN = "1200px 0px";

export function useInView(
  ref: React.RefObject<Element | null>,
  rootMargin: string = VIEW_MARGIN,
): boolean {
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // 环境不支持 IntersectionObserver 时**当作在视口内**:宁可多画几张,
    // 也不要整页画布空白(画不出来比画得慢严重得多)
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setInView(entry.isIntersecting);
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, rootMargin]);

  return inView;
}
