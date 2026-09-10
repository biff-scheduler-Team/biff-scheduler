// 应用状态:我的排片 / 豆瓣映射 / 方案与设置
// 本地优先(localStorage 即时生效),D1 云端尽力同步;API 不可用时自动降级本地。

import type { Group, Mapping, PlanEntry, Priority, Settings } from "./types";
import { api } from "./api";

const LS_PLAN = "biff.plan.v1";
const LS_SETTINGS = "biff.settings.v1";
const LS_WISH = "biff.wish.v1";
const LS_GV_TALK = "biff.gvtalk.v1"; // GV 映后谈单场覆写(code → 是否参加);缺省跟随 Settings.gvTalkOn

export const store = {
  plan: new Map<string, PlanEntry>(),
  mappings: new Map<string, Mapping>(),
  group: "A" as Group,
  settings: { alarmMin: 45, transitMin: 0, gvTalkOn: true } as Settings,
  online: true,
};

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

/** M2.5「AI 排片」想看打标:影片节点 key(cat:<id> / sched:<片名>)→ 优先级;localStorage 持久 */
export const wish = new Map<string, Priority>();

export function loadWish(): void {
  try {
    const raw = localStorage.getItem(LS_WISH);
    if (!raw) return;
    for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, string>)) {
      if (v === "must" || v === "maybe" || v === "wild") wish.set(k, v as Priority);
    }
  } catch {
    /* ignore */
  }
}

export function setWish(key: string, priority: Priority | null): void {
  if (priority) wish.set(key, priority);
  else wish.delete(key);
  try {
    localStorage.setItem(LS_WISH, JSON.stringify(Object.fromEntries(wish)));
  } catch {
    /* ignore */
  }
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

/* ---------- 本地持久化 ---------- */
function saveLocal(): void {
  try {
    localStorage.setItem(LS_PLAN, JSON.stringify([...store.plan.values()]));
  } catch {
    /* ignore */
  }
}
function saveSettingsLocal(): void {
  try {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(store.settings));
  } catch {
    /* ignore */
  }
}

/* ---------- 云端初始化(启动时调用一次) ---------- */
export async function syncFromCloud(): Promise<void> {
  const [planRows, mappingRows] = await Promise.all([api.getPlan(), api.getMapping()]);
  if (planRows) {
    store.online = true;
    // 云端为准合并;仅存在于本地(如离线期间改动)的条目回推云端
    const remote = new Set(planRows.map((r) => r.code));
    const localOnly = [...store.plan.keys()].filter((c) => !remote.has(c));
    const merged = new Map(store.plan);
    for (const r of planRows) {
      merged.set(r.code, { code: r.code, group: r.group_tag, priority: r.priority, note: r.note });
    }
    store.plan = merged;
    for (const c of localOnly) {
      const e = store.plan.get(c);
      if (e) void api.putPlan(c, { group_tag: e.group, priority: e.priority, note: e.note });
    }
  } else {
    store.online = false; // 纯静态环境:仅本地
  }
  if (mappingRows) {
    for (const r of mappingRows) {
      store.mappings.set(r.code, { code: r.code, subject_id: r.subject_id, title_cn: r.title_cn, douban_url: r.douban_url });
    }
  }
  notify();
}

/* ---------- 变更入口(本地即时 + 云端异步) ---------- */
function persist(code: string, entry?: PlanEntry): void {
  if (entry) store.plan.set(code, entry);
  else store.plan.delete(code);
  saveLocal();
  notify();
  pushCloud(code, entry);
}

async function pushCloud(code: string, entry?: PlanEntry): Promise<void> {
  if (!store.online) return;
  const ok = entry
    ? await api.putPlan(code, { group_tag: entry.group, priority: entry.priority, note: entry.note })
    : await api.deletePlan(code);
  if (!ok) {
    store.online = false;
    notify();
  }
}

export function toggleCode(code: string): void {
  const existing = store.plan.get(code);
  if (existing && existing.group === store.group) {
    persist(code); // 同方案内再点 = 移除
  } else {
    persist(code, { code, group: store.group, priority: existing?.priority ?? "maybe", note: existing?.note ?? "" });
  }
}

export function removeCode(code: string): void {
  persist(code);
}

/** 直接设某场优先级(§14 2c 三段 seg 用,替代原循环 chip) */
export function setPriority(code: string, priority: Priority): void {
  const e = store.plan.get(code);
  if (!e || e.priority === priority) return;
  persist(code, { ...e, priority });
}

/** 整组替换为给定选片(§13.4 M2.5「采纳建议」):组内不在清单里的移除,清单内按新优先级落盘 */
export function replaceGroup(g: Group, picks: { code: string; priority: Priority }[]): void {
  const want = new Map(picks.map((p) => [p.code, p.priority]));
  let changed = false;
  for (const [code, e] of [...store.plan]) {
    if (e.group !== g) continue;
    const p = want.get(code);
    if (p === undefined) {
      store.plan.delete(code);
      saveLocal();
      changed = true;
      void pushCloud(code);
    } else if (p !== e.priority) {
      const ne = { ...e, priority: p };
      store.plan.set(code, ne);
      saveLocal();
      changed = true;
      void pushCloud(code, ne);
      want.delete(code);
    } else {
      want.delete(code);
    }
  }
  for (const [code, priority] of want) {
    const ne: PlanEntry = { code, group: g, priority, note: store.plan.get(code)?.note ?? "" };
    store.plan.set(code, ne);
    saveLocal();
    changed = true;
    void pushCloud(code, ne);
  }
  if (changed) notify();
}

export function flipGroup(code: string): void {
  const e = store.plan.get(code);
  if (!e) return;
  persist(code, { ...e, group: e.group === "A" ? "B" : "A" });
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

export function loadSettings(): void {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (raw) store.settings = { ...store.settings, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* ignore */
  }
}

export function clearPlan(): void {
  const codes = [...store.plan.keys()];
  store.plan.clear();
  saveLocal();
  notify();
  if (store.online) codes.forEach((c) => void api.deletePlan(c));
}
