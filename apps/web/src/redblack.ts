// 电影红黑榜 —— 贴纸数据 / 配额 / 排序 / 持久化(2026-09-16,PLAN-20260916102339)
//
// 口径(用户当天三轮修订后的最终形态):
//   · **一部电影一枚贴纸**(红 / 黑二选一,贴上就没有第二个名额):在卡片上标记「看过」解锁,
//     点红 / 黑按钮就在这张卡的画布上生成一枚;
//   · 贴纸落在**卡片右侧的留白画布**上,位置是自由相对坐标 —— 允许重叠、每枚角度不同(±15°),
//     像线下手绘打卡墙,不做避让 / 吸附;
//   · 贴纸**贴过就保留**:取消「看过」标记不会把已贴的收走(那是已经做过的动作)。
//
// ⚠ 本模块是纯逻辑 + localStorage 读写,**import 期不碰 DOM**(单测挂内存 localStorage 替身即可)。

import type { FilmNode } from "./app/model";
import { removeWorkspaceItem, writeWorkspaceItem } from "./workspace-storage";

export type StickerType = "red" | "black";

/** 一枚已贴的贴纸。`posX` / `posY` 是**画布内的相对坐标(0..1)** —— 存像素会在换屏 /
 *  换列数之后跑到画布外面去(卡片宽度本来就不是定值)。 */
export interface Sticker {
  id: string;
  type: StickerType;
  posX: number;
  posY: number;
}

/** 影片 key → 已贴贴纸(每种颜色最多 `MAX_PER_COLOR` 枚) */
export type StickerBoard = Map<string, Sticker[]>;

export type SortMode = "total" | "red" | "black";

/** 当前结构(v2)。**独立键**:v1 是「槽位 + 一部一枚」的旧模型,互相不兼容。 */
export const LS_REDBLACK = "biff.redblack.v2";
/** 旧结构(槽位模型)—— 只作为一次性迁移源,读完即删 */
const LS_REDBLACK_V1 = "biff.redblack.v1";
/** 「看过」标记 —— 独立键(存影片 key 数组):标记与贴纸是两件事,合在一个键里只会互相牵连 */
export const LS_REDBLACK_WATCHED = "biff.redblack.watched.v1";
/** ⚠ **已废弃**(2026-09-16):「示例铺底」功能已删 —— 正式环境就该是空的,让用户自己贴
 *  (用户原话:「正式环境不应该是空的让用户自己贴的吗」)。这个键现在只在一次性清理
 *  (`purgeDemoLeavings`) 里被删掉一次,新代码不要再读它。 */
export const LS_REDBLACK_SEEN = "biff.redblack.seen.v1";

/** 一部电影只有一枚贴纸(用户 2026-09-16 定:「标记看过只能选一个贴纸」)——
 *  红 / 黑是同一个名额的两种取舍,贴上就没得再贴,收回才重新可选。 */
export const MAX_PER_FILM = 1;

/** 落点边距(相对):贴纸中心不出这个范围,免得贴在画布最边上被裁掉一半 */
const SPOT_MARGIN = 0.08;

/** 一部片的**全体**红黑计数 —— 红黑榜是「全部用户都可以贴」的,这份计数**只来自服务端聚合**
 *  (`film-votes.ts::loadFilmVotes` + api 的 `/api/stats/film-votes`),本地绝不造:
 *  造出来的假数字会在接口上线后与真实票数打架(用户 2026-09-16 明确要求去掉模拟)。
 *  ⚠ 它与 `StickerBoard` 是两回事:`StickerBoard` 是**我自己**贴的那几枚(带坐标、可拖),
 *    这里是大家贴出来的**数量」。 */
export type CrowdCounts = Map<string, StickerCounts>;

/* ---------------- 位置与角度 ---------------- */

