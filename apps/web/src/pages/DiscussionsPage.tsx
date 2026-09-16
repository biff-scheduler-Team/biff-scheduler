import { REACTION_EMOJIS } from "@biff/contracts/reactions";
import { discussionCategoryLabel } from "@biff/contracts/screening";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { matchScreenings } from "../app/schedule-search";
import { useCatalog } from "../app/store";
import { ScreeningDiscussionDialog } from "../components/ScreeningDiscussionDialog";
import { useScreeningCounts } from "../components/ScreeningTickets";
import {
  ActionButton,
  DialogContainer,
  DialogTrigger,
  SearchField,
  ToastQueue,
} from "../components/spectrum";
import { effEndMin, talkOnOf } from "../gv";
import { venueShort } from "../legend";
import {
  fetchDiscussionBoard,
  formatDiscussionTime,
  type DiscussionPost,
} from "../screening-discussion";
import { store } from "../state";
import type { Screening } from "../types";
import { dateInfo, displayTitle, fmtEndClock } from "../util";
import "../components/screening-social.css";

/** 单个帖子格子。
 *
 *  ⚠ 「进入讨论」仍是**既有的场次讨论弹层** —— 帖子必须挂在某个场次上(接口契约如此),
 *    发帖 / 反应 / 删除 / 社区提醒整套口径都在那里;讨论区只负责「把集合摆出来 + 定位」。
 *  ⚠ 弹层**打开时才挂载**(与 `DiscussionEntry` 同一手法):`DialogTrigger` 会无条件渲染 children,
 *    而弹层挂载即拉列表 —— 整面墙 N 个格子会变成 N 个请求 + N 条失败 toast。
 */
function DiscussionTile({
  post,
  screening,
  located,
  onPosted,
}: {
  post: DiscussionPost;
  screening: Screening | undefined;
  located: boolean;
  /** 弹层里发帖成功后把新帖插到方格墙首位(见 `ScreeningDiscussionDialog.onPosted`)。 */
  onPosted: (post: DiscussionPost) => void;
}) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  const mapping = store.mappings.get(post.code);
  const title = screening ? displayTitle(screening, mapping?.title_cn) : post.code;
  const when = screening
    ? `${dateInfo(screening.date).label} ${screening.start_time.slice(0, 5)}–${fmtEndClock(
        effEndMin(screening, talkOnOf(post.code)),
      )}`
    : "该场次已不在本次排期中";
  const reactions = REACTION_EMOJIS.map((emoji) => ({
    emoji,
    count: post.reactionCounts[emoji] ?? 0,
  })).filter((item) => item.count > 0);
  return (
    <li
      className={located ? "discussion-tile located" : "discussion-tile"}
      data-discussion-id={post.id}
      data-discussion-code={post.code}
    >
      <div className="discussion-tile-head">
        <span className="discussion-tag" data-discussion-category={post.category}>
          {discussionCategoryLabel(post.category)}
        </span>
        <time dateTime={new Date(post.createdAt).toISOString()}>
          {formatDiscussionTime(post.createdAt)}
        </time>
      </div>
      <p className="discussion-tile-body">{post.body}</p>
      <div className="discussion-tile-meta">
        <strong>{title}</strong>
        <span>{when}</span>
        <span>
          场次 {post.code} · {post.displayName}
        </span>
      </div>
      <div className="discussion-tile-foot">
        {reactions.length > 0 ? (
          <span className="discussion-tile-reactions" aria-label="已有反应">
            {reactions.map((item) => (
              <span key={item.emoji}>
                {item.emoji} {item.count}
              </span>
            ))}
          </span>
        ) : (
          <span className="muted">还没有人反应</span>
        )}
        <DialogTrigger
          isOpen={open}
          onOpenChange={(next) => {
            // 每次打开都重挂载弹层:清空草稿 / 重新拉第一页(与 DiscussionEntry 同一手法)
            if (next) setSession((n) => n + 1);
            setOpen(next);
          }}
        >
          <ActionButton
            aria-label={`进入场次 ${post.code} 的讨论`}
            isDisabled={!screening}
          >
            进入讨论
          </ActionButton>
          {open && screening && (
            <ScreeningDiscussionDialog key={session} screening={screening} onPosted={onPosted} />
          )}
        </DialogTrigger>
      </div>
    </li>
  );
}

