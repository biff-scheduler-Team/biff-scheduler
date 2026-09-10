// 应用状态:选片记录(影片级) / 豆瓣映射 / 方案与设置。
//
// 单一数据源 = store.picks:「我的选片」(按片看)与「我的行程」(按场次看)是同一份数据的两个视图。
// 档位只有一份且在影片级 —— 行程行改档位 = 改该片档位,两个视图永不打架(旧版 wish + plan 两套已合并)。
//
// 本地优先(localStorage 即时生效),D1 云端尽力同步;API 不可用时自动降级本地。

import type { Group, Mapping, PickEntry, PickSlot, Priority, Settings } from "./types";
import { api } from "./api";

const LS_PICKS = "biff.picks.v2";
const LS_SETTINGS = "biff.settings.v1";
const LS_GV_TALK = "biff.gvtalk.v1"; // GV 映后谈单场覆写(code → 是否参加);缺省跟随 Settings.gvTalkOn
const LS_GV_TALK_MIN = "biff.gvtalkmin.v1"; // GV 映后谈单场时长覆写(code → 分钟);缺省跟随 Settings.gvTalkMin
/** 旧版两套数据的 localStorage key —— 仅作一次性迁移源(迁移后不删,留作回退) */
const LS_PLAN_LEGACY = "biff.plan.v1";
const LS_WISH_LEGACY = "biff.wish.v1";

export const store = {
  /** 唯一数据源:影片 key(filmNodeKey)→ 选片记录 */
  picks: new Map<string, PickEntry>(),
  /** 派生索引:场次 code → { 影片 key, 方案 }。每次变更重建,供网格/行程/弹层 O(1) 反查 */
  slotIndex: new Map<string, { key: string; group: Group }>(),
  mappings: new Map<string, Mapping>(),
  group: "A" as Group,
  settings: { alarmMin: 45, transitMin: 0, gvTalkOn: true, gvTalkMin: 25 } as Settings,
  online: true,
};

/* ---------- 派生查询(视图层只读这些,不再自己遍历 picks) ---------- */

/** 该场是否已选 / 归属方案 */
export function slotOf(code: string): { key: string; group: Group } | undefined {
  return store.slotIndex.get(code);
}

/** 该场在当前方案里吗(网格绿底 / 行程行是否展示) */
export function inGroup(code: string, g: Group = store.group): boolean {
  return store.slotIndex.get(code)?.group === g;
}

/** 某方案下的全部场次 code */
export function codesOfGroup(g: Group): string[] {
  const out: string[] = [];
  for (const e of store.picks.values()) for (const p of e.picks) if (p.group === g) out.push(p.code);
  return out;
}

/** 某场对应的影片档位(行程行三段 seg 读它);未选场次 → undefined */
export function priorityOfCode(code: string): Priority | null | undefined {
  const hit = store.slotIndex.get(code);
  return hit ? store.picks.get(hit.key)?.priority : undefined;
}

/** 某影片节点的档位(甘特卡色点 / 影片库行三选 / 详情弹层读它) */
export function priorityOfKey(key: string): Priority | undefined {
  return store.picks.get(key)?.priority ?? undefined;
}

/** 该片已排场次数(0 = 已选片但未排场) */
export function pickedCount(key: string): number {
  return store.picks.get(key)?.picks.length ?? 0;
}

/** 已排场次总数(顶栏计数用) */
export function totalSlots(): number {
  return store.slotIndex.size;
}

/** GV 映后谈单场覆写:code → 参加(true)/放弃(false);无条目 = 跟随全局默认 */
export const gvTalk = new Map<string, boolean>();

export function loadGvTalk(): void {
  try {
    const raw = localStorage.getItem(LS_GV_TALK);
    if (!raw) return;
    for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, boolean>)) {
      if (typeof v === "boolean") gvTalk.set(k, v);
    }
  } catch {
    /* ignore */
  }
}

export function saveGvTalk(): void {
  try {
    localStorage.setItem(LS_GV_TALK, JSON.stringify(Object.fromEntries(gvTalk)));
  } catch {
    /* ignore */
  }
}

/** 翻转某场映后谈:true=参加 / false=放弃 / null=清除覆写(回到跟随全局默认) */
export function setGvTalk(code: string, on: boolean | null): void {
  if (on === null) gvTalk.delete(code);
  else gvTalk.set(code, on);
  saveGvTalk();
  notify();
}

/** GV 映后谈单场时长覆写:code → 分钟数;无条目 = 跟随全局默认 Settings.gvTalkMin。
 *  与 gvTalk(参加/放弃)正交:一个管「去不去」,一个管「多久」。 */
export const gvTalkMinOv = new Map<string, number>();

