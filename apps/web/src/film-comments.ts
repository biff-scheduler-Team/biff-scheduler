/**
 * 红黑榜「大家说」评语的客户端缓存 + 分页（2026-09-29,PLAN-20260929181900）。
 *
 * 形状与 `film-votes.ts` 同构（单例缓存 + 广播 + 失败静默降级），差别只在形状：
 * 那边是「一部片一个计数」，这边是**一串按时间倒序的评语**，所以多了游标分页。
 *
 * ⚠ **API 没上线时页面必须照常可用** —— 读失败一律退化成「还没有人写评语」（空页），
 *   绝不把错误抛给页面：评语是红黑榜的附加内容，为它把整页拖挂不划算。
 * ⚠ **游标是不透明串**：原样回传，前端不解析、不自己拼、也不缓存成结构化对象
 *   （见 `apps/api/src/film-vote-stats.ts::encodeCommentCursor`）。
 * ⚠ 服务端**不回身份标识**（`contributor` 那条硬约束），所以列表里认不出「哪条是我写的」——
 *   这不是缺陷，是刻意的；「改我的评语」走本地那份（`redblack.ts` 的 `Sticker.comment`）。
 */

import { EDITION } from "./edition";

export type FilmCommentVote = "red" | "black";

/** 「大家说」里的一行。⚠ 与 api 侧 `CommentItem` 逐字对齐（不含 `contributor`）。 */
export interface FilmComment {
  filmKey: string;
  vote: FilmCommentVote;
  comment: string;
  /** 写入时的昵称快照；匿名 / 未登录时为 `null`（前端显示「匿名观众」） */
  displayName: string | null;
}

/** 一页：`nextCursor` 为 `null` 表示没有下一页了（「加载更多」按钮据此消失）。 */
export interface FilmCommentsPage {
  items: FilmComment[];
  nextCursor: string | null;
}

/** 模块对外的整体状态（供视图层订阅；每次变化换一个新对象，便于比较）。 */
export interface FilmCommentsState {
  items: readonly FilmComment[];
  nextCursor: string | null;
  /** 第一页**取过了**（成功或降级；不区分，见 `loadComments` 的说明） */
  loaded: boolean;
  loading: boolean;
}

/** 一页多少条 —— 与服务端缺省值（`COMMENT_PAGE_SIZE`）一致，不指望它替我们兜底。 */
export const COMMENT_PAGE_SIZE = 20;

/** 空页。⚠ 每次**新建**一个对象:它是**导出函数**的返回值,共用一份的话调用方一次
 *  `page.items.push(...)` 就会污染后续所有「失败降级」的返回值(而那种 bug 只会在别人手里复现)。 */
function emptyPage(): FilmCommentsPage {
  return { items: [], nextCursor: null };
}

let items: FilmComment[] = [];
let nextCursor: string | null = null;
let loaded = false;
let loading = false;
let snapshot: FilmCommentsState = { items, nextCursor, loaded, loading };
/** 已经**成功取过**的页游标（`""` = 第一页）。分页去重靠它，而不是靠比评语内容 ——
 *  比内容会把「两个人恰好同名同评语」当成重复条目丢掉（那是真的两条）。 */
const requested = new Set<string>();
let inflight: Promise<FilmCommentsState> | null = null;
const listeners = new Set<() => void>();

export function onFilmCommentsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(): void {
  snapshot = { items, nextCursor, loaded, loading };
  for (const listener of listeners) listener();
}

/** 当前状态（同步读；未加载过时是空页） */
export function peekFilmComments(): FilmCommentsState {
  return snapshot;
}

/** 读取端白名单：服务端固然不会发坏数据，但客户端缓存**不能假设上游永远正确**
 *  （旧版本 API、代理改写、半截响应）—— 与 `film-votes.ts::parseVotes` 同一条原则。
 *  ⚠ 没有正文的行直接丢弃：列表里一行空白比少一行更让人困惑。 */