/** 讨论区:全站帖子墙(2026-09-15,PLAN-20260915233816)。
 *
 *  与行程页的关系:行程场次卡上的「讨论 N」跳到 `/discussions?focus=<场次 code>`,
 *  这里滚动到该场次的第一条并高亮该场次的所有格子 —— 即「直接定位到这个区域的这个帖子」。
 *  口径上定位的是**场次**(入口只有场次级信息),不是单条帖子。
 *
 *  ⚠ **定位条自带「发帖」入口**(2026-09-16,`PLAN-20260916102631`):行程卡上的「讨论」只做跳转,
 *    而方格墙的格子是**已存在的帖子** —— 某场一条帖子都没有时,没有这个入口就无法发首帖
 *    (会形成「回行程点『讨论』→ 又跳回来」的闭环)。发帖仍走 `ScreeningDiscussionDialog`(唯一实现)。
 *
 *  ⚠ **页头另有常驻的「发帖」入口**(2026-09-16,`PLAN-20260916154255`):上面两个入口都要求
 *    **场次已知**(一个来自 focus / 一个来自已有帖子),所以无 focus 的 `/discussions` 上原本
 *    根本发不了帖 —— 用户手上知道编号(如 0412)却得先绕去行程页。这里补的入口是「自己挑一场」:
 *    内联展开场次检索(与「添加转票场次」共用 `app/schedule-search.ts`),选中后再开既有弹层。
 *    ⚠ 选择区**刻意不是弹层** —— 两层 modal 交接(关选择器 + 开讨论层同帧)的焦点归还没有保证。
 */
