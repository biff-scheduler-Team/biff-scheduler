// 请求超时信号的**兜底**（2026-10-05，PLAN-20261005182415 §A）。
//
// 为什么值得单测：`AbortSignal.timeout` 是 Safari 16.4 才有的 API，旧 Safari 与部分内嵌
// WebView 上它是 `undefined`，而全站十来处 `fetch` 都直接调它 —— 那一句会在 `fetch` **之前**
// 抛 `TypeError`，再被各模块的 `catch` 当成「网络不通」。红黑榜那边表现就是
// 「贴纸永远同步不上去，提示一直说检查网络」（用户 2026-10-05 报的症状）。
//
// 这里钉三条：① 有原生实现时**用它**（不要反手退化成手写计时器）；
// ② 没有时退到 `AbortController` + `setTimeout`，而且**到点真的 abort**；
// ③ 兜底给出的是一个**真信号**（给 `undefined` 的话 fetch 会当成「没有信号」，
//    请求就永远挂着 —— 比抛错更难查）。

import { afterEach, describe, expect, it, vi } from "vitest";

/** 造一个「没有 `AbortSignal.timeout`」的环境。
 *  ⚠ `class X extends AbortSignal {}` **不行**：静态方法会被子类继承，能力检测照样通过。 */
function stubLegacyAbortSignal(): void {
  vi.stubGlobal("AbortSignal", {});
}

describe("timeoutSignal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("有原生 `AbortSignal.timeout` 时直接交给它（不自己造计时器）", async () => {
    vi.resetModules();
    const { timeoutSignal } = await import("../src/net");
    const spy = vi.spyOn(AbortSignal, "timeout");
    timeoutSignal(50);
    expect(spy).toHaveBeenCalledWith(50);
  });

  it("★ 没有原生实现时退到 AbortController，且到点真的中止", async () => {
    vi.useFakeTimers();
    stubLegacyAbortSignal();
    vi.resetModules();
    const { timeoutSignal } = await import("../src/net");

    const signal = timeoutSignal(1_000);
    expect(signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(999);
    expect(signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
  });

  it("★ 兜底给出的是**真信号**，不是 undefined（undefined 会让请求永远挂着）", async () => {
    vi.useFakeTimers();
    // ⚠ 先把真的那个类存下来：stub 之后 `instanceof AbortSignal` 判的就是那个空对象了
    const RealAbortSignal = AbortSignal;
    stubLegacyAbortSignal();
    vi.resetModules();
    const { timeoutSignal } = await import("../src/net");

    const signal = timeoutSignal(10);
    expect(signal).toBeInstanceOf(RealAbortSignal);
    expect(typeof signal.addEventListener).toBe("function");
  });
});
