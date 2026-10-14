/**
 * 「扫码投票」弹层(2026-10-14,PLAN-20261014205414)。
 *
 * 用户原话:「二维码是你直接在页面上嵌入一个按钮弹出可保存的二维码 用于分享」——
 * 所以这里只做三件事:把投票链接画成二维码、「下载 PNG」/「复制图片」、把链接本身也亮出来。
 *
 * ⚠ a11y 不自造:`role=dialog` / aria-modal / focus trap / Esc 全部由 S2 的 `Dialog` 提供(§5);
 *   **焦点归还**由调用方(红黑榜控制栏那枚按钮)负责,照 `RedBlackShareDialog` 的同一手法。
 * ⚠ 这个组件**只在打开时挂**(懒加载,见 `RedBlackPage.tsx`),所以 `qrcode-generator` 与
 *   `poster-brush.ts`(只借它的 `SITE`)都不进首屏 chunk。
 * ⚠ 二维码必须**白底深色**:弹层会跟着暗色主题走,而反色二维码很多相机扫不出来 ——
 *   所以这里是整个页面里少数几个**写死颜色**的地方(`vote-qr.css::.qr-box`),不是漏了 token。
 */

import { useEffect, useRef, useState } from "react";
import { download } from "../app/download";
import { SITE } from "../poster-brush";
import { qrMatrix } from "../qr";
import { voteUrl } from "../quick-vote";
import { copyImageOrDownload } from "./share-image";
import {
  ActionButton,
  Button,
  ButtonGroup,
  Content,
  Dialog,
  DialogContainer,
  Heading,
  ToastQueue,
} from "./spectrum";
import "./vote-qr.css";

const FILE_NAME = "BIFF2026-扫码投票.png";

/** 导出图里一格画多少像素(二维码的「物理分辨率」就是它 × (模块数 + 白边))。
 *  ⚠ 取 12:链接约 50 字符 → 版本 3~4(29~33 模块),加上 8 格白边后导出边长约 450~500px ——
 *    贴到微信里被压缩一轮之后仍扫得动。再小(8)会在压缩后糊掉,再大(16)只是白涨体积。 */
const CELL = 12;

/** 白边(quiet zone)格数。⚠ **必须留**:规格要求至少 4 格,少了相机对不准边界。 */
const QUIET = 4;

/** 把矩阵画到画布上(白底 + 深色格)。**不做**圆角 / 渐变 / logo —— 那些都会降低扫码成功率。 */
function drawMatrix(canvas: HTMLCanvasElement, matrix: readonly boolean[][]): void {
  const modules = matrix.length;
  const side = (modules + QUIET * 2) * CELL;
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, side, side);
  ctx.fillStyle = "#000000";
  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (!matrix[row][col]) continue;
      ctx.fillRect((col + QUIET) * CELL, (row + QUIET) * CELL, CELL, CELL);
    }
  }
}

/** `toBlob` 的回调形态 → Promise(画布出图只有这一种异步写法)。 */
function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((next) => resolve(next), "image/png"));
}

interface VoteQrDialogProps {
  onDismiss: () => void;
}

export function VoteQrDialog({ onDismiss }: VoteQrDialogProps) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState("");
  /** 链接:域名来自 `poster-brush.ts::SITE`(唯一来源),路径来自 `quick-vote.ts::voteUrl`(唯一来源)——
   *  这个组件里**没有**第二个拼链接的地方。
   *  ⚠ 只是个常量,不进 state:它是纯函数,每次渲染同一个字符串,`useEffect` 的依赖也就恒等。 */
  const url = voteUrl(`https://${SITE}`);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let canceled = false;
    setError("");
    try {
      drawMatrix(element, qrMatrix(url));
      void canvasBlob(element).then((next) => {
        if (canceled) return;
        if (next) setBlob(next);
        else setError("二维码生成失败，请关掉再打开一次。");
      });
    } catch {
      // 内容超容量 / 画布不可用 —— 两种情况对用户是同一件事:这张图没出来
      setError("二维码生成失败，请关掉再打开一次。");
    }
    return () => {
      canceled = true;
    };
  }, [url]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      ToastQueue.positive("链接已复制", { timeout: 5000 });
    } catch {
      // 剪贴板不可用(非安全上下文 / 没授权)—— 上面那段链接是可选中的,叫人手动复制
      ToastQueue.neutral("当前浏览器无法复制，请长按上面的链接手动复制。", { timeout: 5000 });
    }
  };

  return (
    <DialogContainer onDismiss={onDismiss}>
      <Dialog size="L">
        <Heading slot="title">扫码投票</Heading>
        <Content>
          <p className="qr-lede">
            把这张二维码发给朋友，或用手机直接扫：扫码打开快速投票 —— 左滑不喜欢、右滑喜欢。
          </p>
          <div className="qr-box">
            <canvas ref={canvas} className="qr-canvas" role="img" aria-label={`投票链接二维码：${url}`} />
          </div>
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
          <p className="qr-url">{url}</p>
        </Content>
        <ButtonGroup>
          {blob && <Button onPress={() => download(blob, FILE_NAME)}>下载 PNG 图片</Button>}
          {blob && (
            <ActionButton onPress={() => void copyImageOrDownload(blob, FILE_NAME)}>
              复制图片
            </ActionButton>
          )}
          <Button variant="secondary" onPress={() => void copyLink()}>
            复制链接
          </Button>
          <Button variant="secondary" onPress={onDismiss}>
            关闭
          </Button>
        </ButtonGroup>
      </Dialog>
    </DialogContainer>
  );
}
