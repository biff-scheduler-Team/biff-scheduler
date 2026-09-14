/** 排期数据更新日志 —— 加载产物 + 挑出「和我有关的部分」。
 *
 * 数据源 = 静态产物 `public/changelog.json`(`tools/build_changelog.py`:对比 git HEAD 与当前排期)。
 * 文件缺失 / 解析失败一律**静默降级**(与 `extras.ts` 同口径):它只是提示,不是运行前提。
 *
 * 为什么不在前端现算差异:前端只持有一版排期,**「上一版长什么样」已经不在客户端**。
 */

import type { Catalog, ChangelogAdded, ChangelogChanged, ChangelogFile } from "./types";
import { filmNodeKey } from "./util";

/** 已确认的版本号。**独立 localStorage 键**(与 `biff.ranks.v1` / `biff.gvtalk.v1` 同口径)——
 *  视图偏好不混进 `biff.settings.v1`,「重置设置」不会顺手把它带走。
 *  ⚠ `biff.*` 键**只增不改**:旧版不读这个键,也不会因为它的存在而坏。 */
const LS_SEEN = "biff.dataver.v1";

let data: ChangelogFile | null = null;

export async function loadChangelog(): Promise<void> {
  try {
    // `default`(而非 `no-cache`):与 data.ts / extras.ts 同口径,交给 PWA 预缓存命中(现场断网可用)
    const res = await fetch("/changelog.json", { cache: "default" });
    if (!res.ok) return;
    const parsed = (await res.json()) as ChangelogFile;
    if (!parsed || !Array.isArray(parsed.added) || !Array.isArray(parsed.changed)) return;
    data = parsed;
  } catch {
    /* 缺文件 / 旧部署:保持 null,顶栏不出现「数据更新」入口 */
  }
}

export function peekChangelog(): ChangelogFile | null {
  return data;
}

/** 本地已确认的版本号(没确认过 = 空串) */
export function seenVersion(): string {
  try {
    return localStorage.getItem(LS_SEEN) ?? "";
  } catch {
    return ""; // 隐私模式 / 存储被禁:当作「没确认过」,不抛
  }
}

/** 记下已确认的版本号(顶栏入口据此消失) */
export function markSeen(version: string): void {
  try {
    localStorage.setItem(LS_SEEN, version);
  } catch {
    /* 存不进去就让入口常驻,不影响主流程 */
  }
}

/** 判断「和我有关」需要的三样东西。`seen` 由调用方传入而不是内部读 localStorage ——
 *  这样 `changelogHighlights()` 是纯函数,可以直接单测。 */
export interface ChangelogScope {
  /** 我行程里的场次 code */
  codes: ReadonlySet<string>;
  /** 我选中的影片 key(`util.ts::filmNodeKey`) */
  filmKeys: ReadonlySet<string>;
  /** 本地已确认的版本号(`seenVersion()`) */
  seen: string;
}

export interface ChangelogHighlights {
  /** ① 我行程里信息变了的场次 */
  mine: ChangelogChanged[];
  /** ② 我选过的影片的新排期 */
  myFilmsAdded: ChangelogAdded[];
  /** ③ 其余新增场次(概况用) */
  othersAdded: ChangelogAdded[];
  /** 本次新增总数(概况标题用) */
  addedTotal: number;
  /** 是否值得提示:有内容 **且** 这一版还没确认过 */
  hasUpdate: boolean;
  /** 徽章数字 = 与我相关的条数(0 时按钮不显示数字,但仍可点开看概况) */
  relevant: number;
}

const EMPTY: ChangelogHighlights = {
  mine: [],
  myFilmsAdded: [],
  othersAdded: [],
  addedTotal: 0,
  hasUpdate: false,
  relevant: 0,
};

/** 把产物切成「我的」与「其余的」三组。
 *
 *  影片身份一律走 `filmNodeKey()` —— 它是全站唯一身份口径(官网英文名 → 中文名 → 原始片名三条路)。
 *  按片名字符串直接比会漏掉后两条路,表现为「明明选了这部片,却说没有新排期」。 */
export function changelogHighlights(cat: Catalog, scope: ChangelogScope): ChangelogHighlights {
  if (!data) return EMPTY;
  const mine = data.changed.filter((c) => scope.codes.has(c.code));
  const myFilmsAdded: ChangelogAdded[] = [];
  const othersAdded: ChangelogAdded[] = [];
  for (const s of data.added) {
    (scope.filmKeys.has(filmNodeKey(cat, s)) ? myFilmsAdded : othersAdded).push(s);
  }
  const hasContent = data.added.length > 0 || data.changed.length > 0;
  return {
    mine,
    myFilmsAdded,
    othersAdded,
    addedTotal: data.added.length,
    hasUpdate: hasContent && scope.seen !== data.schedule_generated_at,
    relevant: mine.length + myFilmsAdded.length,
  };
}

/** 新增场次按影院归并(概况区用)—— 保持首次出现顺序,与 `venues.json` 的泳道顺序无关。 */
export function addedByVenue(added: ChangelogAdded[]): { venue: string; list: ChangelogAdded[] }[] {
  const groups = new Map<string, ChangelogAdded[]>();
  for (const s of added) {
    const list = groups.get(s.venue_display);
    if (list) list.push(s);
    else groups.set(s.venue_display, [s]);
  }
  return [...groups.entries()].map(([venue, list]) => ({ venue, list }));
}
