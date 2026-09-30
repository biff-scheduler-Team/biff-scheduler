/**
 * 红黑榜「这一部怎么样」评语的客户端**读侧**（2026-09-29）。
 *
 * ## 沿革（为什么这里**没有**模块级缓存了）
 * 它原本是一个**跨片的单例缓存**（页面底部那个「大家说」模块用：一份列表 + 一个游标 +
 * 变更广播）。2026-09-29 那天「大家说」被换成了**卡片级讨论区**：弹层一次只问
 * 「**这一部**的评语」，而且换一张卡就是另一份列表。于是这一层退回到它本该有的形状：
 *   · 保留**纯函数**（白名单解析、游标解析）与**一次请求**（`loadFilmComments`）；
 *   · 去掉模块级的列表 / 游标 / 广播 —— 「当前这一份列表」是**弹层实例**的状态。
 *     放在模块级单例里会让两个入口互相覆盖，而那只表现为「列表偶尔不对」：
 *     没有报错、也难以复现（要同时开着两个弹层）。
 *
 * ⚠ **API 没上线时页面必须照常可用** —— 读失败一律退化成空页，绝不把错误抛给页面：
 *   评语是红黑榜的附加内容，为它把整页拖挂不划算。
 * ⚠ **游标是不透明串**：原样回传，前端不解析、不自己拼、也不缓存成结构化对象
 *   （见 `apps/api/src/film-vote-stats.ts::encodeCommentCursor`）。
 * ⚠ 服务端**不回身份标识**（`contributor` 那条硬约束），所以列表里认不出「哪条是我写的」——
 *   这不是缺陷，是刻意的；「改我的评语」走本地那份（`redblack.ts` 的 `Sticker.comment`）。
 */

import { EDITION } from "./edition";

export type FilmCommentVote = "red" | "black";

/** 讨论区里的一行。⚠ 与 api 侧 `CommentItem` 逐字对齐（不含 `contributor`）。
 *
 *  ⚠ **刻意没有「款式」**：讨论区只列颜色 + 正文 + 昵称。款式是**展板**上的东西
 *    （群点按款聚合，那是谁也认不出谁的一张图）；逐条公开「某人选了哪一款」等于
 *    在这条已经公开的名单上再加一个可追踪的维度 —— 口径见 PLAN 的硬约束
 *    「皮肤只回聚合计数，不得新增逐票明细的公开读接口」。 */
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

/** 一页多少条 —— 与服务端缺省值（`COMMENT_PAGE_SIZE`）一致，不指望它替我们兜底。 */
export const COMMENT_PAGE_SIZE = 20;

/** 讨论区的「列表 + 游标」状态。⚠ 它是一个**值**，不是模块级单例 —— 每个弹层实例一份
 *  （两个入口同时开着时，各自翻各自的页）。 */
export interface CommentListState {
  items: readonly FilmComment[];
  nextCursor: string | null;
  /** 第一页**取过了**（成功或失败降级；不区分 —— 见 `mergeCommentPage` 的说明） */
  loaded: boolean;
  loading: boolean;
}

export const EMPTY_COMMENT_LIST: CommentListState = {
  items: [],
  nextCursor: null,
  loaded: false,
  loading: false,
};

/** 把一页合并进当前状态。
 *
 *  ⚠ 抽成**纯函数**而不是写在组件里的理由：下面这三条边界错了**都不会报错**，
 *    只表现为「看起来少了几行」或「再也翻不动」——
 *      · `cursor === null`（第一页）→ **换掉**整份列表；否则接到尾巴上；
 *      · 追加拿到**空页**时**不动游标**：那多半是这一次请求失败了，用户再点一次就能重试；
 *        把它清掉等于告诉用户「后面没有了」（而那是假的）；
 *      · 降级（第一页就失败）也算 `loaded`：否则一进弹层就无限重试，而且空态永远闪不出来。
 *    放在组件里就只能靠 E2E 覆盖，而这三条在 E2E 里都要造额外的失败注入才碰得到。 */
export function mergeCommentPage(
  state: CommentListState,
  page: FilmCommentsPage,
  cursor: string | null,
): CommentListState {
  const first = cursor === null;
  const appending = !first && page.items.length > 0;
  return {
    items: first ? page.items : appending ? [...state.items, ...page.items] : state.items,
    nextCursor: first || appending ? page.nextCursor : state.nextCursor,
    loaded: true,
    loading: false,
  };
}

/** 空页。⚠ 每次**新建**一个对象：它是**导出函数**的返回值，共用一份的话调用方一次
 *  `page.items.push(...)` 就会污染后续所有「失败降级」的返回值（而那种 bug 只会在别人手里复现）。 */
function emptyPage(): FilmCommentsPage {
  return { items: [], nextCursor: null };
}

/** 读取端白名单：服务端固然不会发坏数据，但客户端**不能假设上游永远正确**
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

/** **拉一页**（纯请求 + 解析，不持有任何状态）。
 *
 *  ⚠ `filmKey` 走了服务端**既有的可选过滤**（`readRecentComments` 的 `options.filmKey`），
 *    没有新开一条读路径：读出形状、白名单、游标语义全部不变。
 *  ⚠ 失败（404 / 500 / 断网）与「这一页本来就是空的」都回同一份空页 —— 调用方无法区分，
 *    这是有意的：业务上它俩的处理完全一样（照常显示已有的那些行）。
 *  ⚠ 弹层关掉后返回也无所谓：`AbortSignal.timeout` 保证请求不会永远挂着。 */
export async function loadFilmComments(
  options: { filmKey?: string | null; cursor?: string | null; limit?: number } = {},
): Promise<FilmCommentsPage> {
  const params = new URLSearchParams({
    edition: EDITION,
    limit: String(options.limit ?? COMMENT_PAGE_SIZE),
  });
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.filmKey) params.set("filmKey", options.filmKey);
  try {
    const response = await fetch(`/api/stats/film-comments?${params.toString()}`, {
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return emptyPage();
    return parseCommentsPage(await response.json());
  } catch {
    // 接口还没部署 / 断网：退化成空页，页面照常可用（弹层显示空态）
    return emptyPage();
  }
}
