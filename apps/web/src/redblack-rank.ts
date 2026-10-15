// 红黑榜「排行榜」的行模型（2026-10-15，PLAN-20261015153233）。
//
// ★ 起因（用户原话）：「红黑榜有直观的榜单吗 在快速投票旁边加一个榜单 简单展示红榜 黑榜 TOP50 …
//   只需要显示影片的名称海报 以及红黑贴纸数 只需要样式参考分享图就行」。
//   榜单那一页此前只有卡片栅格（`RedBlackPage` 的 `.rb-grid`）：顺序排过、**但没有名次**，
//   而每张卡一半的面积是贴纸画布 —— 想「扫一眼看排行」得在近 300 张卡之间滚。
//
// ★ 与分享图**同源**：门槛（`boardHasVotes`）与排序（`sortByVotes`）逐字复用 `redblack.ts`，
//   候选集合同样先过 `boardFilms`（合集拆成成员片）。
//   ⚠ 这里**只**决定「取前几名」与「一行显示什么」—— 两处各写一套排序的话，
//     弹层与分享图会给出两份不同的名次，而那种错没人会立刻看出来（§5 口径单一来源）。
//
// ⚠ 纯模型：import 期不碰 DOM、不读时钟，可以直接被 node 单测 import（与 `hot-board.ts` 同一分层）。

import type { FilmNode } from "./app/model";
import {
  boardFilms,
  boardHasVotes,
  sortByVotes,
  type CrowdCounts,
  type SortMode,
} from "./redblack";

/** 每榜取前几名。⚠ 与分享图的 `redblack-poster.ts::TOP_N`（10）**不是**同一个数：
 *  那张图是发出去的长图，这里是一屏扫完的读数，用户口径就是「TOP50」。 */
export const RANK_LIMIT = 50;

/** 一行 = 一条影片。⚠ **只有**用户点名的那三样（名次由列表位置给）：
 *  海报、片名、红黑数；评分 / 单元 / 场次编号 / 我贴的那一色都不在榜上（那是分享图的行）。 */
export interface RankRow {
  key: string;
  /** 片名（中文优先，与卡片 / 分享图同一条展示规则） */
  title: string;
  /** 英文名；与中文名相同时是**空串**（同 `RbCard` / `RbPosterRow`：不重复画一遍） */
  en: string;
  /** 全站红 / 黑票数 */
  red: number;
  black: number;
  /** 影片海报相对路径 —— 目录里有才带（缺图是常态）。缺图时视图层画占位块，
   *  **不编一个路径**（与卡片 / 分享图同一条来源 `FilmNode.poster`）。 */
  poster?: string;
}

/** 两榜的名字 —— 只写这一份（弹层的两列都从它取，别在 JSX 里再抄一遍） */
export const RANK_BOARDS: ReadonlyArray<{ mode: SortMode; label: string }> = [
  { mode: "red", label: "红榜" },
  { mode: "black", label: "黑榜" },
];

/**
 * 造一榜的行。
 *
 * ⚠ 三条口径**全部**来自既有实现，本函数不新立规则：
 *  ① 候选 = `boardFilms(films)`（合集场次拆成成员片，与卡片栅格同一份）；
 *  ② 门槛 = 该榜那一色**至少一票**（`boardHasVotes`）—— 黑榜里列一堆「黑 0」毫无意义，
 *     而且它不是「票数 > 0」：一部 3 红 0 黑 的片照样不该出现在黑榜里；
 *  ③ 排序 = `sortByVotes`（该榜票数降序，同数量比评分，再按目录序稳定）。
 *
 * ⚠ `limit <= 0` = **不截断**（与分享图 `topN <= 0` 那一档同义）；不足 `limit` 行时自然全列，
 *   不补零 —— 冷门榜本来就只有几部片有票。
 */
export function buildRankRows(
  films: readonly FilmNode[],
  crowd: CrowdCounts,
  mode: SortMode,
  priorRate: number,
  limit: number = RANK_LIMIT,
): RankRow[] {
  const ranked = sortByVotes(
    boardFilms(films).filter((film) => boardHasVotes(crowd.get(film.key), mode)),
    crowd,
    mode,
    priorRate,
  );
  const shown = limit > 0 ? ranked.slice(0, limit) : ranked;
  return shown.map((film) => {
    const counts = crowd.get(film.key);
    return {
      key: film.key,
      title: film.zh,
      en: film.en && film.en !== film.zh ? film.en : "",
      red: counts?.red ?? 0,
      black: counts?.black ?? 0,
      poster: film.poster,
    };
  });
}
