// 数据备份 / 迁移 —— 换域名 / 换设备时把本机片单「搬」过去(纯逻辑 + 下载,无弹层)。
//
// 背景:片单(选片 / 排片 / 抢票顺位 / GV 覆写 / 设置 / 筛选)只存 localStorage(见 state.ts 文件头),
// 而 localStorage **按 origin 隔离** —— 绑定新域名后,用户在新域名看到的是空数据。
// 云端早已整体退役(纯静态零后端),所以「搬家」只能靠一份显式 JSON:旧站导出 → 新站导入。
//
// ★ 三条设计口径:
//   ① **不写死键清单**,按 `biff.` 前缀快照全部键 —— 将来新增视图偏好键会自动被带上,
//      不会再出现「加了新键、忘了加进备份」这种静默丢数据的漏洞。
//   ② 值是**原始字符串**(localStorage 里存什么就搬什么),备份层不解析业务结构 ——
//      schema 演进由各模块自己的 hydrate / 校验兜底,备份格式因此天然向后兼容。
//   ③ 导入是**整体替换**(先清空本机全部 `biff.` 键再写入),不做合并 ——
//      顺位 / GV 覆写都按场次 code 索引,半新半旧混在一起会产出说不清来源的状态。
//
// ⚠ 本模块**不得在 import 期触碰 DOM** —— 纯函数要能在 node 环境被单测直接导入
//   (见 vitest.config.ts)。「导入备份」弹层因需要 modal / ui,单列在 `backup-panel.ts`。

import { el, todayIsoLocal } from "./util";
import { toast } from "./toast";

/** 备份覆盖的 localStorage 前缀 —— 全站键统一 `biff.`(state.ts / filters.ts / library.ts 同口径)。 */
export const BACKUP_PREFIX = "biff.";

/** 信封标识 / 版本 —— 导入时用来确认「这确实是一份备份」。 */
const BACKUP_APP = "biff-scheduler";
const BACKUP_VERSION = 1;

/** 备份文件结构:`data` 的键是 localStorage 键名,值是**原样**的字符串。 */
export interface BackupFile {
  app: string;
  version: number;
  exportedAt: string;
  origin: string;
  data: Record<string, string>;
}

/** 存储抽象 —— 只用这五个成员,便于单测用内存实现替身(node 环境没有 localStorage)。 */
export interface BackupStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 本机全部 `biff.` 键。**先收集成数组再操作** —— 边遍历边删会因索引前移而漏键(见 restore)。 */
function prefixKeys(storage: BackupStorage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.startsWith(BACKUP_PREFIX)) keys.push(k);
  }
  return keys;
}

/** 快照本机数据 → 备份对象(纯函数:存储 / 时间 / origin 全部入参,便于单测)。 */
export function snapshot(storage: BackupStorage, now: Date, origin: string): BackupFile {
  const data: Record<string, string> = {};
  for (const k of prefixKeys(storage)) {
    const v = storage.getItem(k);
    if (v !== null) data[k] = v;
  }
  return { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: now.toISOString(), origin, data };
}

/** 还原备份 → 本机(**整体替换**)。返回实际写入的键数。
 *
 *  ⚠ 必须先收集全部待删键再删除:`removeItem` 会让 `storage.key(i)` 的索引整体前移,
 *    边遍历边删会漏掉一半的键(症状 =「导入后还剩几条旧数据」)。
 *  ⚠ 只接受 `biff.` 前缀且值为字符串的条目 —— 备份文件是用户可手改的,不能让它往
 *    localStorage 里塞任意键(也顺手挡住 `__proto__` 这类怪键名)。 */
export function restore(storage: BackupStorage, data: Record<string, string>): number {
  for (const k of prefixKeys(storage)) storage.removeItem(k);
  let n = 0;
  for (const [k, v] of Object.entries(data)) {
    if (!k.startsWith(BACKUP_PREFIX) || typeof v !== "string") continue;
    storage.setItem(k, v);
    n++;
  }
  return n;
}

