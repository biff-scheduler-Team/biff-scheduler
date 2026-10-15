/**
 * 红黑榜「排行榜」弹层（2026-10-15，`PLAN-20261015153233`）。
 *
 * ★ 用户原话：「红黑榜有直观的榜单吗 在快速投票旁边加一个榜单 简单展示红榜 黑榜 TOP50
 *   因为现在贴纸区 只需要显示影片的名称海报 以及红黑贴纸数 只需要样式参考分享图就行」。
 *
 * ★ 版式与配色**照着分享图那一行做**（`redblack-poster.ts` 的 `drawRow` / `drawSection` /
 *   `drawCounts`）：从左到右 **名次 → 行内海报 → 片名（中 / 英）→ 红 N · 黑 N**，
 *   深底 + 海报色、分节头是一根红竖条 —— 看过那张长图的人不用重新学一遍。
 *   ⚠ 2026-10-15（`PLAN-20261015161935`）用户看过第一版后的话：「排行样式应该参考红黑榜的分享样式」
 *     —— 第一版只借了**版式顺序**、配色走的是应用 token（白底），观感与那张图差得远。
 *   ⚠ 色值一律从 `COLORS` 注入（`POSTER_SKIN`），本文件与 `rank-board.css` 都不写死色值。
 *
 * ★ 两层分开：排序与门槛在 `redblack-rank.ts`（纯逻辑、可单测，且与分享图同一支），
 *   本文件只管取数 + 编排。⚠ 票数**由页面传进来**（`reconciledCrowd`，见 `RedBlackPage`）——
 *   自己再算一份的话，弹层上的数字会与同一屏里卡片上的数字对不上。
 *
 * ★ 底部 `ButtonGroup` 里那枚「生成分享图」是**交接**、不是第二条出图路径（2026-10-15，
 *   `PLAN-20261015170310`，用户「没有分享按钮吧无法分享结果」）：本弹层让位、
 *   `RedBlackShareDialog` 接手，并带上 `RANK_LIMIT` 作为分享图的默认档 ——
 *   分享的就是刚看到的这份 TOP50。
 *
 * ⚠ a11y 不自造：`role=dialog` / aria-modal / focus trap / Esc 全由 S2 的 `Dialog` 提供（§5）；
 *   **焦点归还**由调用方负责（那枚按钮的主人 `BoardPage` 才知道该还给谁，与「快速投票」同一手法）。
 * ⚠ 刻意**不懒加载**：本弹层只 import 已在页面里的 `redblack.ts` / `poster-brush.ts`（后者是纯常量，
 *   无 DOM 副作用、可被 tree-shake）与两个 `@biff/contracts` 类型，懒加载只换来一次无谓的往返。
 *   对比：`RedBlackShareDialog` 懒加载是因为一条链上带着 `redblack-poster.ts`（KB 级）。
 */

import { useMemo, type CSSProperties } from "react";
import type { FilmNode } from "../app/model";
import { COLORS } from "../poster-brush";
import type { CrowdCounts } from "../redblack";
import { buildRankRows, RANK_BOARDS, RANK_LIMIT } from "../redblack-rank";
import { Button, ButtonGroup, Content, Dialog, DialogContainer, Heading } from "./spectrum";
import "./rank-board.css";

/** 分享图那一套**固定深色**（`poster-brush.ts::COLORS`——分享图是对外成品，底色不随应用主题翻，
 *  理由见那里的注释）。这里把它注入成 CSS 变量，而不是在 `rank-board.css` 里再抄一份色值：
 *  同一含义只允许有一处定义，抄第二份就会在改调色板时静默分叉（§5）。 */
const POSTER_SKIN = {
  "--rbr-bg": COLORS.bg,
  "--rbr-card": COLORS.card,
  "--rbr-line": COLORS.line,
  "--rbr-ink": COLORS.ink,
  "--rbr-ink2": COLORS.ink2,
  "--rbr-muted": COLORS.muted,
  "--rbr-red": COLORS.red,
  "--rbr-red2": COLORS.red2,
} as CSSProperties;

interface RedBlackRankDialogProps {
  /** 影片库（**全量**，与卡片栅格同一份）—— `buildRankRows` 内部再走 `boardFilms` 把它拆成成员片 */
  films: readonly FilmNode[];
  /** 以本地视角修正过的全站票数（与卡片 / hero / 分享图**同一份**，见 `RedBlackPage::reconciledCrowd`） */
  crowd: CrowdCounts;
  /** 评分先验（全站红占比）—— 排序里「同票数比评分」要用它，与卡片角标同一个数 */
  priorRate: number;
  /** 「生成分享图」——**交接**给分享图弹层（`RedBlackShareDialog`），本弹层由调用方关掉。
   *  ⚠ 不在这里内嵌出图：分享图只有一份实现（§5），这里只负责把「我要分享这份排行」这件事交出去。 */
  onShare: () => void;
  onDismiss: () => void;
}

export function RedBlackRankDialog({
  films,
  crowd,
  priorRate,
  onShare,
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
          {/* 这一块 = 「把分享图那一屏搬进来」：深底、海报色、分节头是一根红竖条。
              色值全部来自 `POSTER_SKIN`（见文件头），本组件不写死任何一个色值。 */}
          <div className="rbr-sheet" style={POSTER_SKIN}>
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
                    {/* 分节头 = 红色竖条 + 标题 + 行数（形态照分享图的 `drawSection`）。
                        行数带上是因为：红榜第 37 名之后就没了，读者得知道「这是全部」 */}
                    <h3 className="rbr-col-title">
                      <span className="rbr-bar" aria-hidden="true" />
                      <span className="rbr-col-label">{board.label}</span>
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
                              {/* 分段上色（分享图 `drawCounts`）：标签与分隔符走次级色，
                                  只有两个数字上色。⚠ 深底上用的是**海报那一对**
                                  （`COLORS.red2` / `COLORS.ink2`），不是浅底的 `.rb-tally__*` */}
                              <span className="rbr-counts">
                                <span className="rbr-red">红 {row.red}</span>
                                <span>{" · "}</span>
                                <span className="rbr-black">黑 {row.black}</span>
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
          </div>
        </Content>
        <ButtonGroup>
          {/* 往外发的入口 —— 用户原话：「没有分享按钮吧无法分享结果」。
              与页头那枚同名同义（`RedBlackPage` 的「生成分享图」），落到**同一个**分享图弹层。
              ⚠ 空榜时禁用：一票都没有就没有排行可分享，点开只会得到一张「一节都没勾」的图。
              ⚠ 它是这一层的主操作，所以是实底 `Button`（「关闭」退成 secondary）。 */}
          <Button isDisabled={boards.length === 0} onPress={onShare}>
            生成分享图
          </Button>
          <Button variant="secondary" onPress={onDismiss}>
            关闭
          </Button>
        </ButtonGroup>
      </Dialog>
    </DialogContainer>
  );
}
