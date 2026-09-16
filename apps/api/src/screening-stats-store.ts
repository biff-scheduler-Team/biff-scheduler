/**
 * 同场观影人数:贡献者表 + 预聚合表的差分维护(读 O(场次数),写只动差分)。
 *
 * 形状与 `want-store.ts` 完全同构 —— 那里按 `film_key`,这里按场次 `code`;
 * **唯一的差别是键**,算法刻意保持一致,便于两处对照排查。
 */

import { and, eq } from "drizzle-orm";
import { database } from "./db";
import { screeningAttendanceContribution, screeningAttendanceStat } from "./db/schema";
import { formatAttendanceCounts, SCREENING_CODE_MAX_LENGTH } from "./screening-stats";
import { diffFilmKeys } from "./want-stats";
import { clearContributorWants } from "./want-store";
import { clearContributorVotes } from "./film-vote-store";

type Db = ReturnType<typeof database>;

function parseWeight(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** 替换一位贡献者的场次集合;按差分增量维护预聚合表。 */
export async function replaceContributorScreenings(
  db: Db,
  edition: string,
  contributor: string,
  weight: number,
  codes: Iterable<string>,
) {
  const next = new Set(
    [...codes].filter(
      (code) => typeof code === "string" && code.length > 0 && code.length <= SCREENING_CODE_MAX_LENGTH,
    ),
  );
  const existing = await db
    .select({
      code: screeningAttendanceContribution.code,
      weight: screeningAttendanceContribution.weight,
    })
    .from(screeningAttendanceContribution)
    .where(
      and(
        eq(screeningAttendanceContribution.edition, edition),
        eq(screeningAttendanceContribution.contributor, contributor),
      ),
    )
    .all();
  const previousCodes = existing.map((row) => row.code);
  const previousWeight = existing[0] ? parseWeight(existing[0].weight) : weight;
  // 复用 want-store 的同一份字符串集合差分(纯逻辑,与 film / code 无关),不写第二份
  const { removed, added } = diffFilmKeys(previousCodes, next);
  const now = Date.now();
  const weightLabel = String(weight);

  for (const code of removed) {
    await db
      .delete(screeningAttendanceContribution)
      .where(
        and(
          eq(screeningAttendanceContribution.edition, edition),
          eq(screeningAttendanceContribution.code, code),
          eq(screeningAttendanceContribution.contributor, contributor),
        ),
      )
      .run();
    const row = await db
      .select()
      .from(screeningAttendanceStat)
      .where(and(eq(screeningAttendanceStat.edition, edition), eq(screeningAttendanceStat.code, code)))
      .get();
    if (!row) continue;
    const nextSum = Math.max(0, parseWeight(row.weight_sum) - previousWeight);
    if (nextSum <= 1e-9) {
      await db
        .delete(screeningAttendanceStat)
        .where(and(eq(screeningAttendanceStat.edition, edition), eq(screeningAttendanceStat.code, code)))
        .run();
    } else {
      await db
        .update(screeningAttendanceStat)
        .set({ weight_sum: String(nextSum), updated_at: now })
        .where(and(eq(screeningAttendanceStat.edition, edition), eq(screeningAttendanceStat.code, code)))
        .run();
    }
  }

  for (const code of added) {
    await db
      .insert(screeningAttendanceContribution)
      .values({ edition, code, contributor, weight: weightLabel, updated_at: now })
      .onConflictDoNothing()
      .run();
    const row = await db
      .select()
      .from(screeningAttendanceStat)
      .where(and(eq(screeningAttendanceStat.edition, edition), eq(screeningAttendanceStat.code, code)))
      .get();
    if (row) {
      await db
        .update(screeningAttendanceStat)
        .set({ weight_sum: String(parseWeight(row.weight_sum) + weight), updated_at: now })
        .where(and(eq(screeningAttendanceStat.edition, edition), eq(screeningAttendanceStat.code, code)))
        .run();
    } else {
      await db
        .insert(screeningAttendanceStat)
        .values({ edition, code, weight_sum: weightLabel, updated_at: now })
        .run();
    }
  }

  // 仍在集合里但权重变了(匿名 → 登录):补一个差值,别重算全表
  if (existing.length && Math.abs(previousWeight - weight) > 1e-9) {
    const kept = previousCodes.filter((code) => next.has(code));
    const delta = weight - previousWeight;
    for (const code of kept) {
      await db
        .update(screeningAttendanceContribution)
        .set({ weight: weightLabel, updated_at: now })
        .where(
          and(
            eq(screeningAttendanceContribution.edition, edition),
            eq(screeningAttendanceContribution.code, code),
            eq(screeningAttendanceContribution.contributor, contributor),
          ),
        )
        .run();
      const row = await db
        .select()
        .from(screeningAttendanceStat)
        .where(and(eq(screeningAttendanceStat.edition, edition), eq(screeningAttendanceStat.code, code)))
        .get();
      if (!row) continue;
      await db
        .update(screeningAttendanceStat)
        .set({ weight_sum: String(Math.max(0, parseWeight(row.weight_sum) + delta)), updated_at: now })
        .where(and(eq(screeningAttendanceStat.edition, edition), eq(screeningAttendanceStat.code, code)))
        .run();
    }
  }
}

export async function clearContributorScreenings(db: Db, edition: string, contributor: string) {
  await replaceContributorScreenings(db, edition, contributor, 0, []);
}

/** 读全部场次的展示用人数(≤ 场次数 ~750 行,一次扫完)。 */
export async function readScreeningCounts(db: Db, edition: string) {
  const rows = await db
    .select({ code: screeningAttendanceStat.code, weight_sum: screeningAttendanceStat.weight_sum })
    .from(screeningAttendanceStat)
    .where(eq(screeningAttendanceStat.edition, edition))
    .all();
  return formatAttendanceCounts(rows);
}

/**
 * 登录后把「同一浏览器匿名身份」在**所有**贡献表里的行都清掉。
 *
 * ⚠ 每一个 ping(want / screening / film-votes)都必须调它:先跑的那条会顺手删掉匿名 cookie,
 *   后跑的那条就再也算不出自己的匿名 contributor —— 只清一张表的话,
 *   同一人会以「匿名 + 登录」被算两次(展示成 2 人 / 2 票)。
 */
export async function clearAnonContributions(db: Db, edition: string, contributor: string) {
  await clearContributorWants(db, edition, contributor);
  await clearContributorScreenings(db, edition, contributor);
  // 红黑榜投票(2026-09-16,PLAN-20260916102339):同一份「同一人只算一次」的要求
  await clearContributorVotes(db, edition, contributor);
}
