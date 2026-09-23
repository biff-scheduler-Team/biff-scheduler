/**
 * 管理端的读聚合（2026-09-23，PLAN-20260923142546，批 1）。
 *
 * 两件事：
 *   ① `readOverview` —— 一屏看全：五个统计模块的总量 / 去重人数 / 今日增量、对账结论、
 *      账号概况、内容条数；
 *   ② `readContributionRows` —— **通用的贡献行明细**：四张同形的贡献表 + 事件流水收成一条读路径，
 *      免得分页 / 筛选 / DTO 各写四五份（同口径两份 = 红线 5）。
 *
 * ⚠ `contributor` 原文**只有这里会回给浏览器**（与 `film-vote-store.ts::exposeVoteRows` 同级），
 *   门禁只能是 `/api/admin/*` 那两层。任何新增调用点先确认门禁。
 * ⚠ 账号概况**只回统计量**，绝不回片单内容（`festival_document.records`）—— 那是账号自己的东西。
 * ⚠ 这是**管理端低频**路径，所以用裸 SQL 换可读性（`COUNT(DISTINCT …)` 这类在 SQL 里最直白），
 *   并行的独立查询用 `Promise.all` 让往返重叠。它不在任何用户热路径上。
 */

import { sql } from "drizzle-orm";
import { database } from "./db";
import { kstDay } from "./day";
import { dailyMetricFamily, type DailyMetric } from "./stat-daily";
import { auditContributions, type StatAudit } from "./stat-audit";
import { parseCursor, cursorOf, parseLimit } from "./pagination";

type Db = ReturnType<typeof database>;

export const ADMIN_METRICS = ["want", "vote", "screening", "ticket", "telemetry"] as const;

export type AdminMetric = (typeof ADMIN_METRICS)[number];

export function isAdminMetric(value: unknown): value is AdminMetric {
  return typeof value === "string" && (ADMIN_METRICS as readonly string[]).includes(value);
}

/** 每个模块在日账本里对应哪些指标（有子类型的要加起来）。 */
const DAILY_METRICS_OF: Record<AdminMetric, readonly DailyMetric[]> = {
  want: ["want"],
  screening: ["screening"],
  vote: dailyMetricFamily("vote"),
  ticket: dailyMetricFamily("ticket"),
  telemetry: dailyMetricFamily("telemetry"),
};

/** 每张贡献表的「怎么数」——表名与列名来自这个闭合常量表，绝不来自请求参数。 */
interface RowSource {
  table: string;
  /** 目标列（片 / 场次 / 路由） */
  target: string;
  /** 子维度列（颜色 / 抢票结果 / 事件 kind），没有就 null */
  sub: string | null;
  /** 主值的 SQL 表达式 */
  value: string;
  /** 次数列的 SQL 表达式（只有事件流水有意义） */
  hits: string;
}

const ROW_SOURCES: Record<AdminMetric, RowSource> = {
  want: { table: "film_want_contribution", target: "film_key", sub: null, value: "CAST(weight AS REAL)", hits: "0" },
  // 一人一票，权重恒 1（不做加权，理由见 `film-vote-stats.ts`）
  vote: { table: "film_vote_contribution", target: "film_key", sub: "vote", value: "1", hits: "0" },
  screening: {
    table: "screening_attendance_contribution",
    target: "code",
    sub: null,
    value: "CAST(weight AS REAL)",
    hits: "0",
  },
  ticket: {
    table: "screening_ticket_contribution",
    target: "code",
    sub: "outcome",
    value: "CAST(weight AS REAL)",
    hits: "0",
  },
  telemetry: {
    table: "telemetry_contribution",
    target: "target",
    sub: "kind",
    value: "CAST(weight AS REAL)",
    hits: "hits",
  },
};

export interface AdminContributionRow {
  target: string;
  sub: string | null;
  contributor: string;
  anonymous: boolean;
  weight: number;
  hits: number | null;
  updatedAt: number;
}

