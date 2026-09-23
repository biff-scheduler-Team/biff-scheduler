/**
 * 管理端页面的**纯逻辑**（2026-09-23，PLAN-20260923142546，批 2）。
 *
 * 为什么单独一个文件：页面本体（`pages/AdminPage.tsx`）import 期就会碰 DOM，
 * 跑在 node 环境的单测引不了它。把「口径」都放这里 —— tab 归一、指标名、趋势补零、字节格式化、
 * 对账结论一句话 —— 就能被单测钉住（这也是既有模块的通行做法，见 `redblack.ts` 文件头）。
 */

import type { AdminAudit, AdminTrendPoint } from "./admin-api";

/* ---------------- 视图切换 ---------------- */

/** 管理端的几个视图。**用 `?tab=` 而不是嵌套路由**：本轮刻意不动 `main.tsx` / `App.tsx`
 *  （那个会话正在高频改前端），所以接线只留一行路由 + 一条 fullPage 正则；
 *  视图切换走已有的 `useQuery()` 约定，URL 依然可分享可收藏。 */
export const ADMIN_TABS = ["overview", "rows", "trends", "content"] as const;

export type AdminTab = (typeof ADMIN_TABS)[number];

const TAB_LABELS: Record<AdminTab, string> = {
  overview: "概览",
  rows: "明细",
  trends: "趋势",
  content: "内容",
};

export function adminTabLabel(tab: AdminTab): string {
  return TAB_LABELS[tab];
}

/** URL 里的 `?tab=` → 合法视图。未知值一律落回概览（不是 `null`）：管理端不该因为
 *  一个手改的参数就渲染空白。 */
export function adminTabOf(raw: string | null | undefined): AdminTab {
  return (ADMIN_TABS as readonly string[]).includes(raw ?? "") ? (raw as AdminTab) : "overview";
}

export const ADMIN_ROWS_METRICS = ["want", "vote", "screening", "ticket", "telemetry"] as const;

/** URL 里的 `?metric=` → 合法指标（明细视图用）。未知/缺失落回 `vote`（有内容的概率最高）。 */
export function adminRowsMetricOf(raw: string | null | undefined): string {
  return (ADMIN_ROWS_METRICS as readonly string[]).includes(raw ?? "") ? (raw as string) : "vote";
}

/** 趋势视图的指标：既接受精确指标，也接受族的裸名（服务端会展开）。 */
export const ADMIN_TREND_CHOICES = [
  "want",
  "vote",
  "screening",
  "ticket",
  "telemetry",
  "vote:red",
  "vote:black",
] as const;

export function adminTrendMetricOf(raw: string | null | undefined): string {
  return (ADMIN_TREND_CHOICES as readonly string[]).includes(raw ?? "") ? (raw as string) : "vote";
}

/* ---------------- 文案 ---------------- */

const METRIC_LABELS: Record<string, string> = {
  want: "想看人数",
  screening: "同场人数",
  vote: "红黑榜",
  "vote:red": "红票",
  "vote:black": "黑票",
  ticket: "抢票结果",
  "ticket:got": "抢到",
  "ticket:transfer": "转票",
  "ticket:missed": "没抢到",
  "ticket:dropped": "放弃",
  telemetry: "页面 / 点击",
  "telemetry:page": "页面浏览",
  "telemetry:click": "点击",
};

/** 指标名 → 中文。**未知指标原样回**（宁可露出 `foo:bar` 也不要静默显示空白）。 */
export function metricLabel(metric: string): string {
  return METRIC_LABELS[metric] ?? metric;
}

/* ---------------- 趋势补零 ---------------- */

/** `YYYY-MM-DD` 往后一天。纯字符串运算（经 `Date.UTC`），不碰本地时区：
 *  这里只是在**枚举日期序列**，日界本身由服务端定（见 admin-api 拿到的 `fromDay`）。 */
export function nextDay(day: string): string {
  const at = Date.UTC(
    Number(day.slice(0, 4)),
    Number(day.slice(5, 7)) - 1,
    Number(day.slice(8, 10)),
  );
  return new Date(at + 86_400_000).toISOString().slice(0, 10);
}

/**
 * 把接口给的「有点的日子」铺满 `days` 天（缺的补 0）。
 *
 * ⚠ 补 0 是**展示层**的事：接口刻意不补（`readDailySeries` 的文件头写了理由 ——
 *   「那天没人用」与「用了但被撤光」在数据上不是一回事，SQL 里造日期表的代价也远大于这里一行）。
 * ⚠ 起点用服务端给的 `fromDay`，不用本地「今天」：手机时区与部署地不一致时，
 *   本地算出来的起点会与数据错开一天。
 */
export function fillTrendDays(
  points: readonly AdminTrendPoint[],
  fromDay: string,
  days: number,
): AdminTrendPoint[] {
  const byDay = new Map(points.map((point) => [point.day, point]));
  const out: AdminTrendPoint[] = [];
  let day = fromDay;
  for (let index = 0; index < days; index++) {
    const hit = byDay.get(day);
    out.push(hit ? { ...hit } : { day, weight: 0, hits: 0 });
    day = nextDay(day);
  }
  return out;
}

/* ---------------- 对账结论 ---------------- */

/** 对账体检的一句话结论。⚠ 空库（扫到 0 行）要说清是「没有数据」而不是「都对」 ——
 *  否则第一次部署时绿灯会被读成「数据一致」，而其实什么都没比。 */
export function auditHeadline(audit: AdminAudit | undefined): string {
  if (!audit) return "对账未运行";
  const scanned = Object.values(audit.scanned ?? {});
  if (!scanned.length || scanned.every((n) => n === 0)) return "对账：库是空的（没有可比的数据）";
  if (audit.ok) return `对账通过：${scanned.reduce((sum, n) => sum + n, 0)} 行贡献记录与聚合表一致`;
  return `对账发现 ${audit.drifts.length} 处一致性问题`;
}

/* ---------------- 格式化 ---------------- */

/** 字节数 → 人读。管理端只用于「同步文档体积」这类量级判断。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 时间戳 → 本地时间（管理端看「什么时候发生的」）。非法值给 `—` 而不是抛。 */
export function formatTime(ms: number): string {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { hour12: false });
}

/** 数字保留两位（权重和是 0.75 的整数倍，多余小数只可能是累加误差）。 */
export function formatWeight(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Math.round(value * 100) / 100);
}
