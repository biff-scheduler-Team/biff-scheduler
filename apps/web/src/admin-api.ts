/**
 * 管理端接口的客户端（2026-09-23，PLAN-20260923142546，批 2）。
 *
 * ⚠ **这些形状目前只在 web 侧声明**：服务端对应 `apps/api/src/admin-read.ts` 与
 *   `stat-audit.ts`。两边一旦开始漂移，正确做法是上收到 `packages/contracts`（本轮刻意不动它 ——
 *   那个包正被另一个会话的前端改动牵动，撞车的代价大于收益）。这条欠账记在这里，别忘了。
 *
 * ⚠ 一律复用 `account-sync.ts::api()`：它带 `credentials: same-origin`、12s 超时，并把非 2xx
 *   抛成带 `status` 的 `ApiFailure`。这里**不写第二份 fetch 包装**。
 * ⚠ 刻意**不做逐字段白名单**（与 `film-votes.ts` 那套不同）：那些读者面向全体用户且写在缓存里，
 *   坏数据会长期留在本地；管理端每次都是现拉现渲染、读者是运维自己，逐字段校验的收益不抵代码量。
 *   渲染侧仍然按「字段可能缺」写（见 `AdminPage.tsx`）。
 */

import { api, ApiFailure } from "./account-sync";
import { EDITION } from "./edition";

export interface AdminMetricSummary {
  metric: string;
  rows: number;
  contributors: number;
  targets: number;
  total: number;
  today: number;
}

export interface AdminDrift {
  metric: string;
  key: string;
  contribution: number;
  stat: number;
}

export interface AdminAudit {
  edition: string;
  /** 每张贡献表扫到的行数（全 0 = 空库，不是「都对」） */
  scanned: Record<string, number>;
  drifts: AdminDrift[];
  ok: boolean;
}

export interface AdminOverview {
  edition: string;
  today: string;
  earliestDay: string | null;
  metrics: AdminMetricSummary[];
  audit: AdminAudit;
  accounts: { sessions: number; documents: number; documentBytes: number; imported: number };
  content: { discussions: number; feedback: number };
}

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
  metric: string;
  rows: AdminContributionRow[];
  nextCursor: string | null;
}

export interface AdminTrendPoint {
  day: string;
  weight: number;
  hits: number;
}

export interface AdminTrend {
  edition: string;
  metric: string;
  metrics: string[];
  fromDay: string;
  days: number;
  earliestDay: string | null;
  points: AdminTrendPoint[];
}

/** 「这个人能不能进管理端」。`guest` 与 `forbidden` 要给不同的提示语，所以分开。 */
export type AdminProbe = "admin" | "guest" | "forbidden";

/**
 * 探测当前登录身份的管理权限。
 *
 * ⚠ 前端**不抄一份白名单**来判断 —— 那既是第二份口径（改名单就漂），也把名单给了所有人。
 *   服务端的 403 就是「已登录但不是管理员」的权威答案。
 * ⚠ 网络错误/超时**照原样抛**：那是「暂时问不到」，不该被伪装成「你没权限」。
 */
export async function probeAdmin(): Promise<AdminProbe> {
  try {
    await api("/api/admin/whoami");
    return "admin";
  } catch (error) {
    if (error instanceof ApiFailure) return error.status === 401 ? "guest" : "forbidden";
    throw error;
  }
}

const q = (values: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams({ edition: EDITION });
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  return search.toString();
};

export async function loadAdminOverview(edition = EDITION): Promise<AdminOverview> {
  const response = await api(`/api/admin/overview?${q({ edition })}`);
  return (await response.json()) as AdminOverview;
}

export async function loadAdminRows(options: {
  metric: string;
  limit?: number;
  cursor?: string;
  query?: string;
}): Promise<AdminRowPage> {
  const response = await api(
    `/api/admin/rows?${q({ metric: options.metric, limit: options.limit, cursor: options.cursor, q: options.query })}`,
  );
  return (await response.json()) as AdminRowPage;
}

export async function loadAdminTrend(options: {
  metric: string;
  days?: number;
}): Promise<AdminTrend> {
  const response = await api(`/api/admin/trends?${q({ metric: options.metric, days: options.days })}`);
  return (await response.json()) as AdminTrend;
}
