/**
 * 聚合表对账（2026-09-23，PLAN-20260923142546，批 1）。
 *
 * 由来：五套统计都是「贡献表（真值来源）+ 预聚合表（读侧只看它）」。预聚合表一旦与贡献表
 * 不一致，**读侧永远看不出来** —— 榜单照常显示、只是数字是错的。前几轮已经踩过两次
 * （「读出来在 JS 里加减再写回」在并发下丢更新、且永不自愈，见 `stat-batch.ts` 文件头）。
 * 这个对账就是给管理员看那次事故有没有留下疤：把贡献表现算一遍，与聚合表逐项比。
 *
 * ⚠ 它是**只读**的：只报告差异，不修。修法是重算聚合（那是写路径的事，不该由一个体检接口顺手做，
 *   否则「谁在什么时候把数字改回去了」就没人知道）。
 * ⚠ 比较用的是**四舍五入到 2 位**后的相等：权重是 0.75 的整数倍、票数是整数，
 *   两位小数之外只可能是累加误差，拿它当差异会淹掉真差异。
 */

import { sql } from "drizzle-orm";
import { database } from "./db";

type Db = ReturnType<typeof database>;

/** 一处不一致。`contribution` 是**现算**出来的（真值），`stat` 是聚合表里存着的。 */
export interface StatDrift {
  metric: string;
  /** 目标 + 维度（如 `cat:f001|red`、`S001|got`、`page|/redblack|hits`） */
  key: string;
  contribution: number;
  stat: number;
}

export interface StatAudit {
  edition: string;
  /** 每张贡献表扫到的行数 —— 让人知道这次体检到底看了多少东西（全 0 = 库是空的，不是「都对」） */
  scanned: Record<string, number>;
  drifts: StatDrift[];
  ok: boolean;
}

/** 到 2 位小数后相等（见文件头：两位之外只可能是累加误差）。 */
function same(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100);
}

