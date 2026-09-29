// 红黑榜「大家说」—— 榜单下方的页面级评语模块（2026-09-29,PLAN-20260929181900）。
//
// 为什么评语**独立成一个区域**、而不是挂在贴纸上（用户 2026-09-29 的原话）：
// 「评语我觉得单独做一个模块吧 不要放在贴纸上 不然很乱」。
// 于是贴纸回到「只是贴纸」—— 画布上不需要任何悬停命中 / 浮层 / 重叠聚拢那套机制
// （「要求精准点中那一枚 8px 的点」这个问题随之消失），评语回到「只是一列文字」。
//
// 口径（用户 2026-09-29 拍板，完整版见 PLAN）：
//   · 匿名也能评，匿名评语**也公开** —— 读到的是「一个匿名观众说」+ 正文，读不到是谁；
//   · **不显示时间**：`updated_at` 只做服务端排序，不进 UI；
//   · 一人一片一票一评 —— 所以选片范围是**本地已经贴过的那几部**，没贴过就不能评
//     （表单在没贴过任何片时给一句引导，而不是渲染一个空的 select）；
//   · 列表里**不标「这条是我写的」**：服务端不回身份（`contributor` 那条硬约束），
//     前端也不许拿「片名 + 正文相同」去猜。想改自己的评语，就在表单里选那部片 ——
//     文本框会**预填本地那一份**（本地是唯一知道「我写了什么」的地方）。
//
// ⚠ 分页用「加载更多」按钮而**不做无限滚动**：它落在页面最底部，滚动触底在窄屏上不稳定。

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useCatalog } from "../app/store";
import { ToastQueue } from "./spectrum";
import { onFilmVotesChange } from "../film-votes";
import {
  loadComments,
  loadMoreComments,
  onFilmCommentsChange,
  peekFilmComments,
  type FilmCommentsState,
} from "../film-comments";
import type { StickerType } from "../redblack";

/** 评语长度上限（按 Unicode 码点 140，用户 2026-09-29 定）。
 *  ⚠ 它只是**输入侧**的体验拦截（`maxLength`）；权威收口在服务端
 *    （`film-vote-stats.ts::normalizeComment`）—— 本地再截一次就是同一口径的第二份实现。 */
const MAX_COMMENT_LENGTH = 140;

export interface MyFilmRow {
  key: string;
  type: StickerType;
  /** 本地已写的那份评语（没写过则为 `undefined`）—— 选中时预填文本框 */
  comment?: string;
}

export interface FilmCommentsPanelProps {
  /** 我贴过的片（一人一片一票一评 —— 没贴过就不能评，所以候选就是这一份） */
  mine: readonly MyFilmRow[];
  /** 保存某部片的评语；**空串 = 清掉**（`redblack.ts::setStickerComment` 同一口径） */
  onSaveComment: (filmKey: string, comment: string) => void;
}

