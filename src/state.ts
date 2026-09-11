// 应用状态:选片记录(影片级) / 豆瓣映射 / 方案与设置。
//
// 单一数据源 = store.picks:「我的选片」(按片看)与「我的行程」(按场次看)是同一份数据的两个视图。
// 档位只有一份且在影片级 —— 行程行改档位 = 改该片档位,两个视图永不打架(旧版 wish + plan 两套已合并)。
//
// ★ 存储分工(2026-09-11,PLAN-20260911001107):
//   · **片单(选片 / 排片)只存 localStorage** `biff.picks.v2` —— 不写云端,刷新 / 部署都不会「复活」;
//   · **豆瓣映射 = 静态产物** `public/douban.json`(见 data.ts)—— 全站**已无任何云端读写**;
//     文件留空即「零映射」,弹层 / 影片库走中英文搜索兜底。
//   历史:片单曾双写 D1 `user_pick`、映射曾存 D1 `douban_map` —— 两次都因「部署换 origin、云端为准」
//   造成数据复活 / 覆盖,现已全部退役(前端不再 fetch 任何后端)。

import type { Group, Mapping, PickEntry, PickSlot, Priority, Settings } from "./types";
import { loadDoubanMappings } from "./data";

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
  /** 派生索引:场次 code → { 影片 key, 方案 }。每次变更**原地重建**,供网格/行程/弹层 O(1) 反查。
   *  ⚠ 原地(clear + set)而不是整体换新 Map:视图层会把这个引用存进 ctx(如 grid 的 `slots`),
   *  整体换新会让持有者读到点选前的快照(见 `modal.ts::actState` 注释)。 */
  slotIndex: new Map<string, { key: string; group: Group }>(),
  /** 派生索引:方案 → 该方案全部场次 code。`codesOfGroup()` O(1) 取用,避免每次全量遍历 picks */
  groupIndex: new Map<Group, string[]>(),
  mappings: new Map<string, Mapping>(),
  group: "A" as Group,
  settings: { alarmMin: 45, transitMin: 0, gvTalkOn: true, gvTalkMin: 25 } as Settings,
};

/* ---------- 派生查询(视图层只读这些,不再自己遍历 picks) ---------- */

/** 该场是否已选 / 归属方案 */
export function slotOf(code: string): { key: string; group: Group } | undefined {
  return store.slotIndex.get(code);
}

/** 某方案下的全部场次 code —— 读派生索引(O(1));**返回内部数组,调用方只读** */
export function codesOfGroup(g: Group): string[] {
  return store.groupIndex.get(g) ?? [];
}

/** 某场对应的影片档位(行程行三段 seg 读它);未选场次 → undefined */
export function priorityOfCode(code: string): Priority | null | undefined {
  const hit = store.slotIndex.get(code);
  return hit ? store.picks.get(hit.key)?.priority : undefined;
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
  scheduleNotify("picks"); // 谈块状态 / 紧转场 / 行程行都随之变
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
  scheduleNotify("settings"); // 映后时长改的是几何(轴末 / 谈块宽度)→ 归 settings,网格必须重建
}

/** 变更域 —— 让订阅方**按域过滤**重绘,避免「切个主题也重建整张网格 / 整个抽屉」。
 *
 *  ⚠ 域只回答「**哪一类**数据变了」,不回答「哪个具体值变了」:
 *    订阅方若无法判定「本域一定不影响我」,就应当照常重绘(宁可多刷,不可漏刷)。 */
export type ChangeDomain =
  /** 选片 / 排片 / 档位 / GV 单场覆写 —— 网格、行程、抽屉计数全要刷 */
  | "picks"
  /** 当前方案 A/B */
  | "group"
  /** 设置(转场缓冲 / 提醒提前量 / GV 默认 / 缩放) */
  | "settings"
  /** **仅外观**(跟随系统 / 亮色 / 暗色)—— 全站配色由 CSS token 驱动,结构不依赖主题 */
  | "theme"
  /** 豆瓣映射载入完成(影响卡片标题里的中文名) */
  | "mappings"
  /** 未分类 / 多域合并 —— 订阅方按「全刷」处理 */
  | "all";

export type Listener = (domain: ChangeDomain) => void;
const listeners = new Set<Listener>();
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function notify(domain: ChangeDomain = "all"): void {
  listeners.forEach((fn) => {
    try {
      fn(domain);
    } catch (e) {
      // ⚠ 单个订阅方抛错**不得**让其余订阅方静默不刷新 —— 那会表现为「状态改了但界面没动」,
      //    且因为没有用户可见报错,极难定位(2026-09-11 实测踩过:网格 patch 抛 InvalidCharacterError,
      //    抽屉订阅方连带不执行,计数一直停在旧值)。这里兜住并显式打日志。
      console.error("[biff] 订阅方重绘失败(其余订阅方继续)", e);
    }
  });
}

