/** 场次模糊检索 —— 「按编号 / 片名找到那一场」的**唯一实现**(2026-09-16)。
 *
 *  两个场景共用这一份口径:「我的行程 → 添加转票场次」与「讨论区 → 直接按场次发帖」。
 *  匹配字段 / 排序 / 候选上限任一处改动都只该改一次,所以不留在各自的组件里(红线 5)。
 *
 *  ⚠ 排序口径 = 日期 → 开场时间。用户输入的是「我知道是哪一场」,期待的是时间上靠前的候选,
 *    而不是编号顺序 —— 编号只在同日之内连续,跨日期并不按时间递增。
 */

import { store } from "../state";
import type { Screening } from "../types";

/** 候选上限 —— 场景是「我已经知道是哪一场,快点找到它」,不是全量检索工具。 */
export const MAX_SCREENING_MATCHES = 20;

/** 官方场次编号 / 英文名 / 韩文名 / 中文名(含豆瓣中文名)模糊匹配,按日期 + 开场时间排序。 */
export function matchScreenings(all: Screening[], keyword: string): Screening[] {
  const q = keyword.trim().toLowerCase();
  if (!q) return [];
  return all
    .filter((s) => {
      const zh = store.mappings.get(s.code)?.title_cn ?? "";
      return (
        s.code.includes(q) ||
        s.title_en.toLowerCase().includes(q) ||
        s.title_kr.includes(q) ||
        s.title_zh.includes(q) ||
        zh.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time))
    .slice(0, MAX_SCREENING_MATCHES);
}
