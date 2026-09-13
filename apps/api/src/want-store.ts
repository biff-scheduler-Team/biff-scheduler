import { and, eq } from "drizzle-orm";
import { database } from "./db";
import { filmWantContribution, filmWantStat } from "./db/schema";
import { diffFilmKeys, formatWantCounts } from "./want-stats";

type Db = ReturnType<typeof database>;

function parseWeight(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Replace one contributor's want films; adjusts aggregated weight_sum. */
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
  const weightLabel = String(weight);

  for (const filmKey of removed) {
    await db
      .delete(filmWantContribution)
      .where(
        and(
          eq(filmWantContribution.edition, edition),
          eq(filmWantContribution.film_key, filmKey),
          eq(filmWantContribution.contributor, contributor),
        ),
      )
      .run();
    const row = await db
      .select()
      .from(filmWantStat)
      .where(and(eq(filmWantStat.edition, edition), eq(filmWantStat.film_key, filmKey)))
      .get();
    if (!row) continue;
    const nextSum = Math.max(0, parseWeight(row.weight_sum) - previousWeight);
    if (nextSum <= 1e-9) {
      await db
        .delete(filmWantStat)
        .where(and(eq(filmWantStat.edition, edition), eq(filmWantStat.film_key, filmKey)))
        .run();
    } else {
      await db
        .update(filmWantStat)
        .set({ weight_sum: String(nextSum), updated_at: now })
        .where(and(eq(filmWantStat.edition, edition), eq(filmWantStat.film_key, filmKey)))
        .run();
    }
  }

  for (const filmKey of added) {
    await db
      .insert(filmWantContribution)
      .values({
        edition,
        film_key: filmKey,
        contributor,
        weight: weightLabel,
        updated_at: now,
      })
      .onConflictDoNothing()
      .run();
    const row = await db
      .select()
      .from(filmWantStat)
      .where(and(eq(filmWantStat.edition, edition), eq(filmWantStat.film_key, filmKey)))
      .get();
    if (row) {
      await db
        .update(filmWantStat)
        .set({ weight_sum: String(parseWeight(row.weight_sum) + weight), updated_at: now })
        .where(and(eq(filmWantStat.edition, edition), eq(filmWantStat.film_key, filmKey)))
        .run();
    } else {
      await db
        .insert(filmWantStat)
        .values({ edition, film_key: filmKey, weight_sum: weightLabel, updated_at: now })
        .run();
    }
  }

  // Weight changed for still-present films (e.g. anon→auth upgrade): adjust delta.
  if (existing.length && Math.abs(previousWeight - weight) > 1e-9) {
    const kept = previousKeys.filter((key) => next.has(key));
    const delta = weight - previousWeight;
    for (const filmKey of kept) {
      await db
        .update(filmWantContribution)
        .set({ weight: weightLabel, updated_at: now })
        .where(
          and(
            eq(filmWantContribution.edition, edition),
            eq(filmWantContribution.film_key, filmKey),
            eq(filmWantContribution.contributor, contributor),
          ),
        )
        .run();
      const row = await db
        .select()
        .from(filmWantStat)
        .where(and(eq(filmWantStat.edition, edition), eq(filmWantStat.film_key, filmKey)))
        .get();
      if (!row) continue;
      await db
        .update(filmWantStat)
        .set({ weight_sum: String(Math.max(0, parseWeight(row.weight_sum) + delta)), updated_at: now })
        .where(and(eq(filmWantStat.edition, edition), eq(filmWantStat.film_key, filmKey)))
        .run();
    }
  }
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
