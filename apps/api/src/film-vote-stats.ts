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
