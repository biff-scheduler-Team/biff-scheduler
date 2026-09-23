/**
 * 红黑榜投票的读写（2026-09-16,PLAN-20260916102339）。
 *
 * 形状照抄 `want-store.ts`：**贡献表记「谁投了什么」，聚合表记「每部各多少票」**。
 * 聚合表的存在只为一件事 —— 榜单一次要读几百部片的票数，不能每次去 GROUP BY 贡献表。
 * ⚠ 聚合表的改法在 `stat-batch.ts`（SQL 端原子算术 + 一次分批 batch）——
 *   此前是「读出来在 JS 里加减再写回」，两人同时投同一部片会丢票且永不自愈。
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { database } from "./db";
import { filmVoteContribution, filmVoteStat } from "./db/schema";
import {
  diffVotes,
  formatVoteCounts,
  isFilmVote,
  mergeVoteBoards,
  type FilmVote,
} from "./film-vote-stats";
import { kstDay } from "./day";
import { dailyBucketWrites, voteDailyMetric } from "./stat-daily";
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
  // 日桶用同一时刻算日界（`day.ts`：KST，只能服务端算）
  const day = kstDay(now);
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
    // 日账本按**颜色**分桶（见 `stat-daily.ts` 白名单里的说明：合成一个桶会让改票当天互相抵消）。
    // ⚠ 并进同一个 batch，理由见 `stat-daily.ts` 文件头。
    writes.push(
      ...dailyBucketWrites(
        db,
        { edition, day, metric: voteDailyMetric(vote), target: filmKey, weightDelta: delta },
        now,
      ),
    );
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
    writes.push(
      ...dailyBucketWrites(
        db,
        { edition, day, metric: voteDailyMetric(vote), target: filmKey, weightDelta: delta },
        now,
      ),
    );
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

/** 匿名贡献者的标识前缀(`anon:<SHA-256(匿名 cookie)>`)。
 *  ⚠ 新代码一律用它拼 / 判身份:自查接口靠它区分「我这台机器」与「登录身份」,
 *    拼错或忘记前缀会**静默判错归属**(而不是报错)。
 *  ⚠ 已知欠账:5 个 ping 处理器里仍是内联的 `anon:${...}` 字符串 —— 本轮**没顺手改**,
 *    因为那会把一次排查接口的改动变成跨 5 条上报路径的重构(§4「一次提交只做一件事」)。 */
export const ANON_PREFIX = "anon:";

/** 自查读一次最多回多少行 —— 线上目前是个位数票,500 是「远大于真实值、又不至于拖垮 isolate」的上限。 */
export const MAX_VOTE_ROWS = 500;

/** 贡献行原样(含 `contributor`)。**只在服务端内部流转**,不得直接进响应体。 */
export interface VoteRow {
  film_key: string;
  contributor: string;
  vote: string;
  updated_at: number;
}

/** 读该 edition 的贡献行(按更新时间降序,上限 `MAX_VOTE_ROWS`)。
 *  ⚠ 这是唯一一处把「谁投的」读出库的地方,只服务自查接口(PLAN-20260923124402);
 *    公开读路径一律走 `readVoteCounts`(聚合),不要把行数据接到榜单 / 统计链路上。 */
export async function readVoteRows(
  db: Db,
  edition: string,
  limit = MAX_VOTE_ROWS,
): Promise<VoteRow[]> {
  return db
    .select({
      film_key: filmVoteContribution.film_key,
      contributor: filmVoteContribution.contributor,
      vote: filmVoteContribution.vote,
      updated_at: filmVoteContribution.updated_at,
    })
    .from(filmVoteContribution)
    .where(eq(filmVoteContribution.edition, edition))
    .orderBy(desc(filmVoteContribution.updated_at))
    .limit(limit)
    .all();
}

/** 自查接口回给浏览器的一行。⚠ **刻意不含 `contributor`** —— subject 是账号标识,
 *  回出去就是「谁投了什么」的名单;匿名 hash 虽不可反查,但它能当跨表 / 跨接口比对的抓手,
 *  而本接口要回答的只是「这行是不是我的」。所以两者都不回,只回一个 `anonymous` 布尔。 */
export interface VoteAuditRow {
  // ⚠ 字段名走 **camelCase**:库里的行是 snake_case(`VoteRow`),但**对外的 DTO 一律 camelCase**
  //   —— 与 `/api/account/sync`、讨论区 / 反馈那几套一致(`createdAt` / `updatedAt` / `postId`)。
  filmKey: string;
  vote: FilmVote;
  updatedAt: number;
  /** 这一行是不是匿名身份投的 */
  anonymous: boolean;
}

export interface VoteAudit {
  /** 我(登录 subject)名下的行 */
  mine: VoteAuditRow[];
  /** 其余所有行 —— 只区分「是不是匿名的」,不暴露是谁 */
  others: VoteAuditRow[];
  /** 本浏览器这一份匿名身份的情况 */
  thisBrowser: {
    hasAnonCookie: boolean;
    /** 本浏览器匿名身份命中的行(唯一能证明「那枚匿名票是这台机器贴的」的判据) */
    matched: VoteAuditRow[];
  };
}

