// 贴纸外观的**失效链路 + 分桶缓存**(2026-09-28 起,PLAN-20260928003736 / PLAN-20260929195500)。
//
// 为什么单测它:`palette` 与 `cache` 是模块级单例、**只在首次读取**,读失败时还会兜底成中性灰
// `#8b8b8b` —— 那次读到的值会**永久生效**。链路断了不会有任何报错,只表现为「配色不更新」。
// ⚠ 断言的是**链路**(版本 +1 且订阅者被通知),不是某个色值 —— `--rb-red` 目前没有暗色覆盖,
//   色值本来就不变(诚实记录见 `sticker-sprite.ts`)。
//
// 2026-09-29 新增第二组断言:**分桶缓存**。sprite 从「同色一张」变成
// 「色 × 形状 × 图标 × dpr」,键少一个维度不会有任何报错,只会让先画的那种外观被复用给所有贴纸
// (只有人眼看得出来)—— 所以必须机械守住。
//
// ⚠ 这里用假的 MutationObserver / document / Path2D:本测试目录跑在 node 环境,
//   而真机上这一段必须碰 DOM。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { glyphsOf } from "../src/sticker-glyph";
import { shapesOf } from "../src/sticker-shape";
import type { StickerType } from "../src/redblack";

/** 假的 2D 上下文:`build()` 会一路调这些方法,这里只保证「不抛错、不返回 falsy」 */
const gradient = { addColorStop: () => {} };
const ctx = new Proxy(
  {},
  {
    get: (_target, key) => (key === "createRadialGradient" ? () => gradient : () => {}),
    set: () => true,
  },
);

/** node 里没有 `Path2D`,而轮廓与图标现在都经它构造(vitest 环境是 node)。
 *  ⚠ 只记下 `d`,不做解析 —— 这份替身要守的是「缓存分桶」,不是路径语义。 */
class FakePath2D {
  constructor(readonly d: string) {}
}

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
  vi.stubGlobal("Path2D", FakePath2D);
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
    mod.stickerSprite("red", "torn", "star", 2);
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
    mod.stickerSprite("black", "torn", "cross", 2);
    const watcher = FakeMutationObserver.last;

    watcher?.fire();
    expect(seen).toHaveLength(1);

    stop();
    watcher?.fire();
    expect(seen).toHaveLength(1);
  });

  it("监听只挂一个:取多次 sprite 不会越挂越多", () => {
    mod.stickerSprite("red", "torn", "star", 2);
    mod.stickerSprite("black", "scrap", "bolt", 2);
    mod.stickerSprite("red", "stub", "heart", 1);
    expect(FakeMutationObserver.created).toBe(1);
  });
});

describe("分桶缓存:形状与图标都必须是键的一部分", () => {
  it("同一个 (色, 形状, 图标, dpr) 复用同一张离屏画布", () => {
    const a = mod.stickerSprite("red", "torn", "star", 2);
    const b = mod.stickerSprite("red", "torn", "star", 2);
    expect(b.canvas).toBe(a.canvas);
  });

  it("换形状就换一张 —— 不能把先画的那种轮廓复用给所有贴纸", () => {
    const shapes = shapesOf("red");
    const canvases = shapes.map((shape) => mod.stickerSprite("red", shape, "star", 2).canvas);
    expect(new Set(canvases).size).toBe(shapes.length);
  });

  it("换图标也换一张 —— 图标由 id 推导,不由形状决定", () => {
    const glyphs = glyphsOf("red");
    const canvases = glyphs.map((glyph) => mod.stickerSprite("red", "torn", glyph, 2).canvas);
    expect(new Set(canvases).size).toBe(glyphs.length);
  });

  it("换色 / 换 dpr 仍然是各自的桶", () => {
    const red = mod.stickerSprite("red", "torn", "star", 2).canvas;
    const black = mod.stickerSprite("black", "torn", "star", 2).canvas;
    const red1x = mod.stickerSprite("red", "torn", "star", 1).canvas;
    expect(black).not.toBe(red);
    expect(red1x).not.toBe(red);
  });

  it("桶的总数有界,不随票数上涨", () => {
    const seen = new Set<unknown>();
    for (const type of ["red", "black"] as const satisfies readonly StickerType[]) {
      for (const shape of shapesOf(type)) {
        for (const glyph of glyphsOf(type)) {
          for (const dpr of [1, 2]) seen.add(mod.stickerSprite(type, shape, glyph, dpr).canvas);
        }
      }
    }
    // 红族 3×3 + 黑族 3×3 = 18 种组合,× 2 档 dpr = 36
    expect(seen.size).toBe(36);
  });
});

describe("尺寸口径", () => {
  it("贴纸 32px(2026-09-29 由 20 放大,为的是微图标读得出来)", () => {
    expect(mod.STICKER_SIZE).toBe(32);
  });

  it("落影余量必须容得下最外那层影子,否则最外层会被裁掉一条边", () => {
    // 第三层是 offsetY 3 + blur 7 → 外扩约 10px
    expect(mod.SPRITE_PAD).toBeGreaterThanOrEqual(10);
  });
});
