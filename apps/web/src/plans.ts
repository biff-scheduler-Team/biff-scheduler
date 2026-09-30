// 冲突组 → 无冲突方案集合 —— 纯函数(不碰 DOM、不改入参),node 可单测。
//
// 语义(2026-09-11 **二改**,`PLAN-20260911223000`):
//   · **冲突组** = `conflict.ts::conflictGroups()` 的连通分量 —— 同一时间带互相重叠的几场;
//   · **方案** = 「每个冲突组各取一场」的**所有组合**(∪ 不属于任何冲突组的共同场次)。
//     但**同一部片在一套方案里只保留一场**(2026-09-11 三改,`PLAN-20260911230500`)。
//   · 组内**次序** = 开场时间(`fallbackOrder`)。用户可拖的「抢票顺位」已于 2026-09-30
//     连同卡片视图整体下线(`PLAN-20260930213528`)—— 本模块不再接收任何顺位入参。
//     组内次序仍决定两件事:方案**成本**(取第 k 场 = 成本 k)与 `topPlanCodes` 取哪一场(第 1 场)。
//
// ★ 为什么「同片只留一场」(用户报的真实场景):
//   行程里同时留着「同一部片的两天场次」是**抢票备选**(见 `PLAN-20260911223000` D7:
//   冲突双方同时存在是用户明知的状态,抢到哪个去哪个)。但枚举若把两个场次当成**互相独立的槽位**,
//   就会出现荒谬结果 —— 027(10/7 12:20 C3 峡湾)与 071(10/8 09:00 BH 峡湾)是同一部片、
//   分属两个冲突组、各自又都是组内第一场 ⇒ 「最优先」那套 = `027+071` = **同一部片看两遍**。
//   故枚举时按 `filmKeyOf` 去重:一套方案里出现两部同片 → 该组合**直接剔除**(进 `droppedSameFilm` 记账,
//   不进 `options`)。剔除后成本层会自然往上走,补上下一批可行组合,不会因此少列。
//   ⚠ 已知边界:去重只作用在**枚举维度**(picks 之间)。共同场次是各套共用的,
//     若它与某个 pick 恰好同片,那一套里该片仍会出现两次 —— 修它得先定义「共同场次 vs 冲突组同片谁让路」,
//     属新语义,不做。
//
// ★ 为什么方案一定无冲突(以及为什么仍然逐套校验):
//   冲突组是**连通分量**,组与组之间按定义没有冲突边 —— 一套方案从每组各取一场,
//   取出来的任意两场必然分属不同组 ⇒ 不重叠。**这是数学性质,不需要次序去保证。**
//   但本模块仍**逐套跑一遍冲突校验**(`pairSet`)而不是依赖该性质:校验是「证据」,性质是「论证」——
//   将来冲突口径变了(例如补上跨午夜的相邻两日),校验会立刻把不可行的组合筛掉,
//   而不是静默产出一套「看起来能用、其实撞车」的方案。
//   校验失败的场次收进 `broken`(正常恒空)。原先靠它标红的是卡片视图的顺位卡,已下线;
//   字段保留是因为它仍是「方案内部仍重叠」的**唯一证据**,单测直接对着它断言。
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

/* 「顺位撞车」(`RankClash` / `RankClashSpot` / `RankFixChange` / `RankFixPlan`)与
 * `detectRankClashes` / `autoFixRanks` 已于 2026-09-30 整体删除(`PLAN-20260930213528`):
 * 它们回答的是「用户拖出来的顺位互相打架怎么办」—— 顺位本身已随卡片视图下线,
 * 组内次序现在由开场时间唯一决定,不存在「谁该让路」这个可修的状态。 */

export interface PlanSet {
  /** 冲突组(只含 ≥2 场的组),按组内首 code 稳定排序;**组内已按开场时间排好** */
  groups: string[][];
  /** 共同场次(不属于任何冲突组)—— 每一套方案都有,不可能与任何场次冲突 */
  common: string[];
  /** 全部**内部无冲突**的方案,按成本升序(同成本按组序字典序:先满足靠前的组) */
  options: PlanOption[];
  /** 组合总数(∏|组|);**既未截断也未因同片去重剔除**时 = `options.length` */
  total: number;
  /** 是否因为组合数过大被截断(只保留了成本最低的一部分) */
  truncated: boolean;
  /** 卷入「方案内部仍重叠」的场次(校验失败的证据;正常恒空) */
  broken: Set<string>;
  /** 因「同一部片出现两场」被剔除的组合数(见文件头) */
  droppedSameFilm: number;
}

/** 枚举上限 —— 超过就只保留**成本最低**的这一批(展示侧默认也只列前 8 套,故这个量足够宽裕)。
 *  3 组 × 3 场 = 27、4 组 × 3 场 = 81 都远在限内;真到 5 组 × 4 场 = 1024 才会截断。 */
export const MAX_OPTIONS = 240;

/** 冲突组 → 「code → 同组其余场次(按顺位升序,不含自身)」。
 *
 *  分享文案的「↳ 备选」行用它(见 `share.ts::ShareRanking`)。
 *  ⚠ 为什么取**当前行程**的组:**备选存在"当前组"这个形态里**,分组与顺位都是现场算的
 *  (`PLAN-20260915234414`)—— 2026-09-22 之前它还与「方案快照」对比过一句,那份快照形态已随
 *  「已保存方案」整体下线(`PLAN-20260922105228`),对比句随之删除。
 *  ⚠ 组内次序沿用 `buildPlanSet` 排好的次序(开场时间),这里不重排。 */
export function groupMatesOf(groups: string[][]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const group of groups) {
    for (const code of group) {
      out.set(code, group.filter((c) => c !== code));
    }
  }
  return out;
}

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

/**
 * 由「已选场次 + 冲突结果」派生**全部无冲突方案**。
 *
 * 枚举顺序 = **按成本分层**(成本从「组数」一路加到「各组大小之和」),故产出**天然按优先度排序**,
 * 不需要事后 sort;撞到 `MAX_OPTIONS` 就停,留下的必然是最优先的那一批。
 *
 * @param codes         全部已选场次 code(允许重复,内部去重保序)
 * @param conflicts     日期 → 冲突结果(与网格 / 行程同源,见 `conflict.ts::computeConflicts`)
 * @param fallbackOrder 组内排序键(调用方按「开始时刻」给一个单调值;顺位已下线,这是唯一判据)
 * @param filmKeyOf     场次 → 影片 key(与网格 / 影片库同一口径)——
 *                      同一套方案里出现两部同片即剔除,见文件头
 */
export function buildPlanSet(
  codes: string[],
  conflicts: Map<string, ConflictResult>,
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

  // 2) 组内排序:**开场时间**(顺位已随卡片视图下线,这是唯一判据),同刻再按 code 稳定收尾。
  //    组内位置本身仍决定方案成本(取第 k 场 = 成本 k)与 `topPlanCodes` 的取值。
  const inGroup = new Set<string>();
  for (const g of groups) {
    g.sort((a, b) => fallbackOrder(a) - fallbackOrder(b) || a.localeCompare(b));
    for (const c of g) inGroup.add(c);
  }
  const common = all.filter((c) => !inGroup.has(c));

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
      options,
      total: 1,
      truncated: false,
      broken,
      droppedSameFilm: 0,
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

  return { groups, common, options, total, truncated, broken, droppedSameFilm };
}