export interface AdminRowPage {
  metric: AdminMetric;
  rows: AdminContributionRow[];
  /** 下一页的游标；null = 没有更多了 */
  nextCursor: string | null;
}

export const ADMIN_ROWS_MAX_LIMIT = 500;
export const ADMIN_ROWS_DEFAULT_LIMIT = 100;

/**
 * 通用贡献行明细。
 *
 * ⚠ 排序键是 `updated_at DESC, (contributor|target|sub) ASC`，**游标必须带上唯一键**：
 *   只用时间戳翻页时，同一毫秒的多条会被整批跳过或重复（与 `pagination.ts` 文件头同一条理由）。
 */
export async function readContributionRows(
  db: Db,
  options: { edition: string; metric: AdminMetric; limit?: number; cursor?: string; q?: string },
): Promise<AdminRowPage> {
  const source = ROW_SOURCES[options.metric];
  const limit = parseLimit(String(options.limit ?? ""), ADMIN_ROWS_DEFAULT_LIMIT, ADMIN_ROWS_MAX_LIMIT);
  const cursor = parseCursor(options.cursor);
  const keyword = (options.q ?? "").trim().slice(0, 64);
  // ⚠ 表名 / 列名全部来自上面的常量表（闭合），值一律走绑定参数
  const sub = source.sub ? sql.raw(source.sub) : sql`NULL`;
  const sortKey = source.sub
    ? sql`(${sql.raw(`contributor || '|' || ${source.target} || '|' || ${source.sub}`)})`
    : sql`(contributor || '|' || ${sql.raw(source.target)})`;
  // 多取一条用来判断「还有没有下一页」，比再发一次 COUNT 便宜
  const rows = await db.all<{
    target: string;
    sub: string | null;
    contributor: string;
    weight: number | null;
    hits: number | null;
    updated_at: number;
    sort_key: string;
  }>(sql`
    SELECT ${sql.raw(source.target)} AS target,
           ${sub} AS sub,
           contributor,
           ${sql.raw(source.value)} AS weight,
           ${sql.raw(source.hits)} AS hits,
           updated_at,
           ${sortKey} AS sort_key
    FROM ${sql.raw(source.table)}
    WHERE edition = ${options.edition}
      ${keyword ? sql`AND instr(${sql.raw(source.target)}, ${keyword}) > 0` : sql``}
      ${
        cursor
          ? sql`AND (updated_at < ${cursor.createdAt}
                     OR (updated_at = ${cursor.createdAt} AND ${sortKey} > ${cursor.id}))`
          : sql``
      }
    ORDER BY updated_at DESC, sort_key ASC
    LIMIT ${limit + 1}
  `);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    metric: options.metric,
    rows: page.map((row) => ({
      target: row.target,
      sub: row.sub,
      contributor: row.contributor,
      // 与各读路径同一道判据：`anon:` 前缀即匿名身份
      anonymous: row.contributor.startsWith("anon:"),
      weight: Number(row.weight) || 0,
      hits: source.hits === "0" ? null : Number(row.hits) || 0,
      updatedAt: row.updated_at,
    })),
    nextCursor: rows.length > limit && last ? cursorOf(last.updated_at, last.sort_key) : null,
  };
}

export interface AdminMetricSummary {
  metric: AdminMetric;
  /** 贡献行数 */
  rows: number;
  /** 去重贡献者数（真实的「多少人参与」） */
  contributors: number;
  /** 涉及的目标数（片 / 场次 / 页面） */
  targets: number;
  /** 累计值：加权和，或票数 */
  total: number;
  /** 今日增量（来自日账本；`stat_daily` 里没有今天就记 0） */
  today: number;
}

export interface AdminOverview {
  edition: string;
  /** 服务端算的 KST 日界（前端不要自己算） */
  today: string;
  /** 趋势从哪天开始（历史不回填，所以这通常就是上线那天） */
  earliestDay: string | null;
  metrics: AdminMetricSummary[];
  audit: StatAudit;
  accounts: { sessions: number; documents: number; documentBytes: number; imported: number };
  content: { discussions: number; feedback: number };
}

