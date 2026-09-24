/**
 * BIFF 官网票务账号表 —— **本地专属**存储(2026-09-24,`PLAN-20260924141442`)。
 *
 * ★ 为什么不落 `biff.*`(这是本模块存在的全部理由,改之前请先读一遍):
 *   ① **账号云同步**:`sync-data.ts::readWorkspace` 收的是**全部** `biff.` 前缀键,登录后整体
 *      上传到 `festival_document` —— 密码落那儿就是**明文上传云端**;
 *   ② **导出 / 备份**:`backup.ts::BACKUP_PREFIX = "biff."`,`snapshot()` 按前缀全量快照;
 *      `account-sync.ts::downloadAccountBackup` 同口径 —— 密码落那儿就是**写进一份可以
 *      随手发给朋友的 JSON**。
 *   `iffday.workspace.*` 是仓库既有的「本地专属」命名空间(`account-sync.ts` 的 OWNER / cache /
 *   import 三只键都在那儿):`readWorkspace` 只收 `biff.` 前缀,故这份数据**既不上云、也不进备份**;
 *   E2E 的 `storage()` 助手(`e2e/react/helpers.ts`)同样排除 `iffday.`,正好拿来做阴性对照断言。
 *
 * ⚠ **明文存储是用户 2026-09-24 明确拍板的取舍**(PLAN 问答):`ticket.biff.kr` 是跨域站点,
 *   本站没有任何合法手段往它的登录框写值 —— 能提供的只有「打开站点 + 一键复制凭据」。
 *   因此 UI 必须明示「只存这台设备」;`password` 留空 = 用户选择不保存密码。
 * ⚠ 读取路径**不写盘**(与 `biff.*` 各表的同一条纪律):只有用户在设置里点「保存设置」才落盘,
 *   否则 `e2e/react/compatibility.spec.ts` 那两条**全键等值**断言会被凭空冒出来的键打红。
 */

import type { TicketAccount, TicketAccountsFile, TicketInfo } from "./types";

export const TICKET_ACCOUNTS_KEY = "iffday.workspace.ticketaccounts.v1";

/** 只用到这三个成员 —— 便于单测传内存实现(node 环境没有 localStorage)。 */
export interface AccountStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 单个账号的字段长度上限(防手滑粘一整段进来):名称 24 / 用户名 96 / 密码 128。 */
const LABEL_MAX = 24;
const USERNAME_MAX = 96;
const PASSWORD_MAX = 128;

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** 空表 —— **每次现造**(不要把同一个对象交给调用方,免得有人就地改它)。 */
function emptyFile(): TicketAccountsFile {
  return { accounts: [], defaultId: null };
}

/** 读取归一:字段裁剪、丢掉没有 id / 用户名的空壳、`defaultId` 必须指向真实存在的账号。
 *  ⚠ `defaultId` 允许为 `null`(未设默认)—— 解析时表现为「无账号」,不是「报错」。 */
export function normalizeAccountsFile(raw: unknown): TicketAccountsFile {
  if (!raw || typeof raw !== "object") return { accounts: [], defaultId: null };
  const { accounts, defaultId } = raw as { accounts?: unknown; defaultId?: unknown };
  const list: TicketAccount[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(accounts) ? accounts : []) {
    if (!item || typeof item !== "object") continue;
    const { id, label, username, password } = item as Record<string, unknown>;
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    const user = clip(username, USERNAME_MAX);
    // 用户名是账号的唯一意义 —— 空账号只能占位,连「复制用户名」都没得复制
    if (!user) continue;
    seen.add(id);
    list.push({ id, label: clip(label, LABEL_MAX), username: user, password: clip(password, PASSWORD_MAX) });
  }
  const wanted = typeof defaultId === "string" ? defaultId : null;
  const resolved = wanted && seen.has(wanted) ? wanted : null;
  return { accounts: list, defaultId: resolved };
}

