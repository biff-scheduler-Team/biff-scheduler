/** 「想看人数」的客户端缓存（GET /api/stats/want-counts）+ 极简的匿名片键上报。 */

import { EDITION } from "./edition";
let cache: Record<string, number> | null = null;
let loading: Promise<Record<string, number>> | null = null;
// ⚠ 用全局 `setTimeout` 而不是 `window.setTimeout`：本模块由 `state.ts::saveLocal()` 调用，
//   而单测跑在 node 环境（没有 `window`）—— 兄弟模块 `screening-counts` / `film-votes` /
//   `ticket-stats` 都显式这么写并注释过，只有这里漏了，症状是 node 下抛 ReferenceError
//   被 saveLocal 的 try/catch 吞掉 → 「想看人数上报」静默不触发（2026-09-23，PLAN-20260923111748，B6）。
let pingTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

export function onWantCountsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit() {
  for (const listener of listeners) listener();
}

export function peekWantCounts(): Record<string, number> {
  return cache ?? Object.create(null);
}

export async function loadWantCounts(force = false): Promise<Record<string, number>> {
  if (cache && !force) return cache;
  if (loading && !force) return loading;
  loading = (async () => {
    try {
      const response = await fetch(`/api/stats/want-counts?edition=${EDITION}`, {
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) return cache ?? Object.create(null);
      const body = (await response.json()) as { counts?: Record<string, number> };
      cache = body.counts && typeof body.counts === "object" ? body.counts : Object.create(null);
      emit();
      return cache;
    } catch {
      return cache ?? Object.create(null);
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** 隐私边界：只发片键，绝不发整份片单文档；防抖后上报一次。 */
export function scheduleWantPing(filmKeys: Iterable<string>) {
  const films = [...new Set(filmKeys)].filter((key) => key.length > 0).slice(0, 500);
  clearTimeout(pingTimer);
  pingTimer = setTimeout(() => {
    void fetch("/api/stats/want-ping", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edition: EDITION, films }),
      signal: AbortSignal.timeout(12_000),
    })
      .then((response) => {
        if (response.ok) return loadWantCounts(true);
      })
      .catch(() => undefined);
  }, 1200);
}
