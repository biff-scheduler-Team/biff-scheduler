// 贴纸外观的**失效链路**(2026-09-28,PLAN-20260928003736)。
// 为什么单测它:`colors` 与 `cache` 是模块级单例、**只在首次读取**,读失败时还会兜底成中性灰
// `#8b8b8b` —— 那次读到的值会**永久生效**。链路断了不会有任何报错,只表现为「配色不更新」。
// ⚠ 断言的是**链路**(版本 +1 且订阅者被通知),不是某个色值 —— `--rb-red` 目前没有暗色覆盖,
//   色值本来就不变(诚实记录见 `sticker-sprite.ts`)。
// ⚠ 这里用假的 MutationObserver / document:本测试目录跑在 node 环境,而真机上这一段必须碰 DOM。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 假的 2D 上下文:`build()` 会一路调这些方法,这里只保证「不抛错、不返回 falsy」 */
const gradient = { addColorStop: () => {} };
const ctx = new Proxy(
  {},
  {
    get: (_target, key) => (key === "createRadialGradient" ? () => gradient : () => {}),
    set: () => true,
  },
);

class FakeMutationObserver {
  static created = 0;
  static last: FakeMutationObserver | null = null;

  readonly observed: Array<[unknown, unknown]> = [];
  private readonly callback: () => void;

  constructor(callback: () => void) {
    this.callback = callback;
    FakeMutationObserver.created += 1;
    FakeMutationObserver.last = this;
  }

  observe(target: unknown, options: unknown): void {
    this.observed.push([target, options]);
  }

  disconnect(): void {}

  /** 模拟根元素的 `data-theme` 被改了一次 */
  fire(): void {
    this.callback();
  }
}

type SpriteModule = typeof import("../src/sticker-sprite");

let mod: SpriteModule;

beforeEach(async () => {
  FakeMutationObserver.created = 0;
  FakeMutationObserver.last = null;
  vi.stubGlobal("MutationObserver", FakeMutationObserver);
  vi.stubGlobal("document", {
    documentElement: {},
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "#cf3b52" }));
  // 单例是模块级的 —— 每个用例都拿一份干净模块,免得上一个用例建好的监听被算进来
  vi.resetModules();
  mod = (await import("../src/sticker-sprite")) as SpriteModule;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("贴纸外观失效:token 一变就要重画", () => {
  it("data-theme 变化 → 版本 +1 并通知订阅者", () => {
    const seen: number[] = [];
    const stop = mod.onSpriteInvalidate(() => seen.push(mod.spriteEpoch()));
    const before = mod.spriteEpoch();

    // 主题监听是**惰性**挂的:第一次真要去读颜色时才装
    mod.stickerSprite("red", 2);
    const watcher = FakeMutationObserver.last;
    expect(watcher?.observed).toEqual([[{}, { attributes: true, attributeFilter: ["data-theme"] }]]);

    watcher?.fire();

    expect(mod.spriteEpoch()).toBe(before + 1);
    expect(seen).toEqual([before + 1]);
    stop();
  });

  it("退订之后不再收到通知", () => {
    const seen: number[] = [];
    const stop = mod.onSpriteInvalidate(() => seen.push(1));
    mod.stickerSprite("black", 2);
    const watcher = FakeMutationObserver.last;

    watcher?.fire();
    expect(seen).toHaveLength(1);

    stop();
    watcher?.fire();
    expect(seen).toHaveLength(1);
  });

  it("监听只挂一个:取多次 sprite 不会越挂越多", () => {
    mod.stickerSprite("red", 2);
    mod.stickerSprite("black", 2);
    mod.stickerSprite("red", 1);
    expect(FakeMutationObserver.created).toBe(1);
  });
});
