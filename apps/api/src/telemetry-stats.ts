/**
 * 事件流水的服务端口径（2026-09-20，第 3 轮，PLAN-20260920203010 修订 2）。
 *
 * ★ 这一层是**隐私边界本身**，不是格式校验：
 *   本轮的两条用户决定（「默认直接上报、不加提示」+「搜索完全不进统计」）意味着
 *   采集端会不经询问地发数据上来。既然没有「不追踪」开关兜底，就必须在**服务端**
 *   把可接受的取值收死 —— 于是：
 *
 *   · `kind` 只有 `page` / `click` 两类，**没有 search**（搜索维度不是「暂时不做」，
 *     而是本轮明确排除：不记就是不记，不留一条以后会被顺手打开的通道）；
 *   · `page` 收**路径形状**、`click` 收**共享契约里的固定 slug**。
 *     这两条才是真正的闸门：即使客户端被改坏、或被别人伪造请求，
 *     **自由文本（搜索词、片名、人名、备注）也灌不进统计表** —— 它们既不是路径形状，
 *     也不在任何 slug 白名单里。
 *
 * ⚠ 纯逻辑，import 期不碰 DOM / 数据库 —— node 直接可测。
 */

/** kind / slug 白名单与长度上限都来自 `@biff/contracts/telemetry`（前后端同一份）——
 *  这份文件只补**服务端特有的那两条**：路径形状、以及页面路径的归一化。
 *  ⚠ 这两个名字既要 re-export（给 index.ts 用）又要在本文件里用，故 import 与 export 各写一次。 */
import {
  MAX_HITS_PER_TARGET,
  MAX_TELEMETRY_ENTRIES_PER_PING,
  TELEMETRY_TARGET_MAX_LENGTH,
  isClickTargetSlug,
  isTelemetryKind,
  type TelemetryKind,
} from "@biff/contracts/telemetry";

export {
  MAX_HITS_PER_TARGET,
  MAX_TELEMETRY_ENTRIES_PER_PING,
  TELEMETRY_KINDS,
  TELEMETRY_TARGET_MAX_LENGTH,
  isClickTargetSlug,
  isTelemetryKind,
} from "@biff/contracts/telemetry";
export type { TelemetryKind } from "@biff/contracts/telemetry";

/** **页面路径**的形状白名单 —— 见文件头，这是隐私边界。
 *  ⚠ 与 click 的 slug 白名单是两件事：click 必须是固定 slug（共享契约里那份），
 *    page 必须是**以 `/` 开头的路径**（不要求开头就等于把 `schedule` 这种裸词也放进来，
 *    那正是自由文本能钻的缝）。两者都不接受自由文本。 */
const PAGE_PATTERN = /^\/[a-z0-9\-/:]*$/;

/** 一条待落库的增量。 */
export interface TelemetryDelta {
  kind: TelemetryKind;
  target: string;
  hits: number;
}

/** **入站**页面路径的形状 + 长度是否可接受（归一化**之前**的原始值，故不含 `*`）。 */
export function isPageTarget(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= TELEMETRY_TARGET_MAX_LENGTH &&
    PAGE_PATTERN.test(value)
  );
}

/** **存储态** target 是否可信（读表 / 删行时用）。
 *
 *  ⚠ 必须有这一个，不能拿 `isPageTarget` 兼任：归一化会把 id 段写成 `*`
 *    （`/films/f001` → `/films/*`），而 `isPageTarget` 的入站正则不含 `*` ——
 *    用它校验读出来的行，会让**「影片资料」这一整行被静默丢掉**（本轮实测踩到）。
 *    这是「入站形状」与「存储形状」必须分开的两个契约。 */
export function isNormalizedTarget(kind: TelemetryKind, target: unknown): target is string {
  if (typeof target !== "string" || target.length === 0 || target.length > TELEMETRY_TARGET_MAX_LENGTH) {
    return false;
  }
  if (kind === "click") return isClickTargetSlug(target);
  return /^[a-z0-9\-/:*]+$/.test(target);
}

/** 路由路径 → 归一化 target。
 *
 *  ★ 为什么必须归一化：`/films/f001` 这类带 id 的路径**每条都是一次新的 target**，
 *    榜单会被几百个长尾键淹掉，而且影片 id 本身也不是「页面」这个维度的粒度。
 *    归一规则：只保留**前两段**，第二段若像 id（纯数字 / 带字母数字混排的短码）则替换为 `*`。
 *  ⚠ 归一化放在服务端（这里）而不是客户端：客户端可以少写一行，服务端**必须**收得住，
 *    否则「收口只有一处」就变成了「收到什么算什么」。
 */
export function normalizePath(path: string): string | null {
  if (typeof path !== "string") return null;
  const trimmed = path.trim();
  if (!trimmed.startsWith("/")) return null;
  // 去掉查询串与哈希（查询串里可能带 `?q=搜索词` —— **在这里被丢掉，永远不上行**）
  const clean = trimmed.split("?")[0].split("#")[0];
  const parts = clean.split("/").filter((part) => part.length > 0);
  if (parts.length === 0) return "/";
  const head = parts[0].toLowerCase();
  if (!/^[a-z0-9\-]+$/.test(head)) return null;
  if (parts.length === 1) return `/${head}`;
  const second = parts[1].toLowerCase();
  // 第二段看起来像 id（含数字）→ 折叠成 `*`，避免「每部片一个键」
  const segment = /^[a-z0-9\-]*\d[a-z0-9\-]*$/.test(second) ? "*" : second;
  if (!/^[a-z0-9\-*]+$/.test(segment)) return null;
  return `/${head}/${segment}`;
}

