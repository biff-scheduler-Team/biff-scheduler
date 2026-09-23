import { canonical } from "@biff/contracts/canonical";
export { canonical } from "@biff/contracts/canonical";
/** 可跨设备搬运的账号数据：记录 ID 跨设备稳定不变，缺席即删除。 */
export type WorkspaceRecords = Record<string, string>;
export interface WorkspaceStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface SyncConflict {
  key: string;
  local: string | null;
  remote: string | null;
}
export interface CloudDocument {
  revision: number;
  records: WorkspaceRecords;
  updatedAt: number;
}

type Value = null | boolean | number | string | Value[] | { [key: string]: Value };
function isObject(value: Value | undefined): value is { [key: string]: Value } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function equal(a: Value | undefined, b: Value | undefined) {
  return canonical(a) === canonical(b);
}
function mergeValue(
  base: Value | undefined,
  local: Value | undefined,
  remote: Value | undefined,
): { value: Value | undefined; conflict: boolean } {
  if (equal(local, remote)) return { value: local, conflict: false };
  if (equal(local, base)) return { value: remote, conflict: false };
  if (equal(remote, base)) return { value: local, conflict: false };
  if (isObject(local) && isObject(remote) && (base === undefined || isObject(base))) {
    const result: { [key: string]: Value } = Object.create(null);
    let conflict = false;
    for (const key of new Set([
      ...Object.keys(base ?? {}),
      ...Object.keys(local),
      ...Object.keys(remote),
    ])) {
      const merged = mergeValue(base?.[key], local[key], remote[key]);
      if (merged.value !== undefined) result[key] = merged.value;
      conflict ||= merged.conflict;
    }
    return { value: result, conflict };
  }
  return { value: local, conflict: true };
}
export function mergeRecords(
  base: WorkspaceRecords,
  local: WorkspaceRecords,
  remote: WorkspaceRecords,
) {
  const records: WorkspaceRecords = Object.create(null);
  const conflicts: SyncConflict[] = [];
  const decode = (s: string | undefined): Value | undefined =>
    s === undefined ? undefined : (JSON.parse(s) as Value);
  for (const key of new Set([
    ...Object.keys(base),
    ...Object.keys(local),
    ...Object.keys(remote),
  ])) {
    const merged = mergeValue(decode(base[key]), decode(local[key]), decode(remote[key]));
    if (merged.conflict)
      conflicts.push({ key, local: local[key] ?? null, remote: remote[key] ?? null });
    if (merged.value !== undefined) records[key] = canonical(merged.value);
  }
  return { records, conflicts };
}
export function readWorkspace(storage: WorkspaceStorage): WorkspaceRecords {
  const records: WorkspaceRecords = Object.create(null);
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith("biff.")) continue;
    const raw = storage.getItem(key);
    if (raw === null) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      records[`raw:${key}`] = JSON.stringify(raw);
      continue;
    }
    if (key === "biff.picks.v2" && Array.isArray(value)) {
      for (const item of value) {
        if (!item || typeof item.key !== "string") continue;
        const codes: Record<string, boolean> = Object.create(null);
        for (const slot of Array.isArray(item.picks) ? item.picks : [])
          if (typeof slot?.code === "string") codes[slot.code] = true;
        records[`pick:${item.key}`] = canonical({
          key: item.key,
          codes,
          note: typeof item.note === "string" ? item.note : "",
        });
      }
    } else records[`local:${key}`] = canonical(value);
  }
  return records;
}
export function writeWorkspace(storage: WorkspaceStorage, records: WorkspaceRecords) {
  const remove: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith("biff.")) remove.push(key);
  }
  const entries: Record<string, string> = Object.create(null);
  const picks: unknown[] = [];
  for (const [key, raw] of Object.entries(records)) {
    const value = JSON.parse(raw);
    if (key.startsWith("pick:"))
      picks.push({
        key: value.key,
        note: value.note,
        picks: Object.keys(value.codes ?? {})
          .sort()
          .filter((code) => value.codes[code])
          .map((code) => ({ code })),
      });
    else if (key.startsWith("local:biff.")) entries[key.slice(6)] = raw;
    else if (key.startsWith("raw:biff.") && typeof value === "string")
      entries[key.slice(4)] = value;
  }
  if (picks.length || !("biff.picks.v2" in entries))
    entries["biff.picks.v2"] = JSON.stringify(picks);
  // 替换途中若撞上浏览器存储配额失败，要留一份可恢复的快照。
  const before = Object.fromEntries(remove.map((key) => [key, storage.getItem(key)!]));
  try {
    for (const key of remove) storage.removeItem(key);
    for (const [key, value] of Object.entries(entries)) storage.setItem(key, value);
  } catch (error) {
    for (const key of Object.keys(entries)) storage.removeItem(key);
    for (const [key, value] of Object.entries(before)) storage.setItem(key, value);
    throw error;
  }
}
/** 导入提示要用的计数。⚠ 方案那一项随「已保存方案」下线(2026-09-22,`PLAN-20260922105228`):
 *  它原先数的是 `plan:` 前缀的专列记录,而那类记录现在不存在了(旧键走通用的 `local:` 分支)。 */
export function workspaceCounts(records: WorkspaceRecords) {
  return {
    films: Object.keys(records).filter((key) => key.startsWith("pick:")).length,
  };
}