/** 同一微任务内的多次广播合并成一次 —— 批量改动(清空全部 / 批量采纳)只触发一次重绘。
 *  同批次里出现多个不同域 → 合并成 `"all"`(订阅方无法安全地按单域过滤)。
 *  ⚠ 启动期的显式 `notify()`(loadMappings 等)仍是同步广播:调用方需要它立刻生效。 */
let pendingDomains: Set<ChangeDomain> | null = null;
function scheduleNotify(domain: ChangeDomain): void {
  if (!pendingDomains) {
    pendingDomains = new Set<ChangeDomain>();
    queueMicrotask(() => {
      const set = pendingDomains ?? new Set<ChangeDomain>(["all"]);
      pendingDomains = null;
      notify(set.size === 1 ? [...set][0] : "all");
    });
  }
  pendingDomains.add(domain);
}

/* ---------- 本地持久化 + 派生索引 ---------- */
function saveLocal(): void {
  try {
    localStorage.setItem(LS_PICKS, JSON.stringify([...store.picks.values()]));
  } catch {
    /* ignore */
  }
}

/** 由 picks 重建派生索引(**原地**更新 slotIndex,见 store.slotIndex 注释)。
 *  唯一写点:所有变更都经 `commit()` / `mutate()`。 */
function rebuildIndex(): void {
  store.slotIndex.clear();
  const byGroup: Record<Group, string[]> = { A: [], B: [] };
  for (const e of store.picks.values()) {
    for (const p of e.picks) {
      store.slotIndex.set(p.code, { key: e.key, group: p.group });
      byGroup[p.group].push(p.code);
    }
  }
  store.groupIndex.set("A", byGroup.A);
  store.groupIndex.set("B", byGroup.B);
}

/** 空壳记录(无场次 / 无档位 / 无备注)= 已无意义 → 可整条删除 */
function isOrphan(e: PickEntry): boolean {
  return e.picks.length === 0 && e.priority == null && !e.note;
}

/** 记录变更统一出口:落本地 → 重建索引 → 广播(广播合并到微任务)。
 *  entry 省略 = 删除该条记录(其场次随之消失)。
 *  ⚠ 片单**不推云端**(2026-09-10,PLAN-20260910235630):落盘即完成,没有异步回写 ——
 *    这正是「清空后刷新 / 部署都不会复活」的保证。 */
function commit(key: string, entry?: PickEntry): void {
  if (entry) store.picks.set(key, entry);
  else store.picks.delete(key);
  saveLocal();
  rebuildIndex();
  scheduleNotify("picks");
}

/** 批量变更出口:`fn` 内直接改 `store.picks`,结束后**只落盘 / 重建索引 / 广播一次**。
 *  用于清空 / 批量采纳这类 O(n) 改动 —— 逐条 `commit()` 是 O(n²) 写盘 + n 次全量重渲染。 */
function mutate(fn: () => void): void {
  fn();
  saveLocal();
  rebuildIndex();
  scheduleNotify("picks");
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
}

/** 一次性迁移:旧两套 → 统一记录。
 *  ① 旧 wish(影片级打标)→ 记录档位;② 旧 plan(场次级排片)→ picks(档位并入影片级)。
 *  ★ 迁移完成后**删除旧 key**(2026-09-10,PLAN-20260910235630):原先「不删,留作回退」是怕新结构出问题,
 *  但旧 key 会在 `biff.picks.v2` 被清掉时**重新合成出排片与选片**(第二个「数据复活」源)。
 *  现在 v2 是唯一源、且设置里有显式清空入口,回退需求已消失。 */
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
  // 旧 key 用完即删(见上方注释):否则 v2 一旦缺失,旧数据会重新合成出排片 / 选片。
  try {
    localStorage.removeItem(LS_PLAN_LEGACY);
    localStorage.removeItem(LS_WISH_LEGACY);
  } catch {
    /* ignore */
  }
}

/* ---------- 豆瓣映射加载(启动时调用一次) ----------
 * 2026-09-11 起映射是**静态产物**(`public/douban.json`,见 data.ts):没有云端、也没有写入口。
 * 文件留空 = 零映射,全站走中英文搜索兜底。只灌 `store.mappings`,**不动 `store.picks`**。 */
export async function loadMappings(): Promise<void> {
  for (const r of await loadDoubanMappings()) {
    store.mappings.set(r.code, r);
  }
  notify("mappings");
}

/* ---------- 变更入口(本地即时 + 云端异步) ---------- */

/** 设/清某影片的档位(全站唯一一份档位)。
 *  清成 null 且该片已无场次 → 整条记录删除;有场次则保留(回到「未设档位」)。 */
export function setWish(key: string, priority: Priority | null): void {
  const cur = store.picks.get(key);
  if (!cur) {
    if (priority) commit(key, { key, priority, picks: [], note: "" });
    return;
  }
  if (cur.priority === priority) return;
  if (!priority && isOrphan({ ...cur, priority: null })) {
    commit(key); // 空壳(只打标、无场次、无备注)取消 → 删记录
    return;
  }
  commit(key, { ...cur, priority });
}

