// 开票批次（抢票）口径 —— 纯函数，import 期不碰 DOM，node 直接可测。
//
// ★ 为什么单开一个模块：批次是**场次级**属性（同一部片可能既有露天场又有室内重映，批次不同），
//   而官网只印「品类文字」、没有逐场清单 —— 判据必须只写一处，「抢票」页与分享文案共用同一份。
//
// ★ 官网口径（2026-09-15 核实，`biff.kr` 售票页 `page_num=11402`；该页有 WAF，直抓被挡，
//   经搜索引擎快照 + 韩文来源交叉确认，两边措辞一致）：
//     第 1 批 · 9/17(四) 14:00 KST：Opening & Closing Ceremony / Open Cinema /
//       Midnight Passion / Actors' House / Community BIFF
//     第 2 批 · 9/21(一) 14:00 KST：General Screenings / Master Class / Cine Class
//
// ★ 逐场判据（优先级从高到低，穷举且互斥 —— 官网第 1 批品类是**穷举**的，其余必然落第 2 批）：
//     ① tags 含 opening / closing        → 开闭幕
//     ② tags 含 midnight                 → Midnight Passion（联映块场次）
//     ③ venue_id ∈ OPEN_CINEMA_VENUES    → Open Cinema（露天放映）
//     ④ code 命中 COMMUNITY_BIFF_CODE     → Community BIFF（官方编号段 901–942）
//     ⑤ 活动 kind = actors_house          → Actors' House
//     ⑥ 其余                              → 第 2 批（含 Master Class / Cine Class / Special Talk）
//
// ★ 判据 ③ 为什么是「场地」而不是「影片 unit === "Open Cinema"」（实测踩过的坑，勿改回去）：
//   · 官方把 Open Cinema 定义为**露天放映** —— 证据就在本项目的数据里：
//     `public/festival-extras.json` 的折扣条件写着
//     "Discount applicable only for General Screenings and Open Cinema(outdoor screenings)
//      at Busan Cinema Center"；
//   · 官方公布的第 31 届 Open Cinema = 电影殿堂屋顶（露天）剧场 4000 席、10/7–10/14 每晚 20:00 共 8 部
//     （innerview.co.kr 2026-09-14），与本站 `venue_id = "bt"` 的 8 场 20:00 **逐部吻合**：
//     003 / 070 / 163 / 325 / 362 / 466 / 554 / 644；
//   · 按影片 unit 判会**两头错**：漏掉 3 场（003 Gala Presentation / 466 Gala Presentation /
//     554 Korean Cinema Today – Special Premiere 的单元名都不叫 Open Cinema，却在露天场里），
//     又把 4 场**室内重映**误判进第 1 批（724 Sohyang / 393 CGV 2 / 229 LOTTE 4 / 546 KOFIC）。
//
// ★ 判据 ④（Community BIFF）的来历，别删：官方第 1 批品类里**明确含 Community BIFF**，
//   而它在本项目排期里是**官方编号 901–942 的 42 场**（`tools/merge_schedule.py` 从付印册子并进来：
//   官网排期页不列 MEGABOX Busan Theater 1–4，只有册子印了 901–942）。实测双向成立：
//   42 场**全部**落在 m1–m4，且 m1–m4 上没有别的场次 —— 故编号段与场地两种判据都安全，
//   这里取**编号段**（那才是官方身份，场地只是本届的映射，见 `docs/CONVENTIONS.md`）。
//   ⚠ 曾经（本 PLAN 初稿）误判为「Community BIFF 不在排期里、无需判别」—— 那是只看了
//   `tags`（只有 6 场带 `event` 标签）就下的结论。册子里它是**免费 · 当天现场先到先得**，
//   线上第一批同样放号，所以它必须按第 1 批提示，不能悄悄落到第 2 批。

import type { Catalog, Screening } from "./types";

/** 开票批次：`1` = 第一批（9/17 14:00 KST），`2` = 第二批（9/21 14:00 KST） */
export type TicketBatch = 1 | 2;