export function DiscussionsPage() {
  const { cat } = useCatalog();
  const counts = useScreeningCounts();
  const location = useLocation();
  const navigate = useNavigate();
  const [posts, setPosts] = useState<DiscussionPost[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // 定位条上的「发帖」:与格子上的「进入讨论」共用同一个弹层,只是入口不同(见文件头注释)。
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerSession, setComposerSession] = useState(0);
  // 页头常驻的「发帖」:自己挑一场发,不依赖 focus / 已有帖子(见文件头注释)。
  const [picking, setPicking] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [pickedCode, setPickedCode] = useState<string | null>(null);
  const [pickedSession, setPickedSession] = useState(0);
  const grid = useRef<HTMLUListElement>(null);
  const focus = new URLSearchParams(location.search).get("focus");
  const located = focus ? posts.filter((post) => post.code === focus) : [];

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const page = await fetchDiscussionBoard(null);
        if (!alive) return;
        setPosts(page.posts);
        setCursor(page.nextCursor);
      } catch {
        if (alive) ToastQueue.negative("无法加载讨论区，请稍后重试。");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 定位只滚一次:翻页会让 `posts` 变化,若跟着再滚一次就会把用户拽回原位。
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!focus || loading || scrolledFor.current === focus) return;
    const tile = grid.current?.querySelector<HTMLElement>(
      `[data-discussion-code="${focus}"]`,
    );
    if (!tile) return;
    scrolledFor.current = focus;
    tile.scrollIntoView({ block: "center" });
  }, [focus, loading, posts]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchDiscussionBoard(cursor);
      setPosts((prev) => [...prev, ...page.posts]);
      setCursor(page.nextCursor);
    } catch {
      ToastQueue.negative("加载更多失败，请稍后重试。");
    } finally {
      setLoadingMore(false);
    }
  };

  const clearFocus = () => navigate("/discussions", { replace: true });

  // 新帖按时间倒序排在最前 —— 与 `fetchDiscussionBoard` 的排序口径一致,不做二次比较。
  const prependPost = (post: DiscussionPost) => setPosts((prev) => [post, ...prev]);

  // 候选只在选择区展开时算 —— 不展开就不该为整份排期做一次全表匹配。
  const matches = picking ? matchScreenings(cat.schedule.screenings, keyword) : [];
  // 自己挑的那一场:和定位条那条路径一样,发帖仍走 `ScreeningDiscussionDialog`(唯一实现)。
  const pickedTarget = pickedCode ? cat.byCode.get(pickedCode) : undefined;

  /** 选中候选:收起选择区,再开讨论弹层。 */
  const pickScreening = (code: string) => {
    setPicking(false);
    setKeyword("");
    setPickedSession((n) => n + 1);
    setPickedCode(code);
  };

  const closePicker = () => {
    setPicking(false);
    setKeyword("");
  };

  const focusScreening = focus ? cat.byCode.get(focus) : undefined;
  const focusTitle =
    focus && focusScreening
      ? displayTitle(focusScreening, store.mappings.get(focus)?.title_cn)
      : null;

  return (
    <section className="discussions-page" aria-label="讨论区">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">全场次的帖子都在这里</p>
          <h1>讨论区</h1>
        </div>
        <div className="discussions-head-actions">
          <span className="count" aria-live="polite">
            {posts.length} 帖
          </span>
          {/* 常驻发帖口(2026-09-16,`PLAN-20260916154255`):不依赖 focus,也不要求那一场已有帖子。 */}
          <ActionButton
            aria-label="发帖：按场次编号或片名选一场"
            onPress={() => (picking ? closePicker() : setPicking(true))}
          >
            发帖
          </ActionButton>
        </div>
      </div>
      <p className="muted discussions-intro">
        无料交换、物品互换、临时约伴都发在这里，一条帖子对应一个场次。任何人都能读；登录后可发帖、反应。
      </p>

      {picking && (
        <section className="discussion-picker" aria-label="选择要发帖的场次">
          <SearchField
            label="场次编号或片名"
            placeholder="如 419 / 峡湾 / Fjord"
            value={keyword}
            onChange={setKeyword}
          />
          <p className="muted discussion-picker-hint">
            帖子必须挂在某一场上：先按编号或片名找到那一场，再写内容。
          </p>
          {keyword.trim() !== "" && matches.length === 0 && (
            <p className="muted discussion-picker-hint">
              没找到这一场。编号要写官方 3 位（如 001），片名中英文都可以。
            </p>
          )}
          <ul className="discussion-picker-list">
            {matches.map((s) => {
              const venue = cat.venueById.get(s.venue_id);
              return (
                <li className="discussion-picker-row" key={s.code} data-compose-code={s.code}>
                  <div className="discussion-picker-main">
                    <strong>{displayTitle(s, store.mappings.get(s.code)?.title_cn)}</strong>
                    <span>
                      {s.code} · {dateInfo(s.date).label} {s.start_time.slice(0, 5)} ·{" "}
                      {venue ? venueShort(venue) : s.venue_display}
                    </span>
                  </div>
                  {/* aria-label 必须**含可见文案**(无障碍的 label-in-name):只写「在 004 发帖」
                      会让按可见文字操作的语音用户点不到它。 */}
                  <ActionButton
                    aria-label={`发帖（场次 ${s.code}）`}
                    onPress={() => pickScreening(s.code)}
                  >
                    发帖
                  </ActionButton>
                </li>
              );
            })}
          </ul>
          <div className="discussion-picker-actions">
            <ActionButton onPress={closePicker}>收起</ActionButton>
          </div>
        </section>
      )}

      {focus && (
        <div className="discussion-locate-bar" role="status">
          <span>
            已定位到{focusTitle ? `《${focusTitle}》` : `场次 ${focus}`}
            {located.length > 0
              ? `的讨论，共 ${located.length} 帖。`
              : counts.discussions[focus]
                ? "的讨论。"
                : "，这场还没有帖子。"}
          </span>
          {located.length === 0 && (counts.discussions[focus] ?? 0) > 0 && (
            <span className="muted">
              这场更早的帖子还没加载，点「加载更多」继续找。
            </span>
          )}
          {/* 定位条自带发帖口(2026-09-16,`PLAN-20260916102631`):某场**一条帖子都没有**时,
              方格墙里没有任何格子可点 —— 没有这个入口就只能回行程再点「讨论」,而那个按钮
              现在本身就跳回这里,形成闭环。发帖仍走既有弹层(唯一实现),这里只是多一个入口。 */}
          {focusScreening && (
            <DialogTrigger
              isOpen={composerOpen}
              onOpenChange={(next) => {
                // 每次打开都重挂载弹层:清空草稿 / 重新拉第一页(与格子上的「进入讨论」同一手法)
                if (next) setComposerSession((n) => n + 1);
                setComposerOpen(next);
              }}
            >
              <ActionButton aria-label={`在《${focusTitle ?? focus}》发帖`}>发帖</ActionButton>
              {composerOpen && (
                <ScreeningDiscussionDialog
                  key={composerSession}
                  screening={focusScreening}
                  onPosted={prependPost}
                />
              )}
            </DialogTrigger>
          )}
          <ActionButton onPress={clearFocus}>清除定位</ActionButton>
        </div>
      )}

      {loading ? (
        <div className="empty-state">
          <p>正在加载…</p>
        </div>
      ) : posts.length === 0 ? (
        <div className="empty-state">
          <h2>还没有人发言</h2>
          {/* ⚠ 别写回「回行程页点『讨论』写下第一条」—— 那条路径自 `PLAN-20260915233816` 起就已失效
              (卡片上的「讨论」只做跳转);页头现在有常驻发帖口(2026-09-16,`PLAN-20260916154255`)。 */}
          <p>点上面的「发帖」挑一场，写下第一条。</p>
        </div>
      ) : (
        <ul className="discussion-grid" ref={grid}>
          {posts.map((post) => (
            <DiscussionTile
              key={post.id}
              post={post}
              screening={cat.byCode.get(post.code)}
              located={focus === post.code}
              onPosted={prependPost}
            />
          ))}
        </ul>
      )}

      {cursor && (
        <div className="discussion-grid-more">
          <ActionButton onPress={() => void loadMore()} isDisabled={loadingMore}>
            {loadingMore ? "加载中…" : "加载更多"}
          </ActionButton>
        </div>
      )}

      {/* 自己挑一场发的弹层。⚠ 用 `DialogContainer`(与 FilmDialog / AccountHost 同一手法)而不是
          `DialogTrigger`:触发时机是「选中候选」,页面上没有可长期挂着的 trigger 元素。 */}
      <DialogContainer onDismiss={() => setPickedCode(null)}>
        {pickedTarget && (
          <ScreeningDiscussionDialog
            key={pickedSession}
            screening={pickedTarget}
            onPosted={prependPost}
          />
        )}
      </DialogContainer>
    </section>
  );
}
