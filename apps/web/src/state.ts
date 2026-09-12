import { writeWorkspaceItem, removeWorkspaceItem } from "./workspace-storage";
// 应用状态:选片记录 / 抢票顺位 / 豆瓣映射 / 设置。
//
// 单一数据源 = store.picks:「我的选片」(按片看)与「我的行程」(按场次看)是同一份数据的两个视图。
//
// ★ 存储分工(2026-09-11,PLAN-20260911001107):
//   · **片单(选片 / 排片)只存 localStorage** `biff.picks.v2` —— 不写云端,刷新 / 部署都不会「复活」;
//   · **豆瓣映射 = 静态产物** `public/douban.json`(见 data.ts)—— 全站**已无任何云端读写**;
//     文件留空即「零映射」,弹层 / 影片库走中英文搜索兜底。
//   历史:片单曾双写 D1 `user_pick`、映射曾存 D1 `douban_map` —— 两次都因「部署换 origin、云端为准」
//   造成数据复活 / 覆盖,现已全部退役(前端不再 fetch 任何后端)。
//
// ★ **档位(必看 / 备选 / 随缘)已于 2026-09-11 整体删除**(`PLAN-20260911223000`):
//   冲突决策改由**场次级「抢票顺位」**承担(拖动冲突组内的场次排序,见 `plans.ts`),
//   档位在非冲突场景里只剩排序噪声,两套排序机制并存只会互相打架。

import type { Mapping, PickEntry, PickSlot, Settings } from "./types";
import { loadDoubanMappings } from "./data";

const LS_PICKS = "biff.picks.v2";
const LS_SETTINGS = "biff.settings.v1";
const LS_GV_TALK = "biff.gvtalk.v1"; // GV 映后谈单场覆写(code → 是否参加);缺省跟随 Settings.gvTalkOn
const LS_GV_TALK_MIN = "biff.gvtalkmin.v1"; // GV 映后谈单场时长覆写(code → 分钟);缺省跟随 Settings.gvTalkMin
const LS_AGENDA_FOLD = "biff.agendafold.v1"; // 「我的行程」按日收起:已收起的日期集合(纯视图偏好,独立键)
const LS_RANKS = "biff.ranks.v1"; // 抢票顺位:场次 code → 组内序号(1-based);独立键,与 gvtalk 同口径
/** 旧版数据的 localStorage key —— 仅作一次性迁移源(迁移后即删) */
const LS_PLAN_LEGACY = "biff.plan.v1";
const LS_WISH_LEGACY = "biff.wish.v1";

export const store = {
  /** 唯一数据源:影片 key(filmNodeKey)→ 选片记录 */
  picks: new Map<string, PickEntry>(),
  /** 派生索引:场次 code → 影片 key。每次变更**原地重建**,供网格/行程/弹层 O(1) 反查。
   *  ⚠ 原地(clear + set)而不是整体换新 Map:视图层会把这个引用存进 ctx(如 grid 的 `slots`),
   *  整体换新会让持有者读到点选前的快照(见 `modal.ts::actState` 注释)。 */
  slotIndex: new Map<string, { key: string }>(),
  /** 派生索引:全部已排场次 code。`allCodes()` O(1) 取用,避免每次全量遍历 picks */
  allIndex: [] as string[],
  mappings: new Map<string, Mapping>(),
  settings: { alarmMin: 45, transitMin: 0, gvTalkOn: true, gvTalkMin: 25 } as Settings,
};

/* ---------- 派生查询(视图层只读这些,不再自己遍历 picks) ---------- */

/** 该场是否已选 / 属于哪部影片 */
export function slotOf(code: string): { key: string } | undefined {
  return store.slotIndex.get(code);
}

/** 全部已排场次 code —— 读派生索引(O(1));**返回内部数组,调用方只读** */
export function allCodes(): string[] {
  return store.allIndex;
}

