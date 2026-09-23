import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readContributionRows, readOverview } from "../src/admin-read";
import { database } from "../src/db";
import { kstDay } from "../src/day";
import { replaceContributorVotes } from "../src/film-vote-store";
import { replaceContributorScreenings } from "../src/screening-stats-store";
import { applyContributorTelemetry } from "../src/telemetry-store";
import { replaceContributorTickets } from "../src/ticket-stats-store";
import { replaceContributorWants } from "../src/want-store";
import { createAdminSchema, createD1, createSessionSchema, createStatSchema } from "./d1-shim";

/**
 * 管理端读聚合（2026-09-23，PLAN-20260923142546，批 1）。
 *
 * 两件事在这里被钉住：
 *   ① 概览的「总量 / 去重人数 / 今日增量」与各模块**自己那张表**一致（不是另算一套口径）；
 *   ② `rows` 的分页**不重不漏** —— 游标只带时间戳的话，同一毫秒的行会被整批跳过或重复，
 *      所以这里专门造了「同一毫秒两条」的现场。
 *
 * ⚠ 另有一条隐私断言：概览的账号那块**绝不出现片单内容**（`festival_document.records`）。
 */

const EDITION = "biff-2026";
const TODAY = kstDay(Date.now());

describe("readOverview（d1 垫片，跑真 SQL）", () => {
  let sqlite: DatabaseSync;
  let db: ReturnType<typeof database>;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    createStatSchema(sqlite);
    createSessionSchema(sqlite);
    createAdminSchema(sqlite);
    db = database(createD1(sqlite));
  });

  afterEach(() => {
    sqlite.close();
  });

  it("五个模块各自的总量 / 去重人数 / 目标数 / 今日增量，且 today / earliestDay 用服务端日界", async () => {
    await replaceContributorWants(db, EDITION, "c1", 1, ["cat:f001"]);
    await replaceContributorWants(db, EDITION, "c2", 0.75, ["cat:f001", "cat:f002"]);
    await replaceContributorVotes(db, EDITION, "c1", new Map([["cat:f001", "red"]]));

    const overview = await readOverview(db, EDITION);
    const metric = (name: string) => overview.metrics.find((row) => row.metric === name);
    expect(metric("want")).toEqual({
      metric: "want",
      rows: 3,
      contributors: 2,
      targets: 2,
      // 1（登录）+ 0.75 + 0.75（匿名那位的两片）
      total: 2.5,
      today: 2.5,
    });
    expect(metric("vote")).toEqual({
      metric: "vote",
      rows: 1,
      contributors: 1,
      targets: 1,
      total: 1,
      today: 1,
    });
    // 没数据的模块是 0，而不是缺项（前端不用判空）
    expect(metric("ticket")).toEqual({
      metric: "ticket",
      rows: 0,
      contributors: 0,
      targets: 0,
      total: 0,
      today: 0,
    });
    expect(overview.today).toBe(TODAY);
    expect(overview.earliestDay).toBe(TODAY);
    expect(overview.audit.ok).toBe(true);
  });

  it("今日增量按「族」加总：红黑两种颜色算进同一个 vote 数字", async () => {
    await replaceContributorVotes(db, EDITION, "c1", new Map([["cat:f001", "red"]]));
    await replaceContributorVotes(db, EDITION, "c2", new Map([["cat:f001", "black"]]));
    await replaceContributorVotes(db, EDITION, "c3", new Map([["cat:f002", "red"]]));
    const vote = (await readOverview(db, EDITION)).metrics.find((row) => row.metric === "vote");
    expect(vote).toMatchObject({ rows: 3, contributors: 3, targets: 2, total: 3, today: 3 });
  });

  it("概览同时给出对账结论（体检与目录一屏看完）", async () => {
    await replaceContributorScreenings(db, EDITION, "c1", 1, ["008"]);
    sqlite.prepare("UPDATE screening_attendance_stat SET weight_sum = '0.25'").run();
    const overview = await readOverview(db, EDITION);
    expect(overview.audit.ok).toBe(false);
    expect(overview.audit.drifts).toEqual([
      { metric: "screening", key: "008", contribution: 1, stat: 0.25 },
    ]);
  });

  it("★ 账号概况只回统计量：会话数 / 文档数 / 文档字节数 / 已导入数，**绝不回片单内容**", async () => {
    const secret = '{"local:biff.picks.v2":"这是别人的片单，不能出现在管理端"}';
    sqlite
      .prepare(
        "INSERT INTO festival_document (subject, edition, revision, records, updated_at) VALUES (?, ?, 1, ?, ?)",
      )
      .run("user_00000000000000000000000001", EDITION, secret, Date.now());
    sqlite
      .prepare(
        `INSERT INTO app_session (token_hash, subject, payload, expires_at, token_expires_at, refresh_until)
         VALUES ('h1', 'user_00000000000000000000000001', 'x', ?, ?, 0)`,
      )
      .run(Date.now() + 1000, Date.now() + 1000);
    sqlite
      .prepare("INSERT INTO account_import (subject, operation_id, imported_at) VALUES (?, ?, ?)")
      .run("user_00000000000000000000000001", "op-1", Date.now());

    const overview = await readOverview(db, EDITION);
    expect(overview.accounts.sessions).toBe(1);
    expect(overview.accounts.documents).toBe(1);
    expect(overview.accounts.imported).toBe(1);
    // 字节数（不是字符数）：这份 records 里全是 ASCII，两者相等，但断言的是「有值」这件事
    expect(overview.accounts.documentBytes).toBeGreaterThan(20);
    expect(JSON.stringify(overview)).not.toContain("别人的片单");
  });

  it("内容条数：讨论按 edition 收窄，反馈是全站的（它没有 edition 列）", async () => {
    const insertPost = (id: string, edition: string) =>
      sqlite
        .prepare(
          `INSERT INTO screening_post (id, edition, code, subject, display_name, category, body, created_at, updated_at)
           VALUES (?, ?, '008', 's1', 'n', 'chat', 'b', 1, 1)`,
        )
        .run(id, edition);
    insertPost("p1", EDITION);
    insertPost("p2", "biff-2027");
    sqlite
      .prepare(
        `INSERT INTO feedback_post (id, subject, display_name, body, created_at, updated_at)
         VALUES ('f1', 's1', 'n', 'b', 1, 1)`,
      )
      .run();

    const overview = await readOverview(db, EDITION);
    expect(overview.content).toEqual({ discussions: 1, feedback: 1 });
  });
});

