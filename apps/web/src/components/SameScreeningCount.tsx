import { useEffect, useState } from "react";
import {
  onScreeningCountsChange,
  peekScreeningCounts,
  type ScreeningCounts,
} from "../screening-counts";
import "./screening-social.css";

/** 订阅「同场 N 人」的客户端计数缓存(单例 + 广播,与 want-counts 同形)。
 *  计数来自另一个 store(不是 `state.ts`),所以这里要自己订阅一次。 */
export function useScreeningCounts(): ScreeningCounts {
  const [, force] = useState(0);
  useEffect(() => onScreeningCountsChange(() => force((n) => n + 1)), []);
  return peekScreeningCounts();
}

/** 「同场 N 人」——0 或接口未就绪时整块不渲染(不留空位)。
 *
 *  ⚠ 2026-09-30(`PLAN-20260930213528`):宿主从**场次卡**搬到**日程表格子**。
 *    行程页只剩日程表一档,卡片视图下线后它失去了唯一的展示面 —— 但**取数口径一个字没变**
 *    (还是 `screening-counts` 那个整站一次拉取的缓存),只是换了个渲染位置。
 *  ⚠ 搬回来的这一条是用户明确要求的(「日程表还是可以加上同场 N 人」),别再当死代码删掉。 */
export function SameScreeningCount({ code }: { code: string }) {
  const counts = useScreeningCounts();
  const total = counts.attendance[code] ?? 0;
  if (total <= 0) return null;
  return (
    <span
      className="same-count"
      data-same-count={total}
      title="把这一场排进行程的人数(含没抢到票的;只统计人数,不显示名单)"
    >
      同场 <strong>{total}</strong> 人
    </span>
  );
}
