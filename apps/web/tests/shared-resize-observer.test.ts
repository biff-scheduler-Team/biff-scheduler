// 共享 ResizeObserver(2026-09-28,PLAN-20260928003736)。
// 为什么单测它:改造前「每张卡各建一个实例」是一笔看不见的内存成本(近 300 个),而共享之后
// **回调分发**成了新的出错面 —— 分发错了只会表现为「某块画布尺寸不更新」,不报错、不崩,
// 只能靠断言守住。这里用假 ResizeObserver 把「只建一个」「按 target 分发」两件事钉死。

import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeEntry {
  target: Element;
  width: number;
  height: number;
}

/** 假 ResizeObserver:记住被观测的元素,并允许手工触发一次回调(带多个 entry)。 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];

  readonly observed = new Set<Element>();
  private readonly callback: (entries: unknown[]) => void;

  constructor(callback: (entries: unknown[]) => void) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }

  observe(el: Element): void {
    this.observed.add(el);
  }

  unobserve(el: Element): void {
    this.observed.delete(el);
  }

  disconnect(): void {
    this.observed.clear();
  }

  /** 模拟浏览器送来一批 entry */
  emit(entries: FakeEntry[]): void {
    this.callback(
      entries.map((e) => ({ target: e.target, contentRect: { width: e.width, height: e.height } })),
    );
  }
}

type ObserveResize = (el: Element, cb: (width: number, height: number) => void) => () => void;

/** 测试只用它当 WeakMap 的钥匙与 observe 的参数,不需要真 DOM(本用例跑在 node 环境) */
const fakeEl = (): Element => ({}) as Element;

let observeResize: ObserveResize;

beforeEach(async () => {
  FakeResizeObserver.instances = [];
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  // 单例是**模块级**的 —— 每个用例都要一份干净模块,否则「只建一个实例」会被上一个用例建的实例污染
  vi.resetModules();
  ({ observeResize } = (await import("../src/shared-resize-observer")) as {
    observeResize: ObserveResize;
  });
});

describe("observeResize:共享单例", () => {
  it("多个元素共用同一个实例(近 300 张卡不再各建一个)", () => {
    observeResize(fakeEl(), () => {});
    observeResize(fakeEl(), () => {});
    observeResize(fakeEl(), () => {});
    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(FakeResizeObserver.instances[0].observed.size).toBe(3);
  });

  it("回调按 entry.target 分发 —— 一批里带着多个元素也不会张冠李戴", () => {
    const a = fakeEl();
    const b = fakeEl();
    const gotA: Array<[number, number]> = [];
    const gotB: Array<[number, number]> = [];
    observeResize(a, (w, h) => gotA.push([w, h]));
    observeResize(b, (w, h) => gotB.push([w, h]));

    // ⚠ 故意让 b 排在 a 前面:按顺序分发会把这个用例判红
    FakeResizeObserver.instances[0].emit([
      { target: b, width: 20, height: 30 },
      { target: a, width: 10, height: 40 },
    ]);

    expect(gotA).toEqual([[10, 40]]);
    expect(gotB).toEqual([[20, 30]]);
  });

  it("退订后既不再回调、也不再留在被观测集合里", () => {
    const a = fakeEl();
    const got: number[] = [];
    const stop = observeResize(a, (w) => got.push(w));
    const shared = FakeResizeObserver.instances[0];
    expect(shared.observed.has(a)).toBe(true);

    stop();

    expect(shared.observed.has(a)).toBe(false);
    shared.emit([{ target: a, width: 5, height: 5 }]);
    expect(got).toEqual([]);
  });

  it("回调表里没有的元素静默跳过,不抛错", () => {
    observeResize(fakeEl(), () => {});
    expect(() =>
      FakeResizeObserver.instances[0].emit([{ target: fakeEl(), width: 1, height: 1 }]),
    ).not.toThrow();
  });

  it("环境不支持 ResizeObserver 时降级为「不观测」,退订函数仍可安全调用", async () => {
    vi.resetModules();
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = undefined;
    const fresh = (await import("../src/shared-resize-observer")) as { observeResize: ObserveResize };
    const stop = fresh.observeResize(fakeEl(), () => {});
    expect(() => stop()).not.toThrow();
    expect(FakeResizeObserver.instances).toHaveLength(0);
  });
});