/** 字符串 → 稳定哈希(角度 / 落点 / 演示数据都用它推导,保证同一份输入每次结果一样) */
function hashOf(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 把坐标钳进画布的安全区(拖到画布外 / 边缘时用) */
export function clampSpot(posX: number, posY: number): { posX: number; posY: number } {
  const lo = SPOT_MARGIN;
  const hi = 1 - SPOT_MARGIN;
  return {
    posX: Math.min(hi, Math.max(lo, posX)),
    posY: Math.min(hi, Math.max(lo, posY)),
  };
}

/** 由贴纸 id 推导的**确定性**倾斜角(±15°)。
 *  ⚠ 角度不单独存字段:它是「这一枚长什么样」的装饰,由 id 推出来就永远稳定
 *    (存字段反而多一份可能与位置脱节的脏数据)。 */
export function tiltOf(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 1000003;
  return ((hash % 301) / 10) - 15; // -15.0 ~ +15.0
}

/** 哈希的**雪崩**收尾(murmur3 的 fmix32)。
 *  ⚠ 不能直接拿 FNV 的高位当坐标:同一部片的贴纸 id 共享前缀(`cat:f001#crowd-`),
 *    而 FNV 的高位对**末尾那几个字符**几乎不敏感 —— 实测 `(hash >>> 20) % 1000`
 *    算出来的纵坐标会挤成一条横带(个别片 100 枚全落在上面 40% 里),画布根本没铺开。
 *    一天只画 16 枚时看不出来,**放开上限之后一眼就看出**(2026-09-22,PLAN-20260922145815 修订 2)。 */
function mix32(hash: number): number {
  let x = hash;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/** 由 id 推导的**确定性**落点 —— 迁移旧数据 / 画「别人的贴纸」都用它
 *  (不能用 `Math.random`,否则每次载入旧数据贴纸都会换位置)。
 *  ⚠ 取坐标前必须过一遍 `mix32`:见它的注释(不 mix 会挤成一条横带)。 */
export function spotOf(id: string): { posX: number; posY: number } {
  const hash = mix32(hashOf(id));
  const span = 1 - SPOT_MARGIN * 2;
  const a = ((hash >>> 8) % 1000) / 1000;
  const b = ((hash >>> 20) % 1000) / 1000;
  return { posX: SPOT_MARGIN + a * span, posY: SPOT_MARGIN + b * span };
}

/** 把「别人的贴纸」变成画布上能画出来的点:位置由 `(filmKey, index)` **确定性**推导,
 *  红票几枚就画几枚红、黑票几枚就画几枚黑。它们**只读**(不可拖)。
 *
 *  ⚠ 早先这里是 `min(total, 16)` **采样** + 按比例取整 + 「+N」角标 —— 那是为了让「16 枚」不被
 *    读成真实票数。2026-09-22 用户要求「一部片看全部贴纸」后**取消采样**(PLAN-20260922145815):
 *    采样除了让画布上的密度失真,还会**把少数派颜色四舍五入抹掉**(1 红 / 100 黑 → 一枚红点都没有,
 *    而卡片 chip 明明写着「红 1」)。点数变多的代价交给**渲染层**承担:
 *    视口外的卡不画、视口内的卡用 canvas 画(见 `components/StickerCanvas.tsx`)。 */
export function crowdStickers(filmKey: string, counts: StickerCounts | undefined): Sticker[] {
  if (!counts || counts.total <= 0) return [];
  const reds = Math.min(Math.max(0, counts.red), counts.total);
  const out: Sticker[] = [];
  for (let i = 0; i < counts.total; i++) {
    const id = `${filmKey}#crowd-${i}`;
    out.push({ id, type: i < reds ? "red" : "black", ...spotOf(id) });
  }
  return out;
}

/** 生成一枚新贴纸。**不给 `spot` 时落点随机**(点一下按钮就走这条,允许重叠、不避让);
 *  给了 `spot` 就用它(从暂存区拖到画布上松手的那一点)。
 *  `seed` 只为单测可复现而存在,真机走 `Math.random`。 */
export function makeSticker(
  type: StickerType,
  spot?: { posX: number; posY: number },
  seed?: () => number,
): Sticker {
  const rand = seed ?? Math.random;
  const id = `s-${Date.now().toString(36)}-${Math.floor(rand() * 1e9).toString(36)}`;
  const span = 1 - SPOT_MARGIN * 2;
  const at =
    spot ?? { posX: SPOT_MARGIN + rand() * span, posY: SPOT_MARGIN + rand() * span };
  return { id, type, ...clampSpot(at.posX, at.posY) };
}

/* ---------------- 统计 ---------------- */

export interface StickerCounts {
  total: number;
  red: number;
  black: number;
}

export function countsOf(list: readonly Sticker[] | undefined): StickerCounts {
  const total = list?.length ?? 0;
  let red = 0;
  for (const s of list ?? []) if (s.type === "red") red++;
  return { total, red, black: total - red };
}

/** 「**别人的**贴纸」= 全体票数 − 我自己那几枚。
 *  ⚠ 服务端那份**含我**(上报落地后),不减掉就会把我这一枚画重;上报还没落地时会被夹到 0,
 *    之后再把「我那一枚」单独画上去,两个方向都对。
 *  ⚠ 卡片画布(`StickerCanvas`)与分享图(`redblack-poster.ts`)必须共用这一条 ——
 *    两处各写一份,分享图上摊出来的贴纸数就会与卡片对不上。 */
export function othersOf(counts: StickerCounts, mine: StickerCounts): StickerCounts {
  return {
    total: Math.max(0, counts.total - mine.total),
    red: Math.max(0, counts.red - mine.red),
    black: Math.max(0, counts.black - mine.black),
  };
}

export interface FilmTally extends StickerCounts {
  /** 用户是否标记了「看过」 */
  marked: boolean;
  /** 还能不能贴(标记过 + 这一部还没贴)—— 此时暂存区里那两枚红 / 黑可选 */
  canPlace: boolean;
  /** 还能贴几枚(0 / 1);顶部统计按它累加 */
  quota: number;
}

export function tallyOf(filmKey: string, marked: boolean, board: StickerBoard): FilmTally {
  const counts = countsOf(board.get(filmKey));
  const canPlace = marked && counts.total < MAX_PER_FILM;
  return { ...counts, marked, canPlace, quota: canPlace ? 1 : 0 };
}

/** 红黑榜评分 = **红贴纸占比**,折算成 0–10 分(一位小数)。
 *  全红 = 10(看过的都满意)、全黑 = 0(全是雷)、一枚都没贴 = `null`(不显示,而不是 0)。
 *  ⚠ 分母只算**已贴**的贴纸:标记了但还没贴的是「待表态」,不是态度,不该拉低分数。 */
export function scoreOf(counts: StickerCounts): number | null {
  if (!counts.total) return null;
  return Math.round((counts.red / counts.total) * 100) / 10;
}

/* ---------------- 排序 ----------------
 * 三档全部**降序**;并列时保序 —— 所以「一枚贴纸都没有」时结果就是传入顺序
 * (影片库默认顺序:目录序 → 中文名),不引入随机,用户刷新看到的排布是稳定的。 */

/** 某一档排序**看的是哪个数**(总数 / 红 / 黑)。
 *  ⚠ 单独导出而不是埋在 `sortByCounts` 里:分享图要按同一指标**筛掉「该榜为 0」的片**
 *    (黑榜里放一堆「黑 0」毫无意义),两处各写一份必然会漂移。 */
export function sortMetric(counts: StickerCounts | undefined, mode: SortMode): number {
  if (!counts) return 0;
  return mode === "red" ? counts.red : mode === "black" ? counts.black : counts.total;
}

/** 榜单排序按**全体计数**走(红黑榜是大家贴的,排名当然看大家贴了多少) */
export function sortByCounts<T extends { key: string }>(
  films: readonly T[],
  counts: CrowdCounts,
  mode: SortMode,
): T[] {
  return films
    .map((film, index) => ({ film, index }))
    .sort((a, b) => sortMetric(counts.get(b.film.key), mode) - sortMetric(counts.get(a.film.key), mode) || a.index - b.index)
    .map((entry) => entry.film);
}

/** 服务端返回的票数(纯对象) → 榜单用的 `CrowdCounts`。两色都空 / 非法取值的影片不进 Map ——
 *  与 `film-votes.ts::parseVotes` 同一道白名单,这里只负责**形状**转换。 */
export function crowdOf(
  votes: Readonly<Record<string, { red: number; black: number } | undefined>>,
): CrowdCounts {
  const out: CrowdCounts = new Map();
  for (const [key, counts] of Object.entries(votes)) {
    if (!key || !counts) continue;
    const red = Math.max(0, Math.trunc(Number(counts.red) || 0));
    const black = Math.max(0, Math.trunc(Number(counts.black) || 0));
    if (red <= 0 && black <= 0) continue;
    out.set(key, { total: red + black, red, black });
  }
  return out;
}

/** 一部影片票数的**内容签名** —— 只串「排序 / 绘制真正看的那三个数」。
 *  两处共用:① `crowdSignature`(整榜「有新贴纸」的判据)② 画布的**重绘守护**
 *  (`sticker-canvas-guard.ts`)。
 *  ⚠ 一律拿它比,**不要**比 `StickerCounts` 的对象引用:每次重算都是新对象,
 *   数字一模一样也会被当成「变了」——顺序提示会白亮一次、画布会白画一遍。 */
export function countsSignature(counts: StickerCounts): string {
  return `${counts.total},${counts.red},${counts.black}`;
}

/** 排序依据的**内容签名** —— 用来判断「票数是不是真的变了」(顺序冻结的提示判据)。
 *  ⚠ 不能拿 `FilmVoteCounts` / `CrowdCounts` 的**对象引用**比:每次重拉票数都会得到新对象,
 *   数字一模一样也会被当成「有新贴纸」,提示白亮一次
 *   (用户 2026-09-22:只在**数量变化**时才需要提示「有新贴纸 · 重新排序」)。
 *  只串排序真正看的那三个数,并按 key 排一次 —— 服务端返回顺序变了也不算变。 */
export function crowdSignature(counts: CrowdCounts): string {
  return [...counts]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, c]) => `${key}:${countsSignature(c)}`)
    .join("|");
}

