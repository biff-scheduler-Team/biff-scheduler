/**
 * 事件流水：页面浏览 / 点击的采集与读取
 * （2026-09-20，第 3 轮，PLAN-20260920203010 修订 2）。
 *
 * ★ 用户对这两条口径的明确决定（**本轮不再加开关、不加提示**）：
 *   ① 「直接上报，不需要提示」→ 默认采集，没有 consent UI、没有「不追踪」开关；
 *   ② 「搜索完全不进统计」→ 本模块**只发 `location.pathname`**（不带 `?q=…`），
 *      也不存在任何搜索事件 —— 「不发」比「发了再丢」干净。
 *
 * ★ 为什么只发 pathname：查询串是搜索词唯一的载体，`location.pathname` 天然不含它。
 *   服务端还有一层形状白名单（`telemetry-stats.ts`）兜底，但**能在客户端不发就不发**。
 *
 * ★ 增量而不是状态：本模块攒的是「这一批看到了几次」，服务端累加（见 api 侧 store）。
 *   所以没有「整份重发即自愈」这条性质 —— 这也是本模块与其它四个 store 唯一的设计差异。
 *
 * ⚠ 接口没上线时**必须照常可用**：读失败 → 榜单空态；写失败 → 静默丢弃（不重试队列、
 *   不落盘）。落盘会新增 localStorage 键，而数据契约只允许 `biff.*` 键**只增不改**且本轮
 *   不需要持久化 —— 少一个键就少一处隐私面。
 */

import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import {
  CLICK_TARGET_SLUGS,
  MAX_TELEMETRY_ENTRIES_PER_PING,
  TELEMETRY_KINDS,
  isClickTargetSlug,
  type TelemetryKind,
} from "@biff/contracts/telemetry";
import { EDITION } from "./edition";

/** 白名单 / 上限全部来自 `@biff/contracts/telemetry` —— **前后端同一份**：
 *  客户端用它过滤 DOM 上的 `data-track`（手写的，写错宁可不发），服务端用它挡伪造请求。 */
export { TELEMETRY_KINDS } from "@biff/contracts/telemetry";
export type { TelemetryKind } from "@biff/contracts/telemetry";
export const CLICK_TARGETS = CLICK_TARGET_SLUGS;

export interface TelemetryTargetCount {
  /** 多少人用过（去重） */
  viewers: number;
  /** 总共用了多少次 */
  hits: number;
}

export type TelemetryCounts = Partial<Record<TelemetryKind, Record<string, TelemetryTargetCount>>>;

export { MAX_TELEMETRY_ENTRIES_PER_PING };

/** 防抖窗口：与 want / screening / ticket 三处一致（一次导航 + 若干点击合成一批）。 */
const FLUSH_DELAY_MS = 1200;

let cache: TelemetryCounts | null = null;
let loading: Promise<TelemetryCounts> | null = null;
// ⚠ `ReturnType<typeof setTimeout>` 而不是 `number`：本模块会被 node 环境的单测 import
let flushTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

/** 待发送的增量：`kind|target` → 条目（**同一 target 累加次数**）。 */
const pending = new Map<string, { kind: TelemetryKind; target: string; hits: number }>();

export function onTelemetryCountsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** 已缓存的事件计数（同步读，未加载过则为空表）。 */
export function peekTelemetryCounts(): TelemetryCounts {
  return cache ?? {};
}

/** 读取端白名单：与 `ticket-stats.ts::parseTicketCounts` 同一条原则 ——
 *  客户端缓存不能假设上游永远正确（旧 API、代理改写、半截响应）。 */
export function parseTelemetryCounts(raw: unknown): TelemetryCounts {
  const out: TelemetryCounts = {};
  if (!raw || typeof raw !== "object") return out;
  for (const kind of TELEMETRY_KINDS) {
    const bucket = (raw as Record<string, unknown>)[kind];
    if (!bucket || typeof bucket !== "object") continue;
    const rows: Record<string, TelemetryTargetCount> = {};
    for (const [target, value] of Object.entries(bucket as Record<string, unknown>)) {
      if (!target || !value || typeof value !== "object") continue;
      const row = value as { viewers?: unknown; hits?: unknown };
      const viewers = whole(row.viewers);
      const hits = whole(row.hits);
      if (viewers <= 0 && hits <= 0) continue;
      rows[target] = { viewers, hits };
    }
    if (Object.keys(rows).length > 0) out[kind] = rows;
  }
  return out;
}

