/**
 * 「放大看全部」弹层(2026-09-22,PLAN-20260922145815)。
 *
 * 卡片上那块画布只有一百多像素高,票一多贴纸就叠成一片。这个弹层给它一块**大画布**:
 * 与卡片消费同一套位置推导(`crowdStickers` / `spotOf` / `tiltOf`)与同一个 `StickerCanvas`,
 * 所以两处**位置完全一致**,只是这里铺得开、看得清每一枚。
 *
 * ⚠ a11y 不自造:`role=dialog` / aria-modal / focus trap / Esc 全部由 S2 的 `Dialog` 提供
 *   (§5 口径单一来源)。挂载手法照仓库既有路径(`App.tsx` / `ScheduleGantt.tsx`):
 *   **只在打开时**挂 —— 常驻的 `<Dialog>` 会被 `DialogContainer` 当成「当前弹层」一起显示,
 *   详见 `SettingsDialog::ClearDialog` 的注释。
 * ⚠ **焦点归还**在调用方(卡片上那个「看全部」按钮),这里只管内容。
 */

import type { FilmNode } from "../app/model";
import type { StickerCounts } from "../redblack";
import { StickerCanvas } from "./StickerCanvas";
import { Button, ButtonGroup, Content, Dialog, DialogContainer, Heading } from "./spectrum";

interface StickerZoomDialogProps {
  film: FilmNode;
  /** 要画的是**全部**贴纸(大家的 + 我贴的那一枚),不是卡片上那份「别人的」 */
  counts: StickerCounts;
  onDismiss: () => void;
}

export function StickerZoomDialog({ film, counts, onDismiss }: StickerZoomDialogProps) {
  return (
    <DialogContainer onDismiss={onDismiss}>
      <Dialog size="L">
        <Heading slot="title">《{film.zh}》的全部贴纸</Heading>
        <Content>
          <p className="rb-zoom-lede">
            共 {counts.total} 枚（红 {counts.red} · 黑 {counts.black}）—— 位置与卡片上一致，只是铺得开。
          </p>
          {/* 弹层里的画布永远在视口内,`inView` 恒为 true(不需要视口观测) */}
          <div className="rb-zoom-stage">
            <StickerCanvas filmKey={film.key} counts={counts} inView />
          </div>
        </Content>
        <ButtonGroup>
          <Button variant="secondary" onPress={onDismiss}>
            关闭
          </Button>
        </ButtonGroup>
      </Dialog>
    </DialogContainer>
  );
}
