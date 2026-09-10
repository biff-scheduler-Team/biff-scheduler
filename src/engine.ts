// M2.5「AI 帮我排片」— 本地确定性求解引擎(无 LLM、零 key、可解释)。
// 输入:影片 wish 打标(must/maybe/wild,来自 state.wish)+ 各片已发布场次;
// 约束:同方案不重叠 + 跨馆转场缓冲(transitMin),与 conflict.ts 同一套判定;
// 策略:must 强制全覆盖 → 冲突时给「牺牲」说明;maybe 按评分/GV 权重贪心填空档;
//       wild 不进自动单(随缘可后续手动加)。产出 A(+存在差异时 B)两个建议方案,供一键采纳。

import type { Priority, Screening } from "./types";
import { OK_SLACK, hmsToMin } from "./util";

export interface EngineFilm {
  key: string; // 影片节点 key(cat:<id> / sched:<片名>)
  zh: string; // 显示名(中文优先)
  priority: Priority; // 用户 wish
  rating: number | null; // 目录豆瓣评分,maybe 权重用
  shows: Screening[]; // 已发布场次(空=暂无排期)
}

export interface EnginePick {
  code: string;
  filmKey: string;
  zh: string;
  priority: Priority;
  show: Screening;
}

export interface EngineDrop {
  filmKey: string;
  zh: string;
  priority: Priority;
  reason: string;
}

export interface EnginePlan {
  name: "A" | "B";
  picks: EnginePick[]; // 按日期/时间排序
  unscheduled: EngineDrop[]; // wish 过但未纳入(暂无排期 / 被占用 / 未命中)
  stats: { must: number; mustIn: number; maybe: number; maybeIn: number; wild: number };
  score?: PlanScore; // P0-2:由 suggestPlans 附加的评分(供结果弹层展示)
}

export interface EngineInput {
  films: EngineFilm[];
  transitMin: number;
}

/* ================= 方案评分(P0-2,纯函数,可解释) ================= */
/** 各优先级单场权重:must×3 / maybe×2 / wild×1(GV 场次另 +1) */
export const SCORE_W: Record<Priority, number> = { must: 3, maybe: 2, wild: 1 };

export interface PlanScoreParts {
  must: { in: number; total: number; pts: number };
  maybe: { in: number; total: number; pts: number };
  wild: { in: number; total: number; pts: number };
  gv: { in: number; total: number; pts: number }; // GV 奖励(每场 +1)
  tight: { count: number; pts: number }; // 紧转场扣分(每次 −1,pts ≤ 0)
}

export interface PlanScore {
  total: number;
  parts: PlanScoreParts;
}

export interface ScoredRow {
  priority: Priority;
  screening: Screening;
}

export interface ScoreBreakdown {
  total: number;
  pri: Record<Priority, number>; // 各档命中场数
  gv: number; // GV 命中场数
  tight: number; // 紧转场次数(0 ≤ 余量 < OK_SLACK)
}

/** 对任意一组排片(引擎建议 / 手动行程)算质量分。
 *  endOf(s):该场实际结束分钟(缺省 = end_time)。手动行程侧传「有效结束」(GV 放弃映后谈 → 正片末),
 *  引擎自动排片不传(保守按含谈算 —— 放弃后只会更宽松,安全)。 */
export function scorePlanRows(
  rows: ScoredRow[],
  transitMin: number,
  okSlack = OK_SLACK,
  endOf?: (s: Screening) => number
): ScoreBreakdown {
  const sorted = [...rows].sort(
    (a, b) => a.screening.date.localeCompare(b.screening.date) || a.screening.start_time.localeCompare(b.screening.start_time)
  );
  const pri: Record<Priority, number> = { must: 0, maybe: 0, wild: 0 };
  let gv = 0;
  let tight = 0;
  for (const r of sorted) {
    pri[r.priority]++;
    if (r.screening.is_gv) gv++;
  }
  // 同日相邻对:余量 = 间隔 − 跨馆缓冲;重叠(余量<0)由冲突体系展示,不重复计入
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].screening;
    const next = sorted[i].screening;
    if (prev.date !== next.date) continue;
    const prevEnd = endOf ? endOf(prev) : hmsToMin(prev.end_time);
    const gap = hmsToMin(next.start_time) - prevEnd;
    const need = prev.venue_id !== next.venue_id ? transitMin : 0;
    const slack = gap - need;
    if (slack < 0) continue;
    if (slack < okSlack) tight++;
  }
  const total =
    pri.must * SCORE_W.must + pri.maybe * SCORE_W.maybe + pri.wild * SCORE_W.wild + gv - tight;
  return { total, pri, gv, tight };
}

