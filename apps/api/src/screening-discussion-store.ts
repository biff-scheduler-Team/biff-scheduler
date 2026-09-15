/**
 * 场次讨论:帖子 CRUD + 反应 toggle + 分页列表。
 *
 * 形状与 `feedback-store.ts` 同构(公开读 / 登录写 / emoji toggle / 仅作者可删),
 * 差别只在「按场次 code + edition 收窄」。**不复用 `festival_document`**
 * —— 那是「单人整份文档 + revision 乐观锁」,与「多写者 + 聚合读」不同构(见 PLAN.md §4)。
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { ReactionEmoji } from "@biff/contracts/reactions";
import type { DiscussionCategory } from "@biff/contracts/screening";
import type { database } from "./db";
import { screeningPost, screeningReaction } from "./db/schema";
import { aggregateReactions, decideReactionToggle } from "./reactions";
import { cursorOf, parseCursor, parseLimit } from "./pagination";
import { DISCUSSION_LIMIT_DEFAULT, DISCUSSION_LIMIT_MAX } from "./screening-discussion";
import { randomToken } from "./crypto";

type Db = ReturnType<typeof database>;

export function parseDiscussionLimit(raw: string | undefined): number {
  return parseLimit(raw, DISCUSSION_LIMIT_DEFAULT, DISCUSSION_LIMIT_MAX);
}

export function parseDiscussionCursor(raw: string | undefined) {
  return parseCursor(raw);
}

/** 一页帖子(时间倒序),含 reactionCounts 与当前用户的 myReactions。
 *
 *  ⚠ `code` 为 null = **全站讨论区**;非 null = 单个场次的讨论弹层。
 *  两者**共用这一份实现**:游标口径(`${created_at}_${id}` 兜底同毫秒)与反应聚合只允许一处,
 *  拆成两份必然漂移。
 */
async function listPosts(
  db: Db,
  opts: {
    edition: string;
    code: string | null;
    limit: number;
    cursor: { createdAt: number; id: string } | null;
    mySubject: string | null;
  },
) {
  const scope = opts.code
    ? and(eq(screeningPost.edition, opts.edition), eq(screeningPost.code, opts.code))
    : eq(screeningPost.edition, opts.edition);
  const rows = opts.cursor
    ? await db
        .select()
        .from(screeningPost)
        .where(
          and(
            scope,
            sql`(${screeningPost.created_at} < ${opts.cursor.createdAt} OR (${screeningPost.created_at} = ${opts.cursor.createdAt} AND ${screeningPost.id} < ${opts.cursor.id}))`,
          ),
        )
        .orderBy(desc(screeningPost.created_at), desc(screeningPost.id))
        .limit(opts.limit + 1)
        .all()
    : await db
        .select()
        .from(screeningPost)
        .where(scope)
        .orderBy(desc(screeningPost.created_at), desc(screeningPost.id))
        .limit(opts.limit + 1)
        .all();

  const page = rows.slice(0, opts.limit);
  const next = rows.length > opts.limit ? page[page.length - 1] : null;
  const ids = page.map((post) => post.id);
  const reactionRows =
    ids.length === 0
      ? []
      : await db
          .select({
            post_id: screeningReaction.post_id,
            subject: screeningReaction.subject,
            emoji: screeningReaction.emoji,
          })
          .from(screeningReaction)
          .where(inArray(screeningReaction.post_id, ids))
          .all();

  const byPost = new Map<string, Array<{ emoji: string; subject: string }>>();
  for (const row of reactionRows) {
    const list = byPost.get(row.post_id) ?? [];
    list.push({ emoji: row.emoji, subject: row.subject });
    byPost.set(row.post_id, list);
  }

  return {
    posts: page.map((post) => {
      const agg = aggregateReactions(byPost.get(post.id) ?? [], opts.mySubject);
      return {
        id: post.id,
        code: post.code,
        subject: post.subject,
        displayName: post.display_name,
        category: post.category,
        body: post.body,
        createdAt: post.created_at,
        updatedAt: post.updated_at,
        reactionCounts: agg.counts,
        myReactions: opts.mySubject ? agg.myReactions : [],
      };
    }),
    nextCursor: next ? cursorOf(next.created_at, next.id) : null,
  };
}

