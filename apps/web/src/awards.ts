// 获奖信息(官网**颁奖报道** → 离线产物 `public/awards.json`)。
//
// 与 `extras.ts` 同款:文件缺失 / 解析失败一律**静默降级**(徽章与获奖区自动消失),
// 绝不阻塞主流程 —— 获奖是增强,不是运行前提。
//
// 分工:排期(`data.ts`)回答「谁在什么时候放」,这里回答「谁得了奖」。
// 两者之间只有**片名**一座桥,且已在产物里落成 `codes` / `filmIds` 双键 ——
// 前端只查表,不重算匹配(那是 `tools/build_awards.py` 的职责)。
//
// 2026-10-15 立(`PLAN-20261015142133`)。

import type { AwardItem, AwardPerson, AwardsFile } from "./types";

let data: AwardsFile | null = null;
let byCode = new Map<string, AwardItem[]>();
let byFilmId = new Map<string, AwardItem[]>();

/** 摊平后的两张索引:场次 code → 奖项;目录影片 id → 奖项。同一部片多个奖保留全部。 */
export interface AwardIndex {
  byCode: Map<string, AwardItem[]>;
  byFilmId: Map<string, AwardItem[]>;
}

const push = (map: Map<string, AwardItem[]>, key: string, item: AwardItem): void => {
  const list = map.get(key);
  if (list) list.push(item);
  else map.set(key, [item]);
};

/** 纯函数:把产物摊成索引(不碰网络 / DOM,便于单测)。 */
export function indexAwards(file: AwardsFile | null): AwardIndex {
  const index: AwardIndex = { byCode: new Map(), byFilmId: new Map() };
  for (const item of file?.awards ?? []) {
    for (const code of item.codes ?? []) push(index.byCode, code, item);
    for (const id of item.filmIds ?? []) push(index.byFilmId, id, item);
  }
  return index;
}

export async function loadAwards(): Promise<void> {
  try {
    // `default`(而非 `no-cache`):与 data.ts / extras.ts 同口径,交给 PWA 预缓存命中
    const res = await fetch("/awards.json", { cache: "default" });
    if (!res.ok) return;
    const parsed = (await res.json()) as AwardsFile;
    if (!parsed || !Array.isArray(parsed.awards)) return; // 结构守卫
    data = parsed;
    const index = indexAwards(parsed);
    byCode = index.byCode;
    byFilmId = index.byFilmId;
  } catch {
    /* 缺文件 / 旧部署:保持 null,全站按「无获奖信息」渲染 */
  }
}

export function awards(): AwardsFile | null {
  return data;
}

/** 该场次放映的影片获得的奖项(非获奖场次 → 空数组) */
export function awardsForCode(code: string): AwardItem[] {
  return byCode.get(code) ?? [];
}

/** 该目录影片获得的奖项(可传多个 id:同一部片可能有多个目录条目) */
export function awardsForFilms(ids: (string | undefined | null)[]): AwardItem[] {
  const out: AwardItem[] = [];
  const seen = new Set<AwardItem>();
  for (const id of ids) {
    if (!id) continue;
    for (const item of byFilmId.get(id) ?? []) {
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/** 荣誉奖(人物)—— 不对应场次,资料页展示 */
export function awardPeople(): AwardPerson[] {
  return data?.people ?? [];
}

/** 奖项显示名:有人工中文名就用中文,否则回落官网英文原文(不硬译) */
export function awardLabel(item: { award: string; awardZh: string | null }): string {
  return item.awardZh ?? item.award;
}

/** 奖项一行的副标题:演员奖印人名 + 片名,影片奖印导演(都缺就留空) */
export function awardWho(item: AwardItem): string {
  if (item.person) return `${item.person}（${item.film}）`;
  return item.director ? `导演 ${item.director}` : "";
}

/** 场次卡那一枚徽章的 hover 文本(一行一个奖项) */
export function awardBadgeTip(items: AwardItem[]): string {
  const lines = items.map((item) => {
    const who = awardWho(item);
    return `· ${awardLabel(item)}${who ? ` —— ${who}` : ""}`;
  });
  return ["获奖 · 本场放映的影片在本届电影节获奖", ...lines].join("\n");
}
