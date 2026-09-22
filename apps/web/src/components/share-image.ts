/**
 * 分享图的**复制 / 下载**出口(2026-09-22)。
 *
 * 为什么单独成文件:应用现在有两张分享图 —— 看片计划海报(`PosterPreview.tsx`)与
 * 红黑榜分享图(`RedBlackShareDialog.tsx`)。「先试复制图片、不行就退化成下载、并如实告诉用户」
 * 这件事只该有一份答案:复制失败却不提示,用户只会以为「点了没反应」。
 *
 * ⚠ 剪贴板写图片需要 `navigator.clipboard.write` + `ClipboardItem`,两者缺一就抛错 ——
 *   用 try/catch 兜住再退化,而不是先判能力再写(能力检测本身在各浏览器上并不可靠)。
 */

import { download } from "../app/download";
import { ToastQueue } from "./spectrum";

export async function copyImageOrDownload(blob: Blob, fileName: string): Promise<void> {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      throw new Error("clipboard unavailable");
    }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    ToastQueue.positive("图片已复制", { timeout: 5000 });
  } catch {
    download(blob, fileName);
    ToastQueue.neutral("当前浏览器无法复制图片，已改为下载。", { timeout: 5000 });
  }
}
