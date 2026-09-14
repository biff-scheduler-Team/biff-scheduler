/**
 * 客户端缓存 GET /api/stats/screening-counts + 场次上报(镜像 `want-counts.ts`)。
 *
 * ⚠ 只上报**场次 code 列表**,绝不上报备注 / 片单 / 身份 —— 与 want-ping 同一条隐私边界。
 * ⚠ 人数口径:该场出现在多少人的行程里,**不看票务状态**(用户 2026-09-14 拍板「口径最宽」);
 *   只回聚合数字,服务端不返回任何名单。
 */

import { EDITION } from "./edition";

export interface ScreeningCounts {
  /** 该场出现在多少人的行程里 */
  attendance: Record<string, number>;
  /** 该场已发布多少条讨论 */
  discussions: Record<string, number>;
}

let cache: ScreeningCounts | null = null;
let loading: Promise<ScreeningCounts> | null = null;
// ⚠ 用 ReturnType 而不是 `number`:浏览器下是 number,node 下是 Timeout 对象(见 scheduleScreeningPing 注释)
let pingTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function emptyCounts(): ScreeningCounts {
  return { attendance: Object.create(null), discussions: Object.create(null) };
}

function emit() {
  for (const listener of listeners) listener();
}

export function onScreeningCountsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function peekScreeningCounts(): ScreeningCounts {
  return cache ?? emptyCounts();
}

export async function loadScreeningCounts(force = false): Promise<ScreeningCounts> {
  if (cache && !force) return cache;
  if (loading && !force) return loading;
  loading = (async () => {
    try {
      const response = await fetch(`/api/stats/screening-counts?edition=${EDITION}`, {
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) return cache ?? emptyCounts();
      const body = (await response.json()) as Partial<ScreeningCounts>;
      cache = {
        attendance:
          body.attendance && typeof body.attendance === "object"
            ? body.attendance
            : Object.create(null),
        discussions:
          body.discussions && typeof body.discussions === "object"
            ? body.discussions
            : Object.create(null),
      };
      emit();
      return cache;
    } catch {
      return cache ?? emptyCounts();
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** 只发场次 code(1200ms 防抖);上报成功后再拉一次计数,让自己这一票立刻体现。
 *  ⚠ 用**全局** `setTimeout` 而不是 `window.setTimeout`:本模块被 `state.ts::rebuildIndex()` 调用,
 *    而单测跑在 node 环境(没有 `window`)—— 写 `window.` 会让所有 import `state.ts` 的单测直接炸。 */
export function scheduleScreeningPing(codes: Iterable<string>): void {
  const list = [...new Set(codes)].filter((code) => code.length > 0).slice(0, 500);
  clearTimeout(pingTimer);
  pingTimer = setTimeout(() => {
    void fetch("/api/stats/screening-attendance-ping", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edition: EDITION, codes: list }),
      signal: AbortSignal.timeout(12_000),
    })
      .then((response) => {
        if (response.ok) return loadScreeningCounts(true);
      })
      .catch(() => undefined);
  }, 1200);
}
