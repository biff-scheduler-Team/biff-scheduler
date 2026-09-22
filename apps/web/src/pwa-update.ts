// 发版后「新版接管 → 顶部提示 → 一键刷新」(2026-09-22,PLAN-20260922100704)。
//
// 为什么需要这一层:线上 `registerSW.js` 只注册 Service Worker,没有「新版接管后刷新」的逻辑;
// 而 workbox 把 `index.html` 带 revision 预缓存了(线上 sw.js 里
// `{url:"index.html",revision:"dec70d21…"}`),`vite.config.ts` 的
// `navigateFallback: "index.html"` 让导航请求直接吃这份缓存 ——
// **HTML 那层 `max-age=0, must-revalidate` 根本管不到 CacheStorage**。
// 于是:发版后首次打开仍是旧版,要再刷一次才更新;而 SPA 的站内跳转是 `pushState`、
// 不构成导航请求,所以一直开着的标签页永远等不到新版。
//
// 分工:
//   ① `createUpdateDetector` / `createThrottle` / `createOnceGuard` = 纯逻辑,**可单测**;
//   ② `installUpdateWatch` = 模块单例接线(挂监听 + 更新检查 + 给 React 的订阅口)。
//      它必须由 `main.tsx` **顶层**调用:注入的 `registerSW.js` 在 `window.load` 才注册,
//      而模块脚本的执行早于 `window.load` —— 只有这样才能保证「新版接管」的那次
//      `controllerchange` 不会在我们挂上监听之前就烧掉(那一次正是要修的现场)。

/** 更新检查的最小间隔。切回前台很频繁,不加这道闸门就变成对 `sw.js` 的轮询了。 */
export const UPDATE_CHECK_MIN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 定时兜底的间隔。
 * **不可省**:标签页一直开着、用户也不切走时,只有它能让本页发现新版
 * (SW 的自动更新检查只在导航时发生,而 SPA 站内跳转是 `pushState`)。
 */
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/**
 * 检测所需的最小输入。
 *
 * 传一个成员而不是直接吃 `EventTarget`,是为了单测不必伪造 DOM 的多重载 `addEventListener`;
 * 而 `controlled` 必须由调用方在**页面加载那一刻**取,晚一步就分不清
 * 「首次安装的 claim」与「新版接管」了。
 */
export interface UpdateWatchTarget {
  /** 加载那一刻本页是否已被 SW 控制。`false` = 首次访问,之后那次 claim 不算新版。 */
  readonly controlled: boolean;
  /** 订阅 `controllerchange`;返回退订函数。 */
  watchControllerChange(listener: () => void): () => void;
}

export interface UpdateDetector {
  /** 是否已检测到「新版已接管本页」。 */
  readonly available: boolean;
  /**
   * 订阅置位通知;返回退订函数。
   * 已在 `available` 时**不补发** —— 组件自己读一次初始值(这正是 `useSyncExternalStore` 的用法)。
   */
  subscribe(listener: () => void): () => void;
  /** 摘掉监听。 */
  dispose(): void;
}

/**
 * 判定「新版接管了本页」。
 *
 * 判据是 `controllerchange` **加上**「加载时就已经被 SW 控制」这道前提:
 * 首次访问时 SW 装完会主动 claim 本页(`clientsClaim()`),那一次同样触发 `controllerchange`,
 * 但它不是新版 —— 少了这道前提,新访客一进站就会看到升级提示。
 *
 * 幂等:同一实例只置位一次,重复的 `controllerchange`(多标签页 / 外部接管)不再通知。
 */
export function createUpdateDetector(target: UpdateWatchTarget): UpdateDetector {
  let controlled = target.controlled;
  let available = false;
  const listeners = new Set<() => void>();
  const onControllerChange = () => {
    // 首次安装的那次 claim:记下来,但不提示
    if (!controlled) {
      controlled = true;
      return;
    }
    if (available) return;
    available = true;
    for (const listener of listeners) listener();
  };
  const unwatch = target.watchControllerChange(onControllerChange);
  return {
    get available() {
      return available;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      unwatch();
      listeners.clear();
    },
  };
}

/**
 * 频率闸门:距上次放行不足 `minIntervalMs` 就拒掉。
 *
 * 用途是给**更新检查**去抖(`visibilitychange` 与定时器两处都可能同时触发),不是给 UI 动画去抖,
 * 所以记的是「上次放行时刻」,不做尾部延时。
 *
 * `now` 可注入,单测不必碰真时钟。
 */
export function createThrottle(
  minIntervalMs: number,
  now: () => number = () => Date.now(),
): () => boolean {
  // 初值取 -Infinity:第一次调用必须放行,否则首个「切回前台」会被自己的闸门吃掉
  let last = Number.NEGATIVE_INFINITY;
  return () => {
    const at = now();
    if (at - last < minIntervalMs) return false;
    last = at;
    return true;
  };
}

/** 一次性闸门:第一次返回 `true`,之后恒 `false`。保证「刷新」只真刷一次(连点 / 重复回调)。 */
export function createOnceGuard(): () => boolean {
  let spent = false;
  return () => {
    if (spent) return false;
    spent = true;
    return true;
  };
}

let detector: UpdateDetector | null = null;
let stopWatch: (() => void) | null = null;
const reloadGuard = createOnceGuard();

/**
 * 装上「新版接管」监听 + 更新检查。由 `main.tsx` 顶层调用(原因见文件头),重复调用幂等。
 *
 * 没有任何 SW 时(旧浏览器 / 被 e2e 的 `serviceWorkers: "block"` 屏蔽)是空操作。
 */
export function installUpdateWatch(): () => void {
  if (stopWatch) return stopWatch;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};
  const sw = navigator.serviceWorker;

  const throttle = createThrottle(UPDATE_CHECK_MIN_INTERVAL_MS);
  const check = () => {
    if (!throttle()) return;
    // 离线、注册失败、被 e2e 屏蔽都落在这里:更新检查是纯后台动作,
    // **不该产生任何可见副作用**(尤其不能变成未处理的 rejection),所以吞掉异常。
    void sw.ready
      .then(registration => registration.update())
      .catch(() => {
        // 刻意静默:见上
      });
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") check();
  };
  detector = createUpdateDetector({
    controlled: sw.controller != null,
    watchControllerChange: listener => {
      sw.addEventListener("controllerchange", listener);
      return () => sw.removeEventListener("controllerchange", listener);
    },
  });
  document.addEventListener("visibilitychange", onVisibilityChange);
  const timer = window.setInterval(check, UPDATE_CHECK_INTERVAL_MS);

  stopWatch = () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.clearInterval(timer);
    detector?.dispose();
    detector = null;
    stopWatch = null;
  };
  return stopWatch;
}

/** 给 `useSyncExternalStore` 用的订阅口。未安装时是空订阅。 */
export function subscribeUpdateAvailable(listener: () => void): () => void {
  const detach = detector?.subscribe(listener);
  return () => {
    detach?.();
  };
}

/** 给 `useSyncExternalStore` 用的快照。 */
export function getUpdateAvailable(): boolean {
  return detector?.available ?? false;
}

/** 用户点了「刷新」:新版 SW 已经在控制本页了,普通 reload 就能拿到新版(不需要清缓存)。 */
export function reloadForUpdate(): void {
  if (!reloadGuard()) return;
  window.location.reload();
}
