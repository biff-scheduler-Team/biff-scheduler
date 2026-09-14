/** Client cache for GET /api/stats/want-counts + minimal anon film-key ping. */

import { EDITION } from "./edition";
let cache: Record<string, number> | null = null;
let loading: Promise<Record<string, number>> | null = null;
let pingTimer: number | undefined;
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

/** Privacy-safe: only film keys, never full picks document. Debounced. */
export function scheduleWantPing(filmKeys: Iterable<string>) {
  const films = [...new Set(filmKeys)].filter((key) => key.length > 0).slice(0, 500);
  clearTimeout(pingTimer);
  pingTimer = window.setTimeout(() => {
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
