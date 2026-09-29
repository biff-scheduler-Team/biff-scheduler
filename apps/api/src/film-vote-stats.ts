/**
 * 红黑榜投票口径（2026-09-16,PLAN-20260916102339）。
 *
 * 与「想看人数」(`want-stats.ts`) **刻意不同**：那边是「一组 film key + 权重」（登录 1.0 /
 * 匿名 0.75，为了防刷而加权）；这边是「一人一部一票，值为红或黑」——
 * 贴纸是离散的实体隐喻，3 个人贴了红就该显示 3，加权会读出 2.25 这种没人看得懂的数。
 * 防刷交给贡献表的 (edition, film_key, contributor) 唯一约束：同一个人再怎么点也只算一票。
 */

export type FilmVote = "red" | "black";

export const FILM_VOTES: readonly FilmVote[] = ["red", "black"];

export function isFilmVote(value: unknown): value is FilmVote {
  return value === "red" || value === "black";
}

/** 一次上报最多带多少部片（与 want-ping 的 500 对齐，前端也按同一上限截断） */
export const MAX_VOTES_PER_PING = 500;

/** 影片 key 长度上限（与 want-ping 的 key 校验一致） */
export const MAX_FILM_KEY_LENGTH = 128;

export interface VoteCounts {
  red: number;
  black: number;
}

/** 上报列表 → Map。同一部片出现多次时**以最后一条为准**（前端可能把旧值和新值一起发上来了）；
 *  非法条目（空 key / 超长 key / 非红非黑的 vote）静默丢弃 —— 与 `hydrate()` 的「只取白名单」同一条原则。 */
export function normalizeVotes(
  input: Iterable<{ key: unknown; vote: unknown }>,
): Map<string, FilmVote> {
  const out = new Map<string, FilmVote>();
  for (const item of input) {
    if (!item || typeof item.key !== "string" || !isFilmVote(item.vote)) continue;
    if (!item.key || item.key.length > MAX_FILM_KEY_LENGTH) continue;
    out.set(item.key, item.vote);
  }
  return out;
}

/** 聚合行 → 前端读的小字典。两色都归零的影片不返回：没有票的影片本来就该是「无票」，
 *  回一个 `{red:0,black:0}` 只会让前端多一堆「有计数但为 0」的分支。 */
export function formatVoteCounts(
  rows: Iterable<{ film_key: string; red_count: number | string; black_count: number | string }>,
): Record<string, VoteCounts> {
  const counts: Record<string, VoteCounts> = Object.create(null);
  for (const row of rows) {
    // D1 的 integer 列在 drizzle 下是 number，但聚合 SQL 走 text/字符串时也可能到手，统一兜一层
    const red = Math.max(0, Math.trunc(Number(row.red_count) || 0));
    const black = Math.max(0, Math.trunc(Number(row.black_count) || 0));
    if (red <= 0 && black <= 0) continue;
    counts[row.film_key] = { red, black };
  }
  return counts;
}

/** 两次投票的差异，拆成「要撤的」与「要记的」——
 *  **改票会同时出现在两边**（旧值进 removed、新值进 added），所以调用方只要
 *  「先按 removed 减、再按 added 加」就能正确处理改票，不需要第三种类别。 */
export function diffVotes(
  previous: ReadonlyMap<string, FilmVote>,
  next: ReadonlyMap<string, FilmVote>,
): { removed: Array<{ key: string; vote: FilmVote }>; added: Array<{ key: string; vote: FilmVote }> } {
  const removed: Array<{ key: string; vote: FilmVote }> = [];
  const added: Array<{ key: string; vote: FilmVote }> = [];
  for (const [key, vote] of previous) {
    if (next.get(key) !== vote) removed.push({ key, vote });
  }
  for (const [key, vote] of next) {
    if (previous.get(key) !== vote) added.push({ key, vote });
  }
  return { removed, added };
}

/** 把「源身份」的票并进「目标身份」（管理端的认领迁移，2026-09-23，PLAN-20260923140943）。
 *
 *  **冲突口径：同一部片两票不同色时保留目标那一票**，并把冲突原样报出来让人核对。
 *  为什么是保留目标：目标是正式账号（长期身份），源是匿名 / 临时身份（丢登录态的那一侧）——
 *  「账号投的」比「匿名投的」更接近用户的本意。
 *  同色重复计入 `alreadyHad`（无信息量的重合，不必逐条报）。
 *
 *  ⚠ 纯函数，不碰库：真正的写入在 `film-vote-store.ts::claimContributorVotes`。 */
export function mergeVoteBoards(
  target: ReadonlyMap<string, FilmVote>,
  source: ReadonlyMap<string, FilmVote>,
): {
  merged: Map<string, FilmVote>;
  moved: number;
  alreadyHad: number;
  conflicts: Array<{ key: string; source: FilmVote; target: FilmVote }>;
} {
  const merged = new Map(target);
  let moved = 0;
  let alreadyHad = 0;
  const conflicts: Array<{ key: string; source: FilmVote; target: FilmVote }> = [];
  for (const [key, vote] of source) {
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, vote);
      moved += 1;
    } else if (existing === vote) {
      alreadyHad += 1;
    } else {
      conflicts.push({ key, source: vote, target: existing });
    }
  }
  return { merged, moved, alreadyHad, conflicts };
}

/** 红黑榜评分 = 红票占比折算成 0–10 分（一位小数）；一票没有时 `null`（不显示，而不是 0）。
 *  ⚠ 与前端 `redblack.ts::scoreOf` 同口径 —— 前端算的是「含我自己那一票」的合并计数。 */
