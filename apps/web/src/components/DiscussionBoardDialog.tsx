/**
 * 红黑榜「讨论区」的**全局总览**弹层（2026-10-07，PLAN-20261007231522）。
 *
 * 与卡片级那个 `FilmCommentsDialog` 是**两个入口、两种语义**，刻意不合并：
 *   · 卡片级弹层问的是「**这一部**怎么样」（它会带上 `filmKey`）；
 *   · 这个总览问的是「**全站**大家都写了什么」—— 它**不带** `filmKey`。
 * 服务端本就支持不带 `filmKey` 的跨片读（`/api/stats/film-comments` 把 `filmKey` 当
 * **可选过滤**），所以这里**没有新开读路径、也没有后端改动**。
 *
 * ⚠ 每行必须写清**是哪一部**：跨片列表里没有片名，读者根本不知道自己看的是谁 ——
 *   这正是本弹层存在的理由（用户原话「能通过角标或者什么显示是哪个电影的」）。
 *   片名从**全量** `filmByKey` 反查，而不是榜单当前过滤后的那份 ——
 *   总览列的是全站评语，不该跟着页面的搜索词一起缩水。
 * ⚠ 列表里认不出「哪条是我写的」：服务端不回身份标识（`contributor` 那条硬约束），
 *   这不是缺陷，是刻意的（与卡片级弹层的口径逐字一致）。
 * ⚠ 接口没上线 / 挂了必须退化成空态，绝不把页面拖挂 —— 理由同 `film-comments.ts` 的文件头。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { FilmNode } from "../app/model";
import {
  EMPTY_COMMENT_LIST,
  loadFilmComments,
  mergeCommentPage,
  type CommentListState,
} from "../film-comments";
import { Button, ButtonGroup, Content, Dialog, DialogContainer, Heading } from "./spectrum";

interface DiscussionBoardDialogProps {
  /** **全量**片名反查（`useCatalog().filmByKey`）—— 不受页面搜索 / 筛选影响 */
  filmByKey: Map<string, FilmNode>;
  /** 榜单上**真的有卡**的那些片 key（`redblack.ts::boardFilms` 的口径）。
   *  ⚠ 评语可能属于一届里已经**没有排期**的目录片（或旧届残留）：那些行只能读、不能跳 ——
   *    点了会滚到一个根本不存在的卡片上，那比「不能点」更让人困惑。 */
  boardKeys: ReadonlySet<string>;
  /** 点一行 → 跳到该片卡片（关弹层 / 滚动 / 高亮由调用方负责） */
  onJump: (filmKey: string) => void;
  onDismiss: () => void;
}

export function DiscussionBoardDialog({
  filmByKey,
  boardKeys,
  onJump,
  onDismiss,
}: DiscussionBoardDialogProps) {
  /** 列表 + 游标。⚠ 与卡片级弹层一样是**这个弹层实例**的状态（不是模块级单例）——
   *  合并那一页的边界规则全在 `film-comments.ts::mergeCommentPage`（纯函数，单独有单测）。 */
  const [list, setList] = useState<CommentListState>(EMPTY_COMMENT_LIST);
  /** 已经取过的游标（`""` = 第一页）。分页去重靠它，而不是比评语内容 ——
   *  比内容会把「两个人恰好同名同评语」当成重复条目丢掉（那是真的两条）。 */
  const requested = useRef(new Set<string>());

  const load = useCallback(async (cursor: string | null) => {
    const key = cursor ?? "";
    if (requested.current.has(key)) return;
    // ⚠ 降级（空页）也算「取过了」：否则一进弹层就无限重试，而且空态永远闪不出来
    requested.current.add(key);
    setList((prev) => ({ ...prev, loading: true }));
    // ⚠ **不带 `filmKey`** 就是跨片读 —— 见文件头。传了就退回「只问这一部」了。
    const page = await loadFilmComments({ cursor });
    setList((prev) => mergeCommentPage(prev, page, cursor));
  }, []);

  // 打开即取第一页（弹层是「点了才挂」，所以这里就是「打开一次取一次」）
  useEffect(() => {
    void load(null);
  }, [load]);

  const { items, nextCursor, loaded, loading } = list;
  const hasMore = nextCursor !== null;

  return (
    <DialogContainer onDismiss={onDismiss}>
      <Dialog size="L">
        <Heading slot="title">讨论区总览</Heading>
        <Content>
          {/* ⚠ 这句提示不能省：它要说明「为什么这里和卡片上那枚不一样」——
              卡片上那枚只问这一部，这里列的是全站。 */}
          <p className="rb-talk-lede">全站评语，按时间倒序；点一行跳到那一部的卡片。</p>

          {/* 列表。⚠ 空态要**说清为什么空**，不要留一块空白 */}
          {items.length === 0 ? (
            <p className="rb-talk-empty" role="status">
              {loaded ? "还没有人写过评语 —— 第一句可以是你的。" : "正在读取评语…"}
            </p>
          ) : (
            <ul className="rb-talk-list">
              {items.map((item, index) => {
                const film = filmByKey.get(item.filmKey);
                const label = film?.zh ?? "未知影片";
                const inner = (
                  <>
                    <span className={`rb-talk-vote rb-talk-vote--${item.vote}`}>
                      {item.vote === "red" ? "红" : "黑"}
                    </span>
                    {/* 片名角标：跨片列表里「这是哪一部」唯一的信息来源。
                        ⚠ 反查不到时退化成「未知影片」，把原始 key 放进 `title` 供排查 ——
                          直接把 `cat:xxx` / `sched:yyy` 摆到脸上对读者毫无意义。 */}
                    <span className="rb-board-film" title={film ? undefined : item.filmKey}>
                      《{label}》
                    </span>
                    <p className="rb-talk-text">{item.comment}</p>
                    <p className="rb-talk-name">{item.displayName ?? "匿名观众"}</p>
                  </>
                );
                // ⚠ 跳不了的行**用 `div` 而不是禁用的 `button`**：禁用按钮仍会被读屏念成
                //   「按钮，不可用」，而这里根本没有那个动作（榜单上没有它的卡）。
                return (
                  <li className="rb-board-li" key={`${item.filmKey}#${index}`}>
                    {film && boardKeys.has(item.filmKey) ? (
                      <button
                        type="button"
                        className="rb-talk-item rb-board-row"
                        /* ⚠ 这里**刻意**既没有 `aria-label` 也没有 `title` ——
                         *   两者都会成为按钮的**可访问名**，把这行真正的内容（片名 / 评语 / 昵称）
                         *   整个替换掉，读屏用户就再也听不到评语了。
                         *   实测（Chromium 无障碍树）：挂了 `title` 之后算出的名字是
                         *   「跳到《X》的卡片」，评语只剩在看得到的 DOM 里。
                         *   所以「点了会跳」这件事由**上面那句 lede** 交代（可见文案 + 读屏同样读到），
                         *   行按钮的可访问名就老老实实等于它的内容。
                         *   E2E 有一条断言钉着这件事（`name: /第一部真好/`）。 */
                        onClick={() => onJump(item.filmKey)}
                      >
                        {inner}
                      </button>
                    ) : (
                      <div className="rb-talk-item rb-board-row rb-board-row--static">{inner}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {/* 翻页走游标；服务端说没有下一页了（`nextCursor` 为 null）就整颗按钮消失 */}
          {hasMore && (
            <button
              className="rb-talk-more"
              type="button"
              disabled={loading}
              onClick={() => void load(nextCursor)}
            >
              加载更多
            </button>
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