export type BackupParse = { ok: true; data: Record<string, string> } | { ok: false; error: string };

/** 解析用户给的内容(文件读出的文本 / 粘贴的文本)。
 *
 *  接受两种形态:① 本工具导出的信封 `{ app, data }`;
 *  ② **裸键值表** `{ "biff.picks.v2": "…" }`(手抄、或只复制了 data 段的场景)。
 *  两者都归一到「键 → 字符串」,失败时给出**能照做的**中文原因。 */
export function parseBackupText(text: string): BackupParse {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "内容为空" };
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "不是有效的 JSON —— 请确认选择 / 粘贴的是完整备份内容" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "备份内容格式不对(应为一个 JSON 对象)" };
  }
  const obj = raw as Record<string, unknown>;
  const inner = obj.data;
  const table = inner && typeof inner === "object" && !Array.isArray(inner) ? (inner as Record<string, unknown>) : obj;
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(table)) {
    if (k.startsWith(BACKUP_PREFIX) && typeof v === "string") data[k] = v;
  }
  if (Object.keys(data).length === 0) {
    return { ok: false, error: `没找到任何 ${BACKUP_PREFIX}* 数据 —— 这份内容不像本工具的备份` };
  }
  return { ok: true, data };
}

/* ---------------- .ics 导入(2026-09-12) ----------------
 * `.ics` 是**单向出口**(喂日历),它带不动本工具的私有状态(备注 / 顺位 / 已保存方案 / 设置),
 * 但每条 VEVENT 的 `UID:<code>@biff-2026` 里就藏着场次 code —— 故可以「反解出场次清单」。
 * 语义 = **导入一份排片**(朋友把他的 .ics 发你),**不是**「恢复备份」。
 *
 * ⚠ 只认 `<纯数字>@biff-2026`:开票日历的 UID 是 `biff-ticket-<n>@biff-2026`
 *   (见 `ics.ts::buildTicketIcs`),不过滤就会把抢票提醒当成场次。 */

export type IcsParse = { ok: true; codes: string[] } | { ok: false; error: string };

/** 从 .ics 文本反解场次 code(去重保序)。失败时给出**能照做的**中文原因。 */
export function parseIcsCodes(text: string): IcsParse {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "内容为空" };
  if (!/BEGIN:VCALENDAR/i.test(trimmed)) {
    return { ok: false, error: "不是 .ics 日历文件(缺少 BEGIN:VCALENDAR)" };
  }
  const codes: string[] = [];
  const seen = new Set<string>();
  const re = /^UID:(\d+)@biff-2026\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    codes.push(m[1]);
  }
  if (codes.length === 0) {
    return { ok: false, error: "这份 .ics 里没有本工具导出的场次(UID 不是 <code>@biff-2026)" };
  }
  return { ok: true, codes };
}

/* ---------------- 运行时入口(读写真实 localStorage) ---------------- */

function localStore(): BackupStorage {
  return window.localStorage;
}

/** 下载备份文件(「导出备份文件」入口)。本机无数据时只提示、不产出空文件。 */
export function downloadBackup(): void {
  const file = snapshot(localStore(), new Date(), location.origin);
  const n = Object.keys(file.data).length;
  if (n === 0) {
    toast("本机没有可备份的数据 —— 先选几场再导出");
    return;
  }
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a");
  a.href = url;
  a.download = `biff-backup-${todayIsoLocal()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast(`已导出备份(${n} 项)—— 在新域名用「导入数据备份」恢复`);
}

/** 写入并**刷新页面**。
 *  各模块的数据都是启动时从 localStorage 读进内存的(store.picks / rankOf / settings …),
 *  不刷新就只能靠逐模块重新 hydrate —— 漏一个就是「导入成功但界面没变」。刷新是唯一可靠口径。 */
export function applyBackup(data: Record<string, string>): void {
  const n = restore(localStore(), data);
  toast(`已导入 ${n} 项数据,正在刷新…`);
  location.reload();
}