export function loadGvTalkMin(): void {
  try {
    const raw = localStorage.getItem(LS_GV_TALK_MIN);
    if (!raw) return;
    for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) gvTalkMinOv.set(k, v);
    }
  } catch {
    /* ignore */
  }
}

export function saveGvTalkMin(): void {
  try {
    localStorage.setItem(LS_GV_TALK_MIN, JSON.stringify(Object.fromEntries(gvTalkMinOv)));
  } catch {
    /* ignore */
  }
}

/** 设/清某场映后谈时长:number = 覆写本场;null = 清除覆写(回到跟随全局默认) */
export function setGvTalkMin(code: string, min: number | null): void {
  if (min === null) gvTalkMinOv.delete(code);
  else gvTalkMinOv.set(code, min);
  saveGvTalkMin();
  notify();
}

export type Listener = () => void;
const listeners = new Set<Listener>();
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function notify(): void {
  listeners.forEach((fn) => fn());
}

/* ---------- 本地持久化 + 派生索引 ---------- */
function saveLocal(): void {
  try {
    localStorage.setItem(LS_PICKS, JSON.stringify([...store.picks.values()]));
  } catch {
    /* ignore */
  }
}

/** 由 picks 重建场次索引(唯一写点:所有变更都经 commit()) */
function rebuildIndex(): void {
  const idx = new Map<string, { key: string; group: Group }>();
  for (const e of store.picks.values()) for (const p of e.picks) idx.set(p.code, { key: e.key, group: p.group });
  store.slotIndex = idx;
}

/** 记录变更统一出口:落本地 → 重建索引 → 广播 → 云端异步。
 *  entry 省略 = 删除该条记录(其场次随之消失)。 */
function commit(key: string, entry?: PickEntry): void {
  if (entry) store.picks.set(key, entry);
  else store.picks.delete(key);
  saveLocal();
  rebuildIndex();
  notify();
  void pushCloud(key, entry);
}

async function pushCloud(key: string, entry?: PickEntry): Promise<void> {
  if (!store.online) return;
  const ok = entry
    ? await api.putPick(key, { priority: entry.priority, note: entry.note, picks: entry.picks })
    : await api.deletePick(key);
  if (!ok) {
    store.online = false;
    notify();
  }
}

/* ---------- 载入(本地 v2;无则从旧两套一次性迁移) ---------- */

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function isPriority(v: unknown): v is Priority {
  return v === "must" || v === "maybe" || v === "wild";
}

function isGroup(v: unknown): v is Group {
  return v === "A" || v === "B";
}

/** 校验并灌入一批记录(本地 / 云端共用;非法字段一律兜底,绝不抛) */
function hydrate(rows: unknown): number {
  if (!Array.isArray(rows)) return 0;
  let n = 0;
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Partial<PickEntry>;
    const key = typeof r.key === "string" ? r.key : "";
    if (!key) continue;
    const picks: PickSlot[] = [];
    if (Array.isArray(r.picks)) {
      for (const s of r.picks) {
        if (!s || typeof s !== "object") continue;
        const sl = s as Partial<PickSlot>;
        if (typeof sl.code === "string" && sl.code && isGroup(sl.group)) picks.push({ code: sl.code, group: sl.group });
      }
    }
    store.picks.set(key, {
      key,
      priority: isPriority(r.priority) ? r.priority : null,
      picks,
      note: typeof r.note === "string" ? r.note : "",
    });
    n++;
  }
  return n;
}

/** 载入选片记录。localStorage 无 v2 数据时,从旧「plan(场次级)+ wish(影片级)」合成一次。
 *  迁移要用 filmNodeKey 把 code 归到影片 key,故必须在 loadCatalog() 之后调用。 */
export function loadPicks(filmKeyOf: (code: string) => string | null): void {
  const rows = readJson<unknown>(LS_PICKS);
  if (Array.isArray(rows)) {
    hydrate(rows);
  } else {
    migrateLegacy(filmKeyOf);
  }
  rebuildIndex();
  pruneUnsetPicks(); // 存量脏数据(未设档位 + 有场次)载入即清
}

/** 一次性迁移:旧两套 → 统一记录。
 *  ① 旧 wish(影片级打标)→ 记录档位;② 旧 plan(场次级排片)→ picks(档位并入影片级)。
 *  旧 key 不删 —— 留作回退,且不会再次触发(v2 存在即走上面分支)。 */
