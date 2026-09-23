/**
 * 「放大看全部」弹层(2026-09-22,PLAN-20260922145815)。
 *
 * 卡片上那块画布只有一百多像素高,票一多就叠成一片。这个弹层给它一块**大画布**:
 * 与卡片消费同一套位置推导(`crowdStickers` / `spotOf` / `tiltOf`)与同一个 `StickerCanvas`,
 * 所以两处**位置完全一致**,只是这里铺得开、看得清每一枚。
 *
 * ⚠ **组成也与卡片逐字相同**(2026-09-23 修订,PLAN-20260923104622):画布只画**别人的**
 *   (`othersOf(counts, mine)`),「我贴的那一枚」是压在画布之上的一个只读 `.rb-dot` ——
 *   于是它自动带上那圈**常驻纸白边**(与卡片同一处实现),位置也是它的**真实坐标**。
 *   改之前这里是把 `all` 交给画布:我那一枚被画成 `crowdStickers(filmKey, all)` 的**最后一枚**,
 *   那是由 id 推导出来的点,与卡片上它的真实落点**不是同一个位置** —— 而 lede 还写着
 *   「位置与卡片上一致」,且一片同色同尺寸的群点里根本认不出自己那枚。
 *
 * ⚠ a11y 不自造:`role=dialog` / aria-modal / focus trap / Esc 全部由 S2 的 `Dialog` 提供
 *   (§5 口径单一来源)。挂载手法照仓库既有路径(`App.tsx` / `ScheduleGantt.tsx`):
 *   **只在打开时**挂 —— 常驻的 `<Dialog>` 会被 `DialogContainer` 当成「当前弹层」一起显示,
 *   详见 `SettingsDialog::ClearDialog` 的注释。
 * ⚠ **焦点归还**在调用方(卡片上那个「看全部」按钮),这里只管内容。
 */

import type { CSSProperties } from "react";
import type { FilmNode } from "../app/model";
import { countsOf, othersOf, tiltOf, type Sticker, type StickerCounts } from "../redblack";
import { StickerCanvas } from "./StickerCanvas";
import { Button, ButtonGroup, Content, Dialog, DialogContainer, Heading } from "./spectrum";

interface StickerZoomDialogProps {
  film: FilmNode;
  /** 这一部的**全体**票数(已含我自己那一票)—— 就是卡片上写着的那个红黑数字 */
  counts: StickerCounts;
  /** 我贴的那一枚;没贴过 = `undefined`。
   *  ⚠ 它**不进**递给画布的计数:画布只画别人的,这一枚由本组件压在画布之上
   *    (口径与 `RbCard` 一致,白边与光标因此只有一处实现)。 */
  mine?: Sticker;
  onDismiss: () => void;
}

export function StickerZoomDialog({ film, counts, mine, onDismiss }: StickerZoomDialogProps) {
  // 「别人的」= 全体 − 我那一枚。⚠ 服务端那份**含我**,不减掉就会把我画两遍;
  //   上报还没落地时会被夹到 0,这时画布上少一枚、由下面那枚 DOM 补上,两个方向都对。
  const others = othersOf(counts, countsOf(mine ? [mine] : []));

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
            <StickerCanvas filmKey={film.key} counts={others} inView />
            {mine && (
              // ⚠ 这里**只读**:它拖不动、也点不收(那是卡片上的能力),所以不带 `grab` 光标 ——
              //   见 `.rb-dot--still` 的说明。位置/歪斜与卡片上那枚共用同一套写法。
              <span
                className={`rb-dot rb-dot--${mine.type} rb-dot--still`}
                aria-hidden="true"
                style={
                  {
                    left: `${mine.posX * 100}%`,
                    top: `${mine.posY * 100}%`,
                    "--rb-tilt": `${tiltOf(mine.id)}deg`,
                  } as CSSProperties
                }
              />
            )}
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