/** 官网品类原文（页面横幅直接印它，**不翻译不改写** —— 用户拿它对官网核对） */
export const BATCH_CATEGORY_EN: Record<TicketBatch, string> = {
  1: "Opening & Closing Ceremony / Open Cinema / Midnight Passion / Actors' House / Community BIFF",
  2: "General Screenings / Master Class / Cine Class",
};

/** 露天放映（Open Cinema）的场地 —— 见文件头 ③。新增露天场馆时只改这里。 */
const OPEN_CINEMA_VENUES: ReadonlySet<string> = new Set(["bt"]);

/** 属于第 1 批的活动类型（`festival-extras.json` 的 `programs[].kind`） */
const FIRST_BATCH_KINDS: ReadonlySet<string> = new Set(["actors_house"]);

/** Community BIFF 的官方编号段（901–942，见文件头 ④）—— 三位 9 开头。 */
const COMMUNITY_BIFF_CODE = /^9\d\d$/;

export interface BatchContext {
  /** code → 活动类型；取不到（extras 未加载 / 缺文件）按「非活动场」处理，偏保守落第 2 批 */
  kindOf?: (code: string) => string | undefined;
}

export interface BatchVerdict {
  batch: TicketBatch;
  /** 判据说明（人话，页面上解释「为什么算这一批」用）—— 与 `batch` **同源**，不另写一套判断 */
  reason: string;
}

/** 一场 → 开票批次 + 判据说明（口径见文件头） */
export function batchVerdictOf(s: Screening, ctx: BatchContext = {}): BatchVerdict {
  const tags = s.tags ?? [];
  if (tags.includes("opening") || tags.includes("closing")) {
    return { batch: 1, reason: "开闭幕" };
  }
  if (tags.includes("midnight")) {
    return { batch: 1, reason: "Midnight Passion" };
  }
  if (OPEN_CINEMA_VENUES.has(s.venue_id)) {
    return { batch: 1, reason: "Open Cinema（露天放映）" };
  }
  if (COMMUNITY_BIFF_CODE.test(s.code)) {
    return { batch: 1, reason: "Community BIFF" };
  }
  if (FIRST_BATCH_KINDS.has(ctx.kindOf?.(s.code) ?? "")) {
    return { batch: 1, reason: "Actors' House" };
  }
  return { batch: 2, reason: "一般放映" };
}

/** 一场 → 开票批次（`batchVerdictOf` 的薄封装） */
export function ticketBatchOf(s: Screening, ctx: BatchContext = {}): TicketBatch {
  return batchVerdictOf(s, ctx).batch;
}

/** 一场 → 判据说明 */
export function batchReasonOf(s: Screening, ctx: BatchContext = {}): string {
  return batchVerdictOf(s, ctx).reason;
}

export interface BatchGroup {
  batch: TicketBatch;
  /** 该批次的场次，已按「日期 → 开场时间」排序 */
  screenings: Screening[];
}

/** 场次按批次分组 —— 批次顺序固定 1 → 2，空批次不出现；
 *  排期里已不存在的 code（换版残留）静默跳过，与 `share.ts::orderedPickRows` 同口径。 */
export function groupCodesByBatch(
  cat: Pick<Catalog, "byCode">,
  codes: string[],
  ctx: BatchContext = {}
): BatchGroup[] {
  const byBatch = new Map<TicketBatch, Screening[]>();
  const seen = new Set<string>();
  for (const code of codes) {
    if (seen.has(code)) continue;
    seen.add(code);
    const s = cat.byCode.get(code);
    if (!s) continue;
    const batch = ticketBatchOf(s, ctx);
    const list = byBatch.get(batch);
    if (list) list.push(s);
    else byBatch.set(batch, [s]);
  }
  return [...byBatch.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([batch, screenings]) => ({
      batch,
      screenings: [...screenings].sort(
        (a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time)
      ),
    }));
}
