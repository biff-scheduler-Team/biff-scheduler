/**
 * 卡片级**讨论区**弹层（2026-09-29，PLAN-20260929195500）。
 *
 * 它取代了两样东西（都是**删除**，不是并存）：
 *   · 「放大看全部」大画布弹层 —— 用户已接受「大家怎么贴的再也看不到」这个代价；
 *   · 页面底部的「大家说」模块 —— 评语从此**贴着片子**，而不是一个与片子无关的长列表。
 *
 * 一个弹层 = 这一部的讨论区：聚合计数（红 N · 黑 N）+ **只列写了评语的人** + 只给这一部写的表单。
 *
 * ⚠ 「只列写了评语的人」是**服务端口径**（`readRecentComments` 里的 `isNotNull(comment)`），
 *   不是这里筛的 —— 别为了让「大家贴了什么」更完整而在前端把没写评语的人也补上：
 *   那等于把「谁贴了什么」变成一份公开名单（PLAN 里的隐私硬约束）。
 * ⚠ 这里**一枚贴纸都不画**：弹层不保留大画布（用户拍板），而且想看清自己那枚，
 *   卡片上就是它 —— 再画一遍只会多出一处会与卡片不一致的实现。
 * ⚠ a11y 不自造：`role=dialog` / aria-modal / focus trap / Esc 全由 S2 的 `Dialog` 提供；
 *   **只在打开时挂载**（常驻的 `<Dialog>` 会被 `DialogContainer` 当成当前弹层一起显示）。
 *   **焦点归还**在调用方（卡片上那个入口按钮）。
 */

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { FilmNode } from "../app/model";
import { onFilmVotesChange } from "../film-votes";
import {
  EMPTY_COMMENT_LIST,
  loadFilmComments,
  mergeCommentPage,
  type CommentListState,
} from "../film-comments";
import type { Sticker, StickerCounts } from "../redblack";
import { Button, ButtonGroup, Content, Dialog, DialogContainer, Heading, ToastQueue } from "./spectrum";

/** 评语长度上限（按 Unicode 码点 140，用户 2026-09-29 定）。
 *  ⚠ 它只是**输入侧**的体验拦截（`maxLength`）；权威收口在服务端
 *    （`film-vote-stats.ts::normalizeComment`）—— 本地再截一次就是同一口径的第二份实现。 */
const MAX_COMMENT_LENGTH = 140;

interface FilmCommentsDialogProps {
  film: FilmNode;
  /** 这一部的聚合票数（红 N · 黑 N）—— 与卡片上那两个数字**同源**（页面 `reconcile` 过的那份） */
  counts: StickerCounts;
  /** 我贴的那一枚；没贴过 = `undefined`（一人一片一票一评 —— 没贴过就不能评） */
  mine?: Sticker;
  /** 保存这一部的评语；**空串 = 清掉**（`redblack.ts::setStickerComment` 同一口径） */
  onSaveComment: (filmKey: string, comment: string) => void;
  onDismiss: () => void;
}

