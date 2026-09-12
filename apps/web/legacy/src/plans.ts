// 冲突组 → 无冲突方案集合 —— 纯函数(不碰 DOM、不改入参),node 可单测。
//
// 语义(2026-09-11 **二改**,`PLAN-20260911223000`):
//   · **冲突组** = `conflict.ts::conflictGroups()` 的连通分量 —— 同一时间带互相重叠的几场;
//   · **顺位** = 组内位置(1..n),由用户在「我的行程」的顺位卡里**拖动**决定(落 `state.ts::rankOf`)。
//     它**只表达偏好次序**(拖在前面的更想要),**不决定分组**、也不决定「哪套是方案几」;
//   · **方案** = 「每个冲突组各取一场」的**所有组合**(∪ 不属于任何冲突组的共同场次)。
//     但**同一部片在一套方案里只保留一场**(2026-09-11 三改,`PLAN-20260911230500`)。
//   · 顺位唯一的用途 = 给方案**排序**:成本 = Σ(所选场次在组内的顺位),越小越优先
//     —— 全都取首选的那套排第一。
//
// ★ 为什么「同片只留一场」(用户报的真实场景):
//   行程里同时留着「同一部片的两天场次」是**抢票备选**(见 `PLAN-20260911223000` D7:
//   冲突双方同时存在是用户明知的状态,抢到哪个去哪个)。但枚举若把两个场次当成**互相独立的槽位**,
//   就会出现荒谬结果 —— 027(10/7 12:20 C3 峡湾)与 071(10/8 09:00 BH 峡湾)是同一部片、
//   分属两个冲突组、各自又都是组内顺位 1 ⇒ 「最优先」那套 = `027+071` = **同一部片看两遍**。
//   故枚举时按 `filmKeyOf` 去重:一套方案里出现两部同片 → 该组合**直接剔除**(进 `droppedSameFilm` 记账,
//   不进 `options`)。剔除后成本层会自然往上走,补上下一批可行组合,不会因此少列。
//   ⚠ 已知边界:去重只作用在**枚举维度**(picks 之间)。共同场次是各套共用的,
//     若它与某个 pick 恰好同片,那一套里该片仍会出现两次 —— 修它得先定义「共同场次 vs 冲突组同片谁让路」,
//     属新语义,本轮不做。
//
//   ⚠ 一改(同日早先)曾把顺位当成「方案编号」(方案 k = 各组第 k 场),那只产出 max|组| 套;
//     用户澄清「在某一顺位下(比如第一顺位)可以生成多个无冲突的方案」—— 故改为**枚举所有组合**。
//
// ★ 「顺位撞车」= 顺位本身的冲突(2026-09-12 加,见 `RankClash`):
//   去重(上一条)把「同片重复」的组合剔掉是对的,但它**顺带**吞掉了一个用户能自己修的状态 ——
//   若两个冲突组在**同一层**(各组第 k 场)上撞到同一部片,那一层的组合被剔除后,
//   用户看不出「为什么这一层不是每组都取那场」。
//   故本模块把这种「顺位互相打架」**逐层**检出(`rankClashes`),交给 UI **提示 + 逐条让路 +
//   一键全部修复**(`autoFixRanks`,带预览)。
//   ⚠ 层 = 「每个冲突组各取第 k 场」那一套(第 1 层 = 都取首选)。**不查跨层的同片重复**
//     (如 A 组顺位 1 与 B 组顺位 2 同片)—— 那属于正常的备选关系,那套本就不是最优。
//
// ★ 为什么方案一定无冲突(以及为什么仍然逐套校验):
//   冲突组是**连通分量**,组与组之间按定义没有冲突边 —— 一套方案从每组各取一场,
//   取出来的任意两场必然分属不同组 ⇒ 不重叠。**这是数学性质,不需要顺位去保证。**
//   但本模块仍**逐套跑一遍冲突校验**(`pairSet`)而不是依赖该性质:校验是「证据」,性质是「论证」——
//   将来冲突口径变了(例如补上跨午夜的相邻两日),校验会立刻把不可行的组合筛掉,
//   而不是静默产出一套「看起来能用、其实撞车」的方案。
//
// ⚠ 已知边界:`conflict.ts` 按 **`s.date` 分桶**判定,故**跨午夜的相邻两日**之间不会成冲突组
//   (10/8 的 29:35 散场 vs 10/9 的 01:00 开场)—— 这类组合**通不过**任何校验也发现不了。
//   本模块继承同一口径,不在此处另行修正。

