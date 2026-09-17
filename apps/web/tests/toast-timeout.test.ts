// 回归测试:底部 toast 必须**自己会消失**。
//
// 原 bug:React 版直接 re-export 了 S2 的 `ToastQueue`(改前的 `components/spectrum.ts:26`),
// 而 S2 的 `addToast` 只在**显式传了 `timeout`** 时才设自动关闭时间
// (`node_modules/@react-spectrum/s2/src/Toast.tsx`):
//   `let timeout = options.timeout && !options.actionLabel ? Math.max(options.timeout, 5000) : undefined;`
// —— 不传就是 `undefined`,队列永不自动关闭。于是全仓 30+ 处没写 `timeout` 的调用
// (加入选片 / 发布建议 / 删除留言 / 记录转票…)都永久钉在屏幕底部。
//
// 这里把 S2 队列整个 mock 掉:只观察「进队列时带的 options」,不依赖 React / DOM。

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TOAST_TIMEOUT, ToastQueue } from "../src/components/toast";

const { records } = vi.hoisted(() => ({
  records: [] as Array<{ variant: string; options: { timeout?: number } | undefined }>,
}));

vi.mock("@react-spectrum/s2/Toast", () => ({
  ToastQueue: Object.fromEntries(
    (["neutral", "positive", "negative", "info"] as const).map((variant) => [
      variant,
      (_children: string, options?: { timeout?: number }) => {
        records.push({ variant, options });
        return () => {};
      },
    ]),
  ),
}));

describe("ToastQueue 默认自动收起", () => {
  it("四个变体在不传 options 时都把默认 timeout 交给 S2 队列", () => {
    records.length = 0;
    ToastQueue.neutral("中性");
    ToastQueue.positive("成功");
    ToastQueue.negative("失败");
    ToastQueue.info("提示");
    expect(records.map((r) => r.variant)).toEqual(["neutral", "positive", "negative", "info"]);
    expect(records.map((r) => r.options?.timeout)).toEqual([
      DEFAULT_TOAST_TIMEOUT,
      DEFAULT_TOAST_TIMEOUT,
      DEFAULT_TOAST_TIMEOUT,
      DEFAULT_TOAST_TIMEOUT,
    ]);
  });

  it("调用方显式给的 timeout 不被默认值覆盖", () => {
    records.length = 0;
    ToastQueue.positive("已导入 3 场", { timeout: 8000 });
    expect(records).toEqual([{ variant: "positive", options: { timeout: 8000 } }]);
  });
});
