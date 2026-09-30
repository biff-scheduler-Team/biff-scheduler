// 换款轮盘的**几何**（2026-09-29，PLAN-20260929195500）。
//
// 为什么单测这几行：节点位置错了**不会报错**，只会让那一圈看起来「有点歪」
// —— 而圈里躺着的是用户要点的那 5 款皮肤，歪了就看不出「哪颗是现在这款、哪颗在旁边」。
// 具体守两条容易被无意改坏的性质：**第一颗在正上方**、**等角度均分**。

import { afterEach, describe, expect, it, vi } from "vitest";

import { STICKER_SKIN_KEYS } from "@biff/contracts/sticker";
import { NODE_SIZE, WHEEL_RADIUS, WHEEL_REACH, clampAnchor, wheelSeat } from "../src/sticker-wheel";

const COUNT = STICKER_SKIN_KEYS.length;

/** 两颗座位之间的直线距离（弦长）。等角度均分 ⇔ 所有弦长相等。 */
function chord(a: { dx: number; dy: number }, b: { dx: number; dy: number }): number {
  return Math.hypot(a.dx - b.dx, a.dy - b.dy);
}

function seats(): Array<{ dx: number; dy: number }> {
  return STICKER_SKIN_KEYS.map((_, index) => wheelSeat(index, COUNT, WHEEL_RADIUS));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("wheelSeat：节点怎么摆在环上", () => {
  it("第一颗在**正上方**（`-π/2` 那半度）—— 少了它整圈会顺时针歪 90°", () => {
    const first = wheelSeat(0, COUNT, WHEEL_RADIUS);
    expect(first.dx).toBeCloseTo(0, 6);
    expect(first.dy).toBeCloseTo(-WHEEL_RADIUS, 6);
  });

  it("每颗都落在半径上（不是椭圆、也不是从中心散开的螺旋）", () => {
    for (const seat of seats()) {
      expect(Math.hypot(seat.dx, seat.dy)).toBeCloseTo(WHEEL_RADIUS, 1);
    }
  });

  it("★ 等角度均分：相邻两颗的弦长**全都一样**", () => {
    const list = seats();
    const chords = list.map((seat, index) => chord(seat, list[(index + 1) % COUNT]));
    for (const value of chords) expect(value).toBeCloseTo(chords[0], 1);
    // 5 等分时弦长 = 2R·sin(π/5)
    expect(chords[0]).toBeCloseTo(2 * WHEEL_RADIUS * Math.sin(Math.PI / COUNT), 1);
  });

  it("没有两颗坐在同一个位置上（重叠的话等于少了一款可选）", () => {
    const list = seats();
    const seen = new Set(list.map((seat) => `${seat.dx},${seat.dy}`));
    expect(seen.size).toBe(COUNT);
  });

  it("节点个数跟着契约层的款数走（不是写死 5）:给 7 款也能均分", () => {
    const seven = [0, 1, 2, 3, 4, 5, 6].map((index) => wheelSeat(index, 7, WHEEL_RADIUS));
    const chords = seven.map((seat, index) => chord(seat, seven[(index + 1) % 7]));
    for (const value of chords) expect(value).toBeCloseTo(chords[0], 1);
  });

  it("坐标只保留两位小数（它要进内联样式，多余精度会让每次渲染的值都「不相等」）", () => {
    for (const seat of seats()) {
      for (const value of [seat.dx, seat.dy]) {
        expect(Math.round(value * 100) / 100).toBe(value);
      }
    }
  });

  it("环的外沿余量 = 半径 + 半个节点（视口夹取读的就是它）", () => {
    expect(WHEEL_REACH).toBe(WHEEL_RADIUS + NODE_SIZE / 2);
  });
});

describe("clampAnchor：贴到屏幕边上时不许把节点切掉一半", () => {
  it("★ 夹完之后整圈都在视口里（连节点的那半个身子一起算）", () => {
    vi.stubGlobal("window", { innerWidth: 1200, innerHeight: 800 });
    // 四个角 + 四条边的中点，全都是「贴边」的极端位置
    const corners = [
      { x: -50, y: -50 },
      { x: 1250, y: -50 },
      { x: -50, y: 850 },
      { x: 1250, y: 850 },
      { x: 600, y: 2 },
      { x: 600, y: 798 },
      { x: 2, y: 400 },
      { x: 1198, y: 400 },
    ];
    for (const corner of corners) {
      const seat = clampAnchor(corner.x, corner.y);
      expect(seat.x - WHEEL_REACH).toBeGreaterThanOrEqual(0);
      expect(seat.x + WHEEL_REACH).toBeLessThanOrEqual(1200);
      expect(seat.y - WHEEL_REACH).toBeGreaterThanOrEqual(0);
      expect(seat.y + WHEEL_REACH).toBeLessThanOrEqual(800);
    }
  });

  it("本来就在中间 → 一动不动（别把「不需要夹」的也改掉）", () => {
    vi.stubGlobal("window", { innerWidth: 1200, innerHeight: 800 });
    expect(clampAnchor(600, 400)).toEqual({ x: 600, y: 400 });
  });

  it("视口比整圈还小 → 退化成**居中**，而不是把锚点算到屏幕外", () => {
    // 60×60 的视口装不下 46+22 的环
    vi.stubGlobal("window", { innerWidth: 60, innerHeight: 60 });
    expect(clampAnchor(0, 0)).toEqual({ x: 30, y: 30 });
    expect(clampAnchor(999, 999)).toEqual({ x: 30, y: 30 });
  });

  it("没有 `window`（node 单测 / 预渲染）时原样返回，不抛错", () => {
    expect(clampAnchor(12, 34)).toEqual({ x: 12, y: 34 });
  });
});
