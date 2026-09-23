import { DatabaseSync } from "node:sqlite";

/**
 * D1 接口垫片：把 Node 24 内置的 `node:sqlite` 内存库包成最小 D1 接口，
 * 让 drizzle 生成的**真 SQL 被真执行**（而不是断言实现）。
 *
 * 2026-09-23 从 `oauth-session.test.ts` 抽出（PLAN-20260923111748，B1）：
 * 新增的计数聚合测试要断言「一次上报的 D1 往返次数」，
 * 而往返计数必须与垫片同源 —— 各写一份迟早就对不上了。
 *
 * ⚠ 计数口径（`D1ShimStats`）说的是**驱动层真实往返**：
 *   `batches` = `client.batch()` 被调用几次；`outsideRuns` / `outsideAlls` = 不在批次内执行的语句数。
 *   「逐条 await」的实现 `outsideRuns` 会随条数线性增长；批量实现恒为 0。
 */

/** 垫片的使用计数，供「往返次数」类断言读取。 */
export interface D1ShimStats {
  /** `client.batch()` 的调用次数（真实一次网络往返）。 */
  batches: number;
  /** 交给 batch 的语句总数（D1 会在**一个事务**里依次执行它们）。 */
  statementsInBatch: number;
  /** 批次之外执行的 `run()` 次数（逐条 await 的实现会在这里线性增长）。 */
  outsideRuns: number;
  /** 批次之外执行的 `all()` 次数。 */
  outsideAlls: number;
  /** 批次之外执行的 `raw()` 次数 —— drizzle 的带字段查询（`.select()`）走的就是它。 */
  outsideRaws: number;
}

export function createShimStats(): D1ShimStats {
  return { batches: 0, statementsInBatch: 0, outsideRuns: 0, outsideAlls: 0, outsideRaws: 0 };
}

/**
 * 最小 D1 接口垫片。drizzle 的 d1 驱动只用到
 * `prepare().bind().run()/all()/raw()` 与 `batch()`（见 `drizzle-orm/d1/session.js`），
 * 因此把 `node:sqlite` 包成这几个方法即可跑真 SQL。
 *
 * @param stats 传入同一个对象即可在断言里读取往返计数（省略则不计数）。
 */
