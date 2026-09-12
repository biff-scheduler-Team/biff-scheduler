import { z } from "zod";
import {
  canonical,
  mergeRecords,
  readWorkspace,
  writeWorkspace,
  type WorkspaceRecords,
  type SyncConflict,
  type CloudDocument,
} from "./sync-data";

import { accountSchema, accountUserIdSchema as id, type Account } from "./account-contract";
export { accountSchema };
export type { Account };
const recordsSchema = z.record(z.string(), z.string());
const documentSchema = z.object({
  subject: id,
  revision: z.number().int().nonnegative(),
  records: recordsSchema,
  updatedAt: z.number(),
});
const cacheSchema = z.object({
  base: recordsSchema,
  local: recordsSchema,
  revision: z.number(),
  account: accountSchema.nullable(),
  lastSyncAt: z.number(),
});
type Cache = z.infer<typeof cacheSchema>;
export type SyncStatus =
  | "checking"
  | "guest"
  | "offline"
  | "syncing"
  | "synced"
  | "pending"
  | "conflict"
  | "error";
const OWNER = "iffday.workspace.owner.v1";
const cacheKey = (owner: string) => `iffday.workspace.cache.v1:${owner}`;
const importKey = (owner: string) => `iffday.workspace.import.v1:${owner}`;
const emptyCache = (): Cache => ({
  base: {},
  local: {},
  revision: 0,
  account: null,
  lastSyncAt: 0,
});
function cacheFor(owner: string): Cache {
  const raw = localStorage.getItem(cacheKey(owner));
  return raw ? cacheSchema.parse(JSON.parse(raw)) : emptyCache();
}
export class ApiFailure extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    signal: init.signal ?? AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "REQUEST_FAILED" }));
    throw new ApiFailure(
      response.status,
      typeof body.error === "string" ? body.error : "REQUEST_FAILED",
    );
  }
  return response;
}
export const accountState = {
  account: null as Account | null,
  authenticated: false,
  status: "checking" as SyncStatus,
  message: "",
  lastSyncAt: 0,
  pendingImport: null as WorkspaceRecords | null,
  conflicts: [] as SyncConflict[],
};
let owner = "guest";
let cache = emptyCache();
let running = false;
let applying = false;
let changed: () => void = () => {};
let timer: number | undefined;
let remoteConflict: CloudDocument | null = null;
let mergedConflict: WorkspaceRecords = {};
let conflictLocal: WorkspaceRecords = {};
let importingConflict = false;
const listeners = new Set<() => void>();
export function onAccountChange(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function emit() {
  for (const listener of listeners) listener();
}
function persist() {
  localStorage.setItem(cacheKey(owner), JSON.stringify(cache));
  accountState.lastSyncAt = cache.lastSyncAt;
}
function setStatus(status: SyncStatus, message = "") {
  accountState.status = status;
  accountState.message = message;
  emit();
}
function currentRecords() {
  return readWorkspace(localStorage);
}
function apply(records: WorkspaceRecords) {
  applying = true;
  try {
    writeWorkspace(localStorage, records);
    changed();
  } finally {
    applying = false;
  }
}
function remember() {
  if (applying) return;
  if ((localStorage.getItem(OWNER) ?? "guest") !== owner) {
    window.location.reload();
    return;
  }
  cache.local = currentRecords();
  persist();
}
function schedule() {
  if (applying) return;
  try {
    remember();
  } catch {
    setStatus("error", "浏览器无法保存数据，请先导出备份并检查存储空间。");
    return;
  }
  if (!accountState.account || accountState.pendingImport || accountState.conflicts.length) return;
  clearTimeout(timer);
  if (canonical(cache.local) !== canonical(cache.base))
    setStatus(navigator.onLine ? "pending" : "offline");
  timer = window.setTimeout(() => void syncAccount(), 800);
}
async function identify(): Promise<Account | null> {
  try {
    return accountSchema.parse(await (await api("/api/account/me")).json());
  } catch (error) {
    if (error instanceof ApiFailure && error.status === 401) return null;
    throw error;
  }
}
function activate(account: Account | null) {
  const next = account?.user.id ?? "guest";
  if (next !== owner) {
    remember();
    const local = cache.local;
    if (
      owner === "guest" &&
      account &&
      Object.keys(local).length &&
      !localStorage.getItem(importKey(next))
    ) {
      localStorage.setItem(importKey(next), JSON.stringify(local));
    }
    const nextCache = cacheFor(next);
    // Only switch the ownership marker after both outgoing data and incoming data are saved.
    apply(nextCache.local);
    owner = next;
    cache = nextCache;
    localStorage.setItem(OWNER, owner);
  }
  cache.account = account;
  persist();
  accountState.account = account;
  accountState.authenticated = Boolean(account);
  const pending = account ? localStorage.getItem(importKey(owner)) : null;
  accountState.pendingImport = pending ? recordsSchema.parse(JSON.parse(pending)) : null;
  accountState.conflicts = [];
  remoteConflict = null;
}
function isEditing() {
  const element = document.activeElement;
  return (
    element instanceof HTMLElement &&
    element.matches(
      "input:not([type=button]):not([type=submit]),textarea,select,[contenteditable=true]",
    )
  );
}
export async function initAccountSync(onWorkspaceChanged: () => void) {
  changed = onWorkspaceChanged;
  owner = localStorage.getItem(OWNER) ?? "guest";
  cache = cacheFor(owner);
  remember();
  accountState.account = cache.account;
  try {
    const identity = await identify();
    if (!identity && owner !== "guest")
      setStatus("error", "登录已过期。本机数据已保留，请重新登录继续同步。");
    else activate(identity);
  } catch {
    setStatus("offline", "账号暂时无法连接，本机修改会保留。");
  }
  window.addEventListener("iffday:workspace-change", schedule);
  window.addEventListener("online", () => void syncAccount());
  window.addEventListener("focus", () => void syncAccount());
  window.addEventListener("pagehide", remember);
  window.addEventListener("storage", (event) => {
    if (event.key === OWNER && (event.newValue ?? "guest") !== owner) {
      window.location.reload();
      return;
    }
    if (event.key?.startsWith("biff.")) {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        applying = true;
        try {
          changed();
        } finally {
          applying = false;
        }
        schedule();
      }, 50);
    }
  });
  window.setInterval(() => {
    if (document.visibilityState === "visible" && !isEditing()) void syncAccount();
  }, 20_000);
  if (accountState.status !== "offline") await syncAccount();
}
export async function syncAccount() {
  if (running || applying) return;
  running = true;
  try {
    remember();
    const account = await identify();
    if (!account && owner !== "guest") {
      accountState.authenticated = false;
      setStatus("error", "登录已过期。本机数据已保留，请重新登录继续同步。");
      return;
    }
    if (account?.user.id !== accountState.account?.user.id) activate(account);
    else if (account) {
      accountState.account = account;
      cache.account = account;
      accountState.authenticated = true;
    }
    if (!account) {
      setStatus("guest");
      return;
    }
    if (accountState.pendingImport) {
      setStatus("pending", "有本机数据等待合并到账号。");
      return;
    }
    if (accountState.conflicts.length) {
      setStatus("conflict");
      return;
    }
    setStatus("syncing");
    const remote = documentSchema.parse(await (await api("/api/account/sync/biff-2026")).json());
    if (remote.subject !== owner) throw new ApiFailure(409, "ACCOUNT_CHANGED");
    const local = currentRecords();
    const merged = mergeRecords(cache.base, local, remote.records);
    if (merged.conflicts.length) {
      importingConflict = false;
      remoteConflict = remote;
      mergedConflict = merged.records;
      conflictLocal = local;
      accountState.conflicts = merged.conflicts;
      setStatus("conflict");
      return;
    }
    if (canonical(merged.records) !== canonical(local)) {
      if (isEditing()) {
        setStatus("pending", "编辑完成后载入云端更新。");
        return;
      }
      apply(merged.records);
    }
    cache.base = remote.records;
    cache.revision = remote.revision;
    cache.local = merged.records;
    persist();
    if (canonical(cache.local) !== canonical(cache.base)) {
      const sent = cache.local;
      const response = await api("/api/account/sync/biff-2026", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: owner,
          revision: cache.revision,
          operationId: crypto.randomUUID(),
          records: sent,
        }),
      });
      const result = z.object({ revision: z.number().int() }).parse(await response.json());
      cache.base = sent;
      cache.revision = result.revision;
      cache.local = currentRecords();
    }
    cache.lastSyncAt = Date.now();
    persist();
    if (canonical(cache.local) !== canonical(cache.base)) {
      setStatus("pending");
      timer = window.setTimeout(() => void syncAccount(), 800);
    } else setStatus("synced");
  } catch (error) {
    if (error instanceof ApiFailure && error.code === "REVISION_CONFLICT") {
      setStatus("pending");
      timer = window.setTimeout(() => void syncAccount(), 500);
    } else if (
      error instanceof ApiFailure &&
      (error.status === 401 || error.code === "ACCOUNT_CHANGED")
    ) {
      setStatus("error", "账号状态已变化，请重新登录。未同步数据仍保存在这台设备。");
    } else {
      setStatus(
        navigator.onLine ? "error" : "offline",
        error instanceof ApiFailure && error.status === 413
          ? "数据超出同步容量，请先导出备份。"
          : "暂时无法同步，本机修改已保留。连接恢复后会重试。",
      );
    }
  } finally {
    running = false;
  }
}
function finishImport() {
  localStorage.removeItem(importKey(owner));
  accountState.pendingImport = null;
  localStorage.setItem(cacheKey("guest"), JSON.stringify(emptyCache()));
}
export async function importGuestData() {
  if (!accountState.authenticated || !accountState.pendingImport || running) return;
  const guest = accountState.pendingImport;
  localStorage.setItem(`iffday.workspace.import-backup.v1:${owner}`, JSON.stringify(guest));
  const local = currentRecords();
  const combined = mergeRecords({}, local, guest);
  if (combined.conflicts.length) {
    importingConflict = true;
    remoteConflict = { revision: cache.revision, records: guest, updatedAt: 0 };
    mergedConflict = combined.records;
    conflictLocal = local;
    accountState.conflicts = combined.conflicts;
    setStatus("conflict");
    return;
  }
  apply(combined.records);
  cache.local = combined.records;
  persist();
  finishImport();
  await syncAccount();
}
export function conflictSource() {
  return importingConflict ? "导入的本机数据" : "云端数据";
}
export async function skipGuestImport() {
  if (!accountState.account) return;
  // Keep the guest copy recoverable through a local backup; do not upload it without acceptance.
  localStorage.removeItem(importKey(owner));
  accountState.pendingImport = null;
  await syncAccount();
}
export async function resolveSyncConflicts(choices: Record<string, "local" | "remote">) {
  if (!remoteConflict || running) return;
  if (canonical(currentRecords()) !== canonical(conflictLocal)) {
    accountState.conflicts = [];
    remoteConflict = null;
    await syncAccount();
    return;
  }
  const records = { ...mergedConflict };
  for (const conflict of accountState.conflicts) {
    const value = choices[conflict.key] === "remote" ? conflict.remote : conflict.local;
    if (value === null) delete records[conflict.key];
    else records[conflict.key] = value;
  }
  if (!importingConflict) {
    cache.base = remoteConflict.records;
    cache.revision = remoteConflict.revision;
  }
  apply(records);
  cache.local = records;
  persist();
  if (importingConflict) finishImport();
  importingConflict = false;
  accountState.conflicts = [];
  remoteConflict = null;
  await syncAccount();
}
export async function signOutAccount() {
  remember();
  try {
    await api("/api/account/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  } catch (error) {
    if (!(error instanceof ApiFailure && error.status === 401)) throw error;
  }
  activate(null);
  setStatus("guest");
}
export async function refreshAccountProfile() {
  const account = await identify();
  if (account?.user.id !== owner) throw new Error("账号已变化，请刷新页面。");
  accountState.account = account;
  cache.account = account;
  persist();
  emit();
}
export function downloadAccountBackup() {
  remember();
  const data: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith("biff.")) data[key] = localStorage.getItem(key)!;
  }
  const blob = new Blob(
    [
      JSON.stringify(
        {
          app: "biff-scheduler",
          version: 1,
          origin: location.origin,
          exportedAt: new Date().toISOString(),
          data,
        },
        null,
        2,
      ),
    ],
    { type: "application/json" },
  );
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = "biff-2026-account-backup.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
