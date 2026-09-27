/**
 * 元素「离视口够近吗」(2026-09-22,PLAN-20260922145815)。
 *
 * 红黑榜有近 300 张卡,而人一次只看得到 4~6 张 —— 为全部 300 张都画贴纸是纯浪费。
 * 这里只回答「这张卡在不在视口附近」,由调用方决定画什么(画布分配、贴纸绘制)。
 *
 * ⚠ **2026-09-28 改为共享单例**(PLAN-20260928003736):改造前每个 `useInView` 各 `new` 一个
 *   `IntersectionObserver`,299 张卡就是 299 个实例常驻。现在按 `rootMargin` 分档共享 ——
 *   同一档的元素共用一个 Observer,回调经一张 WeakMap 按 `entry.target` 分发。
 *   对外签名与行为完全不变,调用方一行都不用改。
 * ⚠ 为什么按 `rootMargin` 分档而不是只留一个:同一个 Observer 只能有一个 rootMargin。
 *   硬把不同档混在一起就得取最宽的那个,那等于**悄悄改掉别人的预取距离**(有的卡会白画一屏);
 *   分档之后,没传自定义值的调用点依旧全部落在默认那一个实例上(当前代码里只有默认档)。
 * ⚠ 单独成文件而不是塞进 `redblack.ts`:本模块**碰 DOM**,而 `redblack.ts` 被 node 环境的
 *   单测 import,import 期禁止碰 DOM(见 `apps/web/vitest.config.ts`)。
 */

import { useEffect, useState } from "react";

/** 预取边距:比视口再往外一屏。滚动时等这张卡真的露出来,它上一帧就已经画好了 ——
 *  边距取 0 会看到「空画布 → 突然满贴纸」,快速滚动时尤其明显。 */
export const VIEW_MARGIN = "1200px 0px";

/** 元素 → 状态更新函数。⚠ WeakMap:漏了清理也不会把 DOM 引用一直握在手里 */
const callbacks = new WeakMap<Element, (inView: boolean) => void>();

/** 按 `rootMargin` 分档的共享观察者 */
const observers = new Map<string, IntersectionObserver>();

function observerFor(rootMargin: string): IntersectionObserver {
  let shared = observers.get(rootMargin);
  if (!shared) {
    shared = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting);
      },
      { rootMargin },
    );
    observers.set(rootMargin, shared);
  }
  return shared;
}

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
    const observer = observerFor(rootMargin);
    callbacks.set(node, setInView);
    observer.observe(node);
    return () => {
      observer.unobserve(node);
      callbacks.delete(node);
    };
  }, [ref, rootMargin]);

  return inView;
}
