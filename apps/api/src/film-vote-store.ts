/**
 * 红黑榜投票的读写（2026-09-16,PLAN-20260916102339）。
 *
 * 形状照抄 `want-store.ts`：**贡献表记「谁投了什么」，聚合表记「每部各多少票」**。
 * 聚合表的存在只为一件事 —— 榜单一次要读几百部片的票数，不能每次去 GROUP BY 贡献表。
 * ⚠ 聚合表的改法在 `stat-batch.ts`（SQL 端原子算术 + 一次分批 batch）——
 *   此前是「读出来在 JS 里加减再写回」，两人同时投同一部片会丢票且永不自愈。
 */

import { and, eq, sql } from "drizzle-orm";
import { database } from "./db";
import { filmVoteContribution, filmVoteStat } from "./db/schema";
import { diffVotes, formatVoteCounts, isFilmVote, type FilmVote } from "./film-vote-stats";
import {
  clampAddInt,
  flushStatBatch,
  isNonPositiveInt,
  wouldGoNegativeInt,
  type StatWrite,
} from "./stat-batch";

type Db = ReturnType<typeof database>;

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
  const writes: StatWrite[] = [];

  const statKey = (filmKey: string) =>
    and(eq(filmVoteStat.edition, edition), eq(filmVoteStat.film_key, filmKey));

  /** 加一票：聚合行「插入或原地加」（行不存在时用 delta 作初值）。 */
  const addVote = (filmKey: string, vote: FilmVote, delta: number) => {
    writes.push({
      statement: db
        .insert(filmVoteStat)
        .values({
          edition,
          film_key: filmKey,
          red_count: vote === "red" ? delta : 0,
          black_count: vote === "black" ? delta : 0,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [filmVoteStat.edition, filmVoteStat.film_key],
          // UPSERT 的 SET 里表名限定的列指**原行**；另一列不动，故只写被投的那一列。
          set:
            vote === "red"
              ? { red_count: clampAddInt(filmVoteStat.red_count, delta), updated_at: now }
              : { black_count: clampAddInt(filmVoteStat.black_count, delta), updated_at: now },
        }),
    });
  };

  /** 撤一票：探测负漂移 → 钳零写入 → 两色都归零时删行（顺序不可换）。 */
  const removeVote = (filmKey: string, vote: FilmVote, delta: number) => {
    const key = statKey(filmKey);
    const column = vote === "red" ? filmVoteStat.red_count : filmVoteStat.black_count;
    writes.push({
      statement: db
        .update(filmVoteStat)
        .set({ updated_at: sql`${filmVoteStat.updated_at}` })
        .where(and(key, wouldGoNegativeInt(column, delta))),
      drift: `${edition}/${filmKey}`,
    });
    writes.push({
      statement: db
        .update(filmVoteStat)
        .set(
          vote === "red"
            ? { red_count: clampAddInt(column, delta), updated_at: now }
            : { black_count: clampAddInt(column, delta), updated_at: now },
        )
        .where(key),
    });
    writes.push({
      statement: db
        .delete(filmVoteStat)
        .where(
          and(key, isNonPositiveInt(filmVoteStat.red_count), isNonPositiveInt(filmVoteStat.black_count)),
        ),
    });
  };

  // 顺序要紧：先把贡献行落定，再动聚合 —— 中途失败时聚合顶多短暂偏小，不会多算。
  for (const entry of removed) {
    writes.push({
      statement: db
        .delete(filmVoteContribution)
        .where(
          and(
            eq(filmVoteContribution.edition, edition),
            eq(filmVoteContribution.film_key, entry.key),
            eq(filmVoteContribution.contributor, contributor),
          ),
        ),
    });
  }
  for (const entry of added) {
    writes.push({
      statement: db
        .insert(filmVoteContribution)
        .values({ edition, film_key: entry.key, contributor, vote: entry.vote, updated_at: now })
        .onConflictDoUpdate({
          target: [
            filmVoteContribution.edition,
            filmVoteContribution.film_key,
            filmVoteContribution.contributor,
          ],
          set: { vote: entry.vote, updated_at: now },
        }),
    });
  }
  for (const entry of removed) removeVote(entry.key, entry.vote, -1);
  for (const entry of added) addVote(entry.key, entry.vote, 1);

  await flushStatBatch(db, writes);
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