function migrateLegacy(filmKeyOf: (code: string) => string | null): void {
  const legacyPlan = readJson<{ code?: string; group?: string; priority?: string; note?: string }[]>(LS_PLAN_LEGACY);
  const legacyWish = readJson<Record<string, unknown>>(LS_WISH_LEGACY);
  if (!legacyPlan && !legacyWish) return;

  const ensure = (key: string): PickEntry => {
    let e = store.picks.get(key);
    if (!e) {
      e = { key, priority: null, picks: [], note: "" };
      store.picks.set(key, e);
    }
    return e;
  };

  if (legacyWish) {
    for (const [key, p] of Object.entries(legacyWish)) {
      if (!key || !isPriority(p)) continue;
      ensure(key).priority = p;
    }
  }
  if (Array.isArray(legacyPlan)) {
    for (const r of legacyPlan) {
      const code = typeof r?.code === "string" ? r.code : "";
      if (!code) continue;
      const key = filmKeyOf(code);
      if (!key) continue; // 排期里已没有这场(数据换版)→ 丢弃,避免造出无法定位的孤儿场次
      const e = ensure(key);
      if (!e.picks.some((s) => s.code === code)) e.picks.push({ code, group: isGroup(r.group) ? r.group : "A" });
      if (e.priority == null && isPriority(r.priority)) e.priority = r.priority;
      if (!e.note && typeof r.note === "string") e.note = r.note;
    }
  }
  saveLocal();
}

/* ---------- 云端初始化(启动时调用一次) ---------- */
export async function syncFromCloud(): Promise<void> {
  const [pickRows, mappingRows] = await Promise.all([api.getPick(), api.getMapping()]);
  if (pickRows) {
    store.online = true;
    // 云端为准合并;仅存在于本地(离线期间改动 / 首次迁移后尚未上云)的条目回推
    const remote = new Set(pickRows.map((r) => r.film_key));
    const localOnly = [...store.picks.values()].filter((e) => !remote.has(e.key));
    const merged = new Map(store.picks);
    for (const r of pickRows) {
      const picks: PickSlot[] = [];
      try {
        for (const s of JSON.parse(r.picks || "[]") as unknown[]) {
          if (!s || typeof s !== "object") continue;
          const sl = s as Partial<PickSlot>;
          if (typeof sl.code === "string" && sl.code && isGroup(sl.group)) picks.push({ code: sl.code, group: sl.group });
        }
      } catch {
        /* 坏 JSON 视作无场次,不阻断同步 */
      }
      merged.set(r.film_key, {
        key: r.film_key,
        priority: isPriority(r.priority) ? r.priority : null,
        picks,
        note: typeof r.note === "string" ? r.note : "",
      });
    }
    store.picks = merged;
    rebuildIndex();
    saveLocal();
    for (const e of localOnly) void api.putPick(e.key, { priority: e.priority, note: e.note, picks: e.picks });
  } else {
    store.online = false; // 纯静态环境:仅本地
  }
  if (mappingRows) {
    for (const r of mappingRows) {
      store.mappings.set(r.code, { code: r.code, subject_id: r.subject_id, title_cn: r.title_cn, douban_url: r.douban_url });
    }
  }
  pruneUnsetPicks(); // 云端可能带回脏记录(旧客户端写过的「未设 + 有场次」)→ 同步后立即清
  notify();
}

/* ---------- 变更入口(本地即时 + 云端异步) ---------- */

/** 设/清某影片的档位(全站唯一一份档位)。
 *  清成 null = 该片退出选片 → **整条删除(含全部场次)**。「无档位 + 有场次」是非法状态
 *  (档位是入选片单的必要条件,与「加入场次强制定档」互为兜底),不再保留「未设」记录。 */
export function setWish(key: string, priority: Priority | null): void {
  const cur = store.picks.get(key);
  if (!cur) {
    if (priority) commit(key, { key, priority, picks: [], note: "" });
    return;
  }
  if (cur.priority === priority) return;
  if (!priority) {
    commit(key); // 取消档位 → 整片移出(空壳 / 有场次 / 有备注一律删,「未设」不再是合法状态)
    return;
  }
  commit(key, { ...cur, priority });
}

/** 网格 / 详情弹层点选某场:已在 → 移出;不在 → 加入当前方案。
 *  记录不存在时按 initialPriority 建(未打标的片传 null = 未设档位,不再默认「备选」)。 */
export function toggleScreening(key: string, code: string, initialPriority: Priority | null = null): void {
  const cur = store.picks.get(key);
  if (!cur) {
    commit(key, { key, priority: initialPriority, picks: [{ code, group: store.group }], note: "" });
    return;
  }
  const has = cur.picks.some((p) => p.code === code);
  const picks = has ? cur.picks.filter((p) => p.code !== code) : [...cur.picks, { code, group: store.group }];
  if (!picks.length && cur.priority == null && !cur.note) {
    commit(key); // 只剩空壳 → 删记录
    return;
  }
  // 加入新场次时,若该片仍未定档且调用方给了档位 → 一并定档。第三参原本只在「记录不存在」分支生效,
  // 脏记录(未设 + 已有场次)会继续留 null → 「未设」就消灭不掉。这是强制定档的兜底半边。
  const priority = !has && cur.priority == null && initialPriority ? initialPriority : cur.priority;
  commit(key, { ...cur, priority, picks });
}

