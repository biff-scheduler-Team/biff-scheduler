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
 * 转场规则:同场馆无需缓冲;跨场馆时,先结束的场次 end 追加 transit 再判重叠。
 * transitFor(a, b) 入参为两场馆 id。
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

/** §14 1b:取与某 code 同属一个冲突组的全部 code(自身 + 与之成对的对方)。未冲突返回 undefined。 */
export function conflictGroupFor(result: ConflictResult | undefined, code: string): Set<string> | undefined {
  if (!result || !result.codeSet.has(code)) return undefined;
  const group = new Set<string>([code]);
  for (const [a, b] of result.pairs) {
    if (a === code) group.add(b);
    else if (b === code) group.add(a);
  }
  return group;
}