/** 我自己贴出来的那几枚 → 上报载荷。一人一部一票,所以每部只取那一枚的颜色。 */
export function votesOf(board: StickerBoard): Array<{ key: string; vote: StickerType }> {
  const out: Array<{ key: string; vote: StickerType }> = [];
  for (const [key, list] of board) {
    const sticker = list[0];
    if (sticker) out.push({ key, vote: sticker.type });
  }
  return out;
}

/* ---------------- 变更(全部不可变:返回新 board) ----------------
 * ⚠ 纯函数里**不校验「看过」标记**:标记是视图层的概念,这里只管数据结构。 */

function cloneBoard(board: StickerBoard): StickerBoard {
  return new Map([...board].map(([key, list]) => [key, list.map((s) => ({ ...s }))]));
}

/** 贴一枚;这一部已经有贴纸了 → **原样返回**(一部一枚的闸门) */
export function placeSticker(board: StickerBoard, key: string, sticker: Sticker): StickerBoard {
  const list = board.get(key) ?? [];
  if (list.length >= MAX_PER_FILM) return board;
  const next = cloneBoard(board);
  next.set(key, [...(next.get(key) ?? []), sticker]);
  return next;
}

/** 按 id 取下 */
export function takeSticker(board: StickerBoard, key: string, id: string): StickerBoard {
  const list = board.get(key);
  if (!list?.some((s) => s.id === id)) return board;
  const next = cloneBoard(board);
  const rest = (next.get(key) ?? []).filter((s) => s.id !== id);
  if (rest.length) next.set(key, rest);
  else next.delete(key);
  return next;
}

