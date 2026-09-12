// 冲突检测 — 纯函数;按(日期,方案)隔离,支持跨场馆转场缓冲。

export interface Slot {
  code: string;
  date: string;
  start: number; // 当日分钟数(0..1440)
  end: number;
  venue: string;
}

export interface ConflictResult {
  /** 冲突 pair,按 code 字典序去重 */
  pairs: [string, string][];
  /** 卷入冲突的 code 集合 */
  codeSet: Set<string>;
}

/**
 * 判定口径:**只认时间重叠**(a.end > b.start)。
 * 这是刻意的红绿灯语义 ——「红 = 完全冲突(时间重叠)」;
 * 「跨馆余量不足(赶不上)」不是红色,走黄卡(`grid.ts::markTight`)+ 行程页「⚠ 赶不上」。
 *
 * ⚠ `transitFor` 是**死参数**(2026-09-11 单测发现,PLAN-20260911000705 §7.5):
 *   内层 `if (b.start >= a.end) break;` 在追加 transit **之前**就中断了内层循环,而
 *   `a.end + transit > b.start` 在该 guard 下对任何 `transit ≥ 0` **恒真** → 对结果零影响。
 *   保留参数只为不改调用方签名;**勿**改成让它参与判定(那只会把黄卡变红卡,与既定语义相左)。
 */
export function computeConflicts(
  slots: Slot[],
  transitFor: (a: string, b: string) => number
): Map<string, ConflictResult> {
  const byDate = new Map<string, Slot[]>();
  for (const s of slots) {
    const arr = byDate.get(s.date) ?? [];
    arr.push(s);
    byDate.set(s.date, arr);
  }

  const out = new Map<string, ConflictResult>();
  for (const [date, list] of byDate) {
    const pairs: [string, string][] = [];
    const codeSet = new Set<string>();
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (b.start >= a.end) break; // 已按 start 排序,后面不可能重叠
        const transit = a.venue !== b.venue ? transitFor(a.venue, b.venue) : 0;
        // a 先开始:若 a 的结束(跨馆则+缓冲)超过 b 的开始 → 冲突
        if (a.end + transit > b.start) {
          pairs.push([a.code, b.code].sort() as [string, string]);
          codeSet.add(a.code);
          codeSet.add(b.code);
        }
      }
    }
    out.set(date, { pairs, codeSet });
  }
  return out;
}

/** 同方案内、按日期分组的全部已选场次;返回 code 列表(按开始时间排序,供行程/导出用) */
export interface GroupedPlan {
  date: string;
  codes: string[];
  conflicts: ConflictResult | undefined;
}

/** 由 pairs 建**无向邻接表**(conflictGroupFor / conflictGroups 共用)。
 *  只收录成对的 code —— 未冲突的场次不在表内。 */
function adjacencyOf(result: ConflictResult): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    let set = adj.get(a);
    if (!set) {
      set = new Set<string>();
      adj.set(a, set);
    }
    set.add(b);
  };
  for (const [a, b] of result.pairs) {
    link(a, b);
    link(b, a);
  }
  return adj;
}

/** 从某 code 出发做 BFS,取它所在**连通分量**的全部 code。
 *  与 `conflictGroupFor` 同源,但一次给出**当天所有**冲突组(抢票视图按组聚合用)。 */
export function conflictGroups(result: ConflictResult | undefined): string[][] {
  if (!result || result.pairs.length === 0) return [];
  const adj = adjacencyOf(result);
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const stack = [start];
    const group: string[] = [];
    seen.add(start);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      group.push(cur);
      for (const nb of adj.get(cur) ?? []) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        stack.push(nb);
      }
    }
    group.sort();
    groups.push(group);
  }
  // 稳定顺序:组内首 code 字典序 —— 网格 / 行程 / 测试都据此可预期
  groups.sort((a, b) => a[0].localeCompare(b[0]));
  return groups;
}

/** §14 1b:取与某 code 同属一个冲突组的全部 code(自身 + 同组其余)。未冲突返回 undefined。
 *  ⚠ 是**连通分量**而非一跳邻居:三场两两重叠时必须一次拿全(A↔B、B↔C 但 A 与 C 不重叠时,
 *  只走一跳会漏掉 C —— 网格 hover 联动 / 行程择一卡都要求拿全)。 */
export function conflictGroupFor(result: ConflictResult | undefined, code: string): Set<string> | undefined {
  if (!result || !result.codeSet.has(code)) return undefined;
  const adj = adjacencyOf(result);
  const group = new Set<string>([code]);
  const stack = [code];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const nb of adj.get(cur) ?? []) {
      if (group.has(nb)) continue;
      group.add(nb);
      stack.push(nb);
    }
  }
  return group;
}