import { conflictGroups, type ConflictResult } from "./conflict";

/** 一套方案 —— 「每个冲突组各取一场」的一个组合 */
export interface PlanOption {
  /** 各冲突组中选中的场次(顺序与 `PlanSet.groups` 一一对应) */
  picks: string[];
  /** 完整场次列表 = `picks` ∪ 共同场次;未排序,渲染方按日期 / 时间排 */
  codes: string[];
  /** 顺位成本 = Σ 各组所选场次的组内顺位(越小 = 越贴近「都取首选」) */
  cost: number;
}

/** 「顺位撞车」里的一个槽位 —— 某个冲突组在**第 `layer` 层**的场次落在撞车影片上 */
export interface RankClashSpot {
  /** 冲突组索引(对应 `PlanSet.groups`) */
  group: number;
  /** 该组第 `layer` 顺位的场次 code */
  code: string;
  /** 该组内第一个**不与撞车影片同片**的场次(优先取 `layer` 之后,避免动到更靠前的层);
   *  null = 组内其余场次全是同片,无处可让 */
  alt: string | null;
}

/** **顺位撞车** —— 两个及以上冲突组在**同一层**上撞到同一部片(见文件头「顺位冲突」)。
 *
 *  「层」= 「每个冲突组各取第 k 场」那一套(`layer` = k)。第 1 层就是「各组都取首选」。
 *  这不是「两场不能都看」(时间冲突),而是**用户拖出来的偏好次序本身互相打架**:
 *  两组都想要同一部片,而这一层的组合会被「同一部片只留一场」剔除 ⇒
 *  方案对比里**根本不存在**那一层,用户却看不出原因。
 *  故逐层检出后由 UI 提示 + 逐条让路 / 一键全部修复。 */
export interface RankClash {
  /** 第几层(1-based) */
  layer: number;
  /** 撞车的影片 key */
  filmKey: string;
  /** 卷入的槽位(≥2 项,按组序) */
  spots: RankClashSpot[];
}

/** 一键修复里某一组的前后顺序(只记**实际变了**的组) */
export interface RankFixChange {
  group: number;
  before: string[];
  after: string[];
}

/** 一键修复的**预览**(纯数据,先给用户看、确认后再落盘) */
export interface RankFixPlan {
  /** 实际会改动的组(每组一条,`before → after`) */
  changes: RankFixChange[];
  /** 修复后的组顺序(与 `PlanSet.groups` 同序;`changes` 为空时等于原样) */
  groups: string[][];
  /** 修不完的剩余撞车(无处可让 / 超出步数上限) */
  remaining: RankClash[];
}

export interface PlanSet {
  /** 冲突组(只含 ≥2 场的组),按组内首 code 稳定排序;**组内已按顺位排好** */
  groups: string[][];
  /** 共同场次(不属于任何冲突组)—— 每一套方案都有,不可能与任何场次冲突 */
  common: string[];
  /** code → 顺位(1-based);仅冲突组内的场次有条目 */
  rankOf: Map<string, number>;
  /** 全部**内部无冲突**的方案,按成本升序(同成本按组序字典序:先满足靠前的组) */
  options: PlanOption[];
  /** 组合总数(∏|组|);**既未截断也未因同片去重剔除**时 = `options.length` */
  total: number;
  /** 是否因为组合数过大被截断(只保留了成本最低的一部分) */
  truncated: boolean;
  /** 卷入「方案内部仍重叠」的场次(校验失败的证据;正常恒空,UI 据此标红) */
  broken: Set<string>;
  /** 因「同一部片出现两场」被剔除的组合数(见文件头;UI 据此解释套数为什么变少) */
  droppedSameFilm: number;
  /** **第一顺位撞车**(见 `RankClash`);空 = 各组首选之间没有同片重复 */
  rankClashes: RankClash[];
}

