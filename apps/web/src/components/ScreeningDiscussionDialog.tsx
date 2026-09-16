import { REACTION_EMOJIS } from "@biff/contracts/reactions";
import {
  DISCUSSION_BODY_MAX,
  DISCUSSION_CATEGORIES,
  discussionCategoryLabel,
  type DiscussionCategory,
} from "@biff/contracts/screening";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { openAccountPanel } from "../account";
import { ApiFailure, accountState, onAccountChange } from "../account-sync";
import { effEndMin, talkOnOf } from "../gv";
import {
  createDiscussion,
  fetchDiscussion,
  formatDiscussionTime,
  removeDiscussion,
  toggleDiscussionReaction,
  type DiscussionPost,
} from "../screening-discussion";
import { store } from "../state";
import { dateInfo, displayTitle, fmtEndClock } from "../util";
import type { Screening } from "../types";
import {
  ActionButton,
  Button,
  ButtonGroup,
  Content,
  Dialog,
  Heading,
  TextArea,
  ToastQueue,
} from "./spectrum";
import { useScreeningCounts } from "./ScreeningTickets";
import "./screening-social.css";

/** 隐私说明「已读」标记 —— 独立 localStorage 键(纯视图偏好,不混进片单契约)。 */
const PRIVACY_SEEN_KEY = "biff.discussionprivacy.v1";

function privacySeen(): boolean {
  try {
    return localStorage.getItem(PRIVACY_SEEN_KEY) === "1";
  } catch {
    // 读不到就当作已读:宁可少弹一次,也不要每次打开都糊用户一脸
    return true;
  }
}

function markPrivacySeen(): void {
  try {
    localStorage.setItem(PRIVACY_SEEN_KEY, "1");
  } catch {
    /* ignore */
  }
}

/** 场次卡操作行里的「讨论 N」入口(0 条时只写「讨论」)。
 *
 *  2026-09-15(`PLAN-20260915233816`):这里**不再就地弹层**,而是跳到讨论区并定位到该场次
 *  —— 讨论的集合已统一到 `/discussions`,发帖 / 反应 / 删除都从那边的格子上进。
 *  ⚠ 定位参数用 `focus=<场次 code>`(不是 post id):卡片上只有「讨论 N」这个场次级信息。 */
export function DiscussionEntry({ screening }: { screening: Screening }) {
  const counts = useScreeningCounts();
  const navigate = useNavigate();
  const total = counts.discussions[screening.code] ?? 0;
  return (
    <ActionButton
      aria-label={`在讨论区查看场次 ${screening.code} 的讨论`}
      onPress={() =>
        navigate(`/discussions?focus=${encodeURIComponent(screening.code)}`)
      }
    >
      {total > 0 ? `讨论 ${total}` : "讨论"}
    </ActionButton>
  );
}

/** 场次讨论弹层 —— 发帖 / 反应 / 删除 / 社区提醒的**唯一实现**。
 *
 *  `onPosted` 是给「讨论区方格墙」用的:弹层自己维护一份列表,但墙是另一份状态;
 *  不回调的话关掉弹层后墙上还是旧内容,用户会以为没发出去(2026-09-16,`PLAN-20260916102631`)。 */
