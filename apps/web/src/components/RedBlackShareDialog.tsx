/**
 * 「生成分享图」弹层(2026-09-22)。
 *
 * 红黑榜的对外成品:三个榜(总数 / 红 / 黑)各 TOP10 + **我贴过的全部**(不限条数)+ 底部署名。
 * 模型与绘制在 `redblack-poster.ts`(纯逻辑、可单测);这里只管弹层、勾选、预览画布与复制 / 下载。
 *
 * ⚠ a11y 不自造:`role=dialog` / aria-modal / focus trap / Esc 全部由 S2 的 `Dialog` 提供(§5);
 *   挂载手法照仓库既有路径 —— **只在打开时挂**,免得常驻的 `<Dialog>` 被 `DialogContainer`
 *   当成「当前弹层」一起显示(`SettingsDialog::ClearDialog` 的注释里踩过这个坑)。
 * ⚠ **焦点归还**由调用方(红黑榜页面上那个按钮)负责,见 `RedBlackPage.tsx`。
 *
 * ★ **数据是快照,勾选是活的**(2026-09-22):
 *   · 快照 —— 弹层打开那一刻的影片 / 票数 / 我的贴纸就是这张图的内容,之后页面再重拉票数也不影响;
 *   · 勾选 —— 「有的人不想所有的榜单都分享」,所以每一节都能单独勾掉,换勾选只重组这张图。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { FilmNode } from "../app/model";
import { download } from "../app/download";
import { POSTER_W, posterBlob, posterScale } from "../poster-brush";
import {
  allSections,
  buildRbPosterModel,
  drawRbPoster,
  POSTER_SECTIONS,
  rbPosterHeight,
  TOP_N,
  type RbPosterSection,
} from "../redblack-poster";
import type { CrowdCounts, StickerBoard } from "../redblack";
import { copyImageOrDownload } from "./share-image";
import {
  ActionButton,
  Button,
  ButtonGroup,
  Checkbox,
  CheckboxGroup,
  Content,
  Dialog,
  DialogContainer,
  Heading,
} from "./spectrum";

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
  // 数据快照:只在挂载时取一次(见文件头)。用 `useState` 的惰性初值而不是 `useMemo([])`,
  // 就是为了明确表达「这是个初值,不是派生量」。
  const [snapshot] = useState(() => ({ films, crowd, board, site, mine, today: new Date() }));
  const [sections, setSections] = useState<Set<RbPosterSection>>(allSections);
  const model = useMemo(
    () => buildRbPosterModel({ ...snapshot, sections }),
    [snapshot, sections],
  );
  // 「我贴过的」那一项的条数:0 部时勾它没有意义,直接置灰(而不是让用户勾出一节空白)
  const placedCount = useMemo(
    () => [...snapshot.board.values()].filter((list) => list.length > 0).length,
    [snapshot],
  );
  const hasContent = model.boards.length > 0 || model.myRows.length > 0;
  // 出图尺寸随勾选**当场**变:几节几行直接决定高度,所以勾什么就报什么(用户 2026-09-22:
  // 「提示一下选择不同的分享模块后图片分别的大小是多少」)。倍数走 `posterScale`,与实际出图同一处判断。
  const logicalHeight = rbPosterHeight(model);
  const scale = posterScale(POSTER_W, logicalHeight);

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
          {/* 每一节都能单独勾掉:榜单是「全站看法」,不是每个人都愿意全发出去 */}
          <CheckboxGroup
            label="长图内容"
            orientation="horizontal"
            value={[...sections]}
            onChange={(values) => setSections(new Set(values as RbPosterSection[]))}
          >
            {POSTER_SECTIONS.map((section) => (
              <Checkbox
                key={section.id}
                value={section.id}
                isDisabled={section.id === "mine" && placedCount === 0}
              >
                {section.id === "mine" ? `${section.label}（${placedCount} 部）` : section.label}
              </Checkbox>
            ))}
          </CheckboxGroup>
          {/* 尺寸随勾选当场变:节数 / 行数直接决定高度 —— 勾之前就能知道这张图多大 */}
          <p className="rb-share-size" role="status">
            这张长图：
            <strong>
              {POSTER_W * scale} × {logicalHeight * scale}
            </strong>{" "}
            px · {scale}× 出图
            {blob ? ` · PNG 约 ${(blob.size / 1048576).toFixed(1)} MB` : ""}
          </p>
          {!blob && !error && <p role="status">正在生成图片…</p>}
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
          {!hasContent && (
            <p role="status" className="rb-share-lede">
              一节都没勾：图里只剩头部统计与署名，下载与复制已停用。
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
          {blob && (
            <Button isDisabled={!hasContent} onPress={() => download(blob, FILE_NAME)}>
              下载 PNG 图片
            </Button>
          )}
          {blob && (
            <ActionButton
              isDisabled={!hasContent}
              onPress={() => void copyImageOrDownload(blob, FILE_NAME)}
            >
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
