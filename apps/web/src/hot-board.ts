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
 *   · **只有一份榜**：本届**全部影片**（想看 0 的排最后），没有档位 —— 详见下面那段
 *     2026-10-14 的用户反馈说明。
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
  /** **名次变化**：正 = 比昨天上升几名，负 = 下降几名。
   *  ⚠ `null` = **不显示**（没有可比的历史），而不是「没变」——
   *    界面据此决定画不画那个 ▲▼，别把两者画成同一个样子。 */
  rankDelta: number | null;
  /** 影片海报相对路径 —— 目录里有才带，缺图不编路径（与卡片 / 分享图同一条口径） */
  poster?: string;
}

/* ⚠ 2026-10-14 用户反馈：「不需要 热门影片 / 正在升温 / 全部影片 还有上面的解释文字，
 *   全部默认就是全部影片的想看人数就行」。所以**没有档位这个概念了** —— 只有一份榜单：
 *   本届全部影片，按想看人数降序（想看 0 的排最后）。`HotMode` / `HOT_MODES` / `compareByRising`
 *   随之删掉，别再以「留着以后用」为由放回来（那就是死代码）。
 *   ⚠ 日账本的「今日新增」仍然要（`buildHotRows` 的 `options.rising`）：**名次变化**（▲▼）
 *     靠它反推昨日名次，见 `applyRankDeltas`；它**只喂名次、不参与排序**。 */

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
 * 构建榜单行 —— **只有一份榜单**（2026-10-14 用户拍板，见文件里那段说明）：
 * **本届全部影片**，按想看人数降序；想看 0 的排到最后（同数按片名）。
 *
 * ⚠ **不筛「有没有信号」**：一部片想看 0、也一票没有，照样在榜上（排尾）——
 *   用户要的是一份「一眼看全」的榜，而不是「有人气才出现」的榜。
 *   界面的空态因此只剩一种：目录里真的没有影片。
 *
 * ⚠ 只遍历 `films`（目录里的影片）—— 这让 `want-counts` 里那 59 个 `sched:*` 脏 key
 *   （讲座 / 映后谈，2026-10-14 实测）**自动出局**：它们根本不在影片库里。
 *   另有一条探针残留 `cat:__probe-20260930__` 也不在影片库里，同理被挡住。
 *
 * `options.rising` = 今日新增（`want-trend.ts`）—— **只喂名次变化（▲▼），不参与排序**；
 * 不给就是「没有账本数据」→ 名次变化一并不显示（**数据缺口要在界面上看得见，而不是编一个 0**）。
 */
export function buildHotRows(
  films: readonly FilmNode[],
  wants: Readonly<Record<string, number>>,
  crowd: CrowdCounts,
  priorRate: number,
  options: {
    rising?: Readonly<Record<string, number>>;
  } = {},
): HotRow[] {
  const rising = options.rising ?? {};
  const rows: HotRow[] = [];
  for (const film of films) {
    const want = Math.max(0, Math.trunc(Number(wants[film.key]) || 0));
    const counts = crowd.get(film.key);
    const red = Math.max(0, counts?.red ?? 0);
    const black = Math.max(0, counts?.black ?? 0);
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
      rankDelta: null,
      poster: film.poster,
    });
  }
  const sorted = rows.sort(compareByWant);
  applyRankDeltas(sorted, rising);
  return sorted;
}

/** 给榜单的行补上**名次变化**。
 *
 *  口径：`昨日累计 = 当前累计 − 今日新增`（日账本反推，**不是**另存一份快照）——
 *  两者都是真实数据，所以这不是「伪造历史」。再按同一个排序口径算一遍**昨天的名次**，
 *  与今天比较：正 = 上升。
 *
 *  ⚠ 拿不到就不写：昨天累计为 0（昨天还没人想看）时 `rankDelta` 保持 `null`，
 *    界面据此不画 ▲▼ —— 把「新上榜」画成「上升 N 名」是编数据。
 *  ⚠ 账本对该届为空时，每部片的今日新增都是 0 → 昨日累计 == 今日累计 → 名次全等 →
 *    `rankDelta` 全 0。**0 与 `null` 不同**：0 表示「算得出、就是没动」，null 表示「算不出」。 */
function applyRankDeltas(rows: HotRow[], rising: Readonly<Record<string, number>>): void {
  const dayDelta = (row: HotRow) => Math.max(0, Math.trunc(Number(rising[row.key]) || 0));
  const yesterdayWant = (row: HotRow) => row.want - dayDelta(row);
  // ⚠ 两次排名必须用**同一套筛选 + 同一支比较器**：两处差一个条件，
  //   差的就不是名次而是口径（会凭空出现 ±1 的假变化）
  // 筛选是「昨天 / 今天都只看想看 > 0 的片」——想看 0 的片本来就没有名次可言
  const ranks = (pool: HotRow[], wantOf: (row: HotRow) => number) =>
    new Map(
      [...pool]
        .filter((row) => wantOf(row) > 0)
        .sort((a, b) => wantOf(b) - wantOf(a) || a.title.localeCompare(b.title))
        .map((row, index) => [row.key, index + 1]),
    );
  const yesterday = ranks(rows, yesterdayWant);
  const today = ranks(rows, (row) => row.want);
  for (const row of rows) {
    const was = yesterday.get(row.key);
    const now = today.get(row.key);
    // 一侧没有名次（昨天还没人想看 / 今天掉出榜）→ 保持 null：不把「新上榜」画成「上升 N 名」
    if (was === undefined || now === undefined) continue;
    row.rankDelta = was - now;
  }
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
