import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Keep persisted names and defaults compatible with the original 0001_account.sql.
export const oauthPending = sqliteTable("oauth_pending", {
  cookie_hash: text().primaryKey().notNull(),
  payload: text().notNull(),
  expires_at: integer().notNull(),
}, (table) => [index("oauth_pending_expiry").on(table.expires_at)]);

export const appSession = sqliteTable("app_session", {
  token_hash: text().primaryKey().notNull(),
  subject: text().notNull(),
  payload: text().notNull(),
  expires_at: integer().notNull(),
  token_expires_at: integer().notNull(),
  refresh_until: integer().notNull().default(0),
}, (table) => [
  index("app_session_subject").on(table.subject),
  index("app_session_expiry").on(table.expires_at),
]);

export const festivalDocument = sqliteTable("festival_document", {
  subject: text().notNull(),
  edition: text().notNull(),
  revision: integer().notNull().default(0),
  records: text().notNull().default("{}"),
  last_operation: text(),
  updated_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.subject, table.edition] }),
  check("festival_document_records_json", sql`json_valid(${table.records})`),
]);

export type SessionRow = typeof appSession.$inferSelect;

// Account-scoped, shared across devices and editions. Only a committed import creates this row.
export const accountImport = sqliteTable("account_import", {
  subject: text().primaryKey().notNull(),
  operation_id: text().notNull(),
  imported_at: integer().notNull(),
});

/** Per-contributor want-to-watch weight; recompute film_want_stat from these rows. */
export const filmWantContribution = sqliteTable("film_want_contribution", {
  edition: text().notNull(),
  film_key: text().notNull(),
  contributor: text().notNull(),
  weight: text().notNull(), // store as text for exact "1" / "0.75" without float drift in SQLite
  updated_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.edition, table.film_key, table.contributor] }),
  index("film_want_contribution_contributor").on(table.edition, table.contributor),
]);

/** Aggregated weight_sum per film for O(film) reads; display with Math.round. */
export const filmWantStat = sqliteTable("film_want_stat", {
  edition: text().notNull(),
  film_key: text().notNull(),
  weight_sum: text().notNull().default("0"),
  updated_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.edition, table.film_key] }),
]);

/** 建议反馈留言：独立表，不复用 festival_document。 */
export const feedbackPost = sqliteTable("feedback_post", {
  id: text().primaryKey().notNull(),
  subject: text().notNull(),
  display_name: text().notNull(),
  body: text().notNull(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
}, (table) => [
  index("feedback_post_created").on(table.created_at),
  index("feedback_post_subject").on(table.subject),
]);

/** 每用户每帖每种 emoji 至多一条；再点即取消。 */
export const feedbackReaction = sqliteTable("feedback_reaction", {
  post_id: text().notNull(),
  subject: text().notNull(),
  emoji: text().notNull(),
  created_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.post_id, table.subject, table.emoji] }),
  index("feedback_reaction_post").on(table.post_id),
]);

/** 同场观影人数：每位贡献者「行程里有哪些场次」，用于重算 screening_attendance_stat。 */
export const screeningAttendanceContribution = sqliteTable("screening_attendance_contribution", {
  edition: text().notNull(),
  code: text().notNull(),
  contributor: text().notNull(),
  weight: text().notNull(), // 同 film_want_contribution：以文本存 "1" / "0.75"，避免 SQLite 浮点漂移
  updated_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.edition, table.code, table.contributor] }),
  index("screening_attendance_contribution_contributor").on(table.edition, table.contributor),
]);

/** 每场次聚合权重（展示时 Math.round）；O(场次数) 读，供「同场 N 人」徽章。 */
export const screeningAttendanceStat = sqliteTable("screening_attendance_stat", {
  edition: text().notNull(),
  code: text().notNull(),
  weight_sum: text().notNull().default("0"),
  updated_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.edition, table.code] }),
]);

/** 场次讨论帖：一场一条流，分类由 `@biff/contracts/screening` 白名单约束。独立表，不复用 festival_document。 */
export const screeningPost = sqliteTable("screening_post", {
  id: text().primaryKey().notNull(),
  edition: text().notNull(),
  code: text().notNull(),
  subject: text().notNull(),
  display_name: text().notNull(),
  category: text().notNull(),
  body: text().notNull(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
}, (table) => [
  index("screening_post_code_created").on(table.code, table.created_at),
  index("screening_post_subject").on(table.subject),
]);

/** 每用户每帖每种 emoji 至多一条；再点即取消。 */
export const screeningReaction = sqliteTable("screening_reaction", {
  post_id: text().notNull(),
  subject: text().notNull(),
  emoji: text().notNull(),
  created_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.post_id, table.subject, table.emoji] }),
  index("screening_reaction_post").on(table.post_id),
]);
