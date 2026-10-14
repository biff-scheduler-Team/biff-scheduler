/** 「想看」的**按日增量**（GET /api/stats/want-trend）—— 「正在升温」榜的数据源。
 *
 *  ★ 为什么不是 `want-counts.ts` 的第二个字段：两者语义不同、生命周期也不同 ——
 *    `want-counts` 是**累计**（进榜页时就已经有数），这里是**当天新增**（只随日账本变），
 *    混在一个缓存里迟早会把「今天新增」读成「总共这么多」。
 *
 *  ★ 口径（2026-10-14，`PLAN-20261014162246`）：服务端账本按 **KST 日**分桶
 *    （`apps/api/src/day.ts`），所以这里是「**从 `fromDay` 起**的新增」，**不是滚动 24 小时**。
 *    界面必须照着 `fromDay` / `toDay` 如实写，别自己编一个「24 小时」出来。
 *
 *  ⚠ 形状与 `want-counts.ts` 逐字同构（缓存 + 订阅 + 拉取），连「失败时退回上一次的缓存」
 *    这条也照搬：接口挂了时榜单应当是「旧一点的数据」，而不是空的。
 */

import { EDITION } from "./edition";
import { timeoutSignal } from "./net";

export interface WantTrend {
  /** 影片 key → 这段窗口内的新增想看（已由服务端取整；只含正增量） */
  deltas: Record<string, number>;
  /** 窗口左端（含）、右端 —— KST 的 `YYYY-MM-DD`，均由服务端算好 */
  fromDay: string;
  toDay: string;
  /** 服务端实际采用的窗口天数（1 = 仅当天） */
  days: number;
}

let cache: WantTrend | null = null;
let loading: Promise<WantTrend | null> | null = null;
const listeners = new Set<() => void>();

export function onWantTrendChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit() {
  for (const listener of listeners) listener();
}

/** 读缓存。`null` = **还没成功加载过**（「今天没人新增」与「查不到」是两回事，
 *  界面必须能区分 —— 与 `hasWantCounts()` 同一条纪律）。 */
export function peekWantTrend(): WantTrend | null {
  return cache;
}

export async function loadWantTrend(days = 1, force = false): Promise<WantTrend | null> {
  if (cache && !force) return cache;
  if (loading && !force) return loading;
  loading = (async () => {
    try {
      const response = await fetch(`/api/stats/want-trend?edition=${EDITION}&days=${days}`, {
        credentials: "same-origin",
        cache: "no-store",
        signal: timeoutSignal(12_000),
      });
      if (!response.ok) return cache;
      const body = (await response.json()) as Partial<WantTrend>;
      if (!body.deltas || typeof body.deltas !== "object") return cache;
      cache = {
        deltas: body.deltas,
        fromDay: body.fromDay ?? "",
        toDay: body.toDay ?? "",
        days: typeof body.days === "number" ? body.days : days,
      };
      emit();
      return cache;
    } catch {
      return cache;
    } finally {
      loading = null;
    }
  })();
  return loading;
}
