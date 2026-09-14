import { REACTION_EMOJIS } from "@biff/contracts/reactions";
import { useCallback, useEffect, useState } from "react";
import { ActionButton, Button, TextArea, ToastQueue } from "../components/spectrum";
import { openAccountPanel } from "../account";
import { accountState, api, ApiFailure, onAccountChange } from "../account-sync";

type FeedbackPost = {
  id: string;
  subject: string;
  displayName: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  reactionCounts: Record<string, number>;
  myReactions: string[];
};

function formatTime(ms: number) {
  try {
    return new Date(ms).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return String(ms);
  }
}

export function FeedbackPage() {
  const [posts, setPosts] = useState<FeedbackPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [authed, setAuthed] = useState(accountState.authenticated);
  const [me, setMe] = useState(accountState.account?.user.id ?? null);

  useEffect(() => {
    const stop = onAccountChange(() => {
      setAuthed(accountState.authenticated);
      setMe(accountState.account?.user.id ?? null);
    });
    return () => {
      stop();
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = (await (await api("/api/feedback")).json()) as {
        posts: FeedbackPost[];
      };
      setPosts(data.posts);
    } catch {
      ToastQueue.negative("无法加载建议列表，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, authed]);

  const requireLogin = () => {
    openAccountPanel();
  };

  const submit = async () => {
    if (!authed) {
      requireLogin();
      return;
    }
    const body = draft.trim();
    if (!body) {
      ToastQueue.negative("请先写一点建议内容。");
      return;
    }
    if (body.length > 2000) {
      ToastQueue.negative("内容请控制在 2000 字以内。");
      return;
    }
    setSubmitting(true);
    try {
      const post = (await (
        await api("/api/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        })
      ).json()) as FeedbackPost;
      setDraft("");
      setPosts((prev) => [post, ...prev]);
      ToastQueue.positive("已发布");
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 401) requireLogin();
      else ToastQueue.negative("发布失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  };

  const toggle = async (postId: string, emoji: string) => {
    if (!authed) {
      requireLogin();
      return;
    }
    try {
      const result = (await (
        await api(`/api/feedback/${encodeURIComponent(postId)}/reactions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ emoji }),
        })
      ).json()) as {
        reactionCounts: Record<string, number>;
        myReactions: string[];
      };
      setPosts((prev) =>
        prev.map((p) =>
          p.id === postId
            ? { ...p, reactionCounts: result.reactionCounts, myReactions: result.myReactions }
            : p,
        ),
      );
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 401) requireLogin();
      else ToastQueue.negative("反应失败，请稍后重试。");
    }
  };

  const remove = async (postId: string) => {
    if (!authed) {
      requireLogin();
      return;
    }
    try {
      await api(`/api/feedback/${encodeURIComponent(postId)}`, { method: "DELETE" });
      setPosts((prev) => prev.filter((p) => p.id !== postId));
      ToastQueue.positive("已删除");
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 401) requireLogin();
      else if (error instanceof ApiFailure && error.status === 403)
        ToastQueue.negative("只能删除自己的留言。");
      else ToastQueue.negative("删除失败，请稍后重试。");
    }
  };

  return (
    <section className="feedback-page" aria-label="建议反馈">
      <div className="panel-heading">
        <div>
          <h1>建议反馈</h1>
          <p className="muted">任何人可读；登录后可发帖与反应。欢迎吐槽、许愿、报 bug。</p>
        </div>
      </div>

      <div className="feedback-composer">
        <TextArea
          label="写一条建议"
          value={draft}
          onChange={setDraft}
          maxLength={2000}
          isDisabled={submitting}
          placeholder={authed ? "说说你想改进的地方…" : "登录后即可发布建议"}
        />
        <div className="feedback-composer-actions">
          <span className="muted feedback-char-count">{draft.trim().length}/2000</span>
          {authed ? (
            <Button variant="accent" onPress={() => void submit()} isDisabled={submitting}>
              发布
            </Button>
          ) : (
            <ActionButton onPress={requireLogin}>登录后发布</ActionButton>
          )}
        </div>
      </div>

      {loading ? (
        <div className="empty-state">
          <p>正在加载…</p>
        </div>
      ) : posts.length === 0 ? (
        <div className="empty-state">
          <h2>还没有留言</h2>
          <p>来做第一条建议吧。</p>
        </div>
      ) : (
        <ul className="feedback-list">
          {posts.map((post) => {
            const mine = new Set(post.myReactions);
            const isAuthor = me != null && post.subject === me;
            return (
              <li key={post.id} className="feedback-card" data-feedback-id={post.id}>
                <header className="feedback-card-head">
                  <strong>{post.displayName}</strong>
                  <time dateTime={new Date(post.createdAt).toISOString()}>
                    {formatTime(post.createdAt)}
                  </time>
                </header>
                <p className="feedback-body">{post.body}</p>
                <div className="feedback-reactions" role="group" aria-label="反应">
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
                        {count > 0 && <span className="feedback-chip-count">{count}</span>}
                      </button>
                    );
                  })}
                </div>
                {isAuthor && (
                  <div className="feedback-card-actions">
                    <ActionButton onPress={() => void remove(post.id)}>删除</ActionButton>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
