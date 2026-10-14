// 二维码矩阵（2026-10-14，PLAN-20261014205414）。
//
// 为什么单测它：这一层是「链接 → 可扫的格子」的唯一实现，而**扫不出来的二维码肉眼看不出来** ——
// 定位图案错一格、版本号算错一档，屏幕上都还是「一堆黑白方格」。所以这里钉的是结构不变量：
// 必须是方阵、尺寸必须落在合法的版本序列上、三个定位图案必须在角上、同一输入必须稳定。

import { describe, expect, it } from "vitest";
import { qrMatrix } from "../src/qr";

const LINK = "https://biff.lcandy.co/redblack?sort=red&vote=1";

/** QR 的模块数 = 4 × 版本 + 17（版本 1..40）—— 尺寸不合这条式子就说明版本号算错了。 */
function isValidModuleCount(size: number): boolean {
  if (size < 21 || size > 177) return false;
  const version = (size - 17) / 4;
  return Number.isInteger(version) && version >= 1 && version <= 40;
}

/** 定位图案（Finder Pattern）：7×7 的实心外框 + 中间 3×3 实心，两者之间是一圈白。 */
function hasFinderAt(matrix: readonly boolean[][], top: number, left: number): boolean {
  for (let row = 0; row < 7; row += 1) {
    for (let col = 0; col < 7; col += 1) {
      const onRing = row === 0 || row === 6 || col === 0 || col === 6;
      const inCore = row >= 2 && row <= 4 && col >= 2 && col <= 4;
      if (matrix[top + row][left + col] !== (onRing || inCore)) return false;
    }
  }
  return true;
}

describe("qrMatrix:结构", () => {
  it("给出**方阵**，且边长落在合法的版本序列上", () => {
    const matrix = qrMatrix(LINK);
    const size = matrix.length;
    expect(size).toBeGreaterThan(0);
    expect(isValidModuleCount(size)).toBe(true);
    for (const row of matrix) expect(row.length).toBe(size);
  });

  it("三个定位图案分别在左上 / 右上 / 左下角", () => {
    const matrix = qrMatrix(LINK);
    const size = matrix.length;
    expect(hasFinderAt(matrix, 0, 0)).toBe(true);
    expect(hasFinderAt(matrix, 0, size - 7)).toBe(true);
    expect(hasFinderAt(matrix, size - 7, 0)).toBe(true);
  });
});

describe("qrMatrix:确定性与守卫", () => {
  it("同一输入的两次调用逐格相同（二维码不能带随机性）", () => {
    expect(qrMatrix(LINK)).toEqual(qrMatrix(LINK));
  });

  it("内容不同 → 矩阵不同", () => {
    expect(qrMatrix(LINK)).not.toEqual(qrMatrix(`${LINK}&x=1`));
  });

  it("更长的内容不会小于更短的（版本号单调不减）", () => {
    expect(qrMatrix(LINK).length).toBeLessThanOrEqual(qrMatrix(LINK.repeat(3)).length);
  });

  it("空内容抛错（白方块不是二维码，静默返回才是真的坑）", () => {
    expect(() => qrMatrix("")).toThrow();
  });
});