/** 引擎方案评分:在 scorePlanRows 之上补齐各档分母(wish 输入量),供弹层展示 x/y。 */
export function planScore(
  plan: EnginePlan,
  opts: { transitMin: number; gvTotal: number; okSlack?: number }
): PlanScore {
  const bd = scorePlanRows(
    plan.picks.map((p) => ({ priority: p.priority, screening: p.show })),
    opts.transitMin,
    opts.okSlack
  );
  const s = plan.stats;
  const parts: PlanScoreParts = {
    must: { in: bd.pri.must, total: s.must, pts: bd.pri.must * SCORE_W.must },
    maybe: { in: bd.pri.maybe, total: s.maybe, pts: bd.pri.maybe * SCORE_W.maybe },
    wild: { in: bd.pri.wild, total: s.wild, pts: bd.pri.wild * SCORE_W.wild },
    gv: { in: bd.gv, total: opts.gvTotal, pts: bd.gv },
    tight: { count: bd.tight, pts: -bd.tight },
  };
  return {
    total: parts.must.pts + parts.maybe.pts + parts.wild.pts + parts.gv.pts + parts.tight.pts,
    parts,
  };
}

interface Placed {
  filmKey: string;
  zh: string;
  priority: Priority;
  show: Screening;
}

/** 两场是否互斥(同一天 + 时段重叠;跨馆则先结束场次追加转场缓冲再判) */
function blocks(a: Screening, b: Screening, transitMin: number): boolean {
  if (a.date !== b.date) return false;
  const [x, y] = a.start_time <= b.start_time ? [a, b] : [b, a];
  const transit = x.venue_id !== y.venue_id ? transitMin : 0;
  return hmsToMin(x.end_time) + transit > hmsToMin(y.start_time);
}

function fits(cand: Screening, chosen: Placed[], transitMin: number): boolean {
  return !chosen.some((p) => blocks(p.show, cand, transitMin));
}

function blockersOf(show: Screening, chosen: Placed[], transitMin: number): string[] {
  const out: string[] = [];
  for (const p of chosen) {
    if (blocks(p.show, show, transitMin)) out.push(`${p.show.code} ${p.zh}`);
  }
  return out;
}

function sortShows(a: Screening, b: Screening): number {
  return a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time);
}

/** 选出某片在当前已排集合下「最值」的可插场次:GV 优先 → 时间最早 */
function bestFit(film: EngineFilm, chosen: Placed[], transitMin: number): Screening | null {
  const pool = film.shows.filter((sh) => fits(sh, chosen, transitMin));
  if (pool.length === 0) return null;
  return pool.sort(
    (a, b) => Number(Boolean(b.is_gv)) - Number(Boolean(a.is_gv)) || sortShows(a, b)
  )[0];
}

/** maybe 权重:目录评分(×2)+ 该片任一场带 GV(+1) */
function maybeWeight(film: EngineFilm): number {
  return (film.rating ?? 0) * 2 + (film.shows.some((s) => s.is_gv) ? 1 : 0);
}

/** 未纳入理由:暂无排期 / 时段被占用(去重列出至多 3 个) */
function describeDrop(film: EngineFilm, chosen: Placed[], transitMin: number): string {
  if (film.shows.length === 0) return "暂无排期(等 9/11 官方排期后自动可排)";
  const blocked = new Set<string>();
  for (const sh of film.shows) {
    for (const b of blockersOf(sh, chosen, transitMin)) blocked.add(b);
  }
  return blocked.size
    ? `候选场次时段与已排重叠:${[...blocked].slice(0, 3).join("、")}`
    : "未纳入(备选权重排序未命中,可手动加入)";
}