/** 行程行 ✕:只移除该场,记录保留(选片意向不丢 —— 该片仍留在「我的选片」里,标注「未排场」)。
 *  例外:该片从未打标(档位未设)且这是最后一场 → 记录已无意义,一并删除。 */
export function removeScreening(code: string): void {
  const hit = store.slotIndex.get(code);
  if (!hit) return;
  const cur = store.picks.get(hit.key);
  if (!cur) return;
  const picks = cur.picks.filter((p) => p.code !== code);
  if (!picks.length && cur.priority == null && !cur.note) {
    commit(cur.key);
    return;
  }
  commit(cur.key, { ...cur, picks });
}

/** 行程行三段 seg:按 code 反查影片 → 改影片档位(该片全部场次同步,这是「一套数据」的核心语义)。
 *  再点当前档 = null → 回到「未设」。 */
export function setPriorityOfCode(code: string, priority: Priority | null): void {
  const hit = store.slotIndex.get(code);
  if (!hit) return;
  setWish(hit.key, priority);
}

/** 翻转某场归属方案(A↔B) */
export function flipGroup(code: string): void {
  const hit = store.slotIndex.get(code);
  if (!hit) return;
  const cur = store.picks.get(hit.key);
  if (!cur) return;
  const picks = cur.picks.map((p) => (p.code === code ? { code: p.code, group: p.group === "A" ? ("B" as Group) : ("A" as Group) } : p));
  commit(hit.key, { ...cur, picks });
}

/** 整片移除(记录 + 其全部场次) */
export function removePick(key: string): void {
  commit(key);
}

/** 清理「未设档位 + 有场次」的非法记录(强制定档上线前的存量脏数据)。
 *  档位是入选片单的必要条件 → 这类记录整条删除(本地 + 云端 DELETE);有档位 / 无场次的一律不动。
 *  载入与云端同步后各跑一次,幂等 —— 运行期不会再产生,故不需要迁移脚本。 */
export function pruneUnsetPicks(): void {
  for (const e of [...store.picks.values()]) {
    if (e.priority == null && e.picks.length > 0) commit(e.key);
  }
}

/** 整组替换为给定选片(§13.4 M2.5「采纳建议」):先清掉该方案现有场次,再按建议落场次 + 档位。
 *  只动 g 组 —— 另一方案的场次与影片档位不受影响(档位随后被建议覆盖为该片新档位)。 */
export function replaceGroup(g: Group, picks: { key: string; code: string; priority: Priority }[]): void {
  for (const e of [...store.picks.values()]) {
    const rest = e.picks.filter((p) => p.group !== g);
    if (rest.length === e.picks.length) continue;
    if (!rest.length && e.priority == null && !e.note) commit(e.key);
    else commit(e.key, { ...e, picks: rest });
  }
  for (const { key, code, priority } of picks) {
    const cur = store.picks.get(key);
    if (!cur) {
      commit(key, { key, priority, picks: [{ code, group: g }], note: "" });
      continue;
    }
    const next = cur.picks.some((p) => p.code === code) ? cur.picks : [...cur.picks, { code, group: g }];
    commit(key, { ...cur, priority, picks: next });
  }
}

/** 清空全部已排场次(A+B 两方案)。影片打标 / 选片意向保留 ——
 *  没排场的片仍留在「我的选片」里(标注「未排场」),不会被一起清掉。 */
export function clearScreeningSlots(): void {
  for (const e of [...store.picks.values()]) {
    if (!e.picks.length) continue;
    if (e.priority == null && !e.note) commit(e.key);
    else commit(e.key, { ...e, picks: [] });
  }
}

export function setCurrentGroup(g: Group): void {
  store.group = g;
  notify();
}

export function setSettings(patch: Partial<Settings>): void {
  store.settings = { ...store.settings, ...patch };
  saveSettingsLocal();
  notify();
}

/** 甘特缩放倍率:只落盘、**不 notify** —— 缩放只影响网格,让 renderAll 重建行程/角标是白干,
 *  且重建时机由调用方掌握(要先按旧刻度算好锚点再改倍率)。重绘由 main 侧自己调 renderGrid()。 */
export function setZoom(z: number): void {
  store.settings = { ...store.settings, zoom: z };
  saveSettingsLocal();
}

function saveSettingsLocal(): void {
  try {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(store.settings));
  } catch {
    /* ignore */
  }
}

export function loadSettings(): void {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (raw) store.settings = { ...store.settings, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* ignore */
  }
}
