/**
 * 红黑榜投票的读写（2026-09-16,PLAN-20260916102339）。
 *
 * 形状照抄 `want-store.ts`：**贡献表记「谁投了什么」，聚合表记「每部各多少票」**。
 * 聚合表的存在只为一件事 —— 榜单一次要读几百部片的票数，不能每次去 GROUP BY 贡献表。
 * ⚠ 聚合表的改法在 `stat-batch.ts`（SQL 端原子算术 + 一次分批 batch）——
 *   此前是「读出来在 JS 里加减再写回」，两人同时投同一部片会丢票且永不自愈。
 */

import type { StickerSkin } from "@biff/contracts/sticker";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { database } from "./db";
import { filmVoteContribution, filmVoteSkinStat, filmVoteStat, filmVoteSync } from "./db/schema";
import {
  diffVotes,
  formatSkinCounts,
  formatVoteCounts,
  isFilmVote,
  mergeVoteBoards,
  mergeVoteOps,
  normalizeSkin,
  type CommentCursor,
  type FilmVote,
  type VoteBoard,
  type VoteOp,
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

/** 评语随票一起写（2026-09-29,PLAN-20260929181900）。
 *
 *  ⚠ **`comments` 给不给是两件事**：
 *   - **不给**（`undefined`）→ 一个字都不碰评语列。认领迁移 / 管理端删票走这条 ——
 *     那些路径不该顺手把别人写过的评语清掉；
 *   - **给了**（哪怕是空 Map）→ 按**整份替换**语义：这一份里没有评语 ⇒ 该清空。
 *  靠这一处区分，而不是让每条路径各写一份「改评语」的实现（那样迟早两处口径打架）。 */
export interface VoteExtras {
  /** filmKey → 评语（`null` = 这一票没有评语） */
  comments?: ReadonlyMap<string, string | null>;
  /** 写入时快照的昵称；`null` = 匿名 / 未登录（前端显示「匿名观众」） */
  displayName?: string | null;
  /** filmKey → 这一票选的**贴纸款**（`null` = 没带款；旧客户端 / 迁移前的旧票）。
   *  ⚠ 语义与 `comments` **完全一致**（见上）——给不给是两件事，别在这里另立一套。 */
  skins?: ReadonlyMap<string, StickerSkin | null>;
}

/** 用「这个贡献者最新的全部投票」替换他此前的投票，并同步聚合表。
 *  ⚠ 语义是**整份替换**而不是增量：前端每次都把「我贴出来的那些」全量发上来，
 *    这样断网 / 换设备之后重新登录也能靠一次上报把服务端校正回一致。 */
export async function replaceContributorVotes(
  db: Db,
  edition: string,
  contributor: string,
  votes: ReadonlyMap<string, FilmVote>,
  extras?: VoteExtras,
): Promise<void> {
  const existing = await db
    .select({
      film_key: filmVoteContribution.film_key,
      vote: filmVoteContribution.vote,
      comment: filmVoteContribution.comment,
      skin: filmVoteContribution.skin,
    })
    .from(filmVoteContribution)
    .where(
      and(eq(filmVoteContribution.edition, edition), eq(filmVoteContribution.contributor, contributor)),
    )
    .all();
  const previous = new Map<string, FilmVote>();
  const prevComments = new Map<string, string | null>();
  /** 库里那一票上一份的款。⚠ **必须过白名单**（与读侧同一道收口），坏行不许往聚合里塞垃圾。
   *
   *  ⚠ **已知残留（有意的，不是 bug 忘了修）**：一旦库里那一行的款是白名单外的值，
   *    这里归一出 `null`，于是**无从知道该从哪个桶里减** —— 旧的按款聚合行会留下来，
   *    表现为「群点比卡片上的数字多一枚」。它只可能来自**人工改库**：正常写路径
   *    （本函数 + 认领迁移 + 管理端删票）落进去的款一定过白名单。
   *  ⚠⇒ **操作约束：将来删掉某一款皮肤时，必须一并清理 `film_vote_contribution.skin`
   *    与 `film_vote_skin_stat`**（迁移里做），否则那一款留下的桶永远减不掉。
   *    这与 `stat-batch.ts` 的 `stat_drift` 是同一类「人工干预留下的痕迹」，
   *    不在这里静默吃掉 —— 吃掉的后果是漂移永远查不出来。 */
  const prevSkins = new Map<string, StickerSkin | null>();
  for (const row of existing) {
    // 未知取值（被人工改过的坏行）直接丢掉：它没有对应的聚合列可减
    if (isFilmVote(row.vote)) {
      previous.set(row.film_key, row.vote);
      prevComments.set(row.film_key, row.comment ?? null);
      prevSkins.set(row.film_key, normalizeSkin(row.skin));
    }
  }
  const { removed, added } = diffVotes(previous, votes);
  const edits = extras?.comments;
  const skinPayload = extras?.skins;
  const addedKeys = new Set(added.map((entry) => entry.key));
  /** 这一票**下一份**的款。
   *  · 调用方给了 `skins` → 用它（这一份里没有 = 没带款）；
   *  · 没给（认领迁移 / 管理端删票）→ **原样保留库里那一份**，与 `comment` 同一条规矩：
   *    那些路径不该顺手把别人选过的款抹掉。 */
  const nextSkins = new Map<string, StickerSkin | null>();
  for (const key of votes.keys()) {
    nextSkins.set(key, skinPayload ? normalizeSkin(skinPayload.get(key)) : (prevSkins.get(key) ?? null));
  }
  // 票**没变**、只有评语或款变了的那些行 —— `diffVotes` 看不见它们。
  // ⚠ 必须单独算出来：下面那句「票没变就整体返回」在加评语之前是对的，现在会把
  //   「只改评语 / 只换一款」这些**合法编辑**整个吞掉（用户操作了却什么都没发生）。
  const extrasEdits = [...votes.keys()].filter((key) => {
    if (addedKeys.has(key)) return false;
    if (edits && (edits.get(key) ?? null) !== (prevComments.get(key) ?? null)) return true;
    if (skinPayload && nextSkins.get(key) !== (prevSkins.get(key) ?? null)) return true;
    return false;
  });
  if (!removed.length && !added.length && !extrasEdits.length) return;
  const now = Date.now();
  // 日桶用同一时刻算日界（`day.ts`：KST，只能服务端算）
  const day = kstDay(now);
  /** 这一次上报的语句，**按影片归拢**（2026-10-05，PLAN-20261005182415 §B）。
   *
   * ⚠ 为什么不能像原来那样先攒进一个平铺数组：`chunkStatements` 现在**只在写组边界上切块**，
   *   而写组是按「`group` 相同的连续段」认的 —— 平铺数组里「某部片的贡献行」与「它自己的聚合行」
   *   隔着几十条语句，分块时照样会被劈开，修了个寂寞。所以从**攒的那一刻**就按片归拢，
   *   并且给每条语句打上 `group: filmKey`。
   * ⚠ 片内的相对顺序不变（贡献行 → 聚合行 → 按款 → 日桶），所以中途失败时一部片要么整片落、
   *   要么整片不落 —— 不会再留下「贡献行有了、聚合没跟上」那种**永不修复**的半截状态。 */
  const byFilm = new Map<string, StatWrite[]>();
  const push = (filmKey: string, ...items: StatWrite[]): void => {
    const tagged = items.map((item) => ({ ...item, group: item.group ?? filmKey }));
    const list = byFilm.get(filmKey);
    if (list) list.push(...tagged);
    else byFilm.set(filmKey, tagged);
  };

  const statKey = (filmKey: string) =>
    and(eq(filmVoteStat.edition, edition), eq(filmVoteStat.film_key, filmKey));

  /** 加一票：聚合行「插入或原地加」（行不存在时用 delta 作初值）。 */
  const addVote = (filmKey: string, vote: FilmVote, delta: number) => {
    push(filmKey, {
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
    push(
      filmKey,
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
    push(filmKey, {
      statement: db
        .update(filmVoteStat)
        .set({ updated_at: sql`${filmVoteStat.updated_at}` })
        .where(and(key, wouldGoNegativeInt(column, delta))),
      drift: `${edition}/${filmKey}`,
    });
    push(filmKey, {
      statement: db
        .update(filmVoteStat)
        .set(
          vote === "red"
            ? { red_count: clampAddInt(column, delta), updated_at: now }
            : { black_count: clampAddInt(column, delta), updated_at: now },
        )
        .where(key),
    });
    push(filmKey, {
      statement: db
        .delete(filmVoteStat)
        .where(
          and(key, isNonPositiveInt(filmVoteStat.red_count), isNonPositiveInt(filmVoteStat.black_count)),
        ),
    });
    push(
      filmKey,
      ...dailyBucketWrites(
        db,
        { edition, day, metric: voteDailyMetric(vote), target: filmKey, weightDelta: delta },
        now,
      ),
    );
  };

  /* ---------------- 按款聚合（2026-09-29） ----------------
   * 与 `film_vote_stat` 是「同一件事的细分」：那边两色总数是**权威**（旧票也在内），
   * 这边只覆盖**带款**的那些票。所以两者的加减必须同源同拍，否则群点会比数字多或少。
   *
   * ⚠ **不进日账本**（`stat-daily`）：账本要回答的是「今天红黑各涨了多少」，而款是展示细节；
   *   把款并进桶会让桶数乘上款数，且白名单那边本来就只有「颜色」这一维的口径。 */
  const skinKey = (filmKey: string, skin: StickerSkin, vote: FilmVote) =>
    and(
      eq(filmVoteSkinStat.edition, edition),
      eq(filmVoteSkinStat.film_key, filmKey),
      eq(filmVoteSkinStat.skin, skin),
      eq(filmVoteSkinStat.vote, vote),
    );

  /** 按款加一票：与 `addVote` 同形，多一个 `skin` 维、列名是 `count`。 */
  const addSkinCount = (filmKey: string, skin: StickerSkin, vote: FilmVote, delta: number): void => {
    push(filmKey, {
      statement: db
        .insert(filmVoteSkinStat)
        .values({ edition, film_key: filmKey, skin, vote, count: delta, updated_at: now })
        .onConflictDoUpdate({
          target: [
            filmVoteSkinStat.edition,
            filmVoteSkinStat.film_key,
            filmVoteSkinStat.skin,
            filmVoteSkinStat.vote,
          ],
          set: { count: clampAddInt(filmVoteSkinStat.count, delta), updated_at: now },
        }),
    });
  };

  /** 按款撤一票：探测负漂移 → 钳零写入 → 归零即删行（顺序不可换，与 `removeVote` 同一手）。 */
  const removeSkinCount = (filmKey: string, skin: StickerSkin, vote: FilmVote, delta: number): void => {
    const key = skinKey(filmKey, skin, vote);
    push(filmKey, {
      statement: db
        .update(filmVoteSkinStat)
        .set({ updated_at: sql`${filmVoteSkinStat.updated_at}` })
        .where(and(key, wouldGoNegativeInt(filmVoteSkinStat.count, delta))),
      drift: `${edition}/${filmKey}/${skin}/${vote}`,
    });
    push(filmKey, {
      statement: db
        .update(filmVoteSkinStat)
        .set({ count: clampAddInt(filmVoteSkinStat.count, delta), updated_at: now })
        .where(key),
    });
    push(filmKey, {
      statement: db
        .delete(filmVoteSkinStat)
        .where(and(key, isNonPositiveInt(filmVoteSkinStat.count))),
    });
  };

  // 顺序要紧：一部片内部**先把贡献行落定、再动聚合** —— 中途失败时那一部片整体没写，
  // 不会留下「贡献行有了、聚合没跟上」（那是差分为空 ⇒ **永不修复**的半截状态）。
  for (const entry of removed) {
    push(entry.key, {
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
    push(entry.key, {
      statement: db
        .insert(filmVoteContribution)
        .values({
          edition,
          film_key: entry.key,
          contributor,
          vote: entry.vote,
          // 调用方给了评语这一份 → 用它；没给（认领迁移 / 管理端删票）→ 原样保留库里那一份
          comment: edits ? (edits.get(entry.key) ?? null) : (prevComments.get(entry.key) ?? null),
          // 款同理：`nextSkins` 在「没给这一份」时已经回落到库里那一份
          skin: nextSkins.get(entry.key) ?? null,
          display_name: extras?.displayName ?? null,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [
            filmVoteContribution.edition,
            filmVoteContribution.film_key,
            filmVoteContribution.contributor,
          ],
          // ⚠ SET 里**只放调用方真的想改的列**：没给 `comments` / `skins` 就不写对应列，
          //   否则「改色」会把这一票的评语与款顺手抹掉。
          set: {
            vote: entry.vote,
            ...(edits ? { comment: edits.get(entry.key) ?? null } : {}),
            ...(skinPayload ? { skin: nextSkins.get(entry.key) ?? null } : {}),
            ...(extras?.displayName !== undefined ? { display_name: extras.displayName } : {}),
            updated_at: now,
          },
        }),
    });
  }
  // 票**没变**、只有评语 / 款变了的那些行：票的 diff 里没有它们，要单独补一条 UPDATE。
  // ⚠ 一并刷新 `updated_at` —— 「大家说」按它倒序，改了评语就该排到最前。
  // ⚠ SET 里同样只放调用方真给的那几列（同上面那条说明）。
  for (const filmKey of extrasEdits) {
    const vote = votes.get(filmKey);
    if (!vote) continue;
    push(filmKey, {
      statement: db
        .update(filmVoteContribution)
        .set({
          ...(edits ? { comment: edits.get(filmKey) ?? null } : {}),
          ...(skinPayload ? { skin: nextSkins.get(filmKey) ?? null } : {}),
          ...(extras?.displayName !== undefined ? { display_name: extras.displayName } : {}),
          updated_at: now,
        })
        .where(
          and(
            eq(filmVoteContribution.edition, edition),
            eq(filmVoteContribution.film_key, filmKey),
            eq(filmVoteContribution.contributor, contributor),
          ),
        ),
    });
  }
  // 两色总数 —— **权威那一本账**（旧票也在内，见 `filmVoteSkinStat` 的说明）。
  for (const entry of removed) removeVote(entry.key, entry.vote, -1);
  for (const entry of added) addVote(entry.key, entry.vote, 1);
  // 按款细分：撤的按**旧款**减、加的按**新款**加 —— 改款自然落成「旧款 −1 / 新款 +1」。
  // ⚠ 必须与上面那两行**同源同拍**：少减一次，群点就会比卡片上的数字多一枚，且永不自愈。
  for (const entry of removed) {
    const skin = prevSkins.get(entry.key) ?? null;
    if (skin) removeSkinCount(entry.key, skin, entry.vote, -1);
  }
  for (const entry of added) {
    const skin = nextSkins.get(entry.key) ?? null;
    if (skin) addSkinCount(entry.key, skin, entry.vote, 1);
  }
  // 只换了款（票与颜色都没动）的那几票：`removed` / `added` 里没有它们，得自己算。
  for (const filmKey of extrasEdits) {
    const vote = votes.get(filmKey);
    if (!vote) continue;
    const before = prevSkins.get(filmKey) ?? null;
    const after = nextSkins.get(filmKey) ?? null;
    if (before === after) continue;
    if (before) removeSkinCount(filmKey, before, vote, -1);
    if (after) addSkinCount(filmKey, after, vote, 1);
  }

  // ⚠ 按片展开：`chunkStatements` 认的是「同一 `group` 的**连续段**」，所以「一部片的语句相邻」
  //   必须由这里保证 —— 上面那几轮循环本身是「先把所有片的贡献行写完、再统一写聚合」，
  //   只有在收口时按片展开，一部片的语句才真的相邻、真的同组。
  await flushStatBatch(db, [...byFilm.values()].flat());
}

/** 撤掉这个贡献者的全部投票（登出、或匿名身份升级为登录身份时调用）。 */
export async function clearContributorVotes(db: Db, edition: string, contributor: string): Promise<void> {
  await replaceContributorVotes(db, edition, contributor, new Map());
}

/* ---------------- 增量上报（2026-10-05，PLAN-20261005182415 §C） ----------------
 * 上报从「整份替换」加成「一台设备一批 ops + 一个批次号」。这里有两个东西：
 *   ① 上面那条写路径**照旧复用**（差分 + 聚合 + 日桶全是它，绝不另写一份）；
 *   ② 新增的只有「水位」：`film_vote_sync` 回答「这一批是不是已经落过了」。
 *
 * ⚠ **为什么水位要按设备记**（主键里那个 `client_id`）：`seq` 是每台设备各数各的。少了这一维，
 *    两台设备会用同一个 `contributor` 把对方的 seq 当成「已落过的重放」跳过 ——
 *    症状是「我这台贴的票上不去」，而且在服务端看不出来（水位是 6，人家发的是 5）。
 * ⚠ **为什么水位要最后推**：中途失败时水位不动 ⇒ 客户端重发同一批 ⇒ 因为每个 op 都是
 *    「把这部片设成某状态」，重放只会得到空差分。反过来（先推水位）就是**静默丢票**。
 * ⚠ **为什么还是整份替换的语义**：op 是**意图**，不是补丁。服务端先把「当前状态 + 这批 op」
 *    合成目标状态，再交给上面那条整份替换路径 —— 所以「部分载荷」在这里本来就是安全的。 */

/** 按身份读当前那面墙（三张表同源）。⚠ 与写路径同一道白名单：坏行直接丢。 */
export async function readContributorBoard(
  db: Db,
  edition: string,
  contributor: string,
): Promise<VoteBoard> {
  const rows = await readContributorVotes(db, edition, contributor);
  const board: VoteBoard = { votes: new Map(), comments: new Map(), skins: new Map() };
  for (const row of rows) {
    if (!isFilmVote(row.vote)) continue;
    board.votes.set(row.film_key, row.vote);
    board.comments.set(row.film_key, row.comment ?? null);
    board.skins.set(row.film_key, normalizeSkin(row.skin));
  }
  return board;
}

/** 这台设备报到哪一批了（没报到过就是 0）。 */
async function readLastSeq(
  db: Db,
  edition: string,
  contributor: string,
  clientId: string,
): Promise<number> {
  const row = await db
    .select({ last_seq: filmVoteSync.last_seq })
    .from(filmVoteSync)
    .where(
      and(
        eq(filmVoteSync.edition, edition),
        eq(filmVoteSync.contributor, contributor),
        eq(filmVoteSync.client_id, clientId),
      ),
    )
    .get();
  return Math.max(0, Math.trunc(Number(row?.last_seq ?? 0)));
}

/** 推进水位。⚠ `max(旧值, 新值)` 而不是直接赋值：两批并发时它们都会读到同一个旧值、
 *  都通过守卫，直接赋值会让**已经落过的**那一批把水位写低（与 `clampAddInt` 同一类手法）。 */
async function writeLastSeq(
  db: Db,
  edition: string,
  contributor: string,
  clientId: string,
  seq: number,
): Promise<void> {
  const now = Date.now();
  await db
    .insert(filmVoteSync)
    .values({ edition, contributor, client_id: clientId, last_seq: seq, updated_at: now })
    .onConflictDoUpdate({
      target: [filmVoteSync.edition, filmVoteSync.contributor, filmVoteSync.client_id],
      set: { last_seq: sql`max(${filmVoteSync.last_seq}, ${seq})`, updated_at: now },
    });
}

export interface ApplyVoteOpsResult {
  /** `false` = 这一批的 `seq` 不大于水位，**整批跳过**（重放 / 乱序到的旧批次）。 */
  applied: boolean;
  /** 合并后的票数（跳过的批次也回，便于客户端对账）。 */
  total: number;
}

/** 应用一批增量 ops（`applyVoteOps` 的**纯**那一半在 `film-vote-stats.ts::mergeVoteOps`）。
 *
 *  ⚠ 多一次「读当前那面墙」的往返（`readContributorBoard` + 写路径自己的那次读）：换来的是
 *    **不复制第二条写路径**。往返数是**常数级**的（与 op 条数无关），这正是 `stat-batch.ts`
 *    那条「逐条 await 会线性放大」的约束想守住的性质。 */
export async function applyVoteOps(
  db: Db,
  edition: string,
  contributor: string,
  clientId: string,
  seq: number,
  ops: readonly VoteOp[],
  extras?: { displayName?: string | null },
): Promise<ApplyVoteOpsResult> {
  const board = await readContributorBoard(db, edition, contributor);
  if (seq > 0 && seq <= (await readLastSeq(db, edition, contributor, clientId))) {
    return { applied: false, total: board.votes.size };
  }
  const next = mergeVoteOps(board, ops);
  // ⚠ 目标状态整份给出（`comments` / `skins` 覆盖 `next.votes` 的每一部片）：op 的含义就是
  //   「这一票现在是这个状态」，所以这里**不是**「不碰那两列」，而是「按这一份写」。
  await replaceContributorVotes(db, edition, contributor, next.votes, {
    comments: next.comments,
    skins: next.skins,
    ...(extras?.displayName !== undefined ? { displayName: extras.displayName } : {}),
  });
  // ⚠ 水位**最后**推（见文件头那段的说明）
  if (seq > 0) await writeLastSeq(db, edition, contributor, clientId, seq);
  return { applied: true, total: next.votes.size };
}

/* ---------------- 聚合对账（2026-10-05，PLAN-20261005182415 §B） ----------------
 * 由来：上面的写路径**只在「贡献行有差分」时**才修正聚合。而半截提交（老代码按 40 条硬切
 * 那会儿）留下的正是「贡献行有了、聚合没跟上」—— 差分为空 ⇒ `replaceContributorVotes`
 * 直接 return ⇒ **永远修不回来**。服务端能观测到的症状：`film_vote_contribution` 有我这一票，
 * 而榜上的数字不含它。
 * 这里给运维 / 定时任务开一条**唯一**能把它修回来的出口：按贡献表把两台当前累计表重算一遍。
 *
 * ⚠ **幂等**：全部按贡献表现算，连跑两次结果一致（不信任何前端传来的值）。
 * ⚠ **不动日桶（`stat_daily`）**：它记的是「当天变了多少」，没有历史可依 —— 重算只能修
 *    「当前累计」那两张表。这条必须写在返回值与 docstring 里，否则运维会以为它修全了。
 * ⚠ 四条语句**逐条**执行、而且**不用 DELETE + INSERT**：任何一条中途失败都不会把表清空
 *    （最坏是「修到一半」，再跑一次就收敛）。 */

export interface RecountResult {
  /** 重算后还有票的影片数（`film_vote_stat` 的行数）。 */
  films: number;
  /** 对账后**还剩几处不一致**（贡献表 vs 两色总数表）。⚠ 正常必须是 0 —— 它不是 0 就说明
   *  重算本身没跑完（中途失败），再跑一次即可。 */
  gaps: number;
}

export async function recountVoteStats(db: Db, edition: string): Promise<RecountResult> {
  const now = Date.now();
  // ① 两色总数：有票的按贡献表 upsert。
  // ⚠ `INSERT ... SELECT` 配 `ON CONFLICT` 时必须带 `WHERE`（SQLite 靠它把 upsert 子句与
  //    JOIN 的 ON 区分开）—— 下面这句的 `WHERE edition = ?` 正是那个作用，去掉会直接语法报错。
  await db.run(sql`
    INSERT INTO film_vote_stat (edition, film_key, red_count, black_count, updated_at)
    SELECT edition, film_key,
           SUM(CASE WHEN vote = 'red' THEN 1 ELSE 0 END),
           SUM(CASE WHEN vote = 'black' THEN 1 ELSE 0 END),
           ${now}
    FROM film_vote_contribution
    WHERE edition = ${edition}
    GROUP BY edition, film_key
    ON CONFLICT(edition, film_key) DO UPDATE SET
      red_count = excluded.red_count,
      black_count = excluded.black_count,
      updated_at = excluded.updated_at
  `);
  // ② 票被撤光的那些影片 → 删掉残行（「归零即删行」是这张表既有的口径，见 `removeVote`）
  await db.run(sql`
    DELETE FROM film_vote_stat
    WHERE edition = ${edition}
      AND NOT EXISTS (
        SELECT 1 FROM film_vote_contribution AS c
        WHERE c.edition = film_vote_stat.edition AND c.film_key = film_vote_stat.film_key
      )
  `);
  // ③ 按款细分：同一套 upsert + 清残行。⚠ `skin IS NULL` 的票不进这本账（没带款的旧票），
  //    与 `replaceContributorVotes` / `formatSkinCounts` 是同一条口径。
  await db.run(sql`
    INSERT INTO film_vote_skin_stat (edition, film_key, skin, vote, count, updated_at)
    SELECT edition, film_key, skin, vote, COUNT(*), ${now}
    FROM film_vote_contribution
    WHERE edition = ${edition} AND skin IS NOT NULL
    GROUP BY edition, film_key, skin, vote
    ON CONFLICT(edition, film_key, skin, vote) DO UPDATE SET
      count = excluded.count,
      updated_at = excluded.updated_at
  `);
  await db.run(sql`
    DELETE FROM film_vote_skin_stat
    WHERE edition = ${edition}
      AND NOT EXISTS (
        SELECT 1 FROM film_vote_contribution AS c
        WHERE c.edition = film_vote_skin_stat.edition
          AND c.film_key = film_vote_skin_stat.film_key
          AND c.skin = film_vote_skin_stat.skin
          AND c.vote = film_vote_skin_stat.vote
      )
  `);
  // ④ 对账：把「还剩几处不一致」回给调用方（运维看一眼就知道修干净没有）。
  //    ⚠ 与上面那四条是**独立**的读，不去断言它们是同一个快照（D1 没有跨语句事务）。
  const filmsRow = (await db.get(sql`
    SELECT COUNT(*) AS n FROM film_vote_stat WHERE edition = ${edition}
  `)) as Record<string, unknown> | undefined;
  const gapsRow = (await db.get(sql`
    SELECT COUNT(*) AS n FROM (
      SELECT c.film_key
      FROM film_vote_contribution AS c
      LEFT JOIN film_vote_stat AS s
             ON s.edition = c.edition AND s.film_key = c.film_key
      WHERE c.edition = ${edition}
      GROUP BY c.film_key, s.red_count, s.black_count
      HAVING SUM(CASE WHEN c.vote = 'red'   THEN 1 ELSE 0 END) <> COALESCE(s.red_count, 0)
          OR SUM(CASE WHEN c.vote = 'black' THEN 1 ELSE 0 END) <> COALESCE(s.black_count, 0)
    )
  `)) as Record<string, unknown> | undefined;
  return { films: Number(filmsRow?.n ?? 0), gaps: Number(gapsRow?.n ?? 0) };
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
  /** 评语与昵称快照（2026-09-29,PLAN-20260929181900）：**只有 `readContributorVotes` 会带**它们 ——
   *  认领迁移（匿名 → 登录）要把评语跟着票一起搬，否则用户写过的评语会丢。
   *  ⚠ 声明成**可选**：`readVoteRows`（自查接口）那条路径不读它们，也不该被逼着读。 */
  comment?: string | null;
  display_name?: string | null;
  /** 这一票选的贴纸款（2026-09-29）。与 `comment` 同理：**只有 `readContributorVotes` 会带**，
   *  因为认领迁移要把款跟着票一起搬；`readVoteRows`（自查接口）不读它。
   *  `null` / `undefined` = 没带款（旧票 / 旧客户端）。 */
  skin?: string | null;
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
      // 评语、昵称与贴纸款：认领迁移要拿它们去搬（见 `claimContributorVotes`）。
      // ⚠ 只在这条「按身份读自己那一份」的路径上读；自查接口那条例外见 `VoteRow` 的说明。
      comment: filmVoteContribution.comment,
      display_name: filmVoteContribution.display_name,
      skin: filmVoteContribution.skin,
      updated_at: filmVoteContribution.updated_at,
    })
    .from(filmVoteContribution)
    .where(
      and(eq(filmVoteContribution.edition, edition), eq(filmVoteContribution.contributor, contributor)),
    )
    .all();
}

/** 「大家说」读出来的一行。⚠ **不含 `contributor`** —— 连 select 都不 select 它。 */
export interface CommentRow {
  film_key: string;
  vote: string;
  comment: string | null;
  display_name: string | null;
  updated_at: number;
}

/** 「大家说」读一页：只取**写了评语**的行，按 `(updated_at, film_key)` 倒序。
 *
 *  ⚠ `contributor` **一个字都不读**：它是身份标识（见本文件 `VoteAuditRow` 那段说明），
 *    不让它进 select 列表，「顺手带进响应体」这条路就从源头断了。
 *  ⚠ 游标分页而**不是 offset**：这份数据是持续在长的，offset 在「有人刚写了一条」时
 *    会漏行 / 重行；游标按 `(updated_at, film_key)` 走就不会。
 *  ⚠ 多取一条当「还有没有下一页」的探针，返回前切掉。 */
export async function readRecentComments(
  db: Db,
  edition: string,
  cursor: CommentCursor | null,
  limit: number,
  options: { filmKey?: string | null } = {},
): Promise<{ rows: CommentRow[]; nextCursor: CommentCursor | null }> {
  // 按片读（2026-09-29）：卡片级讨论区问的是「**这一部**的评语」，而这条读接口原本是跨片的。
  // ⚠ 加过滤而不是新写一条读路径：读出形状、白名单、游标语义全部不变，
  //   只是多一个 `WHERE film_key = ?` —— 另写一份迟早两处口径打架（红线 5）。
  const onlyFilm = options.filmKey ? eq(filmVoteContribution.film_key, options.filmKey) : undefined;
  // 严格小于游标：`(updated_at, film_key)` 是**复合序** —— 先比时间，时间相同再比 key
  // （同一毫秒里两个人给两片写评语是可能的，只比时间会漏行）
  const afterCursor = cursor
    ? sql`(${filmVoteContribution.updated_at} < ${cursor.updatedAt}
        OR (${filmVoteContribution.updated_at} = ${cursor.updatedAt}
            AND ${filmVoteContribution.film_key} < ${cursor.filmKey}))`
    : undefined;
  const rows = await db
    .select({
      film_key: filmVoteContribution.film_key,
      vote: filmVoteContribution.vote,
      comment: filmVoteContribution.comment,
      display_name: filmVoteContribution.display_name,
      updated_at: filmVoteContribution.updated_at,
    })
    .from(filmVoteContribution)
    .where(
      and(
        eq(filmVoteContribution.edition, edition),
        // 没写评语的行不该出现在这一页：它们没有内容可展示，只会白占额度
        // ⚠ **口径就是「只列写了评语的人」**（用户 2026-09-29 拍板）—— 别为了让
        //    「大家贴了什么」更完整而放开它：那等于把「谁贴了什么」变成公开名单。
        isNotNull(filmVoteContribution.comment),
        onlyFilm,
        afterCursor,
      ),
    )
    .orderBy(desc(filmVoteContribution.updated_at), desc(filmVoteContribution.film_key))
    .limit(limit + 1)
    .all();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: hasMore && last ? { updatedAt: last.updated_at, filmKey: last.film_key } : null,
  };
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
  options: { dryRun?: boolean; displayName?: string | null } = {},
): Promise<ClaimOutcome> {
  const [fromRows, toRows] = await Promise.all([
    readContributorVotes(db, edition, from),
    readContributorVotes(db, edition, to),
  ]);
  const source = votesMapOf(fromRows);
  const { merged, moved, alreadyHad, conflicts } = mergeVoteBoards(votesMapOf(toRows), source);
  // 评语跟着票一起搬（2026-09-29,PLAN-20260929181900）：认领之后源行会被清掉，
  // 不搬的话**票还在、评语没了**，而且不给用户任何提示。
  // ⚠ 冲突口径与票一致 —— **目标优先**（见 `mergeVoteBoards` 的说明）：同一部片两边都写过时保留目标那份，
  //   所以先铺源、再让目标覆盖。
  const comments = new Map<string, string | null>();
  for (const row of fromRows) comments.set(row.film_key, row.comment ?? null);
  for (const row of toRows) comments.set(row.film_key, row.comment ?? null);
  // 贴纸款同样跟着票搬（2026-09-29）。不搬的后果与评语一样：票还在、**款变回默认**，
  // 而且按款聚合会当场偏掉（源的款没被减、目标的款没被加）。
  // ⚠ 冲突口径与票、评语一致 —— **目标优先**：先铺源、再让目标覆盖。
  const skins = new Map<string, StickerSkin | null>();
  for (const row of fromRows) skins.set(row.film_key, normalizeSkin(row.skin));
  for (const row of toRows) skins.set(row.film_key, normalizeSkin(row.skin));
  const dryRun = options.dryRun === true;
  if (!dryRun) {
    await replaceContributorVotes(db, edition, to, merged, {
      comments,
      skins,
      // 认领之后这些票归**登录身份**，署名也该跟着换（匿名 → 真实昵称）。
      // ⚠ 调用方不给 `displayName` 就**不动**昵称列 —— 传 `undefined` 与传 `null` 是两件事
      //   （后者会把昵称清成「匿名观众」）。
      ...(options.displayName !== undefined ? { displayName: options.displayName } : {}),
    });
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

/** 榜单读取：一次拿到这个 edition 下**每部片每款各几票**（2026-09-29）。
 *
 *  只服务一件事：展板上的群点要画出「大家各自选了什么款」。
 *  ⚠ 与 `readVoteCounts` 一样是**稀疏**的：没有款的票不在这里（它们在总数那本账里），
 *    调用方必须按「总数 − 各款之和 = 没带款的票」自己兜底，而不是假定两者相等。
 *  ⚠ 与 `readVoteCounts` 是**两次独立查询**：D1 没有跨语句事务，两者可能读到相差一拍的快照。
 *    这是可接受的（下一拍就自愈），但**不要在服务端把两者相减后当成不变量去断言**。 */
export async function readSkinCounts(
  db: Db,
  edition: string,
): Promise<Record<string, Partial<Record<StickerSkin, { red: number; black: number }>>>> {
  const rows = await db
    .select({
      film_key: filmVoteSkinStat.film_key,
      skin: filmVoteSkinStat.skin,
      vote: filmVoteSkinStat.vote,
      count: filmVoteSkinStat.count,
    })
    .from(filmVoteSkinStat)
    .where(eq(filmVoteSkinStat.edition, edition))
    .all();
  return formatSkinCounts(rows);
}
