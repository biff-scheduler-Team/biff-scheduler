// 排片**质量分** —— 对一组排片(手动行程)算一个可解释的质量分。
// 历史:「本地确定性求解引擎」已于 2026-09-10 下线,本文件只剩质量分,
// 故由 `engine.ts` 更名 `score.ts`(2026-09-10,PLAN-20260910232833)。
//
// 质量分的**唯一消费者**是「我的行程」头部那枚 `分 N` 药丸(main.ts::buildAgendaHost),
// 它与「怎么排出建议」无关 —— 手动排的行程一样要能算分,所以它必须留下。
//
// ★ 2026-09-11(`PLAN-20260911223000`):**去掉档位权重** —— 档位(必看 / 备选 / 随缘)已整体删除,
//   它在冲突场景里的作用由「拖动顺位」接管(见 `plans.ts`)。现在的口径是「排了就算数」:
//     分 = 场次数 + GV 场数 − 紧转场次数

import type { Screening } from "./types";
import { OK_SLACK, hmsToMin, slackBetween } from "./util";

/* ================= 行程质量分(纯函数,可解释) ================= */

export interface ScoredRow {
  screening: Screening;
}

export interface ScoreBreakdown {
  total: number;
  count: number; // 场次数(每场 +1)
  gv: number; // GV 命中场数(+1)
  tight: number; // 紧转场次数(0 ≤ 余量 < OK_SLACK)(−1)
}

/** 对一组排片(手动行程)算质量分。
 *  endOf(s):该场实际结束分钟(缺省 = end_time)。手动行程侧传「有效结束」(GV 放弃映后谈 → 正片末)。 */
export function scorePlanRows(
  rows: ScoredRow[],
  transitMin: number,
  okSlack = OK_SLACK,
  endOf?: (s: Screening) => number
): ScoreBreakdown {
  const sorted = [...rows].sort(
    (a, b) =>
      a.screening.date.localeCompare(b.screening.date) ||
      a.screening.start_time.localeCompare(b.screening.start_time)
  );
  let gv = 0;
  let tight = 0;
  for (const r of sorted) if (r.screening.is_gv) gv++;
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
  const count = sorted.length;
  return { total: count + gv - tight, count, gv, tight };
}