describe("readContributionRows（通用明细 + 游标分页）", () => {
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

  it("红黑票：颜色进 sub，一人一票故 weight 恒 1；同一次上报的行共享一个时间戳", async () => {
    await replaceContributorVotes(db, EDITION, "c1", new Map([["cat:f001", "red"]]));
    await replaceContributorVotes(db, EDITION, `${"anon:"}hash`, new Map([["cat:f002", "black"]]));
    const page = await readContributionRows(db, { edition: EDITION, metric: "vote" });
    expect(page.rows).toEqual([
      {
        target: "cat:f002",
        sub: "black",
        contributor: "anon:hash",
        anonymous: true,
        weight: 1,
        hits: null,
        updatedAt: expect.any(Number),
      },
      {
        target: "cat:f001",
        sub: "red",
        contributor: "c1",
        anonymous: false,
        weight: 1,
        hits: null,
        updatedAt: expect.any(Number),
      },
    ]);
  });

  it("事件流水：hits 有值（只有它有意义），sub 是 kind", async () => {
    await applyContributorTelemetry(
      db,
      EDITION,
      "c1",
      0.75,
      new Map([["page|/redblack", { kind: "page", target: "/redblack", hits: 3 }]]),
    );
    const page = await readContributionRows(db, { edition: EDITION, metric: "telemetry" });
    expect(page.rows).toEqual([
      {
        target: "/redblack",
        sub: "page",
        contributor: "c1",
        anonymous: false,
        weight: 0.75,
        hits: 3,
        updatedAt: expect.any(Number),
      },
    ]);
  });

  it("抢票结果：sub 是四项结果之一", async () => {
    await replaceContributorTickets(db, EDITION, "c1", 1, new Map([["S001", "transfer"]]));
    const page = await readContributionRows(db, { edition: EDITION, metric: "ticket" });
    expect(page.rows[0]).toMatchObject({ target: "S001", sub: "transfer", weight: 1, hits: null });
  });

  it("q 只按目标名收窄（不是按贡献者）", async () => {
    await replaceContributorWants(db, EDITION, "c1", 1, ["cat:f001", "cat:f002"]);
    const page = await readContributionRows(db, { edition: EDITION, metric: "want", q: "f002" });
    expect(page.rows.map((row) => row.target)).toEqual(["cat:f002"]);
  });

  it("★ 分页不重不漏：同一毫秒的多条靠唯一键兜底（只带时间戳的游标会跳过或重复它们）", async () => {
    // 直接插行以拿到**可控且重复**的时间戳 —— 走 store 的话同一毫秒是天然结果，但不好精确构造
    const insert = (filmKey: string, at: number) =>
      sqlite
        .prepare(
          "INSERT INTO film_vote_contribution (edition, film_key, contributor, vote, updated_at) VALUES (?, ?, 'c1', 'red', ?)",
        )
        .run(EDITION, filmKey, at);
    insert("cat:f001", 3000);
    insert("cat:f002", 2000); // ← 同一毫秒两条
    insert("cat:f003", 2000);
    insert("cat:f004", 1000);
    insert("cat:f005", 500);

    const collected: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await readContributionRows(db, { edition: EDITION, metric: "vote", limit: 2, cursor });
      collected.push(...result.rows.map((row) => row.target));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(collected).toEqual(["cat:f001", "cat:f002", "cat:f003", "cat:f004", "cat:f005"]);
    expect(new Set(collected).size).toBe(5);
  });

  it("最后一页的 nextCursor 是 null（前端据此收手）", async () => {
    await replaceContributorWants(db, EDITION, "c1", 1, ["cat:f001"]);
    const page = await readContributionRows(db, { edition: EDITION, metric: "want", limit: 10 });
    expect(page.rows).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });
});
