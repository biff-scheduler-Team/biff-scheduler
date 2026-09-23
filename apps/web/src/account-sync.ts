import { hasImportableData } from "@biff/contracts/import";
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

import { accountSchema, accountUserIdSchema as id, type Account } from "@biff/contracts/account";
export { accountSchema };
export type { Account };
const recordsSchema = z.record(z.string(), z.string());
const documentSchema = z.object({
  subject: id,
  importedAt: z.number().nullable(),
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
/** 缓存损坏时把原文另存的键（`owner` 维度，与 cache 键同构）。 */
function cacheCorruptKey(owner: string) {
  return `iffday.workspace.cache.corrupt.v1:${owner}`;
}

/**
 * localStorage 里的缓存原文 → `Cache`（**纯函数**，故可被单测钉住）。
 *
 * ⚠ 损坏 / 半截 JSON 一律降级成空缓存，并把原文交回调用方另存 —— 不能让解析异常冒出去：
 *   抛点此前落在 `initAccountSync` 的 `try` **之外**，异常会冲出整个初始化，
 *   于是 `iffday:workspace-change` / `online` / `focus` / `storage` 监听与 20s 定时同步
 *   **全都还没挂上** —— 此后用户任何改动都不会再同步，只能手动清 localStorage 才能恢复。
 */
export function parseStoredCache(raw: string | null): { cache: Cache; corruptRaw: string | null } {
  if (!raw) return { cache: emptyCache(), corruptRaw: null };
  try {
    return { cache: cacheSchema.parse(JSON.parse(raw)), corruptRaw: null };
  } catch {
    return { cache: emptyCache(), corruptRaw: raw };
  }
}

function cacheFor(owner: string): Cache {
  const { cache: stored, corruptRaw } = parseStoredCache(localStorage.getItem(cacheKey(owner)));
  if (corruptRaw) {
    console.warn("workspace_cache_corrupt", owner);
    // 另存原文（排障 / 恢复有据可查），但**绝不让写失败影响同步**：配额满等异常直接忽略。
    try {
      localStorage.setItem(cacheCorruptKey(owner), corruptRaw);
    } catch {
      // 忽略：连原文都存不下时，功能正确性优先于留证
    }
  }
  return stored;
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
  /** 这个会话能不能自动续期(登录时上游有没有给 refresh token)。null = 还不知道。 */
  renewable: null as boolean | null,
  /** 上一次登录失败时服务端分诊出来的 `account_error` 码(没有失败过就是 null)。 */
  loginError: null as string | null,
  /** 与之配套的 `account_ms`:失败那一步上游调用自己的耗时。 */
  loginErrorElapsed: null as string | null,
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
let importResolution: { revision: number; local: WorkspaceRecords; records: WorkspaceRecords } | null = null;
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
/** `/api/account/me` 的响应 = 账号资料 + 会话的续期能力(`renewable`)。 */
const meSchema = accountSchema.extend({ renewable: z.boolean().optional() });

/** 服务端分诊出来的 401 原因(见 PLAN-20260916104514)。 */
let failureCode: string | null = null;
const failureReasons: Record<string, string> = {
  SESSION_NO_COOKIE: "浏览器里没有带上登录凭证",
  SESSION_NOT_FOUND: "服务端已经没有这个会话",
  SESSION_NO_REFRESH_TOKEN: "登录时没有拿到可自动续期的凭证",
  SESSION_REFRESH_REJECTED: "账号系统拒绝了续期",
  IDENTITY_REJECTED: "账号系统拒绝了身份校验",
};

/** 「登录已过期」这句话必须带上原因 —— 否则用户和我们只能靠猜(上次的排查就卡在这里)。 */
function expiredMessage() {
  const reason = failureCode ? failureReasons[failureCode] : undefined;
  return `登录已过期${reason ? `（${reason}）` : ""}。本机数据已保留，请重新登录继续同步。`;
}

async function identify(): Promise<{ account: Account | null; renewable: boolean | null }> {
  try {
    const parsed = meSchema.parse(await (await api("/api/account/me")).json());
    failureCode = null;
    accountState.renewable = parsed.renewable ?? null;
    return { account: parsed, renewable: accountState.renewable };
  } catch (error) {
    if (error instanceof ApiFailure && error.status === 401) {
      failureCode = error.code;
      accountState.renewable = null;
      return { account: null, renewable: null };
    }
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
      hasImportableData(local) &&
      !localStorage.getItem(importKey(next))
    ) {
      localStorage.setItem(importKey(next), JSON.stringify(local));
    }
    const nextCache = cacheFor(next);
    // 只在本机旧数据与拉回来的新数据都落盘之后，才切换「这份数据属于谁」的标记。
    apply(nextCache.local);
    owner = next;
    cache = nextCache;
    localStorage.setItem(OWNER, owner);
  }
  cache.account = account;
  persist();
  accountState.account = account;
  accountState.authenticated = Boolean(account);
  // 登出 / 切账号时清掉上一次的结论,免得面板显示的是上一个会话的续期能力。
  if (!account) accountState.renewable = null;
  // 登录真的成功了才清掉「上次登录失败」的原因:失败后本机是 guest,不能再挂着那条提示误导人。
  if (account) {
    accountState.loginError = null;
    accountState.loginErrorElapsed = null;
  }
  const pending = account ? localStorage.getItem(importKey(owner)) : null;
  accountState.pendingImport = pending ? recordsSchema.parse(JSON.parse(pending)) : null;
  accountState.conflicts = [];
  remoteConflict = null;
  importResolution = null;
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
    if (!identity.account && owner !== "guest") setStatus("error", expiredMessage());
    else activate(identity.account);
  } catch {
    setStatus("offline", "账号暂时无法连接，本机修改会保留。");
  }
  window.addEventListener("iffday:workspace-change", schedule);
  window.addEventListener("online", () => void syncAccount());
  window.addEventListener("focus", () => void syncAccount());
  // pagehide 这条路径此前没有 try/catch（`schedule()` 那条有）——
  // 存储配额满时「最后一次改动」会静默丢失，只在控制台留一个未捕获异常。
  window.addEventListener("pagehide", () => {
    try {
      remember();
    } catch {
      // 最后一次保存失败：此时页面已在卸载，无法再提示用户，只能留痕。
      console.warn("workspace_pagehide_persist_failed");
    }
  });
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
    const { account } = await identify();
    if (!account && owner !== "guest") {
      accountState.authenticated = false;
      setStatus("error", expiredMessage());
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
    if (accountState.conflicts.length) {
      setStatus("conflict");
      return;
    }
    setStatus("syncing");
    let remote = documentSchema.parse(await (await api("/api/account/sync/biff-2026")).json());
    if (remote.subject !== owner) throw new ApiFailure(409, "ACCOUNT_CHANGED");
    let local = currentRecords();
    if (accountState.pendingImport && (remote.importedAt !== null || !hasImportableData(accountState.pendingImport)))
      finishImport(false);
    let merged = mergeRecords(cache.base, local, remote.records);
    if (merged.conflicts.length) {
      importingConflict = false;
      remoteConflict = remote;
      mergedConflict = merged.records;
      conflictLocal = local;
      accountState.conflicts = merged.conflicts;
      setStatus("conflict");
      return;
    }
    if (accountState.pendingImport) {
      const guest = accountState.pendingImport;
      localStorage.setItem(`iffday.workspace.import-backup.v1:${owner}`, JSON.stringify(guest));
      const combined = mergeRecords({}, merged.records, guest);
      const resolution = importResolution?.revision === remote.revision && canonical(importResolution.local) === canonical(local)
        ? importResolution.records : null;
      if (combined.conflicts.length && !resolution) {
        importingConflict = true;
        remoteConflict = remote;
        mergedConflict = combined.records;
        conflictLocal = local;
        accountState.conflicts = combined.conflicts;
        setStatus("conflict");
        return;
      }
      remote = await submitImport(remote, resolution ?? combined.records, local);
      local = currentRecords();
      merged = mergeRecords(cache.base, local, remote.records);
      if (merged.conflicts.length) {
        importingConflict = false;
        remoteConflict = remote;
        mergedConflict = merged.records;
        conflictLocal = local;
        accountState.conflicts = merged.conflicts;
        setStatus("conflict");
        return;
      }
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
function finishImport(consumed: boolean) {
  localStorage.removeItem(importKey(owner));
  accountState.pendingImport = null;
  importResolution = null;
  if (consumed) localStorage.setItem(cacheKey("guest"), JSON.stringify(emptyCache()));
}
async function submitImport(remote: CloudDocument, records: WorkspaceRecords, before: WorkspaceRecords) {
  const sourceRecords = accountState.pendingImport;
  if (!sourceRecords) throw new Error("No pending import");
  const response = await api("/api/account/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subject: owner, revision: remote.revision, operationId: crypto.randomUUID(), records, sourceRecords }),
  });
  const result = documentSchema.extend({ imported: z.boolean() }).parse(await response.json());
  if (result.subject !== owner) throw new ApiFailure(409, "ACCOUNT_CHANGED");
  // 请求在途期间的改动必须留下：下一次合并以「导入前的工作区」作共同祖先，
  // 以服务端确认后的版本作远端。
  cache.base = before;
  cache.local = currentRecords();
  persist();
  finishImport(result.imported);
  return result;
}
export function conflictSource() {
  return importingConflict ? "导入的本机数据" : "云端数据";
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
  if (importingConflict) {
    importResolution = { revision: remoteConflict.revision, local: conflictLocal, records };
    importingConflict = false;
    accountState.conflicts = [];
    remoteConflict = null;
    await syncAccount();
    return;
  }
  cache.base = remoteConflict.records;
  cache.revision = remoteConflict.revision;
  apply(records);
  cache.local = records;
  persist();
  importingConflict = false;
  accountState.conflicts = [];
  remoteConflict = null;
  await syncAccount();
}
export async function signOutAccount() {
  remember();
  // ⚠ 本地清理与网络调用**解耦**（2026-09-23，PLAN-20260923111748，B4）：
  //   此前 `api()` 抛错（断网 / 12s 超时 / 非 401）会直接 throw，`activate(null)` 根本执行不到 ——
  //   于是「断网时无法登出」，共享设备上 A 的 `biff.*` 数据（片单 / 想看的片）原样留着，B 打开就能看到。
  //   登出是共享设备上切断他人访问的主要手段，不该被网络可用性绑死；
  //   服务端会话让它自然过期即可（cookie 已被 activate(null) 清掉的本地归属抵消不了，但会话本身有时效）。
  let failure: unknown = null;
  try {
    await api("/api/account/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  } catch (error) {
    if (!(error instanceof ApiFailure && error.status === 401)) failure = error;
  }
  activate(null);
  setStatus("guest");
  if (failure) console.warn("signout_network_failed", failure instanceof Error ? failure.name : "UnknownError");
}
export async function refreshAccountProfile() {
  const { account } = await identify();
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
