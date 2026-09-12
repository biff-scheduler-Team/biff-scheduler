import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { appSession, festivalDocument, oauthPending } from "../apps/api/src/db/schema";

// Verify Drizzle against the migration already applied to production, not a regenerated schema.
describe("existing D1 schema compatibility", () => {
  it("maps every existing column, nullability and index without changing persisted data", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(readFileSync("apps/api/migrations/0001_account.sql", "utf8"));
      for (const table of [oauthPending, appSession, festivalDocument]) {
        const config = getTableConfig(table);
        const columns = db.prepare(`PRAGMA table_info('${config.name}')`).all();
        expect(columns.map((column) => column.name).sort()).toEqual(config.columns.map((column) => column.name).sort());
        for (const column of config.columns) {
          const persisted = columns.find((item) => item.name === column.name)!;
          expect(Boolean(persisted.notnull)).toBe(column.notNull);
        }
        const indexes = db.prepare(`PRAGMA index_list('${config.name}')`).all();
        for (const index of config.indexes)
          expect(indexes.map((item) => item.name)).toContain(index.config.name);
      }
      db.prepare("INSERT INTO festival_document(subject, edition, updated_at) VALUES (?, ?, ?)").run("existing-user", "biff-2026", 1);
      expect(db.prepare("SELECT revision, records FROM festival_document").get()).toEqual({ revision: 0, records: "{}" });
      expect(() => db.prepare("UPDATE festival_document SET records = ?").run("invalid json")).toThrow();
      expect(() => db.prepare("INSERT INTO festival_document(subject, edition, updated_at) VALUES (?, ?, ?)").run("existing-user", "biff-2026", 2)).toThrow();
    } finally { db.close(); }
  });
});