/** 一屏概览。⚠ 只回统计量：账号那块**没有任何片单内容**。 */
export async function readOverview(db: Db, edition: string): Promise<AdminOverview> {
  const today = kstDay(Date.now());

  /** 每个模块的贡献侧统计（行数 / 去重人数 / 目标数 / 总量）。 */
  const summaryQuery = (source: RowSource) =>
    db.get<{ rows: number; contributors: number; targets: number; total: number | null }>(sql`
      SELECT COUNT(*) AS rows,
             COUNT(DISTINCT contributor) AS contributors,
             COUNT(DISTINCT ${sql.raw(source.target)}) AS targets,
             COALESCE(SUM(${sql.raw(source.value)}), 0) AS total
      FROM ${sql.raw(source.table)}
      WHERE edition = ${edition}
    `);

  const [
    want,
    vote,
    screening,
    ticket,
    telemetry,
    daily,
    earliest,
    sessions,
    documents,
    documentBytes,
    imported,
    discussions,
    feedback,
    audit,
  ] = await Promise.all([
    summaryQuery(ROW_SOURCES.want),
    summaryQuery(ROW_SOURCES.vote),
    summaryQuery(ROW_SOURCES.screening),
    summaryQuery(ROW_SOURCES.ticket),
    summaryQuery(ROW_SOURCES.telemetry),
    db.all<{ metric: string; total: number | null }>(sql`
      SELECT metric, SUM(CAST(weight_sum AS REAL)) AS total
      FROM stat_daily WHERE edition = ${edition} AND day = ${today} GROUP BY metric
    `),
    db.get<{ day: string | null }>(sql`
      SELECT min(day) AS day FROM stat_daily WHERE edition = ${edition}
    `),
    db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM app_session`),
    db.get<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM festival_document WHERE edition = ${edition}
    `),
    // 体积按**字节**算：SQlite 的 LENGTH(TEXT) 数字符，先 CAST 成 BLOB 才是字节
    db.get<{ n: number | null }>(sql`
      SELECT COALESCE(SUM(LENGTH(CAST(records AS BLOB))), 0) AS n
      FROM festival_document WHERE edition = ${edition}
    `),
    db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM account_import`),
    db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM screening_post WHERE edition = ${edition}`),
    // ⚠ 反馈表没有 edition 列（全站一份），所以不按 edition 过滤
    db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM feedback_post`),
    auditContributions(db, edition),
  ]);

  const todayByMetric = new Map<string, number>();
  for (const row of daily) todayByMetric.set(row.metric, Number(row.total) || 0);
  const todayOf = (metric: AdminMetric) =>
    Math.round(DAILY_METRICS_OF[metric].reduce((sum, key) => sum + (todayByMetric.get(key) ?? 0), 0) * 100) / 100;

  const summary = (metric: AdminMetric, row: typeof want): AdminMetricSummary => ({
    metric,
    rows: Number(row?.rows) || 0,
    contributors: Number(row?.contributors) || 0,
    targets: Number(row?.targets) || 0,
    total: Math.round((Number(row?.total) || 0) * 100) / 100,
    today: todayOf(metric),
  });

  return {
    edition,
    today,
    earliestDay: earliest?.day ?? null,
    metrics: [
      summary("want", want),
      summary("vote", vote),
      summary("screening", screening),
      summary("ticket", ticket),
      summary("telemetry", telemetry),
    ],
    audit,
    accounts: {
      sessions: Number(sessions?.n) || 0,
      documents: Number(documents?.n) || 0,
      documentBytes: Number(documentBytes?.n) || 0,
      imported: Number(imported?.n) || 0,
    },
    content: {
      discussions: Number(discussions?.n) || 0,
      feedback: Number(feedback?.n) || 0,
    },
  };
}
