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