export function readTicketAccounts(storage: AccountStorage): TicketAccountsFile {
  try {
    const raw = storage.getItem(TICKET_ACCOUNTS_KEY);
    if (!raw) return emptyFile();
    return normalizeAccountsFile(JSON.parse(raw) as unknown);
  } catch {
    /* 半截 JSON / 配额异常:一律降级成空表,不让解析异常冒出去 */
    return emptyFile();
  }
}

/** 落盘。空表 → **删键**而不是写 `{"accounts":[]}`(localStorage 只增不减的老毛病)。 */
export function writeTicketAccounts(storage: AccountStorage, file: TicketAccountsFile): void {
  const normalized = normalizeAccountsFile(file);
  if (!normalized.accounts.length) {
    storage.removeItem(TICKET_ACCOUNTS_KEY);
    return;
  }
  storage.setItem(TICKET_ACCOUNTS_KEY, JSON.stringify(normalized));
}

/** 账号 id —— 只在本机有意义(它会被写进**上云**的 `biff.ticketinfo.v1`,
 *  所以换设备后可能指向一个不存在的账号,由 `resolveAccountOf` 回落默认账号兜底)。 */
export function newAccountId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `acc-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/** 显示名:`label` 优先,空则回落用户名;两者都空(只可能出现在**还没保存**的草稿里,
 *  因为读取归一会把没有用户名的账号丢掉)→ 给一个占位名。
 *  界面上不允许出现「空白选项」—— 下拉里一个空 label 会让人以为程序坏了。 */
export function accountLabelOf(account: TicketAccount): string {
  return account.label || account.username || "未命名账号";
}

/** 按 id 找账号;找不到 → `null`。 */
export function accountById(
  file: TicketAccountsFile,
  id: string | null | undefined,
): TicketAccount | null {
  if (!id) return null;
  return file.accounts.find((account) => account.id === id) ?? null;
}

/** 默认账号(设置里指定);未设 / 指向已删账号 → `null`。 */
export function defaultAccount(file: TicketAccountsFile): TicketAccount | null {
  return accountById(file, file.defaultId);
}

/** 某一场的票**实际用的账号** —— 「票里单独设置优先,否则按设置中的默认账号」(用户 2026-09-24)。
 *
 *  三级回落:`明细里的 accountId` → `默认账号` → `null`。
 *  ⚠ 覆盖的 id 在本机找不到(跨设备同步过来的旧 id / 账号被删)→ **回落到默认账号**,
 *    而不是报错或显示空 —— 票还是要有账号可用。调用方若想提示「原账号已不在本机」,
 *    自己比对 `info.accountId` 与返回值即可。 */
export function resolveAccountOf(
  file: TicketAccountsFile,
  info: TicketInfo | undefined,
): TicketAccount | null {
  return accountById(file, info?.accountId) ?? defaultAccount(file);
}

/* ---------- 运行时单例(浏览器里那一份真表) ----------
 * 与 `screening-counts.ts` 同形:模块级可变对象 + 订阅广播。**不放进 `state.ts`** ——
 * `state.ts` 管的是 `biff.*` 那份「应用状态」,这份数据按设计就不属于那个命名空间。 */

let cache: TicketAccountsFile = emptyFile();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeTicketAccounts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function peekTicketAccounts(): TicketAccountsFile {
  return cache;
}

function browserStorage(): AccountStorage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

/** 从本机读一次(**只读**,载入路径唯一的写盘禁令见文件头)。 */
export function loadTicketAccounts(): void {
  const storage = browserStorage();
  if (!storage) return;
  cache = readTicketAccounts(storage);
  emit();
}

/** 整表替换(设置弹层「保存设置」的唯一出口):归一 → 落盘 → 广播。 */
export function setTicketAccounts(next: TicketAccountsFile): void {
  const normalized = normalizeAccountsFile(next);
  cache = normalized;
  const storage = browserStorage();
  if (storage) writeTicketAccounts(storage, normalized);
  emit();
}