/** 拖动**已经贴在画布上**的那一枚:只改坐标(相对坐标,钳进安全区)。
 *  ⚠ **没有「挪到别的片」这回事**(2026-09-23 用户:「张贴区应该是电影之间独立的」):
 *    一枚贴纸的归属就是 `key` 这一部,别片的画布不是它的落点 —— 想给别片贴,走别片自己的暂存区。
 *    落点算不算「本片画布」由视图层判定(`RedBlackPage.tsx::finishRef`),不是就算出界(收回)。
 *    所以这里**连参数都不给**跨片的可能:留一条永远不该被调用的路径,就是给下次复发留门。 */
export function moveSticker(
  board: StickerBoard,
  key: string,
  id: string,
  posX: number,
  posY: number,
): StickerBoard {
  const next = cloneBoard(board);
  const src = next.get(key);
  const i = src?.findIndex((s) => s.id === id) ?? -1;
  if (!src || i < 0) return board;
  src[i] = { ...src[i], ...clampSpot(posX, posY) };
  return next;
}

/* ---------------- 持久化 ----------------
 * v2(自由坐标)与 v1(槽位)结构不兼容 → **新键 + 一次性迁移 + 删旧键**(仓库惯例,见 `state.ts`)。
 * 读取端一律白名单 + 兜底:未知字段忽略,非法条目静默丢弃。 */

function readJson(key: string): unknown {
  try {
    const text = localStorage.getItem(key);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function parseV2(raw: unknown): StickerBoard {
  const board: StickerBoard = new Map();
  if (!raw || typeof raw !== "object") return board;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !Array.isArray(value)) continue;
    const list: Sticker[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const s = item as Partial<Sticker>;
      if (typeof s.id !== "string" || !s.id) continue;
      if (s.type !== "red" && s.type !== "black") continue;
      if (typeof s.posX !== "number" || !Number.isFinite(s.posX)) continue;
      if (typeof s.posY !== "number" || !Number.isFinite(s.posY)) continue;
      // 一部只留第一枚:数据损坏 / 旧模型残留时,宁可少一枚,也不要卡片上飘出两三枚贴纸
      if (list.length >= MAX_PER_FILM) continue;
      const spot = clampSpot(s.posX, s.posY);
      list.push({ id: s.id, type: s.type, ...spot });
    }
    if (list.length) board.set(key, list);
  }
  return board;
}

/** v1(槽位模型)→ v2:丢掉槽位,按 id 推导一个稳定落点。
 *  槽位坐标是「哪一格」,没有跨结构的意义 —— 保留视觉上的分散即可。 */
