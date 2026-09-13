/** Want-to-watch weighting: logged-in 1.0, anonymous 0.75; display Math.round (四舍五入). */

export const WANT_WEIGHT_AUTH = 1;
export const WANT_WEIGHT_ANON = 0.75;
export const DEFAULT_WANT_EDITION = "biff-2026";

export function roundWantCount(weightSum: number): number {
  return Math.round(weightSum);
}

export function wantWeightFor(authenticated: boolean): number {
  return authenticated ? WANT_WEIGHT_AUTH : WANT_WEIGHT_ANON;
}

/** Extract film keys from festival_document-style records (`pick:<filmKey>`). */
export function pickFilmKeysFromRecords(records: Record<string, string>): Set<string> {
  const keys = new Set<string>();
  for (const key of Object.keys(records)) {
    if (key.startsWith("pick:") && key.length > 5) keys.add(key.slice(5));
  }
  return keys;
}

/** Diff two film-key sets into remove / add for contribution updates. */
export function diffFilmKeys(previous: Iterable<string>, next: Iterable<string>) {
  const prev = new Set(previous);
  const nxt = new Set(next);
  const removed: string[] = [];
  const added: string[] = [];
  for (const key of prev) if (!nxt.has(key)) removed.push(key);
  for (const key of nxt) if (!prev.has(key)) added.push(key);
  return { removed, added };
}

export function formatWantCounts(
  rows: Iterable<{ film_key: string; weight_sum: string | number }>,
): Record<string, number> {
  const counts: Record<string, number> = Object.create(null);
  for (const row of rows) {
    const sum = typeof row.weight_sum === "number" ? row.weight_sum : Number(row.weight_sum);
    if (!Number.isFinite(sum) || sum <= 0) continue;
    counts[row.film_key] = roundWantCount(sum);
  }
  return counts;
}