/** 贡献行 → 「按访问者分档」的投影。纯函数,便于单测(见 `tests/film-vote-audit.test.ts`)。 */
export function auditVoteRows(
  rows: readonly VoteRow[],
  viewer: { subject: string; anonContributor: string | null },
): VoteAudit {
  const mine: VoteAuditRow[] = [];
  const others: VoteAuditRow[] = [];
  const matched: VoteAuditRow[] = [];
  for (const row of rows) {
    // 被人工改过的坏行:白名单之外一律不猜、不展示(与 `replaceContributorVotes` 同一道收口)
    if (!isFilmVote(row.vote)) continue;
    const item: VoteAuditRow = {
      filmKey: row.film_key,
      vote: row.vote,
      updatedAt: row.updated_at,
      anonymous: row.contributor.startsWith(ANON_PREFIX),
    };
    if (row.contributor === viewer.subject) mine.push(item);
    else others.push(item);
    if (viewer.anonContributor && row.contributor === viewer.anonContributor) matched.push(item);
  }
  return {
    mine,
    others,
    thisBrowser: { hasAnonCookie: Boolean(viewer.anonContributor), matched },
  };
}

/* ---------------- 管理端(2026-09-23,PLAN-20260923140943) ----------------
 * 门禁在 `index.ts`(`/api/admin/*` 两层:requireIdentity + subject 白名单),这里只管数据。 */

/** 管理端回给浏览器的一行 —— **含 `contributor` 原文**。
 *  ⚠ 全站唯一一处会把它回出去的地方:公开统计只回聚合,自查接口只回「是不是我的」。
 *    要给它加调用点,先确认门禁(见 `admin.ts`)。 */
export interface VoteAdminRow {
  filmKey: string;
  vote: FilmVote;
  contributor: string;
  anonymous: boolean;
  updatedAt: number;
}

/** 贡献行 → 管理端 DTO。白名单外的坏 vote 行仍然丢弃(与其它读路径同一道收口)。 */
export function exposeVoteRows(rows: readonly VoteRow[]): VoteAdminRow[] {
  const out: VoteAdminRow[] = [];
  for (const row of rows) {
    if (!isFilmVote(row.vote)) continue;
    out.push({
      filmKey: row.film_key,
      vote: row.vote,
      contributor: row.contributor,
      anonymous: row.contributor.startsWith(ANON_PREFIX),
      updatedAt: row.updated_at,
    });
  }
  return out;
}

/** 只读某个身份在这个 edition 下的票(走 `(edition, contributor)` 索引)。
 *  ⚠ 不做 `MAX_VOTE_ROWS` 截断:这是写路径的前置读(删 / 迁移都按它算整份),
 *    截断会让「整份替换」把没读到的那部分**当成撤票删掉**。 */
export async function readContributorVotes(
  db: Db,
  edition: string,
  contributor: string,
): Promise<VoteRow[]> {
  return db
    .select({
      film_key: filmVoteContribution.film_key,
      contributor: filmVoteContribution.contributor,
      vote: filmVoteContribution.vote,
      updated_at: filmVoteContribution.updated_at,
    })
    .from(filmVoteContribution)
    .where(
      and(eq(filmVoteContribution.edition, edition), eq(filmVoteContribution.contributor, contributor)),
    )
    .all();
}

/** 贡献行 → votes Map(白名单外的坏行丢弃 —— 与 `replaceContributorVotes` 的读侧同一道收口)。 */
function votesMapOf(rows: readonly VoteRow[]): Map<string, FilmVote> {
  const out = new Map<string, FilmVote>();
  for (const row of rows) if (isFilmVote(row.vote)) out.set(row.film_key, row.vote);
  return out;
}

/** 删掉某身份下的一票(管理端)。返回是否真的删掉了一行。
 *  复用 `replaceContributorVotes` 的**整份替换**:贡献行与聚合计数在同一个 batch 里改,
 *  不写第二份「减一票」实现(否则就是同一口径两份,见红线 5)。 */
export async function removeContributorVote(
  db: Db,
  edition: string,
  contributor: string,
  filmKey: string,
): Promise<boolean> {
  const rows = await readContributorVotes(db, edition, contributor);
  if (!rows.some((row) => row.film_key === filmKey)) return false;
  const next = votesMapOf(rows);
  next.delete(filmKey);
  await replaceContributorVotes(db, edition, contributor, next);
  return true;
}

/** 认领迁移的结果。 */
export interface ClaimOutcome {
  from: string;
  to: string;
  /** 并过去了几票(目标原本没有的片) */
  moved: number;
  /** 目标本来就有同一部片的同一颜色 —— 无事发生 */
  alreadyHad: number;
  /** 同一部片两色冲突:保留**目标**那票,这里逐条报出来给人核对 */
  conflicts: Array<{ key: string; source: FilmVote; target: FilmVote }>;
  dryRun: boolean;
  /** 源身份这次被撤掉的票数 */
  cleared: number;
  /** 目标身份迁移后的票数 */
  targetTotal: number;
}

/** 把 `from` 的票整份并到 `to`(管理端;典型场景:丢登录态后匿名贴的票并回账号)。
 *
 *  ⚠ **写入顺序不可换**:先并到目标、再清源。
 *    中途失败时留下的是「两边都在」(重复计数,可见且可自愈);反序会**丢票且不可恢复**。
 *    也正因为可自愈,这个操作是**幂等**的 —— 重跑一次就收敛。 */
export async function claimContributorVotes(
  db: Db,
  edition: string,
  from: string,
  to: string,
  options: { dryRun?: boolean } = {},
): Promise<ClaimOutcome> {
  const [fromRows, toRows] = await Promise.all([
    readContributorVotes(db, edition, from),
    readContributorVotes(db, edition, to),
  ]);
  const source = votesMapOf(fromRows);
  const { merged, moved, alreadyHad, conflicts } = mergeVoteBoards(votesMapOf(toRows), source);
  const dryRun = options.dryRun === true;
  if (!dryRun) {
    await replaceContributorVotes(db, edition, to, merged);
    await replaceContributorVotes(db, edition, from, new Map());
  }
  return {
    from,
    to,
    moved,
    alreadyHad,
    conflicts,
    dryRun,
    cleared: source.size,
    targetTotal: merged.size,
  };
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