/** must 全覆盖 DFS:收集全部可行解,取「场次数最多、其次总结束最早」的前两个不同解(A/B) */
function mustSolutions(musts: EngineFilm[], transitMin: number): Placed[][] {
  const order = [...musts].sort((a, b) => a.shows.length - b.shows.length); // 候选少的先探
  const sols: { chosen: Placed[]; sumEnd: number; key: string }[] = [];

  const rec = (i: number, chosen: Placed[]): void => {
    if (i === order.length) {
      sols.push({
        chosen,
        sumEnd: chosen.reduce((s, p) => s + hmsToMin(p.show.end_time), 0),
        key: chosen.map((p) => p.show.code).sort().join(","),
      });
      return;
    }
    const film = order[i];
    for (const sh of film.shows.filter((s) => fits(s, chosen, transitMin)).sort(sortShows)) {
      rec(i + 1, [...chosen, { filmKey: film.key, zh: film.zh, priority: "must", show: sh }]);
    }
    rec(i + 1, chosen); // 本片放弃(=与既有 must 冲突,牺牲)
  };
  rec(0, []);

  sols.sort(
    (a, b) => b.chosen.length - a.chosen.length || a.sumEnd - b.sumEnd || a.key.localeCompare(b.key)
  );
  const uniq: Placed[][] = [];
  for (const s of sols) {
    if (!uniq.some((u) => u.map((p) => p.show.code).sort().join(",") === s.key)) uniq.push(s.chosen);
    if (uniq.length >= 2) break;
  }
  return uniq;
}

/** 以给定 must 摆放为基础,maybe 贪心填空,产出完整方案 */
function buildPlan(
  name: "A" | "B",
  mustChosen: Placed[],
  maybeFilms: EngineFilm[],
  transitMin: number,
  total: { must: number; maybe: number; wild: number }
): EnginePlan {
  const chosen = [...mustChosen];
  for (const film of [...maybeFilms].sort((a, b) => maybeWeight(b) - maybeWeight(a))) {
    const pick = bestFit(film, chosen, transitMin);
    if (pick) chosen.push({ filmKey: film.key, zh: film.zh, priority: "maybe", show: pick });
  }

  return {
    name,
    picks: chosen
      .slice()
      .sort((a, b) => sortShows(a.show, b.show))
      .map((p) => ({ code: p.show.code, filmKey: p.filmKey, zh: p.zh, priority: p.priority, show: p.show })),
    unscheduled: [], // 由 suggest() 按原 wish 输入补齐(需要无排期片信息)
    stats: {
      must: total.must,
      mustIn: chosen.filter((p) => p.priority === "must").length,
      maybe: total.maybe,
      maybeIn: chosen.filter((p) => p.priority === "maybe").length,
      wild: total.wild,
    },
  };
}

/** 主入口:返回 1~2 个建议方案(A 恒有;B 仅在存在与 A 不同的可行 must 摆放时给出) */
export function suggestPlans(input: EngineInput): EnginePlan[] {
  const { films, transitMin } = input;
  const musts = films.filter((f) => f.priority === "must" && f.shows.length > 0);
  const maybeFilms = films.filter((f) => f.priority === "maybe");
  const total = {
    must: films.filter((f) => f.priority === "must").length,
    maybe: maybeFilms.length,
    wild: films.filter((f) => f.priority === "wild").length,
  };
  // GV 分母:打了标(must/maybe)且任一场带 GV 的影片数
  const gvTotal = films.filter((f) => f.priority !== "wild" && f.shows.some((sh) => sh.is_gv)).length;

  const baseMust = mustSolutions(musts, transitMin);
  const sols = baseMust.length ? baseMust : [[]]; // must 全无排期时也给出(空 must 单)
  const plans: EnginePlan[] = [];
  const seenKeys = new Set<string>();

  for (const [i, mustChosen] of sols.entries()) {
    if (plans.length >= 2) break;
    const plan = buildPlan((i === 0 ? "A" : "B") as "A" | "B", mustChosen, maybeFilms, transitMin, total);
    const key = plan.picks.map((p) => p.code).sort().join(",");
    if (seenKeys.has(key)) continue; // B 与 A 完全相同则不出 B
    seenKeys.add(key);
    plans.push(plan);
  }

  // 补齐 each plan 的 unscheduled(must/maybe 原 wish 输入里没进 picks 的)
  for (const plan of plans) {
    const inPlan = new Set(plan.picks.map((p) => p.filmKey));
    const drops: EngineDrop[] = [];
    for (const f of films) {
      if (f.priority === "wild") continue; // 随缘不进自动单,也不提示
      if (inPlan.has(f.key)) continue;
      drops.push({ filmKey: f.key, zh: f.zh, priority: f.priority, reason: describeDrop(f, plan.picks.map((p) => ({ filmKey: p.filmKey, zh: p.zh, priority: p.priority, show: p.show })), transitMin) });
    }
    plan.unscheduled = drops;
  }
  for (const plan of plans) {
    plan.score = planScore(plan, { transitMin, gvTotal });
  }
  return plans;
}
