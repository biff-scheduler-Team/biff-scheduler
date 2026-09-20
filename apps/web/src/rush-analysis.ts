/**
 * 「数据分析」页的聚合口径（抢票分析模块，2026-09-20，PLAN-20260920161837）。
 *
 * 六个区块的计算全在这里，页面只做渲染 —— 纯逻辑、import 期不碰 DOM，node 直接可测。
 * 数据全部来自**已加载的单例**（排期产物 + 四套已有聚合），本模块不发任何网络请求。
 *
 * ★ 各阈值的取法与理由（**只此一处**）：
 *   · `MIN_RATE_SAMPLES = 10` —— 抢到率的分母（已抢到 + 没抢到 + 放弃）低于 10 时**不给率值**。
 *     3 个人标记就报「抢到率 33%」是把噪声当结论；10 是「至少两位数的人」这条最低底线。
 *   · `MIN_VOTES_FOR_VERDICT = 5` —— 红黑榜总票数低于 5 时不下「口碑好 / 坏」的结论。
 *     与上同理：贴纸是离散的，2 红 1 黑说成「好评」没有意义。
 *   · `TOP_N` = 10 / 20 —— 集中度只报这两档。
 *
 * ★ 为什么**不做基尼系数 / 赫芬达尔指数**：
 *   它们的数值无法被用户直觉校验（「HHI = 0.031」要用户信谁？），与本站「口径必须能被人话
 *   解释」的一贯风格相悖。改成「Top N 占比」+「承载全站一半需求需要多少场」——
 *   两句话就能说清，且直接指导「盯住哪几场」。
 *
 * ⚠ **24+ 时制（红线）**：时段分桶读 `start_time` 的**原始小时**，`>= 24` 归入「次日」档，
 *   **任何地方不得 `% 24`**。实测本届 `schedule.json` 795 场的开场小时域是 08–23、
 *   `pni.json` 是 09–22，故「次日」档是防御性分支（换版 / 补录可能出现），单测用合成样本覆盖。
 */

import { capacityOf, difficultyOf, percentileOf, type DifficultyLevel } from "./capacity";
import type { Catalog, Screening } from "./types";
import type { TicketCounts } from "./ticket-stats";

/** 抢到率的分母下限：低于它就不给率值（见文件头）。 */
export const MIN_RATE_SAMPLES = 10;

/** 口碑结论的最小票数（红 + 黑），低于它不下结论（见文件头）。 */
export const MIN_VOTES_FOR_VERDICT = 5;

/** 集中度报的档位。 */
export const TOP_N = [10, 20] as const;

/** 进度条 / 占比显示用的分子分母（页面据此画既有 CSS 条形）。 */
export interface Share {
  count: number;
  demand: number;
  /** 0–1；总量为 0 时不产出该行（`demandConcentration` 直接返回 null） */
  share: number;
}

/* ---------------- 输入行 ---------------- */

/** 一场的「需求侧」原始行 —— 页面从排期 + 容量 + 同场人数装配，本模块只认这几个字段。 */
export interface ShowDemandRow {
  code: string;
  /** ISO 日期 */
  date: string;
  /** 开场时间的**原始小时**（24+ 时制不取模；`>= 24` 属次日档） */
  startHour: number;
  /** 抢票人数 = 「同场 N 人」（0 = 尚无数据） */
  demand: number;
  /** 该厅座位数；未收录 → `null` */
  capacity: number | null;
  /** 影厅 id。
   *  ⚠ **可选**：第 1 轮的行只有上面五个字段，供给分组（第 2 轮）才需要它。
   *    设成必填会把既有的 35 条单测全部改红 —— 而「既有测试一条不改」正是「口径没被动过」的证据。 */
  venueId?: string;
}

/** `"29:35"` → `29`（**不取模**，见文件头）。非法输入 → `null`。
 *  ⚠ 用正则而不是 `slice(0, 2)`：后者会把空串读成 `Number("") === 0`，凭空造出一个「00 时」桶。 */
export function startHourOf(startTime: string): number | null {
  const matched = /^(\d{1,3}):/.exec(startTime.trim());
  if (!matched) return null;
  const hour = Number(matched[1]);
  return Number.isInteger(hour) && hour >= 0 ? hour : null;
}

