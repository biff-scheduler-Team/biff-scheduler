// 贴纸外观的**失效链路 + 分桶缓存**(2026-09-28 起,PLAN-20260928003736 / 20260929195500)。
//
// 为什么单测它:`palette` 与 `cache` 是模块级单例、**只在首次读取**,读失败时还会兜底成中性灰
// `#8b8b8b` —— 那次读到的值会**永久生效**。链路断了不会有任何报错,只表现为「配色不更新」。
// ⚠ 断言的是**链路**(版本 +1 且订阅者被通知),不是某个色值 —— `--rb-red` 目前没有暗色覆盖,
//   色值本来就不变(诚实记录见 `sticker-sprite.ts`)。
//
// 第二组断言是**分桶缓存**:缓存键从 `type@dpr` 变成 `type@款@dpr`(2026-09-29)。
// 键少一个维度不会有任何报错,只会让先画的那款被复用给所有贴纸(只有人眼看得出来)。
//
// ⚠ 这里用假的 MutationObserver / document / Path2D:本测试目录跑在 node 环境,
//   而真机上这一段必须碰 DOM。

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ALL_SKINS } from "../src/sticker-skin";

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
    mod.stickerSprite("red", "clap", 2);
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
    mod.stickerSprite("black", "clap", 2);
    const watcher = FakeMutationObserver.last;

    watcher?.fire();
    expect(seen).toHaveLength(1);

    stop();
    watcher?.fire();
    expect(seen).toHaveLength(1);
  });

  it("监听只挂一个:取多次 sprite 不会越挂越多", () => {
    mod.stickerSprite("red", "clap", 2);
    mod.stickerSprite("black", "scrap", 2);
    mod.stickerSprite("red", "stub", 1);
    expect(FakeMutationObserver.created).toBe(1);
  });
});

describe("分桶缓存:款必须是键的一部分", () => {
  it("同一个 (色, 款, dpr) 复用同一张离屏画布", () => {
    const a = mod.stickerSprite("red", "clap", 2);
    const b = mod.stickerSprite("red", "clap", 2);
    expect(b.canvas).toBe(a.canvas);
  });

  it("★ 换款就换一张 —— 不能把先画的那款复用给所有贴纸", () => {
    const canvases = ALL_SKINS.map((skin) => mod.stickerSprite("red", skin, 2).canvas);
    expect(new Set(canvases).size).toBe(ALL_SKINS.length);
  });

  it("换色 / 换 dpr 仍然是各自的桶", () => {
    const red = mod.stickerSprite("red", "clap", 2).canvas;
    const black = mod.stickerSprite("black", "clap", 2).canvas;
    const red1x = mod.stickerSprite("red", "clap", 1).canvas;
    expect(black).not.toBe(red);
    expect(red1x).not.toBe(red);
  });

  it("桶的总数有界,不随票数上涨", () => {
    const seen = new Set<unknown>();
    for (const type of ["red", "black"] as const) {
      for (const skin of ALL_SKINS) {
        for (const dpr of [1, 2]) seen.add(mod.stickerSprite(type, skin, dpr).canvas);
      }
    }
    // 2 色 × 5 款 × 2 档 dpr = 20
    expect(seen.size).toBe(20);
  });
});

describe("尺寸口径", () => {
  it("贴纸 20px(2026-09-29:用户看过 32 的实机效果后要求调小)", () => {
    expect(mod.STICKER_SIZE).toBe(20);
  });

  // 尺寸是**两处表达**(canvas sprite 那一侧 + CSS 里那枚 DOM 按钮),靠注释提醒是靠不住的 ——
  // 贴纸尺寸已经被用户改过四轮(26 → 20 → 32 → 20),而两处不一致的症状只有人眼看得出来
  // (画布上的群点与我自己那枚大小不一样)。E2E 也守着这一条,但那条要跑三浏览器、慢得多。
  it("★ 样式表里 `.rb-dot` 的 width / height 与 `STICKER_SIZE` 逐字一致", () => {
    const css = readFileSync(new URL("../src/pages/redblack-parity.css", import.meta.url), "utf8");
    const block = /\.rb-dot \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    const size = `${mod.STICKER_SIZE}px`;
    expect(block).toMatch(new RegExp(`width:\\s*${size}`));
    expect(block).toMatch(new RegExp(`height:\\s*${size}`));
    // 派生值一并钉住:拖拽浮标比本体大 2px,落点预览与本体等大
    const ghost = /\.rb-ghost \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(ghost).toMatch(new RegExp(`width:\\s*${mod.STICKER_SIZE + 2}px`));
    const preview = /\.rb-preview \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(preview).toMatch(new RegExp(`width:\\s*${size}`));
  });

  it("落影余量必须容得下最外那层影子,否则最外层会被裁掉一条边", () => {
    // 第三层是 offsetY 3 + blur 7 → 外扩约 10px
    expect(mod.SPRITE_PAD).toBeGreaterThanOrEqual(10);
  });
});