/* ---------- 抢票顺位(场次级,2026-09-11,PLAN-20260911223000) ----------
 * 场次 code → 组内序号(1-based)。**只在冲突组内有意义** —— 它回答的是
 * 「同一时间带互相重叠的几场,先保哪一场」,顺序即方案编号(见 `plans.ts`)。
 *
 * ⚠ 存的是**用户拖出来的次序**,不是绝对值:每次拖完都由 `setRanks()` 把该组整组归一成 1..n,
 *   所以「删掉组内一场」不会留下空洞(下一次拖拽 / 渲染即重新归一)。
 * ⚠ 独立 localStorage 键(`biff.ranks.v1`,与 `biff.gvtalk.v1` 同口径)—— 视图偏好不混进
 *   `biff.settings.v1`,「重置设置」不会顺手把顺位带走。
 * ⚠ 场次被移出行程后其顺位由 `rebuildIndex()` 就地 prune(否则换版 / 重排后残留脏数据)。 */
export const rankOf = new Map<string, number>();

export function loadRanks(): void {
  try {
    const raw = localStorage.getItem(LS_RANKS);
    if (!raw) return;
    for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 1) rankOf.set(k, Math.round(v));
    }
  } catch {
    /* ignore */
  }
}

function saveRanks(): void {
  try {
    writeWorkspaceItem(LS_RANKS, JSON.stringify(Object.fromEntries(rankOf)));
  } catch {
    /* ignore */
  }
}

/** 某场的顺位;未设 / 不在冲突组 → undefined */
export function rankOfCode(code: string): number | undefined {
  return rankOf.get(code);
}

/** 把一组场次按给定次序写成顺位 1..n(冲突组内拖动排序的唯一出口)。
 *  只动这一组的 code —— 别的组的顺位不受影响。广播 `"picks"`:行程 / 方案对比 / 冲突角标都随之刷新。 */
export function setRanks(codes: string[]): void {
  let changed = false;
  codes.forEach((code, i) => {
    if (rankOf.get(code) !== i + 1) {
      rankOf.set(code, i + 1);
      changed = true;
    }
  });
  if (!changed) return;
  saveRanks();
  scheduleNotify("picks");
}

/* (原「抢票结果」三态状态已于 2026-09-11 删除 —— 抢票在票务系统里完成,
 *  在排片工具里追踪「已抢到 / 售罄」是多余的中间态;冲突组仍保留聚合与顺位排序。) */

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
    writeWorkspaceItem(LS_GV_TALK, JSON.stringify(Object.fromEntries(gvTalk)));
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
    writeWorkspaceItem(LS_GV_TALK_MIN, JSON.stringify(Object.fromEntries(gvTalkMinOv)));
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

/* ---------- 「我的行程」按日收起(2026-09-11) ----------
 * 纯视图偏好:只回答「这一天在行程里折不折」,不碰选片 / 排片数据 —— 收起 ≠ 取消选片。
 * 独立 localStorage 键(与 `biff.gvtalk.v1` / 抽屉宽度同口径):不进 Settings,
 * 「清空 / 重置设置」不会顺手把折叠状态带走。 */

/** 已收起的日期集合(ISO 日期字符串,如 "2026-09-17") */
export const agendaFolded = new Set<string>();

export function loadAgendaFold(): void {
  try {
    const raw = localStorage.getItem(LS_AGENDA_FOLD);
    if (!raw) return;
    const rows = JSON.parse(raw) as unknown;
    if (!Array.isArray(rows)) return;
    for (const d of rows) if (typeof d === "string" && d) agendaFolded.add(d);
  } catch {
    /* ignore */
  }
}

function saveAgendaFold(): void {
  try {
    writeWorkspaceItem(LS_AGENDA_FOLD, JSON.stringify([...agendaFolded]));
  } catch {
    /* ignore */
  }
}

/** 该日期在行程里是否已收起 */
export function isAgendaFolded(date: string): boolean {
  return agendaFolded.has(date);
}

/** 收起 / 展开行程中的某一天(点日期头左侧的折叠箭头)。
 *  广播 `"agenda"` 域 —— 只有抽屉会重绘,网格 / 顶栏 / 角标全部跳过(纯抽屉内视图折叠)。 */
export function toggleAgendaFold(date: string): void {
  if (agendaFolded.has(date)) agendaFolded.delete(date);
  else agendaFolded.add(date);
  saveAgendaFold();
  scheduleNotify("agenda");
}

/** 变更域 —— 让订阅方**按域过滤**重绘,避免「切个主题也重建整张网格 / 整个抽屉」。
 *
 *  ⚠ 域只回答「**哪一类**数据变了」,不回答「哪个具体值变了」:
 *    订阅方若无法判定「本域一定不影响我」,就应当照常重绘(宁可多刷,不可漏刷)。 */
