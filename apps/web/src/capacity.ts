/**
 * 影厅容量与「抢票难度」口径（抢票分析模块，2026-09-20，PLAN-20260920161837）。
 *
 * ★ 为什么用**倍率**（需求人数 ÷ 座位数）而不是绝对人数：
 *   本届露天场（电影殿堂屋顶剧场，官方口径 4,000 席）与试写室级小厅量级悬殊，
 *   「300 人想抢」在露天场是冷场、在 200 席小厅是挤爆 —— 绝对人数不可比。
 *
 * ★ 阈值怎么定的（**只此一处**，改这里就是改全站口径）：
 *   · **≥ 1**  → 极高：想抢的人已经多过座位数，「不是人人都能进」是可以直接说出口的事实；
 *   · **≥ 0.5** → 高：一半以上座位有主，普通热门场；
 *   · **≥ 0.2** → 中：有竞争但大概率抢得到；
 *   · **< 0.2** → 低：冷场。
 *   ⚠ 阈值是**经验分档**，不是概率模型 —— 它不预测「你能不能抢到」，只描述「多少人想要 vs 多少座」。
 *     故 UI 必须同时印出「需求人数 / 容量 / 倍率」三元组，让用户能自己复核分档是否合理。
 *
 * ★ 容量缺失（`capacity` 未收录）→ 难度为 `unknown`，**绝不估数**：
 *   编一个容量进去会让难度看着精确、实则错得无法察觉。调用方改用相对分位排名（`percentileOf`）。
 *
 * ⚠ 纯逻辑，import 期不碰 DOM —— node 直接可测。
 */

import type { Venue } from "./types";

/** 难度档位。`unknown` 专指「该厅未收录座位数」，不是「低难度」。 */
export const DIFFICULTY_LEVELS = ["extreme", "high", "medium", "low", "unknown"] as const;

export type DifficultyLevel = (typeof DIFFICULTY_LEVELS)[number];

export const DIFFICULTY_LABELS: Record<DifficultyLevel, string> = {
  extreme: "极高",
  high: "高",
  medium: "中",
  low: "低",
  unknown: "未收录",
};

/** 分级下界（倍率）。顺序从高到低取第一个满足的档；见文件头「阈值怎么定的」。 */
export const DIFFICULTY_THRESHOLDS: ReadonlyArray<{ level: DifficultyLevel; min: number }> = [
  { level: "extreme", min: 1 },
  { level: "high", min: 0.5 },
  { level: "medium", min: 0.2 },
  { level: "low", min: 0 },
];

/** 某厅的座位数；未收录 / 非法 / ≤ 0 一律 `null`（**不要**退化成 0 —— 那会让倍率变成 Infinity）。 */
export function capacityOf(venue: Venue | undefined | null): number | null {
  const value = venue?.capacity;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

/** 竞争倍率 = 需求人数 ÷ 座位数。
 *  分母缺失 / ≤ 0 → `null`（**不是** 0，也不是 Infinity：调用方据此走「未收录」分支）。 */
export function demandRatio(demand: number, capacity: number | null): number | null {
  if (capacity === null || !Number.isFinite(capacity) || capacity <= 0) return null;
  const d = Number.isFinite(demand) && demand > 0 ? demand : 0;
  return d / capacity;
}

export function difficultyLevelOf(ratio: number | null): DifficultyLevel {
  if (ratio === null || !Number.isFinite(ratio)) return "unknown";
  for (const { level, min } of DIFFICULTY_THRESHOLDS) {
    if (ratio >= min) return level;
  }
  return "unknown";
}

export interface Difficulty {
  level: DifficultyLevel;
  /** 倍率；未收录容量时为 `null` */
  ratio: number | null;
  /** 人话解释「为什么算这一档」—— 页面上直接印，供用户复核分档 */
  reason: string;
}

/** 一场 → 难度档位 + 倍率 + 判据说明。 */
export function difficultyOf(demand: number, capacity: number | null): Difficulty {
  const ratio = demandRatio(demand, capacity);
  if (ratio === null) {
    return { level: "unknown", ratio: null, reason: "该厅未收录座位数，按相对排名参考" };
  }
  const level = difficultyLevelOf(ratio);
  const percent = Math.round(ratio * 100);
  const reasons: Record<Exclude<DifficultyLevel, "unknown">, string> = {
    extreme: `需求 ${demand} 人 > 座位 ${capacity} 席，想抢的人坐不下`,
    high: `需求已达座位的 ${percent}%，普通热门场`,
    medium: `需求为座位的 ${percent}%，有竞争但大概率抢得到`,
    low: `需求为座位的 ${percent}%，冷场`,
  };
  return { level, ratio, reason: level === "unknown" ? "该厅未收录座位数，按相对排名参考" : reasons[level] };
}

/** 相对分位：`peers` 是**有容量**的那些场次的倍率（无需排序，本函数自己排）。
 *  返回 0–100（高于多少比例的样本）；样本 < 2 或自身无倍率 → `null`（分位数在小样本上没有意义）。 */
export function percentileOf(ratio: number | null, peers: Iterable<number>): number | null {
  if (ratio === null || !Number.isFinite(ratio)) return null;
  const list = [...peers].filter((x) => Number.isFinite(x));
  if (list.length < 2) return null;
  let below = 0;
  for (const x of list) if (x < ratio) below++;
  return Math.round((below / list.length) * 100);
}
