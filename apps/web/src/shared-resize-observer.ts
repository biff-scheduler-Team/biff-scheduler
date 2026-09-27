/**
 * 共享的 ResizeObserver(2026-09-28,PLAN-20260928003736)。
 *
 * 为什么:红黑榜有近 300 张卡,每张卡的贴纸画布各自 `new ResizeObserver(...)` 就是 300 个实例
 * 常驻内存。而它们要做的事**完全一样** —— 把「内容盒尺寸」回给对应的那个元素。一个实例就够。
 *
 * 做法:模块级单例 + 一张 `WeakMap<Element, 回调>`。回调**按 `entry.target` 分发** ——
 * 共享之后一次回调可能带着多个元素的 entry 一起来,不能假设「一次只观测一个元素」。
 *
 * ⚠ 用 WeakMap 而不是 Map:万一某处漏了取消观测,元素被回收后那条回调也跟着消失,
 *   不会留下一张永远不再被访问、却一直握着 DOM 引用的表。
 * ⚠ 本模块**不在 import 期碰 DOM**(`ResizeObserver` 只在首次调用时才读,且带 `typeof` 守卫),
 *   所以 node 环境的单测可以直接 import 它。
 */

type ResizeCallback = (width: number, height: number) => void;

const callbacks = new WeakMap<Element, ResizeCallback>();
let observer: ResizeObserver | null = null;

/** 取(必要时创建)单例。环境不支持时返回 null —— 调用方降级为「不观测」,不是报错。 */
function sharedObserver(): ResizeObserver | null {
  if (typeof ResizeObserver === "undefined") return null;
  if (!observer) {
    observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // contentRect 是**内容盒**(不含 padding / border)—— 与改造前 `StickerCanvas` 读的口径逐字一致
        callbacks.get(entry.target)?.(entry.contentRect.width, entry.contentRect.height);
      }
    });
  }
  return observer;
}

/** 观测一个元素的尺寸,返回**取消观测**函数(在 `useEffect` 的 cleanup 里调用)。
 *
 * ⚠ 刻意只给「成对的一个入口」:回调表里删条目与 `unobserve` 必须一起发生 ——
 *   拆成两个函数迟早会被只调用一半(表删了但还在观测,或反过来)。
 * ⚠ 同一个元素被重复观测时,`observe` 本身幂等,而回调以**最后一次**注册的为准。 */
export function observeResize(el: Element, cb: ResizeCallback): () => void {
  const shared = sharedObserver();
  if (!shared) return () => {};
  callbacks.set(el, cb);
  shared.observe(el);
  return () => {
    callbacks.delete(el);
    shared.unobserve(el);
  };
}