export function createD1(sqlite: DatabaseSync, stats?: D1ShimStats): D1Database {
  const meta = (changes: number) => ({
    changes,
    last_row_id: 0,
    duration: 0,
    rows_read: 0,
    rows_written: changes,
    size_after: 0,
  });
  let inBatch = false;
  const statement = (query: string, params: unknown[]) => ({
    bind: (...next: unknown[]) => statement(query, next),
    run: async () => {
      if (!inBatch && stats) stats.outsideRuns += 1;
      const info = sqlite.prepare(query).run(...(params as never[]));
      return { success: true, results: [], meta: meta(Number(info.changes)) };
    },
    all: async () => {
      if (!inBatch && stats) stats.outsideAlls += 1;
      return {
        success: true,
        results: sqlite.prepare(query).all(...(params as never[])),
        meta: meta(0),
      };
    },
    // drizzle 的 `.get()` / 带字段的 `.all()` 走 `values()` → `raw()`，
    // 要的是「按列顺序的数组的数组」。
    raw: async () => {
      if (!inBatch && stats) stats.outsideRaws += 1;
      return (sqlite.prepare(query).all(...(params as never[])) as Record<string, unknown>[]).map((row) =>
        Object.values(row),
      );
    },
  });
  return {
    prepare: (query: string) => statement(query, []),
    batch: async (statements: { run(): Promise<unknown> }[]) => {
      if (stats) {
        stats.batches += 1;
        stats.statementsInBatch += statements.length;
      }
      const results = [];
      inBatch = true;
      try {
        for (const statement of statements) results.push(await statement.run());
      } finally {
        inBatch = false;
      }
      return results;
    },
    exec: async (query: string) => {
      sqlite.exec(query);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
}

/** 会话表（与 `migrations/0001_account.sql` 逐字一致）。登录态相关的测试都要它。 */
export function createSessionSchema(sqlite: DatabaseSync): void {
  sqlite.exec(`
    CREATE TABLE app_session (
      token_hash TEXT PRIMARY KEY NOT NULL,
      subject TEXT NOT NULL,
      payload TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      token_expires_at INTEGER NOT NULL,
      refresh_until INTEGER NOT NULL DEFAULT 0
    );
  `);
}

/** 管理端概览会碰到的「非统计」表（与 `migrations/0001`、`0002`、`0004`、`0005` 逐字一致）。
 *  ⚠ **刻意不含 `app_session`**（那在 `createSessionSchema` 里）—— 两个函数各建一次会让
 *    同时用它们的测试挂在 "table app_session already exists" 上。
 *  ⚠ 概览只需这几张表存在；讨论帖 / 反馈的列照迁移给全，免得以后加断言又要来补。 */
export function createAdminSchema(sqlite: DatabaseSync): void {
  sqlite.exec(`
    CREATE TABLE festival_document (
      subject TEXT NOT NULL,
      edition TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      records TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(records)),
      last_operation TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(subject, edition)
    );
    CREATE TABLE account_import (
      subject TEXT PRIMARY KEY NOT NULL,
      operation_id TEXT NOT NULL,
      imported_at INTEGER NOT NULL
    );
    CREATE TABLE screening_post (
      id TEXT PRIMARY KEY NOT NULL,
      edition TEXT NOT NULL,
      code TEXT NOT NULL,
      subject TEXT NOT NULL,
      display_name TEXT NOT NULL,
      category TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE feedback_post (
      id TEXT PRIMARY KEY NOT NULL,
      subject TEXT NOT NULL,
      display_name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

/** 计数聚合相关表的建表 DDL（与 `migrations/0003`、`0006`、`0007`、`0008`、`0010` 逐字一致）。 */
export function createStatSchema(sqlite: DatabaseSync): void {
  sqlite.exec(`
    CREATE TABLE film_want_contribution (
      edition TEXT NOT NULL,
      film_key TEXT NOT NULL,
      contributor TEXT NOT NULL,
      weight TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(edition, film_key, contributor)
    );
    CREATE TABLE film_want_stat (
      edition TEXT NOT NULL,
      film_key TEXT NOT NULL,
      weight_sum TEXT DEFAULT '0' NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(edition, film_key)
    );
    CREATE TABLE screening_attendance_contribution (
      edition TEXT NOT NULL,
      code TEXT NOT NULL,
      contributor TEXT NOT NULL,
      weight TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(edition, code, contributor)
    );
    CREATE TABLE screening_attendance_stat (
      edition TEXT NOT NULL,
      code TEXT NOT NULL,
      weight_sum TEXT DEFAULT '0' NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(edition, code)
    );
    CREATE TABLE film_vote_contribution (
      edition TEXT NOT NULL,
      film_key TEXT NOT NULL,
      contributor TEXT NOT NULL,
      vote TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(edition, film_key, contributor)
    );
    CREATE TABLE film_vote_stat (
      edition TEXT NOT NULL,
      film_key TEXT NOT NULL,
      red_count INTEGER DEFAULT 0 NOT NULL,
      black_count INTEGER DEFAULT 0 NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(edition, film_key)
    );
    CREATE TABLE screening_ticket_contribution (
      edition TEXT NOT NULL,
      code TEXT NOT NULL,
      contributor TEXT NOT NULL,
      outcome TEXT NOT NULL,
      weight TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(edition, code, contributor)
    );
    CREATE TABLE screening_ticket_stat (
      edition TEXT NOT NULL,
      code TEXT NOT NULL,
      got_sum TEXT DEFAULT '0' NOT NULL,
      transfer_sum TEXT DEFAULT '0' NOT NULL,
      missed_sum TEXT DEFAULT '0' NOT NULL,
      dropped_sum TEXT DEFAULT '0' NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(edition, code)
    );
    CREATE TABLE telemetry_contribution (
      edition TEXT NOT NULL,
      kind TEXT NOT NULL,
      target TEXT NOT NULL,
      contributor TEXT NOT NULL,
      hits INTEGER DEFAULT 0 NOT NULL,
      weight TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(edition, kind, target, contributor)
    );
    CREATE TABLE telemetry_stat (
      edition TEXT NOT NULL,
      kind TEXT NOT NULL,
      target TEXT NOT NULL,
      viewer_weight_sum TEXT DEFAULT '0' NOT NULL,
      hits_weight_sum TEXT DEFAULT '0' NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(edition, kind, target)
    );
    CREATE TABLE stat_daily (
      edition TEXT NOT NULL,
      day TEXT NOT NULL,
      metric TEXT NOT NULL,
      target TEXT NOT NULL,
      weight_sum TEXT NOT NULL,
      hits_sum TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(edition, day, metric, target)
    );
  `);
}