function parseV1(raw: unknown): StickerBoard {
  const board: StickerBoard = new Map();
  if (!raw || typeof raw !== "object") return board;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !Array.isArray(value)) continue;
    const list: Sticker[] = [];
    value.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const s = item as { color?: unknown; slot?: unknown; type?: unknown };
      const type = s.type ?? s.color;
      if (type !== "red" && type !== "black") return;
      if (list.length >= MAX_PER_FILM) return;
      const id = `${key}#v1-${index}`;
      list.push({ id, type, ...spotOf(id) });
    });
    if (list.length) board.set(key, list);
  }
  return board;
}

export function loadStickers(): StickerBoard {
  const current = parseV2(readJson(LS_REDBLACK));
  if (current.size) return current;
  const legacy = parseV1(readJson(LS_REDBLACK_V1));
  if (!legacy.size) return current;
  // 迁移当场落盘并删旧键:否则 v2 一旦缺失,旧槽位数据会再被读一次(「数据复活」)
  saveStickers(legacy);
  try {
    removeWorkspaceItem(LS_REDBLACK_V1);
  } catch {
    /* 忽略 */
  }
  return legacy;
}

export function saveStickers(board: StickerBoard): void {
  try {
    writeWorkspaceItem(LS_REDBLACK, JSON.stringify(Object.fromEntries(board)));
  } catch {
    /* 忽略 */
  }
}

export function loadWatched(): Set<string> {
  const watched = new Set<string>();
  const raw = readJson(LS_REDBLACK_WATCHED);
  if (!Array.isArray(raw)) return watched;
  for (const key of raw) if (typeof key === "string" && key) watched.add(key);
  return watched;
}

export function saveWatched(watched: ReadonlySet<string>): void {
  try {
    writeWorkspaceItem(LS_REDBLACK_WATCHED, JSON.stringify([...watched]));
  } catch {
    /* 忽略 */
  }
}

/** 榜单影片候选:**只列有排期的影片**(连场次都没有的目录片谈不上看过没看过) */
export function boardFilms(films: readonly FilmNode[]): FilmNode[] {
  return films.filter((f) => f.shows.length > 0);
}

/* ---------------- 清理「示例铺底」的残留(2026-09-16) ----------------
 * 早先版本首次进入会**自动铺一份示例贴纸**(本意是让空榜也能看出颜色分布与排序),
 * 用户指出正式环境就该是空的(「正式环境不应该是空的让用户自己贴的吗」),该功能已删。
 * 这里只负责把**已经铺出去**的那批数据收干净 —— 否则老用户本地那份会一直顶着一堆
 * 自己从没贴过的贴纸,光删代码救不了他们。 */

/** 示例贴纸的 id 前缀(铺底时代生成的贴纸长这样;用户自己贴的是 `s-` 前缀) */
const DEMO_ID_PREFIX = "demo-";

/**
 * 清掉示例残留,返回清理后的 `board` / `watched`(页面载入时调一次)。
 *
 * 判据分两档,**保守优先**:
 *  ① 贴纸**全部**是示例生成的(或压根没有贴纸)→ 整份都是自动铺的,board 与 watched 一起清空;
 *  ② 混着自己贴的(存在 `s-` 前缀)→ **只摘掉示例那几枚**,用户自己的贴纸与标记一律不动。
 *
 * ⚠ 只在确实读到示例残留时才写盘:清一次即止,之后每次载入都是空转。
 */
export function purgeDemoLeavings(): { board: StickerBoard; watched: Set<string> } {
  const stored = loadStickers();
  const watched = loadWatched();
  const stickers = [...stored.values()].flat();
  if (!stickers.some((s) => s.id.startsWith(DEMO_ID_PREFIX))) {
    // 没有示例残留 —— 顺手把「关掉示例」那个废弃键收掉(功能没了,留着只是一份垃圾数据)
    try {
      removeWorkspaceItem(LS_REDBLACK_SEEN);
    } catch {
      /* 忽略 */
    }
    return { board: stored, watched };
  }

  const mine = stickers.filter((s) => !s.id.startsWith(DEMO_ID_PREFIX));
  if (!mine.length) {
    const empty: StickerBoard = new Map();
    const none = new Set<string>();
    saveStickers(empty);
    saveWatched(none);
    try {
      removeWorkspaceItem(LS_REDBLACK_SEEN);
    } catch {
      /* 忽略 */
    }
    return { board: empty, watched: none };
  }

  const board: StickerBoard = new Map();
  for (const [key, list] of stored) {
    const kept = list.filter((s) => !s.id.startsWith(DEMO_ID_PREFIX));
    if (kept.length) board.set(key, kept);
  }
  saveStickers(board);
  return { board, watched };
}
