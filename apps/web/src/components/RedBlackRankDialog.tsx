/**
 * 红黑榜「排行榜」弹层（2026-10-15，`PLAN-20261015153233`）。
 *
 * ★ 用户原话：「红黑榜有直观的榜单吗 在快速投票旁边加一个榜单 简单展示红榜 黑榜 TOP50
 *   因为现在贴纸区 只需要显示影片的名称海报 以及红黑贴纸数 只需要样式参考分享图就行」。
 *
 * ★ 版式**参考分享图那一行**（`redblack-poster.ts::drawRow`）：从左到右
 *   **名次 → 行内海报 → 片名（中 / 英）→ 红 N · 黑 N**，一行的信息层级与那张长图一致，
 *   看过图的人不用重新学一遍。
 *   ⚠ 颜色**不照抄**：长图是 canvas 画的深底海报，而这一层活在应用里、要跟着亮 / 暗主题走 ——
 *     所以只沿用它的**版式与字阶层级**，配色一律走 token；红 / 黑那两个数字复用既有的
 *     `.rb-tally__*`（全站唯一那份红黑字色，见 `redblack-parity.css`）。
 *
 * ★ 两层分开：排序与门槛在 `redblack-rank.ts`（纯逻辑、可单测，且与分享图同一支），
 *   本文件只管取数 + 编排。⚠ 票数**由页面传进来**（`reconciledCrowd`，见 `RedBlackPage`）——
 *   自己再算一份的话，弹层上的数字会与同一屏里卡片上的数字对不上。
 *
 * ⚠ a11y 不自造：`role=dialog` / aria-modal / focus trap / Esc 全由 S2 的 `Dialog` 提供（§5）；
 *   **焦点归还**由调用方负责（那枚按钮的主人 `BoardPage` 才知道该还给谁，与「快速投票」同一手法）。
 * ⚠ 刻意**不懒加载**（与文件头那条「参考分享图」无关，是一条体积判断）：本弹层只 import
 *   已在页面里的 `redblack.ts` 与两个 `@biff/contracts` 类型，懒加载只换来一次无谓的往返。
 *   对比：`RedBlackShareDialog` 懒加载是因为一条链上带着 `redblack-poster.ts`（KB 级）。
 */

import { useMemo } from "react";
import type { FilmNode } from "../app/model";
import type { CrowdCounts } from "../redblack";
import { buildRankRows, RANK_BOARDS, RANK_LIMIT } from "../redblack-rank";
import { Button, ButtonGroup, Content, Dialog, DialogContainer, Heading } from "./spectrum";
import "./rank-board.css";

interface RedBlackRankDialogProps {
  /** 影片库（**全量**，与卡片栅格同一份）—— `buildRankRows` 内部再走 `boardFilms` 把它拆成成员片 */
  films: readonly FilmNode[];
  /** 以本地视角修正过的全站票数（与卡片 / hero / 分享图**同一份**，见 `RedBlackPage::reconciledCrowd`） */
  crowd: CrowdCounts;
  /** 评分先验（全站红占比）—— 排序里「同票数比评分」要用它，与卡片角标同一个数 */
  priorRate: number;
  onDismiss: () => void;
}

export function RedBlackRankDialog({
  films,
  crowd,
  priorRate,
  onDismiss,
}: RedBlackRankDialogProps) {
  // ⚠ 两榜**同一拍**算完（同一个 useMemo）：分成两个 useMemo 会让它们在票数刷新时错开一拍，
  //   而这一屏里两列是并排看的，「红榜已经更新、黑榜还是旧数」比两边都旧更刺眼。
  const boards = useMemo(
    () =>
      RANK_BOARDS
        // 该榜一票都没有 → **整列不渲染**（与分享图 `.filter(rows.length > 0)` 同一条：
        // 黑榜里挂一个空标题只会让人以为加载坏了）
        .map((board) => ({ ...board, rows: buildRankRows(films, crowd, board.mode, priorRate) }))
        .filter((board) => board.rows.length > 0),
    [films, crowd, priorRate],
  );

  return (
    <DialogContainer onDismiss={onDismiss}>
      <Dialog size="L">
        <Heading slot="title">红黑榜排行</Heading>
        <Content>
          <p className="rbr-lede">
            红榜 / 黑榜各取前 {RANK_LIMIT} 名 · 按该榜自己的贴纸数排（同数量比评分）。
          </p>
          {boards.length === 0 ? (
            /* 空榜只说一句「怎么开始」—— 两列都空时**不**渲染两个空标题 */
            <p className="rbr-empty" role="status">
              榜上还没有贴纸 —— 点「快速投票」投一枚，这里就有排名了。
            </p>
          ) : (
            <div className="rbr-cols" data-rbr-boards={boards.length}>
              {boards.map((board) => (
                <section className="rbr-col" data-rbr-board={board.mode} key={board.mode}>
                  {/* 标题里带上这一列的行数：红榜第 37 名之后就没了，读者得知道「这是全部」 */}
                  <h3 className="rbr-col-title">
                    {board.label}
                    <span className="rbr-col-count">{board.rows.length}</span>
                  </h3>
                  <ol className="rbr-list">
                    {board.rows.map((row, index) => {
                      const rank = index + 1;
                      return (
                        <li
                          className="rbr-row"
                          key={row.key}
                          data-rbr-key={row.key}
                          data-rbr-rank={rank}
                        >
                          <span className="rbr-rank">{String(rank).padStart(2, "0")}</span>
                          {row.poster ? (
                            /* `decoding="async"` 与卡片同一处置：一屏最多 100 张海报，
                               同步解码会在主线程上抢滚动（它只影响解码时机，不改变布局与优先级） */
                            <img
                              className="rbr-poster"
                              src={row.poster}
                              loading="lazy"
                              decoding="async"
                              alt=""
                            />
                          ) : (
                            /* 缺图是常态 —— 走统一的占位块（印片名首字），**不编一个路径** */
                            <span className="rbr-poster rbr-poster--none" aria-hidden="true">
                              {row.title.trim().charAt(0)}
                            </span>
                          )}
                          <span className="rbr-body">
                            <span className="rbr-title">{row.title}</span>
                            {row.en && <span className="rbr-en">{row.en}</span>}
                            {/* 红 / 黑的字色复用页面那颗合并胶囊里那两段（`.rb-tally__*`）——
                                同一屏里「红」的颜色只允许有一处定义（§5） */}
                            <span className="rbr-counts">
                              <span className="rb-tally__red">红 {row.red}</span>
                              <span className="rb-tally__sep">{" · "}</span>
                              <span className="rb-tally__black">黑 {row.black}</span>
                            </span>
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))}
            </div>
          )}
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