function whole(raw: unknown): number {
  const n = Math.round(Number(raw) || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function loadTelemetryCounts(force = false): Promise<TelemetryCounts> {
  if (cache && !force) return cache;
  if (loading && !force) return loading;
  loading = (async () => {
    try {
      const response = await fetch(`/api/stats/telemetry-counts?edition=${EDITION}`, {
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) return cache ?? {};
      const body = (await response.json()) as { counts?: unknown };
      cache = parseTelemetryCounts(body.counts);
      emit();
      return cache;
    } catch {
      return cache ?? {};
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/* ---------------- 采集 ---------------- */

/** 剥掉查询串与哈希。
 *
 *  ⚠ **这里必须做，不能只靠服务端**：服务端也会剥（`telemetry-stats.ts::normalizePath`），
 *    但那已经是「数据出过一次浏览器」之后了 —— 本轮用户明确「搜索完全不进统计」，
 *    最干净的做法是**搜索词根本不上行**。两道一起做：客户端不发，服务端也收不住。
 *  ⚠ 调用方应当直接给 `location.pathname`；这里剥一层是防御，不是主要机制。 */
function pathOnly(pathname: string): string {
  return pathname.split("?")[0].split("#")[0];
}

/** 记一次页面浏览。`pathname` 必须来自 `location.pathname`（查询串会被这里再剥一次）。 */
export function trackPageView(pathname: string): void {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return;
  const clean = pathOnly(pathname);
  if (!clean.startsWith("/")) return;
  bump("page", clean);
}

/** 记一次入口点击。`target` 不在白名单里**直接丢弃**（DOM 上的 `data-track` 是手写的）。 */
export function trackClick(target: string): void {
  if (!isClickTargetSlug(target)) return;
  bump("click", target);
}

function bump(kind: TelemetryKind, target: string): void {
  const key = `${kind}|${target}`;
  const existing = pending.get(key);
  if (existing) existing.hits += 1;
  else if (pending.size < MAX_TELEMETRY_ENTRIES_PER_PING) pending.set(key, { kind, target, hits: 1 });
  schedule();
}

function schedule(): void {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flushTelemetry(), FLUSH_DELAY_MS);
}

/** 立即把待发增量发出去。**导出是为了测试与导航卸载时可确定地触发**。 */
export async function flushTelemetry(): Promise<void> {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  if (pending.size === 0) return;
  const events = [...pending.values()];
  pending.clear();
  try {
    const response = await fetch("/api/stats/telemetry-ping", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edition: EDITION, events }),
      signal: AbortSignal.timeout(12_000),
    });
    if (response.ok) await loadTelemetryCounts(true);
  } catch {
    /* 接口未部署 / 断网：丢掉这一批即可（不做重试队列 —— 见文件头） */
  }
}

/** 丢弃待发增量（单测用）。 */
export function resetTelemetryBuffer(): void {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  pending.clear();
}

/** 待发条数（单测断言「攒了几条」用）。 */
export function pendingTelemetrySize(): number {
  return pending.size;
}

/* ---------------- React 接线 ---------------- */

/**
 * 装全站采集：路由变化记一次页面浏览，点击经 `data-track` 冒泡到 document 统一收集。
 *
 * ⚠ **本页的导航不会重复计数**：用 `location.key` 去重。React 严格模式在开发态会把
 *   effect 跑两遍，只按 `pathname` 判重会在 dev 下把每次浏览都算成 2 次。
 * ⚠ 点击用**捕获阶段**监听：某些入口会 `stopPropagation`（如卡片内的链接），
 *   冒泡阶段会漏掉它们。
 * ⚠ 不做 `sendBeacon` / `beforeunload` 补发：那是另一条隐式通道，本轮不引入。
 */
export function useTelemetryTracking(): void {
  const location = useLocation();
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (lastKey.current === location.key) return;
    lastKey.current = location.key;
    trackPageView(location.pathname);
  }, [location.key, location.pathname]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onClick = (event: MouseEvent) => {
      const origin = event.target as Element | null;
      const marked = origin?.closest?.("[data-track]");
      const target = marked?.getAttribute("data-track");
      if (target) trackClick(target);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
}