/** 枚举上限 —— 超过就只保留**成本最低**的这一批(展示侧默认也只列前 8 套,故这个量足够宽裕)。
 *  3 组 × 3 场 = 27、4 组 × 3 场 = 81 都远在限内;真到 5 组 × 4 场 = 1024 才会截断。 */
export const MAX_OPTIONS = 240;

/** 稳定 pair 键(无向去重,与 `conflict.ts::computeConflicts` 的 pairs 口径一致) */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** 组合内部是否撞车 —— 返回第一对冲突(无 → null)。
 *  只查 `picks`:`common` 里的场次按定义不在任何冲突组里 ⇒ 不可能有冲突对。 */
function firstOverlap(picks: string[], pairSet: Set<string>): [string, string] | null {
  for (let i = 0; i < picks.length; i++) {
    for (let j = i + 1; j < picks.length; j++) {
      if (pairSet.has(pairKey(picks[i], picks[j]))) return [picks[i], picks[j]];
    }
  }
  return null;
}

/** 组合里是否出现**同一部片的两场**(同一部片在一套方案里只能出现一次,见文件头)。
 *  `filmKeyOf` 返回 null(排期换版后查不到该 code)的场次**不参与判定** —— 宁可不判,不误杀。 */
function hasSameFilm(picks: string[], filmKeyOf: (code: string) => string | null): boolean {
  const seen = new Set<string>();
  for (const c of picks) {
    const key = filmKeyOf(c);
    if (key === null) continue;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/** 检出**顺位撞车**:逐层查「各组第 k 场」里同一部片出现 ≥2 次(见 `RankClash`)。
 *  `filmKeyOf` 返回 null 的场次**不参与判定**(数据换版查不到影片)—— 宁可不判,不误杀。
 *  ⚠ 组大小不齐时,第 k 层只由**有第 k 场**的组构成;单组不成撞车。 */
export function detectRankClashes(
  groups: string[][],
  filmKeyOf: (code: string) => string | null
): RankClash[] {
  const maxLayer = groups.reduce((n, g) => Math.max(n, g.length), 0);
  const out: RankClash[] = [];
  for (let layer = 1; layer <= maxLayer; layer++) {
    const byFilm = new Map<string, number[]>();
    groups.forEach((g, gi) => {
      if (g.length < layer) return;
      const key = filmKeyOf(g[layer - 1]);
      if (key === null) return;
      const arr = byFilm.get(key);
      if (arr) arr.push(gi);
      else byFilm.set(key, [gi]);
    });
    for (const [filmKey, gis] of byFilm) {
      if (gis.length < 2) continue;
      out.push({
        layer,
        filmKey,
        spots: gis.map((gi) => ({
          group: gi,
          code: groups[gi][layer - 1],
          // 优先在 `layer` 之后找让路候选 —— 不动更靠前的层(那些层可能已经排好了)
          alt:
            groups[gi].slice(layer).find((c) => filmKeyOf(c) !== filmKey) ??
            groups[gi].find((c) => filmKeyOf(c) !== filmKey) ??
            null,
        })),
      });
    }
  }
  // 稳定顺序:先按层、再按首个槽位的组序 —— UI / 单测都据此可预期
  out.sort((a, b) => a.layer - b.layer || a.spots[0].group - b.spots[0].group);
  return out;
}

/** 一键修复的步数上限 —— 每步至少消掉一处撞车,正常远用不到;纯属防「贪心原地打转」的兜底 */
const MAX_FIX_STEPS = 24;

/** **一键全部修复**:贪心地把撞车一处处让路,直到干净或无处可让(见 `RankFixPlan`)。
 *
 *  每步在「所有撞车 × 所有可让路的槽位」里挑**让路后剩余撞车最少**的那个(并列时取先遇到的),
 *  故同一部片在多层上打架时不会来回横跳。返回值是**预览**,不动入参 —— 用户确认后再落盘。
 *
 *  ⚠ 贪心不保证全局最优(这是 NP 难问题的启发式);步数上限 + `remaining` 让「修不完」可见。 */
export function autoFixRanks(groups: string[][], filmKeyOf: (code: string) => string | null): RankFixPlan {
  const cur = groups.map((g) => [...g]);
  const original = groups.map((g) => [...g]);
  let clashes = detectRankClashes(cur, filmKeyOf);
  let steps = 0;
  while (clashes.length > 0 && steps < MAX_FIX_STEPS) {
    let best: { gi: number; order: string[]; score: number } | null = null;
    for (const clash of clashes) {
      for (const spot of clash.spots) {
        if (spot.alt === null) continue;
        const g = cur[spot.group];
        const i = g.indexOf(spot.code);
        const j = g.indexOf(spot.alt);
        if (i < 0 || j < 0) continue;
        const next = [...g];
        [next[i], next[j]] = [next[j], next[i]];
        const trial = cur.map((x, k) => (k === spot.group ? next : x));
        const score = detectRankClashes(trial, filmKeyOf).length;
        if (!best || score < best.score) best = { gi: spot.group, order: next, score };
      }
    }
    if (!best) break; // 所有撞车都无处可让
    cur[best.gi] = best.order;
    clashes = detectRankClashes(cur, filmKeyOf);
    steps++;
  }
  const changes: RankFixChange[] = [];
  cur.forEach((g, gi) => {
    if (original[gi].join("|") !== g.join("|")) changes.push({ group: gi, before: [...original[gi]], after: [...g] });
  });
  return { changes, groups: cur, remaining: clashes };
}

/**
 * 由「已选场次 + 冲突结果 + 顺位」派生**全部无冲突方案**。
 *
 * 枚举顺序 = **按成本分层**(成本从「组数」一路加到「各组大小之和」),故产出**天然按优先度排序**,
 * 不需要事后 sort;撞到 `MAX_OPTIONS` 就停,留下的必然是最优先的那一批。
 *
 * @param codes         全部已选场次 code(允许重复,内部去重保序)
 * @param conflicts     日期 → 冲突结果(与网格 / 行程同源,见 `main.ts::computeAllConflicts`)
 * @param rankOf        场次 → 顺位(用户拖出来的;缺省 = 未设,走兜底排序)
 * @param fallbackOrder 未设顺位时的组内兜底排序键(调用方按「日期 + 开始时刻」给一个单调值)
 * @param filmKeyOf     场次 → 影片 key(`main.ts::filmKeyOfCode`,与网格 / 影片库同一口径)——
 *                      同一套方案里出现两部同片即剔除,见文件头
 */
export function buildPlanSet(
  codes: string[],
  conflicts: Map<string, ConflictResult>,
  rankOf: Map<string, number>,
  fallbackOrder: (code: string) => number,
  filmKeyOf: (code: string) => string | null
): PlanSet {
  const all: string[] = [];
  const seen = new Set<string>();
  for (const c of codes) {
    if (seen.has(c)) continue;
    seen.add(c);
    all.push(c);
  }

  // 1) 冲突组:只保留 ≥2 场的组(1 场不成组),按组内首 code 稳定排序
  const groups: string[][] = [];
  for (const result of conflicts.values()) {
    for (const g of conflictGroups(result)) if (g.length >= 2) groups.push([...g]);
  }
  groups.sort((a, b) => a[0].localeCompare(b[0]));

  // 2) 组内排序:显式顺位优先(未设 → +∞ 排最后),再按兜底键 / code 稳定收尾;
  //    排完即**归一**成 1..n —— 顺位只有「组内相对次序」一个含义,不存绝对值。
  const rank = new Map<string, number>();
  const inGroup = new Set<string>();
  for (const g of groups) {
    g.sort((a, b) => {
      const ra = rankOf.get(a) ?? Number.POSITIVE_INFINITY;
      const rb = rankOf.get(b) ?? Number.POSITIVE_INFINITY;
      return ra - rb || fallbackOrder(a) - fallbackOrder(b) || a.localeCompare(b);
    });
    g.forEach((c, i) => {
      rank.set(c, i + 1);
      inGroup.add(c);
    });
  }
  const common = all.filter((c) => !inGroup.has(c));

  // 2.5) 第一顺位撞车(见文件头):组内已排好序,故 `g[0]` 即首选
  const rankClashes = detectRankClashes(groups, filmKeyOf);

  // 3) 冲突对(逐套校验用)
  const pairSet = new Set<string>();
  for (const result of conflicts.values()) for (const [a, b] of result.pairs) pairSet.add(pairKey(a, b));

  const options: PlanOption[] = [];
  const broken = new Set<string>();
  const m = groups.length;
  let total = 1;
  for (const g of groups) total *= g.length;

  if (m === 0) {
    // 没有冲突组 → 唯一一套 = 全部已选场次(谈不上对比,UI 据此不渲染对比区)
    options.push({ picks: [], codes: [...all], cost: 0 });
    return {
      groups,
      common,
      rankOf: rank,
      options,
      total: 1,
      truncated: false,
      broken,
      droppedSameFilm: 0,
      rankClashes,
    };
  }

  const picks: string[] = [];
  const sumSizes = groups.reduce((a, g) => a + g.length, 0);

  /** 枚举一趟(成本从「组数」一路加到「各组大小之和」,每层一次精确用尽成本的 DFS)。
   *  `walk` 只在 `rem` 恰好用尽时产出,故每个组合只会被访问一次。
   *  @param dedupe 是否剔除「同一部片出现两场」的组合(见文件头)
   *  @returns `truncated` = 撞到 `MAX_OPTIONS` 时是否还有更高成本的组合没枚举到;`dropped` = 本趟剔除数 */
  const enumerate = (dedupe: boolean): { truncated: boolean; dropped: number } => {
    const cap = options.length + MAX_OPTIONS;
    let dropped = 0;
    const walk = (i: number, rem: number, cost: number): void => {
      if (options.length >= cap) return;
      if (i === m) {
        if (rem !== 0) return;
        const bad = firstOverlap(picks, pairSet);
        if (bad) {
          broken.add(bad[0]);
          broken.add(bad[1]);
          return;
        }
        if (dedupe && hasSameFilm(picks, filmKeyOf)) {
          dropped++;
          return;
        }
        options.push({ picks: [...picks], codes: [...common, ...picks], cost });
        return;
      }
      const g = groups[i];
      const restMin = m - i - 1; // 后面每组至少还要花 1 点成本
      const maxR = Math.min(g.length, rem - restMin);
      for (let r = 1; r <= maxR; r++) {
        picks.push(g[r - 1]);
        walk(i + 1, rem - r, cost + r);
        picks.pop();
      }
    };
    for (let c = m; c <= sumSizes; c++) {
      walk(0, c, 0);
      if (options.length >= cap) return { truncated: c < sumSizes, dropped };
    }
    return { truncated: false, dropped };
  };

  const first = enumerate(true);
  let truncated = first.truncated;
  let droppedSameFilm = first.dropped;
  // 兜底:去重后一套都不剩(例如每个冲突组的成员恰好都是同一部片的两场)——
  // 此时「同片只留一场」把所有组合都判死,退回**不去重**的结果:
  // 宁可比对里出现同片重复,也不给一个空列表(那时 UI 连对比区都不会渲染)。
  if (options.length === 0 && droppedSameFilm > 0) {
    const retry = enumerate(false);
    truncated = retry.truncated;
    droppedSameFilm = 0;
  }

  return { groups, common, rankOf: rank, options, total, truncated, broken, droppedSameFilm, rankClashes };
}
