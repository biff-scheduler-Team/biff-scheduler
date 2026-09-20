import { useEffect, useState } from "react";
import {
  onScreeningCountsChange,
  peekScreeningCounts,
  type ScreeningCounts,
} from "../screening-counts";
import { setTicket, ticketOf } from "../state";
import { useStore } from "../app/store";
import { TICKET_STATE_LABELS, TICKET_STATES } from "../tickets";
import "./screening-social.css";

/** 订阅「同场 N 人 / 讨论 N」的客户端计数缓存(单例 + 广播,与 want-counts 同形)。
 *  计数来自另一个 store(不是 `state.ts`),所以这里要自己订阅一次。 */
export function useScreeningCounts(): ScreeningCounts {
  const [, force] = useState(0);
  useEffect(() => onScreeningCountsChange(() => force((n) => n + 1)), []);
  return peekScreeningCounts();
}

/** 票务三态 + 「转票」来源标记。点已选中的那一档 = 清回「未标记」。 */
export function ScreeningTicketControl({ code }: { code: string }) {
  // 票务状态存在 state.ts 里:显式订阅一次,避免依赖父组件恰好也订阅了 store
  useStore();
  const record = ticketOf(code);
  return (
    // 比外层场次卡更近的埋点锚点：`closest()` 会先命中最内层，于是「标记票务结果」
    // 被单独记成 `ticket`，而不会混进 `screening` —— 这两件事的意图完全不同。
    <div className="ticket-control" role="group" aria-label={`场次 ${code} 票务结果`} data-track="ticket">
      <span className="ticket-control-label">票务</span>
      {TICKET_STATES.map((state) => {
        const active = record?.state === state;
        return (
          <button
            key={state}
            type="button"
            className={active ? "ticket-chip active" : "ticket-chip"}
            aria-pressed={active}
            data-ticket-state={state}
            onClick={() => setTicket(code, active ? null : state)}
          >
            {TICKET_STATE_LABELS[state]}
          </button>
        );
      })}
      {record?.via === "transfer" && (
        <span className="ticket-transfer" title="这一场的票是别人转给你的">
          转票
        </span>
      )}
    </div>
  );
}

/** 「同场 N 人」——0 或接口未就绪时整块不渲染(不留空位)。 */
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