/** 排期 + 同场人数 → 需求侧的原始行（**全站唯一的装配口径**，2026-09-20 第 2 轮抽出）。
 *
 *  ★ 为什么抽出来：第 1 轮时这段装配写在 `RushAnalysisPage` 里，第 2 轮的四组维度（供给 /
 *    画像 / 群体 / 建议）全都要吃同一份行；再复制一份到各分组里，「时段怎么算」就有两处实现 ——
 *    这正是红线 5 要防的形态。
 *  ⚠ `start_time` 解析不出来（空串 / 脏数据）的场次**整行丢弃**：它连横轴坐标都没有，
 *    留着只会让「有需求的场次」与「总场次」两个数字对不上。
 */
export function buildShowRows(
  cat: Pick<Catalog, "schedule" | "venueById">,
  attendance: Record<string, number>,
): ShowDemandRow[] {
  const rows: ShowDemandRow[] = [];
  for (const screening of cat.schedule.screenings) {
    const hour = startHourOf(screening.start_time);
    if (hour === null) continue;
    rows.push({
      code: screening.code,
      date: screening.date,
      startHour: hour,
      demand: attendance[screening.code] ?? 0,
      capacity: capacityOf(cat.venueById.get(screening.venue_id)),
      venueId: screening.venue_id,
    });
  }
  return rows;
}

/** 场次 → 该场的原始 `Screening`（找不到 → `undefined`）。
 *  分组模块（供给 / 建议）都要反查排期，各自写一遍 `cat.byCode.get(...)` 是没必要的重复。 */
export function screeningOf(cat: Pick<Catalog, "byCode">, code: string): Screening | undefined {
  return cat.byCode.get(code);
}

/* ---------------- 一、抢票难度榜 ---------------- */

export interface DifficultyRow extends ShowDemandRow {
  level: DifficultyLevel;
  ratio: number | null;
  reason: string;
  /** 在有容量的场次里高于多少比例（0–100）；自身无容量 / 样本 < 2 → `null` */
  percentile: number | null;
}

/** 难度榜：倍率降序（未收录容量的排最后，按需求人数降序），同分再按 code 稳定排序。 */
export function difficultyBoard(rows: ShowDemandRow[]): DifficultyRow[] {
  const enriched = rows.map((row) => {
    const verdict = difficultyOf(row.demand, row.capacity);
    return { ...row, ...verdict, percentile: null as number | null };
  });
  const ratios = enriched.map((row) => row.ratio).filter((x): x is number => x !== null);
  for (const row of enriched) row.percentile = percentileOf(row.ratio, ratios);
  return enriched.sort(
    (a, b) =>
      Number(b.ratio ?? -1) - Number(a.ratio ?? -1) ||
      b.demand - a.demand ||
      a.code.localeCompare(b.code),
  );
}

/* ---------------- 二、需求集中度 ---------------- */

export interface Concentration {
  /** 全站需求合计 */
  total: number;
  /** 有需求的场次数 */
  shows: number;
  top10: Share;
  top20: Share;
  /** 承载全站**一半**需求所需的场次数（按需求降序累加到达半数的场次） */
  halfCount: number;
}

/** 需求降序的正数序列（0 / 负 / NaN 一律剔除）。
 *  **集中度与帕累托图共用这一份排序口径** —— 两处各写一次迟早会漂（一处剔 0、一处不剔）。 */
function sortedPositiveDemands(demands: Iterable<number>): number[] {
  return [...demands].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => b - a);
}

/** 集中度：只回答「多少场吃掉了多少需求」。总需求为 0 → `null`（页面整块不渲染）。 */
export function demandConcentration(demands: Iterable<number>): Concentration | null {
  const sorted = sortedPositiveDemands(demands);
  const total = sorted.reduce((sum, n) => sum + n, 0);
  if (total <= 0) return null;
  const half = total / 2;
  let running = 0;
  let halfCount = 0;
  for (const n of sorted) {
    running += n;
    halfCount++;
    if (running >= half) break;
  }
  const share = (n: number): Share => {
    const picked = sorted.slice(0, n);
    const demand = picked.reduce((sum, x) => sum + x, 0);
    return { count: picked.length, demand, share: demand / total };
  };
  return {
    total,
    shows: sorted.length,
    top10: share(TOP_N[0]),
    top20: share(TOP_N[1]),
    halfCount,
  };
}

/** 帕累托图的一个点。 */
export interface ParetoPoint {
  /** 横轴标签：场次序号（`1` / `2` …）或末尾的 `其余` */
  label: string;
  /** 这一档自身的需求 */
  demand: number;
  /** **累计**占比（0–1）—— 折线画的就是它 */
  cumulative: number;
}

