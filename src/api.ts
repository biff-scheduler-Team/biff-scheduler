// REST 封装 — 与 functions/api/* 对齐;同源,无需鉴权。
// API 不可用(如纯静态托管)时静默降级为本地模式,由上层置 online=false。

export interface ApiPlanRow {
  code: string;
  group_tag: "A" | "B";
  /** null = 未设档位(D1 侧 NULL;旧数据默认 'maybe' 已在 0001 迁移里落成非空) */
  priority: "must" | "maybe" | "wild" | null;
  note: string;
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
  getPlan: () => req<ApiPlanRow[]>("/api/plan"),
  putPlan: (code: string, body: { group_tag: string; priority: string | null; note: string }) =>
    req<ApiPlanRow>(`/api/plan/${code}`, { method: "PUT", body: JSON.stringify(body) }),
  deletePlan: (code: string) => req<{ code: string }>(`/api/plan/${code}`, { method: "DELETE" }),
  getMapping: () => req<ApiMappingRow[]>("/api/mapping"),
  putMapping: (code: string, body: { douban_url?: string; title_cn?: string; subject_id?: number }) =>
    req<ApiMappingRow>(`/api/mapping/${code}`, { method: "PUT", body: JSON.stringify(body) }),
};
