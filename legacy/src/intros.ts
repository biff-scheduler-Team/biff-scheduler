// 豆瓣简介:离线产物 `public/douban-intros.json`(Frodo `movie/{id}` 的 `intro`)。
// 与 extras / related 同口径:缺失静默降级,不阻塞主流程。

let bySubject = new Map<string, string>();

/** 启动时调用一次。文件缺失 / 旧部署 → 空表,详情弹层不出现简介。 */
export async function loadIntros(): Promise<void> {
  try {
    const res = await fetch("douban-intros.json", { cache: "default" });
    if (!res.ok) return;
    const parsed = (await res.json()) as { intros?: Record<string, unknown> };
    const intros = parsed?.intros;
    if (!intros || typeof intros !== "object") return;
    const next = new Map<string, string>();
    for (const [key, value] of Object.entries(intros)) {
      const text = typeof value === "string" ? value.trim() : "";
      if (text) next.set(String(key), text);
    }
    bySubject = next;
  } catch {
    /* 缺文件 / 旧部署:保持空表 */
  }
}

/** subject_id → 简介;没有 → null(调用方不占位)。 */
export function introOf(subjectId: string | number | null | undefined): string | null {
  if (subjectId == null || subjectId === "") return null;
  return bySubject.get(String(subjectId)) ?? null;
}
