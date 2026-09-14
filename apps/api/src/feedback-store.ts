import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { database } from "./db";
import { feedbackPost, feedbackReaction } from "./db/schema";
import {
  aggregateReactions,
  decideReactionToggle,
  type FeedbackEmoji,
} from "./feedback";
import { randomToken } from "./crypto";

type Db = ReturnType<typeof database>;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export function parseFeedbackLimit(raw: string | undefined): number {
  const n = Number(raw ?? DEFAULT_LIMIT);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/** cursor = `${created_at}_${id}`，按时间倒序翻页。 */
export function parseFeedbackCursor(
  raw: string | undefined,
): { createdAt: number; id: string } | null {
  if (!raw) return null;
  const i = raw.indexOf("_");
  if (i <= 0) return null;
  const createdAt = Number(raw.slice(0, i));
  const id = raw.slice(i + 1);
  if (!Number.isFinite(createdAt) || !id) return null;
  return { createdAt, id };
}

export function feedbackCursorOf(createdAt: number, id: string): string {
  return `${createdAt}_${id}`;
}

export async function listFeedbackPosts(
  db: Db,
  opts: {
    limit: number;
    cursor: { createdAt: number; id: string } | null;
    mySubject: string | null;
  },
) {
  const rows = opts.cursor
    ? await db
        .select()
        .from(feedbackPost)
        .where(
          sql`(${feedbackPost.created_at} < ${opts.cursor.createdAt}) OR (${feedbackPost.created_at} = ${opts.cursor.createdAt} AND ${feedbackPost.id} < ${opts.cursor.id})`,
        )
        .orderBy(desc(feedbackPost.created_at), desc(feedbackPost.id))
        .limit(opts.limit + 1)
        .all()
    : await db
        .select()
        .from(feedbackPost)
        .orderBy(desc(feedbackPost.created_at), desc(feedbackPost.id))
        .limit(opts.limit + 1)
        .all();

  const page = rows.slice(0, opts.limit);
  const next = rows.length > opts.limit ? page[page.length - 1] : null;
  const ids = page.map((p) => p.id);
  const reactionRows =
    ids.length === 0
      ? []
      : await db
          .select({
            post_id: feedbackReaction.post_id,
            subject: feedbackReaction.subject,
            emoji: feedbackReaction.emoji,
          })
          .from(feedbackReaction)
          .where(inArray(feedbackReaction.post_id, ids))
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
        subject: post.subject,
        displayName: post.display_name,
        body: post.body,
        createdAt: post.created_at,
        updatedAt: post.updated_at,
        reactionCounts: agg.counts,
        myReactions: opts.mySubject ? agg.myReactions : [],
      };
    }),
    nextCursor: next ? feedbackCursorOf(next.created_at, next.id) : null,
  };
}

export async function createFeedbackPost(
  db: Db,
  input: { subject: string; displayName: string; body: string },
) {
  const now = Date.now();
  const id = randomToken();
  await db
    .insert(feedbackPost)
    .values({
      id,
      subject: input.subject,
      display_name: input.displayName,
      body: input.body,
      created_at: now,
      updated_at: now,
    })
    .run();
  return {
    id,
    subject: input.subject,
    displayName: input.displayName,
    body: input.body,
    createdAt: now,
    updatedAt: now,
    reactionCounts: {} as Record<string, number>,
    myReactions: [] as FeedbackEmoji[],
  };
}

export async function deleteFeedbackPost(db: Db, id: string, subject: string) {
  const row = await db.select().from(feedbackPost).where(eq(feedbackPost.id, id)).get();
  if (!row) return { status: "missing" as const };
  if (row.subject !== subject) return { status: "forbidden" as const };
  await db.batch([
    db.delete(feedbackReaction).where(eq(feedbackReaction.post_id, id)),
    db.delete(feedbackPost).where(eq(feedbackPost.id, id)),
  ]);
  return { status: "deleted" as const };
}

export async function toggleFeedbackReaction(
  db: Db,
  input: { postId: string; subject: string; emoji: FeedbackEmoji },
) {
  const post = await db
    .select({ id: feedbackPost.id })
    .from(feedbackPost)
    .where(eq(feedbackPost.id, input.postId))
    .get();
  if (!post) return { status: "missing" as const };

  const existing = await db
    .select()
    .from(feedbackReaction)
    .where(
      and(
        eq(feedbackReaction.post_id, input.postId),
        eq(feedbackReaction.subject, input.subject),
        eq(feedbackReaction.emoji, input.emoji),
      ),
    )
    .get();

  const action = decideReactionToggle(Boolean(existing));
  if (action === "remove") {
    await db
      .delete(feedbackReaction)
      .where(
        and(
          eq(feedbackReaction.post_id, input.postId),
          eq(feedbackReaction.subject, input.subject),
          eq(feedbackReaction.emoji, input.emoji),
        ),
      )
      .run();
  } else {
    await db
      .insert(feedbackReaction)
      .values({
        post_id: input.postId,
        subject: input.subject,
        emoji: input.emoji,
        created_at: Date.now(),
      })
      .run();
  }

  const reactionRows = await db
    .select({
      emoji: feedbackReaction.emoji,
      subject: feedbackReaction.subject,
    })
    .from(feedbackReaction)
    .where(eq(feedbackReaction.post_id, input.postId))
    .all();
  const agg = aggregateReactions(reactionRows, input.subject);
  return {
    status: "ok" as const,
    active: action === "add",
    reactionCounts: agg.counts,
    myReactions: agg.myReactions,
  };
}
