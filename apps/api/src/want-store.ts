import { and, eq, sql } from "drizzle-orm";
import { database } from "./db";
import { filmWantContribution, filmWantStat } from "./db/schema";
import {
  clampAddText,
  flushStatBatch,
  isNonPositiveText,
  wouldGoNegativeText,
  type StatWrite,
} from "./stat-batch";
import { diffFilmKeys, formatWantCounts } from "./want-stats";
import { kstDay } from "./day";
import { dailyBucketWrites } from "./stat-daily";

type Db = ReturnType<typeof database>;

function parseWeight(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** 整份替换某个贡献者的「想看」片单，并同步调整聚合权重。
 *
 *  ⚠ 聚合表的改法在 `stat-batch.ts`（SQL 端原子算术 + 一次批量的往返）。
 *    此前是「读出来在 JS 里加减再写回」，并发上报同一部片会丢更新且永不自愈 —— 见该文件头。
 */
export async function replaceContributorWants(
  db: Db,
  edition: string,
  contributor: string,
  weight: number,
  films: Iterable<string>,
) {
  const next = new Set(
    [...films].filter((key) => typeof key === "string" && key.length > 0 && key.length <= 128),
  );
  const existing = await db
    .select({ film_key: filmWantContribution.film_key, weight: filmWantContribution.weight })
    .from(filmWantContribution)
    .where(and(eq(filmWantContribution.edition, edition), eq(filmWantContribution.contributor, contributor)))
    .all();
  const previousKeys = existing.map((row) => row.film_key);
  const previousWeight = existing[0] ? parseWeight(existing[0].weight) : weight;
  const { removed, added } = diffFilmKeys(previousKeys, next);
  const now = Date.now();
  // 日桶用同一时刻算日界（`day.ts`：KST，只能服务端算）
  const day = kstDay(now);
  const weightLabel = String(weight);
  const writes: StatWrite[] = [];

  const statKey = (filmKey: string) =>
    and(eq(filmWantStat.edition, edition), eq(filmWantStat.film_key, filmKey));

  /** 「按增量改这一部片的聚合」的三件套：探测负漂移 → 钳零写入 → 归零删行。
   *  ⚠ 顺序不可换：探测必须在写入**之前**（钳零之后 `col + delta < 0` 恒真，每条都会误报）。 */
  const adjust = (filmKey: string, delta: number) => {
    const key = statKey(filmKey);
    writes.push({
      statement: db
        .update(filmWantStat)
        .set({ updated_at: sql`${filmWantStat.updated_at}` })
        .where(and(key, wouldGoNegativeText(filmWantStat.weight_sum, delta))),
      drift: `${edition}/${filmKey}`,
    });
    writes.push({
      statement: db
        .update(filmWantStat)
        .set({ weight_sum: clampAddText(filmWantStat.weight_sum, delta), updated_at: now })
        .where(key),
    });
    writes.push({
      statement: db.delete(filmWantStat).where(and(key, isNonPositiveText(filmWantStat.weight_sum))),
    });
    // 日账本记同一个 delta（趋势用）。⚠ 并进**同一个** batch：另起一批等于把每次上报的
    // D1 往返翻倍，而 `stat-atomicity.test.ts` 的往返断言正是为这条存在的。
    // ⚠ 「权重变化」（匿名 0.75 → 登录 1.0）也走这里：日账本与聚合表必须记同一个数，
    // 否则两条口径会慢慢对不上（差值恒为 0 才是自洽）。
    writes.push(
      ...dailyBucketWrites(db, { edition, day, metric: "want", target: filmKey, weightDelta: delta }, now),
    );
  };

  /** 认领一部新片：贡献行落定 + 聚合行「插入或原地加」。 */
  const claim = (filmKey: string) => {
    writes.push({
      statement: db
        .insert(filmWantContribution)
        .values({ edition, film_key: filmKey, contributor, weight: weightLabel, updated_at: now })
        .onConflictDoNothing(),
    });
    writes.push({
      statement: db
        .insert(filmWantStat)
        .values({ edition, film_key: filmKey, weight_sum: weightLabel, updated_at: now })
        .onConflictDoUpdate({
          target: [filmWantStat.edition, filmWantStat.film_key],
          // UPSERT 的 SET 里，表名限定的列指的是**原行**（`excluded.` 才是待插入行）——
          // 所以这一条同时覆盖了「行已存在 → 原地加」与「行不存在 → 用上面的初值」。
          set: { weight_sum: clampAddText(filmWantStat.weight_sum, weight), updated_at: now },
        }),
    });
    writes.push(
      ...dailyBucketWrites(db, { edition, day, metric: "want", target: filmKey, weightDelta: weight }, now),
    );
  };

  for (const filmKey of removed) {
    writes.push({
      statement: db
        .delete(filmWantContribution)
        .where(
          and(
            eq(filmWantContribution.edition, edition),
            eq(filmWantContribution.film_key, filmKey),
            eq(filmWantContribution.contributor, contributor),
          ),
        ),
    });
    adjust(filmKey, -previousWeight);
  }

  for (const filmKey of added) claim(filmKey);

  // 仍在片单里、但权重变了的片（例如匿名 → 登录的升级）：按差值调整。
  if (existing.length && Math.abs(previousWeight - weight) > 1e-9) {
    const delta = weight - previousWeight;
    for (const filmKey of previousKeys) {
      if (!next.has(filmKey)) continue;
      writes.push({
        statement: db
          .update(filmWantContribution)
          .set({ weight: weightLabel, updated_at: now })
          .where(
            and(
              eq(filmWantContribution.edition, edition),
              eq(filmWantContribution.film_key, filmKey),
              eq(filmWantContribution.contributor, contributor),
            ),
          ),
      });
      adjust(filmKey, delta);
    }
  }

  if (writes.length === 0) return;
  await flushStatBatch(db, writes);
}

export async function clearContributorWants(db: Db, edition: string, contributor: string) {
  await replaceContributorWants(db, edition, contributor, 0, []);
}

export async function readWantCounts(db: Db, edition: string) {
  const rows = await db
    .select({ film_key: filmWantStat.film_key, weight_sum: filmWantStat.weight_sum })
    .from(filmWantStat)
    .where(eq(filmWantStat.edition, edition))
    .all();
  return formatWantCounts(rows);
}