/** 帕累托数据：需求降序，前 `limit` 档单列、其余合并成一档（默认 24 档）。
 *  总需求为 0 → `null`（页面整块不渲染，不画空图）。 */
export function demandPareto(demands: Iterable<number>, limit = 24): ParetoPoint[] | null {
  const sorted = sortedPositiveDemands(demands);
  const total = sorted.reduce((sum, n) => sum + n, 0);
  if (total <= 0) return null;
  const head = limit > 0 ? sorted.slice(0, limit) : [];
  const rest = limit > 0 ? sorted.slice(limit) : sorted;
  const out: ParetoPoint[] = [];
  let running = 0;
  head.forEach((demand, index) => {
    running += demand;
    out.push({ label: String(index + 1), demand, cumulative: running / total });
  });
  if (rest.length > 0) {
    const demand = rest.reduce((sum, n) => sum + n, 0);
    running += demand;
    out.push({ label: "其余", demand, cumulative: running / total });
  }
  return out;
}

/* ---------------- 三、需求时间分布 ---------------- */

export interface DateBucket {
  date: string;
  demand: number;
  shows: number;
}

/** 按日期分布（日期字典序 = 时间序）。只统计有需求的场次。 */
export function demandByDate(rows: ShowDemandRow[]): DateBucket[] {
  const buckets = new Map<string, DateBucket>();
  for (const row of rows) {
    if (row.demand <= 0) continue;
    const bucket = buckets.get(row.date) ?? { date: row.date, demand: 0, shows: 0 };
    bucket.demand += row.demand;
    bucket.shows += 1;
    buckets.set(row.date, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export interface HourBucket {
  /** 原始小时；`>= 24` 全部并入 `NEXT_DAY_HOUR` */
  hour: number;
  label: string;
  demand: number;
  shows: number;
}

/** 「次日」档的 bucket key —— 用来聚合一切 `>= 24` 的开场（**不是**取模后的 0 时）。 */
export const NEXT_DAY_HOUR = 24;

/** 按开场时段分布。`hour >= 24` 并入次日档并在 label 上**显式标注**（不取模，见文件头）。 */
export function demandByHour(rows: ShowDemandRow[]): HourBucket[] {
  const buckets = new Map<number, HourBucket>();
  for (const row of rows) {
    if (row.demand <= 0) continue;
    if (!Number.isFinite(row.startHour) || row.startHour < 0) continue;
    const hour = bucketHourOf(row.startHour);
    const bucket = buckets.get(hour) ?? { hour, label: hourLabel(hour), demand: 0, shows: 0 };
    bucket.demand += row.demand;
    bucket.shows += 1;
    buckets.set(hour, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.hour - b.hour);
}

/** 「原始小时 → 分桶小时」的唯一映射：`>= 24` 一律并入次日档（**不取模**）。
 *  供给分组（第 2 轮）按场次时段计数时也走它，避免那里自己写一次 `>= 24 ? ... : ...`。 */
export function bucketHourOf(startHour: number): number {
  return startHour >= NEXT_DAY_HOUR ? NEXT_DAY_HOUR : startHour;
}

export function hourLabel(hour: number): string {
  if (hour >= NEXT_DAY_HOUR) return "次日（跨午夜场）";
  return `${String(hour).padStart(2, "0")}:00`;
}

/* ---------------- 四、抢票结果（全站） ---------------- */

export interface TicketSummary {
  got: number;
  transfer: number;
  missed: number;
  dropped: number;
  /** 抢到率的分母 = 已抢到 + 没抢到 + 放弃（**转票不在其中**，见下） */
  samples: number;
  /** 有结果标记的场次数 */
  shows: number;
  /** 样本 ≥ MIN_RATE_SAMPLES 才给率值，否则为 `null`（页面明示「样本不足」） */
  gotRate: number | null;
  missedRate: number | null;
  droppedRate: number | null;
}

/** 全站抢票结果汇总。
 *
 *  ★ 抢到率 = `已抢到 ÷ (已抢到 + 没抢到 + 放弃)`；**转票单独计数，既不进分子也不进分母**
 *    —— 票是别人转的不等于自己抢到（口径见 PLAN-20260920161837）。
 *  ★ 四项都是加权和（登录 1.0 / 匿名 0.75），所以这里先 `Math.round` 成「人」再算率
 *    —— 与页面上印出来的数字同源，避免「印 3 人、率值却按 2.25 算」这种对不上的情况。
 *  ★ 汇总在**前端**做（这里），服务端只存计数不算率：率值是纯展示派生，两处都算就是同一口径
 *    两份实现（红线 5）。
 */
export function ticketOutcomeStats(counts: Record<string, TicketCounts>): TicketSummary | null {
  let got = 0;
  let transfer = 0;
  let missed = 0;
  let dropped = 0;
  let shows = 0;
  for (const row of Object.values(counts)) {
    const g = whole(row?.got);
    const t = whole(row?.transfer);
    const m = whole(row?.missed);
    const d = whole(row?.dropped);
    if (g + t + m + d <= 0) continue;
    got += g;
    transfer += t;
    missed += m;
    dropped += d;
    shows += 1;
  }
  const samples = got + missed + dropped;
  if (shows === 0) return null;
  const enough = samples >= MIN_RATE_SAMPLES;
  return {
    got,
    transfer,
    missed,
    dropped,
    samples,
    shows,
    gotRate: enough ? got / samples : null,
    missedRate: enough ? missed / samples : null,
    droppedRate: enough ? dropped / samples : null,
  };
}

/** 加权和 → 「人」。用 `Math.round` 而不是 `trunc`：匿名权重是 0.75，截断会把 0.75 直接吃掉。 */
function whole(raw: unknown): number {
  const n = Math.round(Number(raw) || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/* ---------------- 五、热度与口碑关联 ---------------- */

/** 一部片的三个信号 —— `demand` = 该片全部场次的抢票人数之和。 */
export interface FilmSignals {
  key: string;
  title: string;
  /** 想看人数（影片级） */
  want: number;
  /** 抢票人数合计（该片所有场次） */
  demand: number;
  red: number;
  black: number;
}

export type HeatVerdict = "hot-hated" | "hot-loved" | "quiet-loved" | "quiet-hated" | "unknown";

export const HEAT_VERDICT_LABELS: Record<HeatVerdict, string> = {
  "hot-hated": "高热度 · 低口碑",
  "hot-loved": "高热度 · 好口碑",
  "quiet-loved": "小众 · 好口碑",
  "quiet-hated": "少人问津 · 低口碑",
  unknown: "样本不足",
};

export interface FilmHeatRow extends FilmSignals {
  votes: number;
  /** 口碑纵轴：红票占比（0–1）。**一票没有 → `null`**（不画点，而不是画在 0）。 */
  redRatio: number | null;
  verdict: HeatVerdict;
}

/** 热度与口碑对照。
 *
 *  ★ 「热度」的基准 = **本批样本里需求的中位数**（只拿有需求的片算）——
 *    用中位数而不是绝对阈值，是因为站点规模会变（今年 795 场、明年可能翻倍），
 *    写死一个「≥ 50 人算热」迟早失真。
 *  ★ 「口碑」= 红票 ≥ 黑票 → 好，否则差；**总票数 < MIN_VOTES_FOR_VERDICT 一律 `unknown`**
 *    （不下结论），见文件头。
 */
/** 热度基准 = 有需求的片的需求中位数。
 *  **图上的竖线画的就是它** —— 两处各算一次会让参考线跑到判定标准之外（口径单一来源）。 */
export function heatMedian(rows: Iterable<FilmSignals>): number | null {
  return medianOf([...rows].filter((row) => row.demand > 0).map((row) => row.demand));
}

export function hotVsVotes(rows: FilmSignals[]): FilmHeatRow[] {
  const median = heatMedian(rows);
  return rows
    .map((row) => {
      const votes = Math.max(0, row.red) + Math.max(0, row.black);
      return {
        ...row,
        votes,
        // 口碑纵轴放在这里算（不在 JSX 里算）：`red/(red+black)` 是**口径**，只该有一份实现
        redRatio: votes > 0 ? Math.max(0, row.red) / votes : null,
        verdict: verdictOf(row, votes, median),
      };
    })
    .sort((a, b) => b.demand - a.demand || a.title.localeCompare(b.title));
}

function verdictOf(row: FilmSignals, votes: number, median: number | null): HeatVerdict {
  if (votes < MIN_VOTES_FOR_VERDICT) return "unknown";
  const hot = median !== null && row.demand >= median && row.demand > 0;
  const loved = row.red >= row.black;
  if (hot) return loved ? "hot-loved" : "hot-hated";
  return loved ? "quiet-loved" : "quiet-hated";
}

/** 中位数（偶数个取中间两个的平均）。**导出**供 C 组复用 —— 排序取中这件事
 *  在三个分组里都要用，各写一份迟早出现「一处取平均、一处取下侧」的分歧。 */
export function medianOf(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
