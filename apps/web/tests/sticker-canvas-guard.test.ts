// 画布的**重绘守护**(2026-09-22,PLAN-20260922145815)。
// 为什么单测它:滚动时父级有一堆与本卡无关的 re-render(顶部统计刷新、票数重拉……),
// 每次都 `clearRect` 全量重画就是白烧的长任务;而**漏画**的后果又是画布停在旧票数上 ——
// 两种错误都只有肉眼能看出,只能靠断言守住「参数按值没变就不重画」。
//
// 之所以单测得动:判据被拆成了纯逻辑模块(`sticker-canvas-guard.ts`),
// `StickerCanvas` 本身碰 DOM,进不了 node 环境的单测。

import { describe, expect, it } from "vitest";
import { needsRedraw, type DrawKey } from "../src/sticker-canvas-guard";

const base: DrawKey = {
  filmKey: "cat:f001",
  dpr: 2,
  width: 600,
  height: 352,
  counts: "5,3,2",
};

describe("needsRedraw:该不该重画画布", () => {
  it("没有上一次(首次 / 刚从视口外回来)→ 必须画", () => {
    expect(needsRedraw(null, base)).toBe(true);
  });

  it("参数逐字相同 → 不重画(父级无关 re-render 不该动画布)", () => {
    expect(needsRedraw({ ...base }, { ...base })).toBe(false);
  });

  it("票数内容变了 → 重画", () => {
    expect(needsRedraw(base, { ...base, counts: "6,3,3" })).toBe(true);
  });

  it("票数签名相同(数字没变)→ 不重画 —— 哪怕 counts 是新建的对象", () => {
    // 这就是守护存在的理由:`counts` 每次 render 都是新对象,只有签名是「值」
    expect(needsRedraw(base, { ...base, counts: `${5},${3},${2}` })).toBe(false);
  });

  it("换了影片 → 重画(同一个 canvas 元素被复用去画别的片)", () => {
    expect(needsRedraw(base, { ...base, filmKey: "cat:f002" })).toBe(true);
  });

  it("dpr 变了(跨屏拖窗 / 浏览器缩放)→ 重画,否则贴纸发糊", () => {
    expect(needsRedraw(base, { ...base, dpr: 1 })).toBe(true);
  });

  it("backing store 尺寸变了(拉伸窗口 / 断点切换)→ 重画", () => {
    expect(needsRedraw(base, { ...base, width: 601 })).toBe(true);
    expect(needsRedraw(base, { ...base, height: 353 })).toBe(true);
  });
});