export type ChangeDomain =
  /** 选片 / 排片 / 档位 / GV 单场覆写 —— 网格、行程、抽屉计数全要刷 */
  | "picks"
  /** 设置(转场缓冲 / 提醒提前量 / GV 默认 / 缩放) */
  | "settings"
  /** **仅外观**(跟随系统 / 亮色 / 暗色)—— 全站配色由 CSS token 驱动,结构不依赖主题 */
  | "theme"
  /** 豆瓣映射载入完成(影响卡片标题里的中文名) */
  | "mappings"
  /** **仅「我的行程」视图**(按日收起 / 展开)—— 抽屉重绘即可,网格 / 顶栏 / 角标不受影响 */
  | "agenda"
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
    writeWorkspaceItem(LS_PICKS, JSON.stringify([...store.picks.values()]));
  } catch {
    /* ignore */
  }
}

/** 由 picks 重建派生索引(**原地**更新 slotIndex,见 store.slotIndex 注释)。
 *  唯一写点:所有变更都经 `commit()` / `mutate()`。
 *  ★ 顺带 prune `rankOf`:场次被移出行程后它的顺位已无意义,留着会在换版 / 重排后
 *    把「上一轮的次序」当成用户意图(且 localStorage 只增不减)。 */
function rebuildIndex(): void {
  store.slotIndex.clear();
  const codes: string[] = [];
  for (const e of store.picks.values()) {
    for (const p of e.picks) {
      store.slotIndex.set(p.code, { key: e.key });
      codes.push(p.code);
    }
  }
  store.allIndex = codes;
  let pruned = false;
  for (const code of [...rankOf.keys()]) {
    if (store.slotIndex.has(code)) continue;
    rankOf.delete(code);
    pruned = true;
  }
  if (pruned) saveRanks();
}

/** 空壳记录(无场次 / 无备注)= 已无意义 → 可整条删除 */
function isOrphan(e: PickEntry): boolean {
  return e.picks.length === 0 && !e.note;
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

/** 校验并灌入一批记录(本地 / 云端共用;非法字段一律兜底,绝不抛)
 *  ⚠ 旧数据里的 `group`(方案 A/B)与 `priority`(档位)字段都已废弃 —— 只取 code / note,其余忽略(零迁移)。 */
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
        if (typeof sl.code === "string" && sl.code) picks.push({ code: sl.code });
      }
    }
    store.picks.set(key, {
      key,
      picks,
      note: typeof r.note === "string" ? r.note : "",
    });
    n++;
  }
  return n;
}

/** 载入选片记录。localStorage 无 v2 数据时,从旧「plan(场次级)」合成一次。
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

/** 一次性迁移:旧 plan(场次级排片)→ 统一记录。
 *  ⚠ 旧 `wish`(影片级档位)自 2026-09-11 起**不再迁移** —— 档位概念已整体删除
 *  (`PLAN-20260911223000`),没有可落的字段;只保留 plan 里的场次与备注。
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
      e = { key, picks: [], note: "" };
      store.picks.set(key, e);
    }
    return e;
  };

  if (Array.isArray(legacyPlan)) {
    for (const r of legacyPlan) {
      const code = typeof r?.code === "string" ? r.code : "";
      if (!code) continue;
      const key = filmKeyOf(code);
      if (!key) continue; // 排期里已没有这场(数据换版)→ 丢弃,避免造出无法定位的孤儿场次
      const e = ensure(key);
      if (!e.picks.some((s) => s.code === code)) e.picks.push({ code });
      if (!e.note && typeof r.note === "string") e.note = r.note;
    }
  }
  saveLocal();
  // 旧 key 用完即删(见上方注释):否则 v2 一旦缺失,旧数据会重新合成出排片 / 选片。
  try {
    removeWorkspaceItem(LS_PLAN_LEGACY);
    removeWorkspaceItem(LS_WISH_LEGACY);
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

/* ---------- 变更入口(本地即时) ---------- */

/** 「＋ 加入我的选片」:只把**影片**挂进选片清单,**不落任何场次**(2026-09-11 流程改版)。
 *
 *  为什么需要它:流程是「影片库 = 选片 → 我的选片 = 挑场次」两步 ——
 *  「把这部片收进清单」与「排下这一场」是两个动作,前者需要一个只建记录的落点。
 *  幂等:已在清单里则原样返回(记录里的场次 / 备注都不动)。 */
