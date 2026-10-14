/**
 * 二维码 —— 把一段文本编成**模块矩阵**（2026-10-14，PLAN-20261014205414）。
 *
 * 这一层只做一件事：`文本 → boolean[][]`（`true` = 深色格）。**不碰 DOM、不碰 canvas、不碰下载** ——
 * 绘制与导出留在弹层里（`components/VoteQrDialog.tsx`），这样矩阵可以脱开浏览器单测。
 *
 * ⚠ 底层用 `qrcode-generator`（MIT、无 runtime 依赖）—— **引入理由与成本**（AGENTS §5「依赖量化」）：
 *   · 自写一份 byte 模式 + RS 纠错 + 掩码评分的编码器约 400-600 行，正确性风险远大于收益；
 *   · 该包 ESM 产物 52 KB、gzip 11 KB，而**调用点只有扫码弹层**，所以它在弹层里 `import()`（懒加载）——
 *     不进首屏 chunk，不进任何不去扫码的人的下载（同 `redblack-poster.ts` 的处置，见 `RedBlackPage.tsx`）。
 *
 * ⚠ 纠错等级取 `M`（约 15% 冗余）而不是更高：
 *   这个二维码的用法是「对着别人的手机屏幕 / 存下来的图扫」，`M` 足够；
 *   `Q` / `H` 会把版本抬高一档、格子变小，反而更难扫 —— 冗余不是越高越好。
 */

import qrcode from "qrcode-generator";

/** 纠错等级的唯一来源 —— 别在调用处再传一个（那会让同一张图有两种冗余度）。 */
const EC_LEVEL = "M";

/**
 * 文本 → 模块矩阵。`matrix[row][col] === true` 表示这一格要画深色。
 *
 * @param text 要编进二维码的内容（这里是投票链接）。
 * @throws 内容为空时抛 `Error`（空二维码是合法码但毫无意义，静默返回一个白方块才是真的坑）；
 *         内容超出二维码容量时由底层库抛错，本函数**不**吞它 —— 调用方要看得见。
 */
export function qrMatrix(text: string): boolean[][] {
  if (!text) throw new Error("二维码内容不能为空");
  // `0` = 让库自己挑最小的版本号（内容长度决定）。
  const qr = qrcode(0, EC_LEVEL);
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  const rows: boolean[][] = [];
  for (let row = 0; row < size; row += 1) {
    const cols: boolean[] = [];
    for (let col = 0; col < size; col += 1) {
      cols.push(qr.isDark(row, col));
    }
    rows.push(cols);
  }
  return rows;
}
