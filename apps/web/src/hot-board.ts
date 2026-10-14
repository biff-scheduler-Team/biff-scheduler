/**
 * 「热门榜」的纯逻辑（2026-10-14，`PLAN-20261014150805` 修订 1 / 2）。
 *
 * ★ 口径（用户 2026-10-14 拍板）：
 *   · **热度 = 想看人数**（`want-counts.ts`）—— 不是 `rush-analysis.ts` 的 `demand`（抢票人数）。
 *     两者不是一回事：想看是**映前意愿**，抢票是「真把这场排进了行程」。
 *     实测差 20 倍（想看 12,092 / 红黑票 591），只有前者撑得起按单元分组。
 *   · **口碑 = 红黑评分**，逐字复用 `redblack.ts::scoreOf` —— 与红黑榜卡片角标、
 *     分享图行**同一处实现**（§5 口径单一来源）。
 *   · **排序 = 想看降序**，同数按片名（稳定，不随机）。
 *
 * ★ 分层与 `redblack-poster.ts` 同口径：本文件 = **纯逻辑**，import 期不碰 DOM，
 *   可被 node 单测直接 import。
 *
 * ⚠ **本文件刻意不引 ECharts**（`components/charts/bars.tsx` 那条链 gzip 193.9 KB）：
 *   榜单页是非 lazy 路由，引进来会把图表库拖进首屏主包，而首屏 `/schedule` 是
 *   「电影节现场断网也要能打开」的主路径。理由详见 `PLAN-20261014150805` 修订 1 的硬约束。
 */

import type { FilmNode } from "./app/model";
import { scoreOf, type CrowdCounts } from "./redblack";
import { filmUnitKeys, unitLabel } from "./util";

/** 热门榜的一行。 */
export interface HotRow {
  key: string;
  title: string;
  /** 这部片**归属的全部单元键**（已归一，主单元在前）—— 见 `util.ts::filmUnitKeys`。
   *  ⚠ 是数组而不是单值：联映块成员片（`also_units`）在午夜单元里也算成员，
   *    只认主单元会让这里说 5 部、影片库说 9 部（同一个单元两套数）。 */
  units: string[];
  /** **主单元**的展示名（行里那行小字用它，走 `util.ts::unitLabel`） */
  unitName: string;
  want: number;
  red: number;
  black: number;
  /** 口碑评分（与红黑榜卡片角标同一处实现）；一票没有 = `null`（显示成「—」） */
  score: number | null;
  /** 影片海报相对路径 —— 目录里有才带，缺图不编路径（与卡片 / 分享图同一条口径） */
  poster?: string;
}

/** 一个单元分组。 */
export interface HotUnit {
  /** 单元**规范键**（`units.ts::unitKey` 的输出；用于筛选与断言）。未标单元的组是 `未标注单元` */
  id: string;
  /** 展示名（`unitLabel(id)`） */
  name: string;
  /** 组内想看合计（分组排序用） */
  want: number;
  rows: HotRow[];
}

/** 一组行的口径数字。 */
export interface HotTotals {
  films: number;
  want: number;
  votes: number;
}

/** 汇总一组行（全站那份与单元那份走同一个函数，避免两处各算一次）。 */
export function hotTotals(rows: readonly HotRow[]): HotTotals {
  let want = 0;
  let votes = 0;
  for (const row of rows) {
    want += row.want;
    votes += row.red + row.black;
  }
  return { films: rows.length, want, votes };
}

/**
 * 「按想看降序、同数按片名」—— **导出**供 `RushCrowdPanel`（分析页的「群体行为与口碑」）复用：
 * 这条排序口径不该有两份实现（§5 口径单一来源）。
 * ⚠ 它只吃 `{ want, title }` 两个字段，所以两边的行类型都能直接用。
 */
export function compareByWant(
  a: { want: number; title: string },
  b: { want: number; title: string },
): number {
  return b.want - a.want || a.title.localeCompare(b.title);
}

/**
 * 构建热门榜行：只保留**有信号**的影片（想看 > 0 或已有票），按想看降序。
 *
 * ⚠ 只遍历 `films`（目录里的影片）—— 这让 `want-counts` 里那 59 个 `sched:*` 脏 key
 *   （讲座 / 映后谈，2026-10-14 实测）**自动出局**：它们根本不在影片库里。
 *   另有一条探针残留 `cat:__probe-20260930__` 也不在影片库里，同理被挡住。
 */
export function buildHotRows(
  films: readonly FilmNode[],
  wants: Readonly<Record<string, number>>,
  crowd: CrowdCounts,
  priorRate: number,
): HotRow[] {
  const rows: HotRow[] = [];
  for (const film of films) {
    const want = Math.max(0, Math.trunc(Number(wants[film.key]) || 0));
    const counts = crowd.get(film.key);
    const red = Math.max(0, counts?.red ?? 0);
    const black = Math.max(0, counts?.black ?? 0);
    if (!want && !red && !black) continue;
    // ⚠ 单元口径走 `util.ts::filmUnitKeys`（与红黑榜分享图的「按单元切分」、
    //   影片库的 `filmInUnit` / `libraryUnits` 同一支）—— 三处各写一份必然分叉
    const units = filmUnitKeys(film);
    rows.push({
      key: film.key,
      title: film.title,
      units,
      unitName: unitLabel(units[0] ?? ""),
      want,
      red,
      black,
      score: counts ? scoreOf(counts, priorRate) : null,
      poster: film.poster,
    });
  }
  return rows.sort(compareByWant);
}

/**
 * 按单元分组：组内保持 `buildHotRows` 的想看降序；组间按**组内想看合计**降序，
 * 合计相同按单元名（稳定）。
 *
 * ⚠ 不做「小单元合并成其他」—— 实测想看口径下每个单元都有量（最少 31），
 *   组都不空，合并反而让人找不到自己的单元（用户 2026-10-14：「分享的时候可以选择
 *   需要哪个单元的就行」）。要不要折叠由调用方决定。
 */
export function groupByUnit(rows: readonly HotRow[]): HotUnit[] {
  const groups = new Map<string, HotUnit>();
  for (const row of rows) {
    // ⚠ 一部片**可以进多个组**（联映块成员片，见 `util.ts::filmUnitKeys`）：
    //   组里列出来的那一部，就是点这个单元时真的会出现的那一部（筛选同源，见 `HotBoardPanel`）。
    //   它的想看数也因此计入每个相关单元的合计 —— 与影片库「每个单元各计一次」同一口径。
    for (const unit of row.units) {
      let group = groups.get(unit);
      if (!group) {
        // ⚠ 组名用 `unitLabel(组 id)`，**不是**行上的 `unitName`：联映块成员片的主单元在别处，
        //   拿它的名字当组名会把「午夜激情」这一组标成「广角镜 · 纪录片放映」。
        group = { id: unit, name: unitLabel(unit), want: 0, rows: [] };
        groups.set(unit, group);
      }
      group.rows.push(row);
      group.want += row.want;
    }
  }
  return [...groups.values()].sort((a, b) => b.want - a.want || a.name.localeCompare(b.name));
}
