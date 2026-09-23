/**
 * C 组「群体行为与口碑」（2026-09-20，第 2 轮，见 PLAN-20260920203010 修订 1）。
 *
 * ★ 与 A/B 两组的分工：
 *   · A 组看**供给**（有多少场可抢）、B 组看**我自己**（我排了什么）；
 *   · C 组看**别人**：想看人数（意愿）、红黑票（口碑），
 *     外加一条**把我和别人对照起来**的指标 —— 我挑的片在群体里算不算热门。
 *
 * ★ 为什么「我与群体的重合度」放在这一组而不是画像里：
 *   它需要两边的数据（我的片单 + 全站想看），放画像里就得让画像 import 全站计数，
 *   「我的画像」就再也不「只有我自己」了。
 *
 * ★ 两个子面的**不可比性**必须说清：想看人数按**影片**、红黑票按**影片** ——
 *   它们的分母不同，两个榜单不能横向比大小，只能各自看排序。
 *
 * ⚠ 第三个子面「场次讨论（话题）」已于 2026-09-22 随讨论区一并删除
 *   （`PLAN-20260922101227`，用户「『场次讨论 N』指标也一并去掉，读数链路一起清」）：
 *   它的上游计数（`/api/stats/screening-counts` 的 `discussions`）后端仍在返回，但前端不再消费。
 *
 * ⚠ 阈值复用 `rush-analysis.ts::MIN_VOTES_FOR_VERDICT`（本轮**不新增**阈值）：
 *   口径只该有一份，否则「几张票才敢下结论」就会出现两个答案。
 * ⚠ 纯逻辑，import 期不碰 DOM，也不 import 任何网络单例。
 */

import { MIN_VOTES_FOR_VERDICT, medianOf } from "./rush-analysis";
// 取整口径的唯一来源（此前本文件另写了一份 `whole`，见 util.ts 的说明）
import { wholeCount as whole } from "./util";

/* ---------------- 想看人数（意愿） ---------------- */

export interface WantRow {
  key: string;
  title: string;
  want: number;
}

export interface CrowdWant {
  /** 参与统计的影片数（= 目录片数） */
  films: number;
  /** 至少有一人想看的影片数 */
  withWant: number;
  wantTotal: number;
  /** 有想看影片的**中位数** —— 页面上「群体热门」的基准（与热度口径同源） */
  median: number | null;
  /** 想看人数降序 */
  top: WantRow[];
}

/** 想看人数榜。全站一个人都没点 → `null`（页面整组给空态，不画全 0 的图）。 */
export function wantBoard(rows: WantRow[]): CrowdWant | null {
  let wantTotal = 0;
  const positive: WantRow[] = [];
  for (const row of rows) {
    const want = whole(row.want);
    if (want <= 0) continue;
    wantTotal += want;
    positive.push({ ...row, want });
  }
  if (wantTotal <= 0) return null;
  positive.sort((a, b) => b.want - a.want || a.title.localeCompare(b.title));
  return {
    films: rows.length,
    withWant: positive.length,
    wantTotal,
    median: medianOf(positive.map((row) => row.want)),
    top: positive,
  };
}

/* ---------------- 红黑票（口碑） ---------------- */

export interface VoteRow {
  key: string;
  title: string;
  red: number;
  black: number;
}

export interface CrowdVotes {
  /** 至少有一票的影片数 */
  films: number;
  red: number;
  black: number;
  total: number;
  /** 红票占比（0–1）；无票 → `null` */
  redShare: number | null;
  /** 红票最多（降序） */
  topRed: VoteRow[];
  /** 黑票最多（降序） */
  topBlack: VoteRow[];
  /** **有争议**的片：红黑都过 `MIN_VOTES_FOR_VERDICT` 且两边都有人贴 —— 站内看法分裂 */
  divided: VoteRow[];
}

/** 红黑榜汇总。一票都没有 → `null`。 */
export function voteBoard(rows: VoteRow[]): CrowdVotes | null {
  const scored: VoteRow[] = [];
  let red = 0;
  let black = 0;
  for (const row of rows) {
    const r = whole(row.red);
    const b = whole(row.black);
    if (r + b <= 0) continue;
    red += r;
    black += b;
    scored.push({ ...row, red: r, black: b });
  }
  const total = red + black;
  if (total <= 0) return null;
  const byRed = [...scored].sort((a, b) => b.red - a.red || a.title.localeCompare(b.title));
  const byBlack = [...scored].sort((a, b) => b.black - a.black || a.title.localeCompare(b.title));
  return {
    films: scored.length,
    red,
    black,
    total,
    redShare: red / total,
    topRed: byRed,
    topBlack: byBlack,
    // 「有争议」= 两种票都攒到了能下结论的量（两边都 ≥ 阈值）——只贴一枚黑票不算争议
    divided: scored
      .filter((row) => row.red >= MIN_VOTES_FOR_VERDICT && row.black >= MIN_VOTES_FOR_VERDICT)
      .sort((a, b) => b.red + b.black - (a.red + a.black)),
  };
}

/* ---------------- 我与群体的重合度 ---------------- */

export interface Overlap {
  /** 我排了场次的影片数 */
  mine: number;
  /** 其中「群体热门」的影片数（想看 ≥ 全站中位数） */
  hot: number;
  /** 我排的片里，连一个人想看都没有的影片数 */
  cold: number;
  /** 群体热门基准（全站有想看影片的中位数）；无数据 → `null` */
  median: number | null;
}

/** 我的片单 vs 全站想看人数。
 *
 *  ★ 为什么用**中位数**而不是固定阈值：站点规模会变（今年 250 部、明年可能翻倍），
 *    写死「≥ 50 人想看算热门」迟早失真 —— 与 `rush-analysis.ts::hotVsVotes` 同一套理由。
 *  ★ `mine` 为 0 → 返回全 0 而不是 `null`：这时页面自己决定不渲染（空行程已在 B 组拦过）。
 *  ⚠ `hot` 用 `>=` 而不是 `>`：中位数本身就该算热门（与 `heatMedian` 的判定同侧）。
 */
export function myCrowdOverlap(myFilmKeys: string[], rows: WantRow[]): Overlap {
  const board = wantBoard(rows);
  const wantByKey = new Map<string, number>();
  for (const row of rows) wantByKey.set(row.key, whole(row.want));
  const unique = [...new Set(myFilmKeys)];
  let hot = 0;
  let cold = 0;
  for (const key of unique) {
    const want = wantByKey.get(key) ?? 0;
    if (want <= 0) {
      cold += 1;
      continue;
    }
    if (board?.median != null && want >= board.median) hot += 1;
  }
  return { mine: unique.length, hot, cold, median: board?.median ?? null };
}