export function FilmCommentsDialog({
  film,
  counts,
  mine,
  onSaveComment,
  onDismiss,
}: FilmCommentsDialogProps) {
  /** 列表 + 游标。⚠ 它是**这个弹层实例**的状态（不是模块级单例）—— 换了片子就换一份；
   *  合并那一页的规则全在 `film-comments.ts::mergeCommentPage`（纯函数，单独有单测：
   *  「失败留游标」「不重复追加」这些边界错了不会报错，只会看起来少了几行）。 */
  const [list, setList] = useState<CommentListState>(EMPTY_COMMENT_LIST);
  // 预填**本地**那一份：列表里认不出自己那条（服务端不回身份），本地是唯一知道「我写了什么」的地方
  const [draft, setDraft] = useState(() => mine?.comment ?? "");

  /** 已经取过的游标（`""` = 第一页）。分页去重靠它，而不是比评语内容 ——
   *  比内容会把「两个人恰好同名同评语」当成重复条目丢掉（那是真的两条）。 */
  const requested = useRef(new Set<string>());

  const load = useCallback(
    async (cursor: string | null) => {
      const key = cursor ?? "";
      if (requested.current.has(key)) return;
      // ⚠ 降级（空页）也算「取过了」：否则一进弹层就无限重试，而且空态永远闪不出来
      requested.current.add(key);
      setList((prev) => ({ ...prev, loading: true }));
      const page = await loadFilmComments({ filmKey: film.key, cursor });
      setList((prev) => mergeCommentPage(prev, page, cursor));
    },
    [film.key],
  );

  // 打开即取第一页（弹层是「点了才挂」，所以这里就是「打开一次取一次」，不需要幂等开关）
  useEffect(() => {
    void load(null);
  }, [load]);

  /** 「上报成功后重拉一次」的开关。
   *  为什么不能听着票数变化就重拉：评语是**先落本地、1200ms 防抖后才上报**的，
   *  上报成功那一刻服务端才真的收到它 —— `onFilmVotesChange` 正是那个「服务端已确认」的信号。
   *  但同一个信号在**打开弹层时**也会响一次（那一拍的拉票），不加开关就会白多拉一次；
   *  而这个开关只在用户真的写了评语之后才打开。 */
  const refreshOnSync = useRef(false);
  useEffect(
    () =>
      onFilmVotesChange(() => {
        if (!refreshOnSync.current) return;
        refreshOnSync.current = false;
        requested.current.clear();
        void load(null);
      }),
    [load],
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!mine) return;
    onSaveComment(film.key, draft.trim());
    refreshOnSync.current = true;
    ToastQueue.neutral("评语已保存，正在同步到讨论区 —— 稍等一会儿就能看到。", { timeout: 4000 });
  };

  const draftId = useId();
  const { items, nextCursor, loaded, loading } = list;
  const hasMore = nextCursor !== null;

  return (
    <DialogContainer onDismiss={onDismiss}>
      <Dialog size="L">
        <Heading slot="title">《{film.zh}》的讨论区</Heading>
        <Content>
          {/* ⚠ 「下面只列写了评语的人」这句提示**不能省**：看见「红 5 黑 2」却只有一条评语时，
              用户会以为列表漏了 —— 而那是刻意的口径（服务端只回写了评语的行）。 */}
          <p className="rb-talk-lede">
            {counts.total > 0
              ? `红 ${counts.red} · 黑 ${counts.black}；下面只列写了评语的人。`
              : "还没有人给这一部贴过贴纸 —— 榜上第一枚可以是你的。"}
          </p>

          {/* 写入口。⚠ 一人一片一票一评 —— 没贴过就不能评（那是服务端的口径，不是这里的规矩） */}
          {mine ? (
            <form className="rb-talk-form" onSubmit={submit}>
              <label className="rb-talk-label" htmlFor={draftId}>
                给《{film.zh}》写一句
              </label>
              <textarea
                className="rb-talk-input"
                id={draftId}
                value={draft}
                maxLength={MAX_COMMENT_LENGTH}
                rows={2}
                placeholder="这部片怎么样？一两句话说清就行。"
                onChange={(event) => setDraft(event.target.value)}
              />
              <div className="rb-talk-actions">
                <span className="rb-talk-count" aria-live="polite">
                  {draft.length}/{MAX_COMMENT_LENGTH}
                </span>
                {/* ⚠ 只按「我贴过没有」禁用，**不看 `loading`** —— 保存之后会顺手重拉一次列表，
                    把按钮连带置灰会让用户读成「刚才那下没保存上」 */}
                <button className="rb-talk-save" type="submit">
                  保存评语
                </button>
              </div>
            </form>
          ) : (
            <p className="rb-talk-note">
              先在卡片上给《{film.zh}》贴一枚贴纸，就能给它写评语了。
            </p>
          )}

          {/* 列表。⚠ 空态要**说清为什么空**，不要留一块空白 */}
          {items.length === 0 ? (
            <p className="rb-talk-empty" role="status">
              {loaded ? "还没有人写评语 —— 第一句可以是你的。" : "正在读取评语…"}
            </p>
          ) : (
            <ul className="rb-talk-list">
              {items.map((item, index) => (
                <li className="rb-talk-item" key={`${item.filmKey}#${index}`}>
                  <span className={`rb-talk-vote rb-talk-vote--${item.vote}`}>
                    {item.vote === "red" ? "红" : "黑"}
                  </span>
                  <p className="rb-talk-text">{item.comment}</p>
                  <p className="rb-talk-name">{item.displayName ?? "匿名观众"}</p>
                </li>
              ))}
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
