/**
 * 红黑榜投票的读写（2026-09-16,PLAN-20260916102339）。
 *
 * 形状照抄 `want-store.ts`：**贡献表记「谁投了什么」，聚合表记「每部各多少票」**。
 * 聚合表的存在只为一件事 —— 榜单一次要读几百部片的票数，不能每次去 GROUP BY 贡献表。
 */

import { and, eq } from "drizzle-orm";
import { database } from "./db";
import { filmVoteContribution, filmVoteStat } from "./db/schema";
import { diffVotes, formatVoteCounts, isFilmVote, type FilmVote } from "./film-vote-stats";

type Db = ReturnType<typeof database>;

/** 调整某一部片的某一个颜色计数（`delta` 为 ±1）。两色都归零时**删行**，
 *  免得表里堆一堆 0 行把榜单读取撑大。 */
async function adjustStat(
  db: Db,
  edition: string,
  filmKey: string,
  vote: FilmVote,
  delta: number,
  now: number,
): Promise<void> {
  const where = and(eq(filmVoteStat.edition, edition), eq(filmVoteStat.film_key, filmKey));
  const row = await db.select().from(filmVoteStat).where(where).get();
  const red = Math.max(0, Math.trunc(Number(row?.red_count ?? 0)) + (vote === "red" ? delta : 0));
  const black = Math.max(0, Math.trunc(Number(row?.black_count ?? 0)) + (vote === "black" ? delta : 0));
  if (red <= 0 && black <= 0) {
    if (row) await db.delete(filmVoteStat).where(where).run();
    return;
  }
  if (row) {
    await db.update(filmVoteStat).set({ red_count: red, black_count: black, updated_at: now }).where(where).run();
  } else {
    await db
      .insert(filmVoteStat)
      .values({ edition, film_key: filmKey, red_count: red, black_count: black, updated_at: now })
      .run();
  }
}

/** 用「这个贡献者最新的全部投票」替换他此前的投票，并同步聚合表。
 *  ⚠ 语义是**整份替换**而不是增量：前端每次都把「我贴出来的那些」全量发上来，
 *    这样断网 / 换设备之后重新登录也能靠一次上报把服务端校正回一致。 */
export async function replaceContributorVotes(
  db: Db,
  edition: string,
  contributor: string,
  votes: ReadonlyMap<string, FilmVote>,
): Promise<void> {
  const existing = await db
    .select({ film_key: filmVoteContribution.film_key, vote: filmVoteContribution.vote })
    .from(filmVoteContribution)
    .where(
      and(eq(filmVoteContribution.edition, edition), eq(filmVoteContribution.contributor, contributor)),
    )
    .all();
  const previous = new Map<string, FilmVote>();
  for (const row of existing) {
    // 未知取值（被人工改过的坏行）直接丢掉：它没有对应的聚合列可减
    if (isFilmVote(row.vote)) previous.set(row.film_key, row.vote);
  }
  const { removed, added } = diffVotes(previous, votes);
  if (!removed.length && !added.length) return;
  const now = Date.now();

  // 顺序要紧：先把贡献行落定，再动聚合 —— 中途失败时聚合顶多短暂偏小，不会多算。
  for (const entry of removed) {
    await db
      .delete(filmVoteContribution)
      .where(
        and(
          eq(filmVoteContribution.edition, edition),
          eq(filmVoteContribution.film_key, entry.key),
          eq(filmVoteContribution.contributor, contributor),
        ),
      )
      .run();
  }
  for (const entry of added) {
    await db
      .insert(filmVoteContribution)
      .values({ edition, film_key: entry.key, contributor, vote: entry.vote, updated_at: now })
      .onConflictDoUpdate({
        target: [
          filmVoteContribution.edition,
          filmVoteContribution.film_key,
          filmVoteContribution.contributor,
        ],
        set: { vote: entry.vote, updated_at: now },
      })
      .run();
  }
  for (const entry of removed) await adjustStat(db, edition, entry.key, entry.vote, -1, now);
  for (const entry of added) await adjustStat(db, edition, entry.key, entry.vote, 1, now);
}

/** 撤掉这个贡献者的全部投票（登出、或匿名身份升级为登录身份时调用）。 */
export async function clearContributorVotes(db: Db, edition: string, contributor: string): Promise<void> {
  await replaceContributorVotes(db, edition, contributor, new Map());
}

/** 榜单读取：一次拿到这个 edition 下所有影片的红黑票数。 */
export async function readVoteCounts(db: Db, edition: string): Promise<Record<string, { red: number; black: number }>> {
  const rows = await db
    .select({
      film_key: filmVoteStat.film_key,
      red_count: filmVoteStat.red_count,
      black_count: filmVoteStat.black_count,
    })
    .from(filmVoteStat)
    .where(eq(filmVoteStat.edition, edition))
    .all();
  return formatVoteCounts(rows);
}