function add(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

/** 逐项比两个 map：只在「有一侧非 0」时判（两侧都 0 = 都没有，不算差异）。 */
function diff(metric: string, contributions: Map<string, number>, stats: Map<string, number>): StatDrift[] {
  const out: StatDrift[] = [];
  for (const key of new Set([...contributions.keys(), ...stats.keys()])) {
    const contribution = contributions.get(key) ?? 0;
    const stat = stats.get(key) ?? 0;
    if (same(contribution, stat)) continue;
    if (contribution === 0 && stat === 0) continue;
    out.push({ metric, key, contribution, stat });
  }
  return out;
}

export async function auditContributions(db: Db, edition: string): Promise<StatAudit> {
  const scanned: Record<string, number> = {};
  const drifts: StatDrift[] = [];

  /* 想看：贡献表的 weight 之和 vs film_want_stat.weight_sum */
  {
    const rows = await db.all<{ key: string; total: number | null }>(sql`
      SELECT film_key AS key, SUM(CAST(weight AS REAL)) AS total
      FROM film_want_contribution WHERE edition = ${edition} GROUP BY film_key
    `);
    const stats = await db.all<{ key: string; total: number | null }>(sql`
      SELECT film_key AS key, CAST(weight_sum AS REAL) AS total
      FROM film_want_stat WHERE edition = ${edition}
    `);
    scanned.film_want_contribution = rows.length;
    const a = new Map<string, number>();
    for (const row of rows) add(a, row.key, Number(row.total) || 0);
    const b = new Map<string, number>();
    for (const row of stats) add(b, row.key, Number(row.total) || 0);
    drifts.push(...diff("want", a, b));
  }

  /* 红黑榜：贡献表按 (片, 颜色) 计数 vs film_vote_stat 的两列 */
  {
    const rows = await db.all<{ film_key: string; vote: string; n: number }>(sql`
      SELECT film_key, vote, COUNT(*) AS n
      FROM film_vote_contribution WHERE edition = ${edition} GROUP BY film_key, vote
    `);
    const stats = await db.all<{ film_key: string; red_count: number; black_count: number }>(sql`
      SELECT film_key, red_count, black_count FROM film_vote_stat WHERE edition = ${edition}
    `);
    scanned.film_vote_contribution = rows.length;
    const a = new Map<string, number>();
    // ⚠ 白名单外的 vote 值不参与比对：它没有对应的聚合列，硬算只会造出一个假差异
    for (const row of rows) if (row.vote === "red" || row.vote === "black") add(a, `${row.film_key}|${row.vote}`, row.n);
    const b = new Map<string, number>();
    for (const row of stats) {
      add(b, `${row.film_key}|red`, Number(row.red_count) || 0);
      add(b, `${row.film_key}|black`, Number(row.black_count) || 0);
    }
    drifts.push(...diff("vote", a, b));
  }

  /* 同场人数：贡献表 weight 之和 vs screening_attendance_stat.weight_sum */
  {
    const rows = await db.all<{ key: string; total: number | null }>(sql`
      SELECT code AS key, SUM(CAST(weight AS REAL)) AS total
      FROM screening_attendance_contribution WHERE edition = ${edition} GROUP BY code
    `);
    const stats = await db.all<{ key: string; total: number | null }>(sql`
      SELECT code AS key, CAST(weight_sum AS REAL) AS total
      FROM screening_attendance_stat WHERE edition = ${edition}
    `);
    scanned.screening_attendance_contribution = rows.length;
    const a = new Map<string, number>();
    for (const row of rows) add(a, row.key, Number(row.total) || 0);
    const b = new Map<string, number>();
    for (const row of stats) add(b, row.key, Number(row.total) || 0);
    drifts.push(...diff("screening", a, b));
  }

  /* 抢票结果：贡献表按 (场次, 结果) 的 weight 之和 vs 聚合表对应那一列 */
  {
    const rows = await db.all<{ code: string; outcome: string; total: number | null }>(sql`
      SELECT code, outcome, SUM(CAST(weight AS REAL)) AS total
      FROM screening_ticket_contribution WHERE edition = ${edition} GROUP BY code, outcome
    `);
    const stats = await db.all<{
      code: string;
      got_sum: string;
      transfer_sum: string;
      missed_sum: string;
      dropped_sum: string;
    }>(sql`
      SELECT code, got_sum, transfer_sum, missed_sum, dropped_sum
      FROM screening_ticket_stat WHERE edition = ${edition}
    `);
    scanned.screening_ticket_contribution = rows.length;
    const columns: Record<string, keyof (typeof stats)[number]> = {
      got: "got_sum",
      transfer: "transfer_sum",
      missed: "missed_sum",
      dropped: "dropped_sum",
    };
    const a = new Map<string, number>();
    for (const row of rows) {
      // 同上：未知结果没有对应列，不参与比对
      if (!(row.outcome in columns)) continue;
      add(a, `${row.code}|${row.outcome}`, Number(row.total) || 0);
    }
    const b = new Map<string, number>();
    for (const row of stats) {
      for (const [outcome, column] of Object.entries(columns)) {
        add(b, `${row.code}|${outcome}`, Number(row[column]) || 0);
      }
    }
    drifts.push(...diff("ticket", a, b));
  }

  /* 事件流水：贡献表算「多少人用过」与「用了多少次」两个和 vs telemetry_stat 的两列 */
  {
    const rows = await db.all<{
      kind: string;
      target: string;
      viewers: number | null;
      hits: number | null;
    }>(sql`
      SELECT kind, target,
             SUM(CAST(weight AS REAL)) AS viewers,
             SUM(CAST(weight AS REAL) * hits) AS hits
      FROM telemetry_contribution WHERE edition = ${edition} GROUP BY kind, target
    `);
    const stats = await db.all<{
      kind: string;
      target: string;
      viewer_weight_sum: string;
      hits_weight_sum: string;
    }>(sql`
      SELECT kind, target, viewer_weight_sum, hits_weight_sum
      FROM telemetry_stat WHERE edition = ${edition}
    `);
    scanned.telemetry_contribution = rows.length;
    // ⚠ 分隔符 `|`：页面 target 的白名单是 `^[a-z0-9\-/:*]+$`、点入口是 slug，都不含它
    const a = new Map<string, number>();
    for (const row of rows) {
      add(a, `${row.kind}|${row.target}|viewers`, Number(row.viewers) || 0);
      add(a, `${row.kind}|${row.target}|hits`, Number(row.hits) || 0);
    }
    const b = new Map<string, number>();
    for (const row of stats) {
      add(b, `${row.kind}|${row.target}|viewers`, Number(row.viewer_weight_sum) || 0);
      add(b, `${row.kind}|${row.target}|hits`, Number(row.hits_weight_sum) || 0);
    }
    drifts.push(...diff("telemetry", a, b));
  }

  return { edition, scanned, drifts, ok: drifts.length === 0 };
}