/**
 * 上报条目 → 待落库增量（`kind|target` → hits）。
 *
 * ★ 同一 (kind, target) 出现多次**累加**而不是「以最后一条为准」——
 *   这正与其它 ping 相反（那边是整份状态，重发就该覆盖）。计数型数据重发必须累加，
 *   因为客户端只发增量：「打开这一页 3 次」和「打开 1 次」是两条不同的信息。
 * ★ 非法条目**静默丢弃**（与其他 ping 同一条原则：宁少勿错）。
 * ★ **累加之后还要对总量封顶**（2026-09-23，PLAN-20260923111748，B2）：`hits` 的单条上限只挡得住
 *   「一条报十万次」，挡不住「200 条同 key 各报 100 次」—— 那是一次请求灌 20000 次的伪造特征，
 *   正是这个上限想防的东西。故最终值钳到 `MAX_HITS_PER_TARGET`。
 */
export function normalizeTelemetryEntries(input: Iterable<unknown>): Map<string, TelemetryDelta> {
  const out = new Map<string, TelemetryDelta>();
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const { kind, target, hits } = item as { kind?: unknown; target?: unknown; hits?: unknown };
    if (!isTelemetryKind(kind)) continue;
    // page 收**原始路径**（客户端只发 `location.pathname`，就带不上查询串了），
    //   这里再过一遍 `normalizePath` 折叠 id 段；click 收共享契约里的**固定 slug**。
    // ⚠ 两条路都不能绕过各自的白名单 —— 这是「自由文本进不来」的唯一闸门。
    const normalized =
      kind === "page"
        ? typeof target === "string" && isPageTarget(target.split("?")[0])
          ? normalizePath(target)
          : null
        : isClickTargetSlug(target)
          ? target
          : null;
    if (!normalized) continue;
    const raw = Math.floor(Number(hits));
    if (!Number.isFinite(raw) || raw <= 0) continue;
    const count = Math.min(raw, MAX_HITS_PER_TARGET);
    const key = `${kind}|${normalized}`;
    const existing = out.get(key);
    if (existing) existing.hits = Math.min(existing.hits + count, MAX_HITS_PER_TARGET);
    else out.set(key, { kind, target: normalized, hits: count });
    if (out.size >= MAX_TELEMETRY_ENTRIES_PER_PING) break;
  }
  return out;
}

/** 一位贡献者某个 (kind, target) 的**已有**状态（不存在 → `null`）。 */
export interface ContributionSnapshot {
  hits: number;
  weight: number;
}

/** 落库前要算的三个数。 */
export interface TelemetryDeltaPlan {
  /** 累加后的总次数 */
  nextHits: number;
  /** 聚合表「多少人用过」的增量 */
  viewerDelta: number;
  /** 聚合表「总共用了多少次」的增量 */
  hitsDelta: number;
}

/**
 * 计数型的增量落库计划（**纯函数**，2026-09-20 第 3 轮）。
 *
 * ★ 为什么要抽出来：这段算术有三个分支（首次出现 / 累加 / **权重变化**），
 *   而「权重变化」只有「同一浏览器先匿名上报、再登录上报」这一条路径能触发 ——
 *   它需要真实会话，store 级测试跑不到。抽成纯函数后这一段就能被单测钉住。
 *
 * ★ 目标值：`viewers += 新权重 − 旧权重`、`hits += 新权重 × 新次数 − 旧权重 × 旧次数`。
 *   ⚠ 差值里的历史部分必须用**旧次数**：用新次数会把这次增量乘两遍
 *     （本轮实现时确实写错过一次，正是靠这条口径抓回来的）。
 */
export function planTelemetryDelta(
  old: ContributionSnapshot | null,
  incomingHits: number,
  weight: number,
): TelemetryDeltaPlan {
  const oldHits = Math.max(0, old?.hits ?? 0);
  const oldWeight = Math.max(0, old?.weight ?? 0);
  const nextHits = Math.max(0, oldHits + incomingHits);
  return {
    nextHits,
    viewerDelta: weight - oldWeight,
    hitsDelta: weight * nextHits - oldWeight * oldHits,
  };
}

/** 加权和 → 「人 / 次」（与其它 stats 同口径：先四舍五入再展示）。 */
export function roundCount(raw: unknown): number {
  const n = Math.round(Number(raw) || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** `telemetry_stat` 的一行 → 对外形状。两个数字的语义见 schema.ts。 */
export interface TelemetryTargetCount {
  /** 多少人用过（去重后加权） */
  viewers: number;
  /** 总共用了多少次（加权） */
  hits: number;
}

/** 每类的榜单（按 hits 降序）。 */
export type TelemetryCounts = Partial<Record<TelemetryKind, Record<string, TelemetryTargetCount>>>;

/** 空统计（读不到任何行时）—— 调用方据此走空态，而不是拿到 `undefined`。 */
export const EMPTY_TELEMETRY_COUNTS: TelemetryCounts = {};
