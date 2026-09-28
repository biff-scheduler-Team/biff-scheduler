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
//
// 补记(2026-09-28,PLAN-20260928120415):同一段公式还有**第二个**分支没被兜住 ——
// `!options.actionLabel` 为假时 `timeout` 也恒为 `undefined`(S2 的注释写明是**故意**的:
// 可操作提示自动消失会违反 WCAG SC 2.2.1)。于是带「撤销」按钮的那条提示永不关闭
// (用户报的「《蓦然回首》的贴纸收回暂存区了。一直都不消失」)。
// 现在由 `toast.ts` 自己补一个收口定时器,下面两条用例守着它。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TOAST_TIMEOUT, ToastQueue } from "../src/components/toast";

const { records, closeCounts } = vi.hoisted(() => ({
  records: [] as Array<{ variant: string; options: { timeout?: number } | undefined }>,
  closeCounts: [] as number[],
}));

vi.mock("@react-spectrum/s2/Toast", () => ({
  ToastQueue: Object.fromEntries(
    (["neutral", "positive", "negative", "info"] as const).map((variant) => [
      variant,
      (_children: string, options?: { timeout?: number }) => {
        records.push({ variant, options });
        // 返回的 close 与真实 S2 同一形态(`() => queue.close(key)`),这里只记调用次数
        const index = closeCounts.push(0) - 1;
        return () => {
          closeCounts[index] += 1;
        };
      },
    ]),
  ),
}));

describe("ToastQueue 默认自动收起", () => {
  // ⚠ 两个 describe 共用 `records` / `closeCounts`:重置一律放 `beforeEach`,
  //   不放进用例体 —— 免得后来人插用例时漏掉一句、读到上一个用例的残留。
  beforeEach(() => {
    records.length = 0;
    closeCounts.length = 0;
  });

  it("四个变体在不传 options 时都把默认 timeout 交给 S2 队列", () => {
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
    ToastQueue.positive("已导入 3 场", { timeout: 8000 });
    expect(records).toEqual([{ variant: "positive", options: { timeout: 8000 } }]);
  });
});

describe("带操作按钮的提示也要自己收口", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    records.length = 0;
    closeCounts.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("带 actionLabel:S2 不会关,由本层在默认时长后**自动 close**", () => {
    ToastQueue.neutral("《蓦然回首》的贴纸收回暂存区了。", {
      actionLabel: "撤销",
      onAction: () => {},
    });

    expect(records).toHaveLength(1);
    // 还没到点:不能提前把撤销出口关掉
    expect(closeCounts[0]).toBe(0);
    vi.advanceTimersByTime(DEFAULT_TOAST_TIMEOUT - 1);
    expect(closeCounts[0]).toBe(0);

    vi.advanceTimersByTime(1);
    expect(closeCounts[0]).toBe(1);
  });

  it("不带 actionLabel:不额外排定时器,收尾交给 S2(避免双重关闭)", () => {
    ToastQueue.neutral("普通提示");

    vi.advanceTimersByTime(DEFAULT_TOAST_TIMEOUT * 3);
    expect(closeCounts[0]).toBe(0);
  });
});
