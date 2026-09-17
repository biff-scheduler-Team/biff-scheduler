// 全站唯一的 toast 出口。
//
// 为什么需要这一层:S2 的 `ToastQueue` 在 `addToast` 里这样算自动关闭时间
// (`node_modules/@react-spectrum/s2/src/Toast.tsx`):
//   `let timeout = options.timeout && !options.actionLabel ? Math.max(options.timeout, 5000) : undefined;`
// —— **不传 `timeout` 就得到 `undefined`,队列永不自动关闭**,提示会一直钉在屏幕底部
// (`ToastContainer` 默认 `placement="bottom"`)。旧版是 3600ms 自动收起(`legacy/src/toast.ts`),
// React 版换成 S2 后这个默认值丢了:全仓 30+ 处没写 `timeout` 的调用(加入选片 / 发布建议 /
// 删除留言…)只要触发一次就永久占屏。所以默认值只在**这一处**兜,不在 30 个调用点各写一份。
//
// 为什么是 5000 而不是旧版的 3600:S2 对非 `actionLabel` 的 toast 有 **5000ms 下限**,
// 传更小的值也会被 `Math.max` 抬上去 —— 写 3600 只会让读代码的人以为它真的 3.6 秒。
// 调用方仍可用 `{ timeout }` 覆盖(同样受这个下限约束)。

import { ToastQueue as SpectrumToastQueue, type ToastOptions } from "@react-spectrum/s2/Toast";

/** 未指定 `timeout` 时的自动收起时间(毫秒),等于 S2 允许的最小值。 */
export const DEFAULT_TOAST_TIMEOUT = 5000;

type ToastFn = (children: string, options?: ToastOptions) => () => void;

/** 包一层:**只**补默认 timeout,其余 options 原样透传(调用方显式给的值优先)。 */
function withDefaultTimeout(add: ToastFn): ToastFn {
  return (children, options) =>
    add(children, { timeout: DEFAULT_TOAST_TIMEOUT, ...options });
}

export const ToastQueue = {
  neutral: withDefaultTimeout(SpectrumToastQueue.neutral),
  positive: withDefaultTimeout(SpectrumToastQueue.positive),
  negative: withDefaultTimeout(SpectrumToastQueue.negative),
  info: withDefaultTimeout(SpectrumToastQueue.info),
};