export function ScreeningDiscussionDialog({
  screening,
  onPosted,
}: {
  screening: Screening;
  onPosted?: (post: DiscussionPost) => void;
}) {
  const counts = useScreeningCounts();
  const code = screening.code;
  const [posts, setPosts] = useState<DiscussionPost[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [draft, setDraft] = useState("");
  const [category, setCategory] = useState<DiscussionCategory>(DISCUSSION_CATEGORIES[0].key);
  const [submitting, setSubmitting] = useState(false);
  const [authed, setAuthed] = useState(accountState.authenticated);
  const [me, setMe] = useState(accountState.account?.user.id ?? null);
  const [notice, setNotice] = useState(() => !privacySeen());

  useEffect(() => {
    const stop = onAccountChange(() => {
      setAuthed(accountState.authenticated);
      setMe(accountState.account?.user.id ?? null);
    });
    return () => {
      stop();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const page = await fetchDiscussion(code, null);
        if (!alive) return;
        setPosts(page.posts);
        setCursor(page.nextCursor);
      } catch {
        if (alive) ToastQueue.negative("无法加载这场讨论，请稍后重试。");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [code]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchDiscussion(code, cursor);
      setPosts((prev) => [...prev, ...page.posts]);
      setCursor(page.nextCursor);
    } catch {
      ToastQueue.negative("加载更多失败，请稍后重试。");
    } finally {
      setLoadingMore(false);
    }
  };

  const submit = async () => {
    if (!authed) {
      openAccountPanel();
      return;
    }
    const body = draft.trim();
    if (!body) {
      ToastQueue.negative("先写点内容再发布。");
      return;
    }
    if (body.length > DISCUSSION_BODY_MAX) {
      ToastQueue.negative(`内容请控制在 ${DISCUSSION_BODY_MAX} 字以内。`);
      return;
    }
    setSubmitting(true);
    try {
      const post = await createDiscussion(code, category, body);
      setDraft("");
      setPosts((prev) => [post, ...prev]);
      onPosted?.(post);
      ToastQueue.positive("已发布");
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 401) openAccountPanel();
      else ToastQueue.negative("发布失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  };

  const toggle = async (postId: string, emoji: (typeof REACTION_EMOJIS)[number]) => {
    if (!authed) {
      openAccountPanel();
      return;
    }
    try {
      const result = await toggleDiscussionReaction(code, postId, emoji);
      setPosts((prev) =>
        prev.map((post) =>
          post.id === postId
            ? { ...post, reactionCounts: result.reactionCounts, myReactions: result.myReactions }
            : post,
        ),
      );
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 401) openAccountPanel();
      else ToastQueue.negative("反应失败，请稍后重试。");
    }
  };

  const remove = async (postId: string) => {
    if (!authed) {
      openAccountPanel();
      return;
    }
    try {
      await removeDiscussion(code, postId);
      setPosts((prev) => prev.filter((post) => post.id !== postId));
      ToastQueue.positive("已删除");
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 401) openAccountPanel();
      else if (error instanceof ApiFailure && error.status === 403)
        ToastQueue.negative("只能删除自己发的内容。");
      else ToastQueue.negative("删除失败，请稍后重试。");
    }
  };

  const attendance = counts.attendance[code] ?? 0;
  return (
    <Dialog size="M">
      {({ close }) => (
        <>
          <Heading slot="title">{code} 场次讨论</Heading>
          <Content>
            <div className="discussion-dialog">
              <div>
                <p className="discussion-subject">
                  {displayTitle(screening, store.mappings.get(code)?.title_cn)}
                </p>
                <p className="discussion-when">
                  {dateInfo(screening.date).label} {screening.start_time.slice(0, 5)}–
                  {fmtEndClock(effEndMin(screening, talkOnOf(code)))}
                  {attendance > 0 ? ` · 同场 ${attendance} 人` : ""}
                </p>
              </div>

              {notice && (
                <section className="discussion-notice" role="note" aria-label="社区提醒">
                  <strong>先看一眼：这里的几条提醒</strong>
                  <ul className="discussion-notice-list">
                    <li>
                      这里任何人都能读到。手机号 / 微信号 / 二维码 / 住址这类
                      <strong>个人信息</strong>，建议别直接发在帖子里 —— 想留联系方式，先想清楚会被谁看到。
                    </li>
                    <li>这里主要聊电影，和电影无关的话题就不太合适了。</li>
                    <li>
                      本站只是<strong>信息发布平台</strong>，不介入你们之间的沟通；无论在本站联系还是
                      转到私下，交易与约伴的风险都请自己判断。
                    </li>
                    <li>看到不合适的内容，点帖子上的「👎」就好。</li>
                  </ul>
                  <div className="discussion-notice-actions">
                    <ActionButton
                      onPress={() => {
                        markPrivacySeen();
                        setNotice(false);
                      }}
                    >
                      知道了
                    </ActionButton>
                  </div>
                </section>
              )}

              <div className="discussion-composer">
                <div className="discussion-categories" role="group" aria-label="信息分类">
                  {DISCUSSION_CATEGORIES.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className={
                        category === item.key ? "discussion-category active" : "discussion-category"
                      }
                      aria-pressed={category === item.key}
                      data-discussion-category={item.key}
                      onClick={() => setCategory(item.key)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <TextArea
                  label="发布信息"
                  value={draft}
                  onChange={setDraft}
                  maxLength={DISCUSSION_BODY_MAX}
                  isDisabled={submitting}
                  placeholder={
                    authed
                      ? "例：多带了一张 10/8 19:00 的票，原价转；或：散场后想找人聊两句。"
                      : "登录后即可发布"
                  }
                />
                <div className="discussion-composer-actions">
                  <span className="muted">
                    {draft.trim().length}/{DISCUSSION_BODY_MAX}
                  </span>
                  {authed ? (
                    <Button variant="accent" onPress={() => void submit()} isDisabled={submitting}>
                      发布
                    </Button>
                  ) : (
                    <ActionButton onPress={openAccountPanel}>登录后发布</ActionButton>
                  )}
                </div>
              </div>

              {loading ? (
                <p className="discussion-empty">正在加载…</p>
              ) : posts.length === 0 ? (
                <p className="discussion-empty">还没有人在这里发言。要做第一个吗？</p>
              ) : (
                <ul className="discussion-list">
                  {posts.map((post) => {
                    const mine = new Set(post.myReactions);
                    const isAuthor = me != null && post.subject === me;
                    return (
                      <li className="discussion-card" key={post.id} data-discussion-id={post.id}>
                        <header className="discussion-card-head">
                          <span>
                            <strong>{post.displayName}</strong>{" "}
                            <span
                              className="discussion-tag"
                              data-discussion-category={post.category}
                            >
                              {discussionCategoryLabel(post.category)}
                            </span>
                          </span>
                          <time dateTime={new Date(post.createdAt).toISOString()}>
                            {formatDiscussionTime(post.createdAt)}
                          </time>
                        </header>
                        <p className="discussion-body">{post.body}</p>
                        {/* 反应 chip 直接复用 style.css 的 .feedback-chip —— 那是站内「反应按钮」的既有
                            视觉语言;改它要动 style.css(命中 TEST-MAP 的 allOn),本轮刻意不动。 */}
                        <div className="discussion-reactions" role="group" aria-label="反应">
                          {REACTION_EMOJIS.map((emoji) => {
                            const count = post.reactionCounts[emoji] ?? 0;
                            const active = mine.has(emoji);
                            return (
                              <button
                                key={emoji}
                                type="button"
                                className={active ? "feedback-chip active" : "feedback-chip"}
                                aria-pressed={active}
                                data-emoji={emoji}
                                onClick={() => void toggle(post.id, emoji)}
                              >
                                <span aria-hidden="true">{emoji}</span>
                                {count > 0 && (
                                  <span className="feedback-chip-count">{count}</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                        {/* 操作行只对作者出现(删除);非作者没有可做的事,不再渲染空容器 */}
                        {isAuthor && (
                          <div className="discussion-card-actions">
                            <ActionButton onPress={() => void remove(post.id)}>删除</ActionButton>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              {cursor && (
                <ActionButton onPress={() => void loadMore()} isDisabled={loadingMore}>
                  {loadingMore ? "加载中…" : "加载更多"}
                </ActionButton>
              )}
            </div>
          </Content>
          <ButtonGroup>
            <Button variant="secondary" onPress={close}>
              关闭
            </Button>
          </ButtonGroup>
        </>
      )}
    </Dialog>
  );
}