export function addPickFilm(key: string): void {
  if (store.picks.has(key)) return;
  commit(key, { key, picks: [], note: "" });
}

/** 网格 / 影片库场次行点选某场:已在 → 移出;不在 → 加入行程。 */
export function toggleScreening(key: string, code: string): void {
  const cur = store.picks.get(key);
  if (!cur) {
    commit(key, { key, picks: [{ code }], note: "" });
    return;
  }
  const has = cur.picks.some((p) => p.code === code);
  const picks = has ? cur.picks.filter((p) => p.code !== code) : [...cur.picks, { code }];
  if (isOrphan({ ...cur, picks })) {
    commit(key); // 只剩空壳 → 删记录
    return;
  }
  commit(key, { ...cur, picks });
}

/** 行程行 ✕:只移除该场,记录保留(该片仍留在「我的选片」里,标注「未排场」)。
 *  例外:这是该片最后一场且无备注 → 记录已无意义,一并删除。 */
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

/** 整片移除(记录 + 其全部场次) */
export function removePick(key: string): void {
  commit(key);
}

/** 清空全部已排场次。选片意向保留 —— 没排场的片仍留在「我的选片」里(标注「未排场」)。
 *  顺位随之被 `rebuildIndex()` prune(已无场次可排序)。 */
export function clearScreeningSlots(): void {
  mutate(() => {
    for (const e of [...store.picks.values()]) {
      if (!e.picks.length) continue;
      if (isOrphan({ ...e, picks: [] })) store.picks.delete(e.key);
      else store.picks.set(e.key, { ...e, picks: [] });
    }
  });
}

/** **清空全部**(选片 + 排片):把每条记录整条删掉 —— 备注 / 已排场次一起清。
 *  与 `clearScreeningSlots()`(只清场次、保留选片意向)的区别就是「要不要连选片一起清」。
 *  片单已本地化(2026-09-10,PLAN-20260910235630),故这里**纯本地删除** ——
 *  不存在「云端把旧数据同步回来」的可能(旧 `user_pick` 云端表已退役)。 */
export function clearAllPicks(): void {
  mutate(() => store.picks.clear());
}

/** 把一批场次 code 挂进 `store.picks`(调用方负责用 `mutate` 包裹)。
 *  `keyOf` 返回 null(排期换版查不到该 code)→ 静默跳过;已在行程里的不重复加。 */
function attachScreenings(codes: string[], keyOf: (code: string) => string | null): void {
  for (const code of codes) {
    const key = keyOf(code);
    if (!key) continue;
    const cur = store.picks.get(key);
    if (!cur) {
      store.picks.set(key, { key, picks: [{ code }], note: "" });
      continue;
    }
    if (cur.picks.some((p) => p.code === code)) continue;
    store.picks.set(key, { ...cur, picks: [...cur.picks, { code }] });
  }
}

/** 用一批场次 **替换**全部已排场次(.ics 导入的「替换」档,见 `backup.ts::parseIcsCodes`)。
 *  只清场次:**有备注的记录保留**(降级成「未排场」),没备注的空壳整条删。
 *  ⚠ 被清掉场次的抢票顺位由 `rebuildIndex()` 一并 prune(顺位按 code 索引,留着就是脏数据)。 */
export function replaceScreenings(codes: string[], keyOf: (code: string) => string | null): void {
  mutate(() => {
    for (const e of [...store.picks.values()]) {
      if (!e.picks.length) continue;
      if (e.note) store.picks.set(e.key, { ...e, picks: [] });
      else store.picks.delete(e.key);
    }
    attachScreenings(codes, keyOf);
  });
}

