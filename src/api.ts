// REST 封装 — 与 functions/api/* 对齐;同源,无需鉴权。
// API 不可用(如纯静态托管)时静默降级为本地模式,由上层置 online=false。
//
// 选片只有一张表(user_pick,主键 film_key):档位 / 备注 / 已选场次(JSON 文本)都在同一条记录里,
// 与前端 store.picks 一一对应 —— 不再有「场次级 plan + 影片级 wish」两套。

export interface ApiPickRow {
  /** 影片节点 key:cat:<目录 id> | sched:<片名小写>(含中文,故 URL 里必须 encodeURIComponent) */
  film_key: string;
  /** null = 未设档位 */
  priority: "must" | "maybe" | "wild" | null;
  note: string;
  /** 已选场次的 JSON 文本:`[{"code":"101","group":"A"}]`;D1 侧为 TEXT */
  picks: string;
}

export interface ApiMappingRow {
  code: string;
  subject_id: number | null;
  title_cn: string | null;
  douban_url: string | null;
}

async function req<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { ok: boolean; data: T };
    return json.ok ? json.data : null;
  } catch {
    return null;
  }
}

export const api = {
  getPick: () => req<ApiPickRow[]>("/api/pick"),
  putPick: (
    key: string,
    body: { priority: string | null; note: string; picks: { code: string; group: string }[] }
  ) => req<ApiPickRow>(`/api/pick/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify(body) }),
  deletePick: (key: string) => req<{ film_key: string }>(`/api/pick/${encodeURIComponent(key)}`, { method: "DELETE" }),
  getMapping: () => req<ApiMappingRow[]>("/api/mapping"),
  putMapping: (code: string, body: { douban_url?: string; title_cn?: string; subject_id?: number }) =>
    req<ApiMappingRow>(`/api/mapping/${code}`, { method: "PUT", body: JSON.stringify(body) }),
};
