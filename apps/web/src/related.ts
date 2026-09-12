// 豆瓣「相关电影」:离线产物 `public/douban-related.json`(Frodo `/recommendations`)。
//
// 与 extras.ts 同口径:缺失 / 解析失败一律静默降级,不阻塞主流程。
// 「是不是本届」不写进产物 —— 用当前 `store.mappings` 现查,映射续跑后不用重抓推荐。

import type { DoubanRec, FestRef, Mapping } from "./types";

/** 站外推荐在弹层里的条数上限;本届命中不截断(一部推荐里本届重叠实测最多约 10)。 */
export const MORE_CAP = 6;

export interface RelatedSplit {
  festival: DoubanRec[];
  more: DoubanRec[];
}

let bySubject = new Map<string, DoubanRec[]>();

function isRec(value: unknown): value is DoubanRec {
  if (!value || typeof value !== "object") return false;
  const rec = value as DoubanRec;
  return typeof rec.id === "string" && typeof rec.title === "string" && typeof rec.url === "string";
}

/** 启动时调用一次。文件缺失 / 旧部署 → 空表,弹层不出现相关区。 */
export async function loadRelated(): Promise<void> {
  try {
    const res = await fetch("douban-related.json", { cache: "default" });
    if (!res.ok) return;
    const parsed = (await res.json()) as { recs?: Record<string, unknown> };
    const recs = parsed?.recs;
    if (!recs || typeof recs !== "object") return;
    const next = new Map<string, DoubanRec[]>();
    for (const [key, items] of Object.entries(recs)) {
      if (!Array.isArray(items)) continue;
      next.set(String(key), items.filter(isRec));
    }
    bySubject = next;
  } catch {
    /* 缺文件 / 旧部署:保持空表 */
  }
}

export function recsOf(subjectId: string | number | null | undefined): DoubanRec[] {
  if (subjectId == null || subjectId === "") return [];
  return bySubject.get(String(subjectId)) ?? [];
}

/** 把 mappings 收成 subject_id → { filmId, code }。
 *  `f###` 记目录 id,其它键(场次 code)取**第一个**当弹层入口(douban.json 键已排序,001 先于 156)。 */
export function indexFestival(mappings: Map<string, Mapping>): Map<string, FestRef> {
  const out = new Map<string, FestRef>();
  for (const [key, mapping] of mappings) {
    if (mapping.subject_id == null) continue;
    const sid = String(mapping.subject_id);
    const ref = out.get(sid) ?? { filmId: null, code: null };
    if (/^f\d+$/.test(key)) ref.filmId = key;
    else if (!ref.code) ref.code = key;
    out.set(sid, ref);
  }
  return out;
}

/** 一份推荐 → 本届 / 站外。丢掉自身;站外封顶 `MORE_CAP`。顺序保持服务端相关度序。 */
export function splitRelated(
  recs: DoubanRec[],
  sourceId: string,
  fest: Map<string, FestRef>,
  moreCap = MORE_CAP
): RelatedSplit {
  const festival: DoubanRec[] = [];
  const more: DoubanRec[] = [];
  for (const rec of recs) {
    if (rec.id === sourceId) continue;
    if (fest.has(rec.id)) festival.push(rec);
    else if (more.length < moreCap) more.push(rec);
  }
  return { festival, more };
}

/** 弹层入口:该片的推荐按当前映射拆成两段。无数据 → 两段都空。 */
export function relatedOf(
  subjectId: string | number | null | undefined,
  mappings: Map<string, Mapping>
): RelatedSplit {
  const sid = subjectId == null ? "" : String(subjectId);
  if (!sid) return { festival: [], more: [] };
  return splitRelated(recsOf(sid), sid, indexFestival(mappings));
}
