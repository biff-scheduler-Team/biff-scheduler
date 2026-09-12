/** Ignore empty containers, nulls and blank strings when deciding whether to claim an import. */
function populated(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(populated);
  if (typeof value === "object") return Object.values(value).some(populated);
  return true;
}
export function hasImportableData(records: Record<string, string>): boolean {
  return Object.entries(records).some(([key, raw]) => {
    if (!/^(pick:|plan:|local:biff\.|raw:biff\.)/.test(key)) return false;
    try { return populated(JSON.parse(raw)); } catch { return false; }
  });
}
