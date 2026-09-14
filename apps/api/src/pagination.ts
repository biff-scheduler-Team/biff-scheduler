/**
 * 游标分页(纯函数)—— 建议反馈与场次讨论**共用同一份实现**。
 *
 * 游标形如 `${created_at}_${id}`:按创建时间倒序翻页时,同一毫秒内的多条靠 id 兜底,
 * 否则「同毫秒多条」会被整批跳过或重复。以前这套写在 `feedback-store.ts` 里,
 * 场次讨论若照抄一份就会漂移,故上提为本模块。
 */

/** limit 非法(非数 / < 1)→ fallback;超过 max → 截到 max。 */
export function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

export function parseCursor(raw: string | undefined): { createdAt: number; id: string } | null {
  if (!raw) return null;
  const i = raw.indexOf("_");
  if (i <= 0) return null;
  const createdAt = Number(raw.slice(0, i));
  const id = raw.slice(i + 1);
  if (!Number.isFinite(createdAt) || !id) return null;
  return { createdAt, id };
}

export function cursorOf(createdAt: number, id: string): string {
  return `${createdAt}_${id}`;
}
