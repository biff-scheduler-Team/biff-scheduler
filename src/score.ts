// 排片**质量分** —— 对任意一组排片(手动行程 / AI 建议)算一个可解释的质量分。
// 历史:「本地确定性求解引擎」(must 全覆盖 DFS + maybe 贪心填空 + A/B 方案)已于 2026-09-10
// **整体下线**(见 PLAN-20260910143516)——「智能排片」改为 AI 单通道。本文件只剩质量分与
// 共享的影片入参类型,故由 `engine.ts` 更名 `score.ts`(2026-09-10,PLAN-20260910232833)。
//
// 质量分的**唯一消费者**是「我的行程」头部那枚 `分 N` 药丸(main.ts::buildAgendaHost),
// 它与「怎么排出建议」无关 —— 手动排的行程一样要能算分,所以本地引擎下线后它必须留下。

import type { Priority, Screening } from "./types";
import { OK_SLACK, hmsToMin, slackBetween } from "./util";

/** 排片入参:一部**已定档**影片(priority ≠ null)+ 它的全部已发布场次。
 *  现在是「智能排片」打包送给模型的输入类型(ai.ts::buildPayload 消费)。 */
export interface EngineFilm {
  key: string; // 影片节点 key(cat:<id> / sched:<片名>)
  zh: string; // 显示名(中文优先)
  priority: Priority; // 用户 wish
  rating: number | null; // 目录豆瓣评分(仅作打包信息送给模型)
  shows: Screening[]; // 已发布场次(空=暂无排期)
}

/* ================= 方案评分(纯函数,可解释) ================= */
/** 各优先级单场权重:must×3 / maybe×2 / wild×1(GV 场次另 +1);未设档位(null)不参与计分 */
const SCORE_W: Record<Priority, number> = { must: 3, maybe: 2, wild: 1 };

export interface ScoredRow {
  /** null = 未设档位(新加入且影片库未打标)→ 不参与计分 */
  priority: Priority | null;
  screening: Screening;
}

export interface ScoreBreakdown {
  total: number;
  pri: Record<Priority, number>; // 各档命中场数
  unset: number; // 未设档位场数(权重 ×0,仅用于说明,不影响 total)
  gv: number; // GV 命中场数
  tight: number; // 紧转场次数(0 ≤ 余量 < OK_SLACK)
}

/** 对任意一组排片(手动行程 / AI 建议)算质量分。
 *  endOf(s):该场实际结束分钟(缺省 = end_time)。手动行程侧传「有效结束」(GV 放弃映后谈 → 正片末)。 */
export function scorePlanRows(
  rows: ScoredRow[],
  transitMin: number,
  okSlack = OK_SLACK,
  endOf?: (s: Screening) => number
): ScoreBreakdown {
  const sorted = [...rows].sort(
    (a, b) => a.screening.date.localeCompare(b.screening.date) || a.screening.start_time.localeCompare(b.screening.start_time)
  );
  const pri: Record<Priority, number> = { must: 0, maybe: 0, wild: 0 };
  let unset = 0;
  let gv = 0;
  let tight = 0;
  for (const r of sorted) {
    if (r.priority) pri[r.priority]++;
    else unset++;
    if (r.screening.is_gv) gv++;
  }
  // 同日相邻对:余量 = 间隔 − 跨馆缓冲(口径与网格黄卡同源:util.ts::slackBetween)
  // 重叠(余量<0)由冲突体系展示,不重复计入
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].screening;
    const next = sorted[i].screening;
    if (prev.date !== next.date) continue;
    const prevEnd = endOf ? endOf(prev) : hmsToMin(prev.end_time);
    const { verdict } = slackBetween(
      prevEnd,
      hmsToMin(next.start_time),
      prev.venue_id === next.venue_id,
      transitMin,
      okSlack
    );
    if (verdict === "tight") tight++;
  }
  const total =
    pri.must * SCORE_W.must + pri.maybe * SCORE_W.maybe + pri.wild * SCORE_W.wild + gv - tight;
  return { total, pri, unset, gv, tight };
}
