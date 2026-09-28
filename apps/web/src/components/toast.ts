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
//
// 同一段公式还有**第二个**分支(`!options.actionLabel`)没被兜住(2026-09-28,PLAN-20260928120415):
// 带 `actionLabel` 时 `timeout` 也恒为 `undefined` —— S2 的注释写明这是**故意**的
// ("Actionable toasts cannot be auto dismissed. That would fail WCAG SC 2.2.1"),
// 于是带「撤销」按钮的提示**永不关闭**(用户报的「《蓦然回首》的贴纸收回暂存区了。一直都不消失」)。
// 本层因此对 action 场景**自己补一个收口定时器**:S2 那条 `timeout` 在 action 场景是被它自己
// 忽略的,所以口径也**统一以 `DEFAULT_TOAST_TIMEOUT` 为准**,不看调用方写了多少 ——
// 否则同一个字段会有两套语义(非 action 生效 / action 被无视)。
// ⚠ 时长只在**这一处**定义,调用点不要再各写一份。

import { ToastQueue as SpectrumToastQueue, type ToastOptions } from "@react-spectrum/s2/Toast";

/** 未指定 `timeout` 时的自动收起时间(毫秒),等于 S2 允许的最小值。 */
export const DEFAULT_TOAST_TIMEOUT = 5000;

type ToastFn = (children: string, options?: ToastOptions) => () => void;

/** 包一层:**只**补默认 timeout,其余 options 原样透传(调用方显式给的值优先)。
 *  ⚠ 带 `actionLabel` 时还要自己排一个收口定时器 —— S2 对这类提示恒不自动关闭(见文件头)。 */
function withDefaultTimeout(add: ToastFn): ToastFn {
  return (children, options) => {
    const close = add(children, { timeout: DEFAULT_TOAST_TIMEOUT, ...options });
    if (options?.actionLabel) {
      // 对已关闭的 key 再 `close` 是幂等的(react-stately 里 `index >= 0` 才动手),
      // 所以用户点过「撤销」/ 手动叉掉之后,这个定时器到期不会有副作用。
      setTimeout(close, DEFAULT_TOAST_TIMEOUT);
    }
    return close;
  };
}

export const ToastQueue = {
  neutral: withDefaultTimeout(SpectrumToastQueue.neutral),
  positive: withDefaultTimeout(SpectrumToastQueue.positive),
  negative: withDefaultTimeout(SpectrumToastQueue.negative),
  info: withDefaultTimeout(SpectrumToastQueue.info),
};