/** 某场次的一页帖子(时间倒序)——场次讨论弹层用。 */
export function listScreeningPosts(
  db: Db,
  opts: {
    edition: string;
    code: string;
    limit: number;
    cursor: { createdAt: number; id: string } | null;
    mySubject: string | null;
  },
) {
  return listPosts(db, opts);
}

/** 全站讨论区的一页帖子(时间倒序,不按场次收窄)——2026-09-15,PLAN-20260915233816。 */
export function listDiscussionPosts(
  db: Db,
  opts: {
    edition: string;
    limit: number;
    cursor: { createdAt: number; id: string } | null;
    mySubject: string | null;
  },
) {
  return listPosts(db, { ...opts, code: null });
}

export async function createScreeningPost(
  db: Db,
  input: {
    edition: string;
    code: string;
    subject: string;
    displayName: string;
    category: DiscussionCategory;
    body: string;
  },
) {
  const now = Date.now();
  const id = randomToken();
  await db
    .insert(screeningPost)
    .values({
      id,
      edition: input.edition,
      code: input.code,
      subject: input.subject,
      display_name: input.displayName,
      category: input.category,
      body: input.body,
      created_at: now,
      updated_at: now,
    })
    .run();
  return {
    id,
    code: input.code,
    subject: input.subject,
    displayName: input.displayName,
    category: input.category,
    body: input.body,
    createdAt: now,
    updatedAt: now,
    reactionCounts: {} as Record<string, number>,
    myReactions: [] as ReactionEmoji[],
  };
}

export async function deleteScreeningPost(db: Db, id: string, subject: string) {
  const row = await db.select().from(screeningPost).where(eq(screeningPost.id, id)).get();
  if (!row) return { status: "missing" as const };
  if (row.subject !== subject) return { status: "forbidden" as const };
  await db.batch([
    db.delete(screeningReaction).where(eq(screeningReaction.post_id, id)),
    db.delete(screeningPost).where(eq(screeningPost.id, id)),
  ]);
  return { status: "deleted" as const };
}

export async function toggleScreeningReaction(
  db: Db,
  input: { postId: string; subject: string; emoji: ReactionEmoji },
) {
  const post = await db
    .select({ id: screeningPost.id })
    .from(screeningPost)
    .where(eq(screeningPost.id, input.postId))
    .get();
  if (!post) return { status: "missing" as const };

  const existing = await db
    .select()
    .from(screeningReaction)
    .where(
      and(
        eq(screeningReaction.post_id, input.postId),
        eq(screeningReaction.subject, input.subject),
        eq(screeningReaction.emoji, input.emoji),
      ),
    )
    .get();

  const action = decideReactionToggle(Boolean(existing));
  if (action === "remove") {
    await db
      .delete(screeningReaction)
      .where(
        and(
          eq(screeningReaction.post_id, input.postId),
          eq(screeningReaction.subject, input.subject),
          eq(screeningReaction.emoji, input.emoji),
        ),
      )
      .run();
  } else {
    await db
      .insert(screeningReaction)
      .values({
        post_id: input.postId,
        subject: input.subject,
        emoji: input.emoji,
        created_at: Date.now(),
      })
      .run();
  }

  const reactionRows = await db
    .select({ emoji: screeningReaction.emoji, subject: screeningReaction.subject })
    .from(screeningReaction)
    .where(eq(screeningReaction.post_id, input.postId))
    .all();
  const agg = aggregateReactions(reactionRows, input.subject);
  return {
    status: "ok" as const,
    active: action === "add",
    reactionCounts: agg.counts,
    myReactions: agg.myReactions,
  };
}

/** 每场次帖子数(卡片上「讨论 N」用);小表 GROUP BY,不做预聚合。 */
export async function readDiscussionCounts(db: Db, edition: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ code: screeningPost.code, total: sql<number>`count(*)` })
    .from(screeningPost)
    .where(eq(screeningPost.edition, edition))
    .groupBy(screeningPost.code)
    .all();
  const counts: Record<string, number> = Object.create(null);
  for (const row of rows) {
    const n = Number(row.total);
    if (Number.isFinite(n) && n > 0) counts[row.code] = n;
  }
  return counts;
}