export function FilmCommentsPanel({ mine, onSaveComment }: FilmCommentsPanelProps) {
  const { filmByKey } = useCatalog();
  const [state, setState] = useState<FilmCommentsState>(() => peekFilmComments());

  // 首屏取第一页（幂等：模块内部记着「取过了」，重复挂载不会再发请求）
  useEffect(() => {
    const off = onFilmCommentsChange(() => setState(peekFilmComments()));
    void loadComments();
    return off;
  }, []);

  /** 「上报成功后重拉一次」的开关。
   *  为什么不能听着票数变化就重拉：评语是**先落本地、1200ms 防抖后才上报**的，
   *  上报成功那一刻服务端才真的收到它 —— `onFilmVotesChange` 正是那个「服务端已确认」的信号
   *  （`film-votes.ts::applyVotes`）。但同一个信号在**进页面时**也会响一次（首屏那次拉票），
   *  不加开关就会白多拉一次评语；而这个开关只在用户真的写了评语之后才打开。 */
  const refreshOnSyncRef = useRef(false);
  useEffect(
    () =>
      onFilmVotesChange(() => {
        if (!refreshOnSyncRef.current) return;
        refreshOnSyncRef.current = false;
        void loadComments(true);
      }),
    [],
  );

  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState("");
  // 选中的片可能已经不在了（取消「看过」标记会把票一起收回）—— 那就算「没选」
  const selectedKey = useMemo(
    () => (mine.some((row) => row.key === selected) ? selected : ""),
    [mine, selected],
  );

  const headingId = useId();
  const selectId = useId();
  const draftId = useId();

  const pick = (key: string) => {
    setSelected(key);
    // 预填本地那一份：列表里认不出自己那条，所以「改评语」的唯一入口就是这里
    setDraft(mine.find((row) => row.key === key)?.comment ?? "");
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!selectedKey) return;
    onSaveComment(selectedKey, draft.trim());
    refreshOnSyncRef.current = true;
    ToastQueue.neutral("评语已保存，正在同步到「大家说」—— 稍等一会儿就能看到。", {
      timeout: 4000,
    });
  };

  const { items, nextCursor, loaded, loading } = state;
  const busy = loading;

  return (
    <section className="rb-say" aria-labelledby={headingId}>
      <header className="rb-say-head">
        <h2 className="rb-say-title" id={headingId}>
          大家说
        </h2>
        <p className="rb-say-lede">按最新排；不用登录也能评，匿名也会显示为「匿名观众」。</p>
      </header>

      {/* 写入口。⚠ 不在贴纸上加控件（见文件头）—— 所以这里是**唯一**的评语入口 */}
      {mine.length === 0 ? (
        <p className="rb-say-note">
          先在卡片上标记「看过」并贴一枚贴纸，就能给它写评语了。
        </p>
      ) : (
        <form className="rb-say-form" onSubmit={submit}>
          <label className="rb-say-label" htmlFor={selectId}>
            给哪一部写
          </label>
          <select
            className="rb-say-select"
            id={selectId}
            value={selectedKey}
            onChange={(event) => pick(event.target.value)}
          >
            <option value="">选一部你贴过的片…</option>
            {mine.map((row) => {
              const film = filmByKey.get(row.key);
              return (
                <option key={row.key} value={row.key}>
                  《{film?.zh ?? row.key}》 · {row.type === "red" ? "红" : "黑"}
                </option>
              );
            })}
          </select>
          <label className="rb-say-label" htmlFor={draftId}>
            你的评语
          </label>
          <textarea
            className="rb-say-input"
            id={draftId}
            value={draft}
            maxLength={MAX_COMMENT_LENGTH}
            rows={2}
            placeholder="这部片怎么样？一两句话说清就行。"
            disabled={!selectedKey}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="rb-say-actions">
            <span className="rb-say-count" aria-live="polite">
              {draft.length}/{MAX_COMMENT_LENGTH}
            </span>
            {/* ⚠ 只按「有没有选片」禁用,**不看 `busy`** —— 保存之后会顺手重拉一次列表,
                把按钮连带置灰会让用户读成「刚才那下没保存上」 */}
            <button className="rb-say-save" type="submit" disabled={!selectedKey}>
              保存评语
            </button>
          </div>
        </form>
      )}

      {/* 列表。⚠ 空态要**说清为什么空**，不要留一块空白 */}
      {items.length === 0 ? (
        <p className="rb-say-empty" role="status">
          {loaded ? "还没有人写评语 —— 榜上第一句可以是你的。" : "正在读取评语…"}
        </p>
      ) : (
        <ul className="rb-say-list">
          {items.map((item, index) => {
            // 片名由 `filmKey` 走目录反查（服务端**不 join 影片库**，见 PLAN）
            const film = filmByKey.get(item.filmKey);
            return (
              <li className="rb-say-item" key={`${item.filmKey}#${index}`}>
                <span className={`rb-say-vote rb-say-vote--${item.vote}`}>
                  {item.vote === "red" ? "红" : "黑"}
                </span>
                <p className="rb-say-text">{item.comment}</p>
                <p className="rb-say-meta">
                  <span className="rb-say-film">{film ? `《${film.zh}》` : item.filmKey}</span>
                  <span className="rb-say-name">{item.displayName ?? "匿名观众"}</span>
                </p>
              </li>
            );
          })}
        </ul>
      )}

      {/* 翻页走游标；服务端说没有下一页了（`nextCursor` 为 null）就整颗按钮消失 */}
      {nextCursor && (
        <button
          className="rb-say-more"
          type="button"
          disabled={busy}
          onClick={() => void loadMoreComments()}
        >
          加载更多
        </button>
      )}
    </section>
  );
}
