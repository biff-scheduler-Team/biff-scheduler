/**
 * 「生成分享图」弹层(2026-09-22)。
 *
 * 红黑榜的对外成品:三个榜(总数 / 红 / 黑)各 TOP10 + **我贴过的全部**(不限条数)+ 底部署名。
 * 模型与绘制在 `redblack-poster.ts`(纯逻辑、可单测);这里只管弹层、预览画布与复制 / 下载。
 *
 * ⚠ a11y 不自造:`role=dialog` / aria-modal / focus trap / Esc 全部由 S2 的 `Dialog` 提供(§5);
 *   挂载手法照仓库既有路径 —— **只在打开时挂**,免得常驻的 `<Dialog>` 被 `DialogContainer`
 *   当成「当前弹层」一起显示(`SettingsDialog::ClearDialog` 的注释里踩过这个坑)。
 * ⚠ **焦点归还**由调用方(红黑榜页面上那个按钮)负责,见 `RedBlackPage.tsx`。
 *
 * ★ 出图是**快照**:弹层打开那一刻的数据就是这张图的内容 —— 打开后再贴一枚不该让图变来变去
 *   (用户看到的是「我刚生成的那张」,不是「一张一直在变的图」)。
 */

import { useEffect, useRef, useState } from "react";
import type { FilmNode } from "../app/model";
import { download } from "../app/download";
import { posterBlob } from "../poster-brush";
import { buildRbPosterModel, drawRbPoster, TOP_N, type RbPosterModel } from "../redblack-poster";
import type { CrowdCounts, StickerBoard } from "../redblack";
import { copyImageOrDownload } from "./share-image";
import { ActionButton, Button, ButtonGroup, Content, Dialog, DialogContainer, Heading } from "./spectrum";

const FILE_NAME = "BIFF2026-红黑榜.png";

interface RedBlackShareDialogProps {
  films: readonly FilmNode[];
  crowd: CrowdCounts;
  board: StickerBoard;
  /** 与页面 hero 同一份数字(传进来而不是重算 —— 图里的数必须与页面上看到的一字不差) */
  site: { total: number; red: number; black: number };
  mine: { marked: number; placed: number; quota: number };
  onDismiss: () => void;
}

export function RedBlackShareDialog({
  films,
  crowd,
  board,
  site,
  mine,
  onDismiss,
}: RedBlackShareDialogProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState("");
  // 快照:只在挂载时算一次(见文件头)。用 `useState` 的惰性初值而不是 `useMemo([])`,
  // 就是为了明确表达「这是个初值,不是派生量」。
  const [model] = useState<RbPosterModel>(() =>
    buildRbPosterModel({ films, crowd, board, site, mine, today: new Date() }),
  );

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let canceled = false;
    void (async () => {
      try {
        drawRbPoster(element, model);
        const next = await posterBlob(element);
        if (canceled) return;
        if (!next) throw new Error("empty canvas");
        setBlob(next);
      } catch {
        if (!canceled) setError("图片生成失败，请重新生成。");
      }
    })();
    return () => {
      canceled = true;
    };
  }, [model]);

  return (
    <DialogContainer onDismiss={onDismiss}>
      <Dialog size="L">
        <Heading slot="title">红黑榜分享图</Heading>
        <Content>
          <p className="rb-share-lede">
            总数榜 / 红榜 / 黑榜各取前 {TOP_N}；我贴过的全部列出，不限条数。
          </p>
          {!blob && !error && <p role="status">正在生成图片…</p>}
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
          <canvas
            ref={canvas}
            className="rb-share-preview"
            hidden={!blob}
            aria-label="红黑榜分享图片预览"
          />
        </Content>
        <ButtonGroup>
          {blob && <Button onPress={() => download(blob, FILE_NAME)}>下载 PNG 图片</Button>}
          {blob && (
            <ActionButton onPress={() => void copyImageOrDownload(blob, FILE_NAME)}>
              复制图片
            </ActionButton>
          )}
          <Button variant="secondary" onPress={onDismiss}>
            关闭
          </Button>
        </ButtonGroup>
      </Dialog>
    </DialogContainer>
  );
}