export function voteScore(counts: VoteCounts): number | null {
  const total = counts.red + counts.black;
  if (total <= 0) return null;
  return Math.round((counts.red / total) * 100) / 10;
}

/* ---------------- 评语（2026-09-29,PLAN-20260929181900） ----------------
 * 「一人一片一票一评」：评语**挂在票上**，不是独立的一条记录 ——
 * 所以它没有自己的表，撤票 / 改色走 `replaceContributorVotes` 时评语自然跟着走（不留孤儿）。 */

/** 评语长度上限，按 **Unicode 码点**算（用户 2026-09-29 定 140 字）。 */
export const MAX_COMMENT_LENGTH = 140;

/** 昵称快照的长度上限。账号系统那边的上限未知，这里只做防御性截断 ——
 *  它是**展示用**的字段，超长会把「大家说」那一行整个挤爆。 */
export const MAX_DISPLAY_NAME_LENGTH = 40;

/** 按**码点**截断，而不是 `String.prototype.slice`。
 *  ⚠ `slice` 按 UTF-16 码元切：140 个 emoji 会被劈成半个代理对，存进去就是乱码。
 *    这条在「用户能自由输入、且要公开显示」的字段上是必须的。 */
function clampCodePoints(text: string, max: number): string {
  const points = [...text];
  return points.length > max ? points.slice(0, max).join("") : text;
}

/** 评语归一：去首尾空白 → **空串归一成 `null`**（「从来没写」与「写了又清空」同值，
 *  两者对读的人没有区别）→ 超长按码点截断。非字符串一律当没写。 */
export function normalizeComment(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return clampCodePoints(trimmed, MAX_COMMENT_LENGTH);
}

/** 昵称快照归一：与 `normalizeComment` 同一套（截断用同一个码点口径）。 */
export function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return clampCodePoints(trimmed, MAX_DISPLAY_NAME_LENGTH);
}

/** 公开读接口回给浏览器的一行。
 *  ⚠ **刻意不含 `contributor`** —— 与 `VoteAuditRow` / `VoteAdminRow` 是同一条约束：
 *    身份标识绝不出公开接口（见 `film-vote-store.ts` 上那段原话）。
 *    这里连**读**都不读它（调用方的 SQL 也不该 select 它）。 */
export interface CommentItem {
  filmKey: string;
  vote: FilmVote;
  comment: string;
  /** 写入时的昵称快照；匿名 / 未登录时为 `null`（前端显示「匿名观众」）。 */
  displayName: string | null;
}

/** 库里的行 → 公开 DTO。**白名单收口在这一处**（与其它读路径同一道）：
 *  - `vote` 非红非黑 → 丢（被人工改过的坏行一律不猜、不展示）；
 *  - `comment` 空 → 丢（没评语的行回来也没有内容可展示，白白放大响应体）。 */
export function toCommentItems(
  rows: Iterable<{ film_key: string; vote: unknown; comment: unknown; display_name: unknown }>,
): CommentItem[] {
  const out: CommentItem[] = [];
  for (const row of rows) {
    if (!isFilmVote(row.vote)) continue;
    const comment = normalizeComment(row.comment);
    if (!comment) continue;
    out.push({
      filmKey: row.film_key,
      vote: row.vote,
      comment,
      displayName: normalizeDisplayName(row.display_name),
    });
  }
  return out;
}

/** 「大家说」的分页游标：`(updated_at, film_key)`。 */
export interface CommentCursor {
  updatedAt: number;
  filmKey: string;
}

/** 游标 → **不透明串**。
 *
 *  ⚠ 为什么绕这一层而不是直接把 `{updatedAt, filmKey}` 明文回给前端：
 *    游标是**公开响应体的一部分**。明文对象意味着「将来有人往里塞个 `contributor` 方便排序」
 *    只要改一行、而且**看不出来** —— 编码之后，「谁也不许往里加字段」这条约束才落在代码形状上
 *    （解析端是白名单，见 `decodeCommentCursor`）。
 *  ⚠ 先 `encodeURIComponent` 再 `btoa`：`btoa` 只吃 latin1，中文 filmKey 会直接抛。 */
export function encodeCommentCursor(cursor: CommentCursor | null): string | null {
  if (!cursor) return null;
  return btoa(encodeURIComponent(JSON.stringify([cursor.updatedAt, cursor.filmKey])));
}

/** 不透明串 → 游标。**任何异常都当作「没有游标」**（从头开始），
 *  而不是让整个接口 400 —— 用户手上的那一页可能是上一版前端生成的，不该因此什么都读不到。
 *  ⚠ 白名单取字段、逐个校验，不做 `as` 强转。 */
export function decodeCommentCursor(raw: unknown): CommentCursor | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(atob(raw)));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [updatedAt, filmKey] = parsed as [unknown, unknown];
    if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null;
    if (typeof filmKey !== "string" || !filmKey || filmKey.length > MAX_FILM_KEY_LENGTH) return null;
    return { updatedAt: Math.max(0, Math.trunc(updatedAt)), filmKey };
  } catch {
    return null;
  }
}

/** 一页最多回多少条评语（服务端夹紧，不信前端传的数）。 */
export const COMMENT_PAGE_SIZE = 20;
export const MAX_COMMENT_PAGE_SIZE = 50;

/** 把前端的 `limit` 夹进 `[1, MAX_COMMENT_PAGE_SIZE]`，缺省 `COMMENT_PAGE_SIZE`。 */
export function clampCommentLimit(raw: unknown): number {
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) return COMMENT_PAGE_SIZE;
  return Math.min(MAX_COMMENT_PAGE_SIZE, Math.max(1, Math.trunc(value)));
}
