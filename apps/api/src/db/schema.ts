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

/** 红黑榜投票（2026-09-16,PLAN-20260916102339）：每人**每部片一票**，值为红 / 黑。
 *  唯一约束压住「同一个人反复点同一部」—— 改票走 update、撤票走 delete，聚合表永远等于人数。 */
export const filmVoteContribution = sqliteTable("film_vote_contribution", {
  edition: text().notNull(),
  film_key: text().notNull(),
  contributor: text().notNull(),
  vote: text().notNull(), // "red" | "black";白名单收口在 film-vote-stats.ts，不写 CHECK（旧行迁移过来时更宽松）
  updated_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.edition, table.film_key, table.contributor] }),
  index("film_vote_contribution_contributor").on(table.edition, table.contributor),
]);

/** 每部影片的红 / 黑票数，供榜单读取（O(影片数)）。**不做加权** —— 贴纸是「一人一枚」的离散
 *  隐喻，3 个人贴了红就该显示 3（想看人数那套 0.75 / 1.0 权重会把这里读成 2.25）。 */
export const filmVoteStat = sqliteTable("film_vote_stat", {
  edition: text().notNull(),
  film_key: text().notNull(),
  red_count: integer().notNull().default(0),
  black_count: integer().notNull().default(0),
  updated_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.edition, table.film_key] }),
]);

/** 抢票结果：每位贡献者「每场最终怎样了」。形状与 `screening_attendance_contribution` 同构
 *  （2026-09-20，抢票分析模块）—— 那边记「谁把这场排进行程」，这边记「谁最后抢到没有」。
 *  ⚠ `outcome` 是四值而不是三值：`got` + `via=transfer`（票是别人转的）被归一成独立的
 *    `transfer`，这样「转票不进抢到率」这条业务规则在服务端只有一份实现（见 ticket-stats.ts）。 */
export const screeningTicketContribution = sqliteTable("screening_ticket_contribution", {
  edition: text().notNull(),
  code: text().notNull(),
  contributor: text().notNull(),
  outcome: text().notNull(), // "got" | "transfer" | "missed" | "dropped"；白名单收口在 ticket-stats.ts
  weight: text().notNull(), // 同 film_want_contribution：以文本存 "1" / "0.75"，避免 SQLite 浮点漂移
  updated_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.edition, table.code, table.contributor] }),
  index("screening_ticket_contribution_contributor").on(table.edition, table.contributor),
]);

/** 每场次四项权重和（展示时 Math.round）。**刻意不设冗余的 `weight_sum`**：四项互斥、求和即总量，
 *  多一个冗余列只会迟早与四项之一漂移（`screening_attendance_stat` 只有一项求和，故它才需要）。 */
export const screeningTicketStat = sqliteTable("screening_ticket_stat", {
  edition: text().notNull(),
  code: text().notNull(),
  got_sum: text().notNull().default("0"),
  transfer_sum: text().notNull().default("0"),
  missed_sum: text().notNull().default("0"),
  dropped_sum: text().notNull().default("0"),
  updated_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.edition, table.code] }),
]);