/** 网格 / 影片库场次行点选某场:已在 → 移出;不在 → 加入当前方案。
 *  记录不存在时按 initialPriority 建(未打标的片传 null = 未设档位,不再默认「备选」)。 */
export function toggleScreening(key: string, code: string, initialPriority: Priority | null = null): void {
  const cur = store.picks.get(key);
  if (!cur) {
    commit(key, { key, priority: initialPriority, picks: [{ code, group: store.group }], note: "" });
    return;
  }
  const has = cur.picks.some((p) => p.code === code);
  const picks = has ? cur.picks.filter((p) => p.code !== code) : [...cur.picks, { code, group: store.group }];
  if (isOrphan({ ...cur, picks })) {
    commit(key); // 只剩空壳 → 删记录
    return;
  }
  commit(key, { ...cur, picks });
}

/** 行程行 ✕:只移除该场,记录保留(选片意向不丢 —— 该片仍留在「我的选片」里,标注「未排场」)。
 *  例外:该片从未打标(档位未设)且这是最后一场 → 记录已无意义,一并删除。 */
export function removeScreening(code: string): void {
  const hit = store.slotIndex.get(code);
  if (!hit) return;
  const cur = store.picks.get(hit.key);
  if (!cur) return;
  const picks = cur.picks.filter((p) => p.code !== code);
  if (isOrphan({ ...cur, picks })) {
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

/** 把一批场次**追加**进方案 g(§13.4 M2.5「采纳建议」)。**不清空已有场次** ——
 *  另一方案的场次与 g 的现有场次都不动,故「先排 9/19、再排 9/20」可以累积。
 *  (旧 `replaceGroup` 是整组替换:第二次采纳会把第一次的场次一起清掉 —— 即用户报的「覆盖」bug。)
 *  去重口径:该片在 g 里已有场次 → 跳过(每片一场,且保证幂等:重复采纳同一份建议不长出重复场次);
 *  「同片已有 / 与 g 现有场次冲突」由 `ai.ts::planMerge()` 在调用前按网格同口径剔除。
 *  `priority` 传 `null` = **「未设」**(无片单模式:用户从没给这些片打标,不该替他编一个档位);
 *  此时若该片已有档位则**保留原档位**,不抹掉。
 *  返回实际加入的场次数,供 UI 回执。 */
export function addGroupPicks(
  g: Group,
  picks: { key: string; code: string; priority: Priority | null }[]
): number {
  let added = 0;
  mutate(() => {
    for (const { key, code, priority } of picks) {
      const cur = store.picks.get(key);
      if (!cur) {
        store.picks.set(key, { key, priority, picks: [{ code, group: g }], note: "" });
        added++;
        continue;
      }
      if (cur.picks.some((p) => p.group === g)) continue;
      store.picks.set(key, { ...cur, priority: priority ?? cur.priority, picks: [...cur.picks, { code, group: g }] });
      added++;
    }
  });
  return added;
}

/** 清空全部已排场次(A+B 两方案)。影片打标 / 选片意向保留 ——
 *  没排场的片仍留在「我的选片」里(标注「未排场」),不会被一起清掉。 */
export function clearScreeningSlots(): void {
  mutate(() => {
    for (const e of [...store.picks.values()]) {
      if (!e.picks.length) continue;
      if (isOrphan({ ...e, picks: [] })) store.picks.delete(e.key);
      else store.picks.set(e.key, { ...e, picks: [] });
    }
  });
}

/** **清空全部**(选片 + 排片):把每条记录整条删掉 —— 档位 / 备注 / 已排场次一起清。
 *  与 `clearScreeningSlots()`(只清场次、保留选片意向)的区别就是「要不要连选片一起清」。
 *  片单已本地化(2026-09-10,PLAN-20260910235630),故这里**纯本地删除** ——
 *  不存在「云端把旧数据同步回来」的可能(旧 `user_pick` 云端表已退役)。 */
export function clearAllPicks(): void {
  mutate(() => store.picks.clear());
}

export function setCurrentGroup(g: Group): void {
  store.group = g;
  scheduleNotify("group");
}

export function setSettings(patch: Partial<Settings>): void {
  store.settings = { ...store.settings, ...patch };
  saveSettingsLocal();
  // 只有 theme 一个键时归 "theme" 域 —— 外观切换不影响任何结构(配色全走 CSS token),
  // 订阅方可据此跳过网格 / 抽屉重绘。其余设置项一律 "settings"(宁可多刷)。
  const keys = Object.keys(patch);
  scheduleNotify(keys.length === 1 && keys[0] === "theme" ? "theme" : "settings");
}

/** 甘特缩放倍率(横纵共用的整体等比倍率):只落盘、**不 notify** —— 缩放只影响网格,让 renderAll
 *  重建行程/角标是白干,且重建时机由调用方掌握(要先按旧倍率算好锚点再改倍率)。重绘由 main 侧 renderGrid()。 */
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