export function parseCommentItems(raw: unknown): FilmComment[] {
  if (!Array.isArray(raw)) return [];
  const out: FilmComment[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.filmKey !== "string" || !row.filmKey) continue;
    if (row.vote !== "red" && row.vote !== "black") continue;
    if (typeof row.comment !== "string" || !row.comment.trim()) continue;
    out.push({
      filmKey: row.filmKey,
      vote: row.vote,
      comment: row.comment,
      displayName:
        typeof row.displayName === "string" && row.displayName.trim() ? row.displayName : null,
    });
  }
  return out;
}

/** 响应体 → 一页。**缺 `nextCursor` / 非字符串一律当「没有下一页」**（宁可少翻一页，
 *  也不要让前端拿着一个 `"undefined"` 去请求）。 */
export function parseCommentsPage(raw: unknown): FilmCommentsPage {
  if (!raw || typeof raw !== "object") return emptyPage();
  const body = raw as { items?: unknown; nextCursor?: unknown };
  return {
    items: parseCommentItems(body.items),
    nextCursor: typeof body.nextCursor === "string" && body.nextCursor ? body.nextCursor : null,
  };
}

/** **拉一页**（纯请求 + 解析，不改模块状态）。
 *
 *  ⚠ 失败（404 / 500 / 断网）与「这一页本来就是空的」都回同一份空页 —— 调用方无法区分，
 *    这是有意的：业务上它俩的处理完全一样（照常显示已有的那些行）。
 *  ⚠ 页面卸载后返回也无所谓：`AbortSignal.timeout` 保证请求不会永远挂着。 */
export async function loadFilmComments(
  options: { cursor?: string | null; limit?: number } = {},
): Promise<FilmCommentsPage> {
  const params = new URLSearchParams({
    edition: EDITION,
    limit: String(options.limit ?? COMMENT_PAGE_SIZE),
  });
  if (options.cursor) params.set("cursor", options.cursor);
  try {
    const response = await fetch(`/api/stats/film-comments?${params.toString()}`, {
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return emptyPage();
    return parseCommentsPage(await response.json());
  } catch {
    // 接口还没部署 / 断网：退化成空页，页面照常可用（模块显示空态）
    return emptyPage();
  }
}

/** 装载一页：`reset` 换掉整份列表、`append` 接到尾巴上。**同一时刻只允许一页在飞**。 */
function run(cursor: string | null, mode: "reset" | "append"): Promise<FilmCommentsState> {
  if (inflight) return inflight;
  loading = true;
  publish();
  inflight = (async () => {
    try {
      const page = await loadFilmComments({ cursor });
      if (mode === "reset") {
        items = page.items;
        nextCursor = page.nextCursor;
        // ⚠ 降级（空页）也算「取过了」：否则一进页面就无限重试，而且空态永远闪不出来
        loaded = true;
        requested.add("");
      } else if (page.items.length) {
        items = [...items, ...page.items];
        nextCursor = page.nextCursor;
        if (cursor) requested.add(cursor);
      }
      // ⚠ append 拿到空页时**不动 `nextCursor`**：那多半是这一次请求失败了，
      //   用户再点一次「加载更多」就能重试；把它清掉等于让人以为「后面没有了」。
    } finally {
      loading = false;
      inflight = null;
      publish();
    }
    return snapshot;
  })();
  return inflight;
}

/** 取**第一页**（幂等：已经取过就不再发请求；`force` 时重头来过）。
 *  `force` 的用途只有一个：用户刚写完 / 改完一条评语，上报成功后要让它出现在列表里。 */
export async function loadComments(force = false): Promise<FilmCommentsState> {
  if (loaded && !force) return snapshot;
  if (force) requested.clear();
  return run(null, "reset");
}

/** 「加载更多」：按 `nextCursor` 追加一页。
 *  ⚠ 没有下一页 / 这一页已经取过 → 什么都不做（这正是「重复追加」的出口：
 *    连点两次按钮、或上一次请求还在飞的时候又点一次）。 */
export async function loadMoreComments(): Promise<FilmCommentsState> {
  const cursor = nextCursor;
  if (!cursor || requested.has(cursor)) return snapshot;
  return run(cursor, "append");
}
