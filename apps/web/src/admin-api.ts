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
    if (error instanceof ApiFailure) {
      if (error.status === 401) return "guest";
      if (error.status === 403) return "forbidden";
      // ⚠ 5xx / 其它状态**必须原样抛**:只有 403 才叫「你不是管理员」。
      //   原先写成「非 401 一律 forbidden」,于是服务端一挂(500)页面就说「你的账号不在名单里,
      //   去切换账号吧」—— 这是把运维问题伪装成权限问题,正是「暂时问不到」那一态要防的事。
      throw error;
    }
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

/* ---------------- 贴纸（红黑榜投票行）的读 / 删 ----------------
 * ⚠ 这是全站**唯一**会回 `contributor` 原文的接口：门禁在服务端的两层（`/api/admin/*` 的
 *   `requireIdentity` + 名单），前端不抄名单（见 `probeAdmin` 的说明）。
 * ⚠ 删不掉 ≠ 参数写错：服务端在未命中时回 **404 `NOT_FOUND`**（刻意不静默成功），
 *   前端必须把这两种情况分开显示（见 `AdminStickersView`）。 */

export interface AdminVoteRow {
  filmKey: string;
  vote: "red" | "black";
  contributor: string;
  anonymous: boolean;
  updatedAt: number;
}

export async function loadAdminVoteRows(): Promise<{ rows: AdminVoteRow[]; truncated: boolean }> {
  const response = await api(`/api/admin/film-vote-contributions?${q({ edition: EDITION })}`);
  const body = (await response.json()) as { rows?: AdminVoteRow[]; truncated?: boolean };
  return { rows: body.rows ?? [], truncated: body.truncated === true };
}

/**
 * 删掉一枚贴纸（**精确到「谁贴的 + 哪部片」**）。
 *
 * ⚠ 用户与手机版的手势都做不到这件事：贴纸的撤销是「整份 board 替换」（本地 board 里没有那枚
 *   就减回去），所以服务端上别人贴的、或本机 cookie 已经丢了的匿名票**永远撤不掉** ——
 *   这个接口就是那种「死贴纸」的唯一出口（PLAN-20260923124402 那条欠账的收尾）。
 * ⚠ `edition` 必须带上：少了它服务端按默认届次删，会删错届次的同一行。
 */
export async function deleteAdminVote(row: {
  contributor: string;
  filmKey: string;
}): Promise<void> {
  await api(
    `/api/admin/film-vote-contributions?${q({
      edition: EDITION,
      contributor: row.contributor,
      filmKey: row.filmKey,
    })}`,
    { method: "DELETE" },
  );
}

/* ---------------- 内容视图（**复用公开接口**，不另造管理端副本） ----------------
 * 这两个接口本来就带作者、反应、游标分页，而且**已经**回 `subject` 与 `displayName`（公开内容）。
 * 再造一份「管理端版本」= 同一口径两份实现，且从此多一处要与公开口径同步的地方。
 * ⚠ 唯一的差别是管理端**不需要**「发布 / 点赞」那几条写路径 —— 这里只做只读列表。 */

export interface AdminContentPost {
  id: string;
  /** 讨论帖才有（场次 code） */
  code?: string;
  subject: string;
  displayName: string;
  category?: string;
  body: string;
  createdAt: number;
  reactionCounts: Record<string, number>;
  myReactions: string[];
}

export async function loadAdminContent(options: {
  kind: "discussion" | "feedback";
  limit?: number;
}): Promise<AdminContentPost[]> {
  // ⚠ 讨论列表要带 edition（它按届次收窄）；反馈没有 edition 维度（全站一份）
  const path =
    options.kind === "discussion"
      ? `/api/discussions?${q({ limit: options.limit })}`
      : `/api/feedback?${q({ limit: options.limit })}`;
  const response = await api(path);
  const body = (await response.json()) as { posts?: AdminContentPost[] };
  return body.posts ?? [];
}