/** 把一批场次 **并入**现有行程(.ics 导入的「合并」档,默认;已有的不重复加)。 */
export function mergeScreenings(codes: string[], keyOf: (code: string) => string | null): void {
  mutate(() => attachScreenings(codes, keyOf));
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
    writeWorkspaceItem(LS_SETTINGS, JSON.stringify(store.settings));
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

/* ---------- 已保存方案(2026-09-12) ----------
 * 方案不再是系统枚举出来的对比列表,而是**用户手动存下来的快照** ——
 * 「我认可的这一套」= 每组顺位 1 + 共同场次(见 `agenda.ts` 的保存入口)。
 *
 * ⚠ 独立 localStorage 键(`biff.savedplans.v1`,与 ranks / gvtalk 同口径):它不是设置,
 *   「重置设置」不该顺手把方案带走;备份走 `biff.` 前缀快照,自动带上。
 * ⚠ 快照语义:行程之后怎么改都不动已保存的方案;里面的 code 若被移出行程 / 数据换版,
 *   导出时按 `cat` 查不到就静默跳过(列表里另行标注「N 场已不在行程」)。 */

const LS_SAVED_PLANS = "biff.savedplans.v1";

export interface SavedPlan {
  id: string;
  /** 自动命名:方案 1 / 方案 2 … */
  name: string;
  /** 该方案的场次 code(调用方按日期 / 开场时间排好) */
  codes: string[];
  createdAt: number;
}

export const savedPlans: SavedPlan[] = [];

/** 场次集合是否相同(顺序无关)—— 保存去重的唯一口径 */
function sameCodeSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((c) => set.has(c));
}

/** 下一个自动名 —— 取已有「方案 N」的最大 N + 1(删掉中间一个后不会撞名) */
function nextPlanName(): string {
  let max = 0;
  for (const p of savedPlans) {
    const m = /^方案 (\d+)$/.exec(p.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `方案 ${max + 1}`;
}

export function loadSavedPlans(): void {
  try {
    const raw = localStorage.getItem(LS_SAVED_PLANS);
    if (!raw) return;
    const rows = JSON.parse(raw) as unknown;
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      if (!r || typeof r !== "object") continue;
      const p = r as Partial<SavedPlan>;
      if (typeof p.id !== "string" || !p.id) continue;
      if (!Array.isArray(p.codes)) continue;
      const codes = p.codes.filter((c): c is string => typeof c === "string" && Boolean(c));
      savedPlans.push({
        id: p.id,
        name: typeof p.name === "string" && p.name ? p.name : `方案 ${savedPlans.length + 1}`,
        codes,
        createdAt: typeof p.createdAt === "number" ? p.createdAt : Date.now(),
      });
    }
  } catch {
    /* ignore */
  }
}

function persistSavedPlans(): void {
  try {
    writeWorkspaceItem(LS_SAVED_PLANS, JSON.stringify(savedPlans));
  } catch {
    /* ignore */
  }
}

/** 保存一个方案(**场次集合相同则不重复存**,见 `sameCodeSet`)。
 *  广播 `"agenda"` 域 —— 只有抽屉里的「已保存方案」列表需要重绘。 */
export function savePlan(codes: string[]): { ok: boolean; plan?: SavedPlan; reason?: "duplicate" | "empty" } {
  const list = [...new Set(codes)];
  if (list.length === 0) return { ok: false, reason: "empty" };
  if (savedPlans.some((p) => sameCodeSet(p.codes, list))) return { ok: false, reason: "duplicate" };
  const plan: SavedPlan = {
    id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: nextPlanName(),
    codes: list,
    createdAt: Date.now(),
  };
  savedPlans.push(plan);
  persistSavedPlans();
  scheduleNotify("agenda");
  return { ok: true, plan };
}

/** 删除一个已保存方案 */
export function deletePlan(id: string): void {
  const i = savedPlans.findIndex((p) => p.id === id);
  if (i < 0) return;
  savedPlans.splice(i, 1);
  persistSavedPlans();
  scheduleNotify("agenda");
}

/** 按 id 取方案 */
export function planById(id: string): SavedPlan | undefined {
  return savedPlans.find((p) => p.id === id);
}

/** Replace the in-memory view after an account switch or a merged cloud update. */
export function reloadWorkspaceState(filmKeyOf: (code: string) => string | null): void {
  store.picks.clear(); rankOf.clear(); gvTalk.clear(); gvTalkMinOv.clear(); agendaFolded.clear(); savedPlans.length = 0;
  store.settings = { alarmMin: 45, transitMin: 0, gvTalkOn: true, gvTalkMin: 25 };
  loadSettings(); loadGvTalk(); loadGvTalkMin(); loadRanks(); loadSavedPlans(); loadAgendaFold(); loadPicks(filmKeyOf);
  notify("all");
}
