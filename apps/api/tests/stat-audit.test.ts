import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { database } from "../src/db";
import { replaceContributorVotes } from "../src/film-vote-store";
import { replaceContributorScreenings } from "../src/screening-stats-store";
import { auditContributions } from "../src/stat-audit";
import { applyContributorTelemetry } from "../src/telemetry-store";
import { replaceContributorTickets } from "../src/ticket-stats-store";
import { replaceContributorWants } from "../src/want-store";
import { createD1, createStatSchema } from "./d1-shim";

/**
 * 聚合表对账（2026-09-23，PLAN-20260923142546，批 1）。
 *
 * 这个体检的价值全在「**能报出差异**」上 —— 所以除了「一致时为绿」，更要紧的是
 * **人为造出漂移，看它报不报**（直接改聚合表那一格，模拟前几轮那种丢更新）。只测「一致时为绿」
 * 的话，一个永远返回 ok 的实现也能通过。
 */

const EDITION = "biff-2026";

describe("auditContributions（d1 垫片，跑真 SQL）", () => {
  let sqlite: DatabaseSync;
  let db: ReturnType<typeof database>;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    createStatSchema(sqlite);
    db = database(createD1(sqlite));
  });

  afterEach(() => {
    sqlite.close();
  });

  /** 五套统计各写一点（覆盖全部五种表）。 */
  async function seedAll(): Promise<void> {
    await replaceContributorWants(db, EDITION, "c1", 1, ["cat:f001"]);
    await replaceContributorWants(db, EDITION, "c2", 0.75, ["cat:f001", "cat:f002"]);
    await replaceContributorVotes(db, EDITION, "c1", new Map([["cat:f001", "red"]]));
    await replaceContributorVotes(db, EDITION, "c2", new Map([["cat:f001", "black"]]));
    await replaceContributorScreenings(db, EDITION, "c1", 1, ["008"]);
    await replaceContributorTickets(db, EDITION, "c1", 1, new Map([["S001", "got"]]));
    await applyContributorTelemetry(
      db,
      EDITION,
      "c1",
      1,
      new Map([["page|/redblack", { kind: "page", target: "/redblack", hits: 2 }]]),
    );
  }

  it("正常写完之后对账为绿，且每一张贡献表都确实被扫到了", async () => {
    await seedAll();
    const audit = await auditContributions(db, EDITION);
    expect(audit.drifts).toEqual([]);
    expect(audit.ok).toBe(true);
    expect(Object.values(audit.scanned).every((n) => n > 0)).toBe(true);
  });

  it("★ 聚合表被人为改坏 → 必须报出来（这才是它存在的理由）", async () => {
    await seedAll();
    // 模拟「并发丢更新」留下的疤：聚合值比贡献表少 0.75
    sqlite.prepare("UPDATE film_want_stat SET weight_sum = '1' WHERE film_key = 'cat:f001'").run();
    const audit = await auditContributions(db, EDITION);
    expect(audit.ok).toBe(false);
    expect(audit.drifts).toEqual([
      { metric: "want", key: "cat:f001", contribution: 1.75, stat: 1 },
    ]);
  });

  it("★ 聚合行整个丢了也算漂移（stat 侧记 0），而不是当成「没这一部片」", async () => {
    await replaceContributorVotes(db, EDITION, "c1", new Map([["cat:f001", "red"]]));
    sqlite.prepare("DELETE FROM film_vote_stat WHERE film_key = 'cat:f001'").run();
    const audit = await auditContributions(db, EDITION);
    expect(audit.drifts).toEqual([
      { metric: "vote", key: "cat:f001|red", contribution: 1, stat: 0 },
    ]);
  });

  it("★ 贡献表被删、聚合表还留着 → 反向也要报", async () => {
    await replaceContributorScreenings(db, EDITION, "c1", 1, ["008"]);
    sqlite.prepare("DELETE FROM screening_attendance_contribution").run();
    const audit = await auditContributions(db, EDITION);
    expect(audit.drifts).toEqual([
      { metric: "screening", key: "008", contribution: 0, stat: 1 },
    ]);
  });

  it("抢票结果按四列分别比（got 对 got，不串到别的列）", async () => {
    await replaceContributorTickets(db, EDITION, "c1", 1, new Map([["S001", "got"]]));
    sqlite.prepare("UPDATE screening_ticket_stat SET got_sum = '0', missed_sum = '1' WHERE code = 'S001'").run();
    const audit = await auditContributions(db, EDITION);
    expect(audit.drifts).toEqual([
      { metric: "ticket", key: "S001|got", contribution: 1, stat: 0 },
      { metric: "ticket", key: "S001|missed", contribution: 0, stat: 1 },
    ]);
  });

  it("事件流水的两个和分别比（viewers / hits）", async () => {
    await applyContributorTelemetry(
      db,
      EDITION,
      "c1",
      1,
      new Map([["page|/x", { kind: "page", target: "/x", hits: 3 }]]),
    );
    sqlite.prepare("UPDATE telemetry_stat SET hits_weight_sum = '1' WHERE target = '/x'").run();
    const audit = await auditContributions(db, EDITION);
    expect(audit.drifts).toEqual([
      { metric: "telemetry", key: "page|/x|hits", contribution: 3, stat: 1 },
    ]);
  });

  it("未知取值（被人工改过的坏行）不参与比对：不制造假差异", async () => {
    await replaceContributorVotes(db, EDITION, "c1", new Map([["cat:f001", "red"]]));
    sqlite
      .prepare("INSERT INTO film_vote_contribution (edition, film_key, contributor, vote, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(EDITION, "cat:f002", "c9", "purple", Date.now());
    const audit = await auditContributions(db, EDITION);
    expect(audit.ok).toBe(true);
  });

  it("空库：ok 为真但 scanned 全 0 —— 让人看得出「这是空库」而不是「都对」", async () => {
    const audit = await auditContributions(db, EDITION);
    expect(audit.ok).toBe(true);
    expect(audit.drifts).toEqual([]);
    expect(audit.scanned).toEqual({
      film_want_contribution: 0,
      film_vote_contribution: 0,
      screening_attendance_contribution: 0,
      screening_ticket_contribution: 0,
      telemetry_contribution: 0,
    });
  });
});
