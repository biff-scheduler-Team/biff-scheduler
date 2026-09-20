// 「数据分析」页（2026-09-20 精简版）。
//
// ★ 名字是「数据分析」而不是「抢票分析」（2026-09-20，PLAN-20260920193032，用户要求）：
//   这一页读的不只是抢票 —— 还有想看 / 红黑票 / 我的观影画像 / 影片构成，旧名字把它说窄了。
//   ⚠ 路由 `/rush-analysis` 与模块文件名保持不变（书签 / PWA 缓存 / TEST-MAP 的契约），
//   改名只落在显示层：导航项、h1、区域 aria-label。
//
// ★ 这一页现在**只有两组**：
//   ① 群体行为与口碑 —— 想看人数 / 红黑票，可按**影片**与**场次**筛选；
//   ② 我的观影画像 + 影片分析 —— 我的行程构成 与 本届片目构成。
//
// ★ 为什么砍掉其余六组（难度榜 / 需求时间分布 / 需求集中度 / 抢票结果 / 口碑散点 /
//   供给与排片结构 / 行动建议 / 页面与点击热度）：
//   用户原话「太复杂了 而且前端不好看 只留下…」——一页八组、每组长篇口径说明，
//   结果是「什么都说了，但一眼看不到重点」。这一版的取舍是**少而准**：
//   留下来的两组都围绕「多少人想看 / 我排了什么」，且都能筛选。
//   （被砍掉的分组与它们的纯逻辑模块已随本次改动删除，见 PLAN 修订 4。）
//
// ★ 图表库从 recharts 换成 **ECharts**（视觉做法照 ma-agent-harness 的
//   `workspace/analytics/chart-design-tokens.ts`：运行时读令牌 + 统一 tooltip +
//   圆角柱 + 虚线网格）。换库被关在 `components/charts/bars.tsx` 一层里，
//   上层分组代码只认「给我一组 label+value」。

import { useEffect, useState } from "react";
import { Outlet } from "react-router";
import { RushCrowdPanel } from "../components/RushCrowdPanel";
import { RushPortraitPanel } from "../components/RushPortraitPanel";
import { useCatalog } from "../app/store";
import { useChartTokens } from "../chart-theme";
import {
  loadScreeningCounts,
  onScreeningCountsChange,
} from "../screening-counts";
import { loadWantCounts, onWantCountsChange } from "../want-counts";
import { loadFilmVotes, onFilmVotesChange } from "../film-votes";
import "./rush-analysis.css";

/** 三份「单例缓存 + 广播」的客户端计数（形状一致，见各自文件头）。
 *  ⚠ 票务结果 / 事件流水两份**不在这一页**了（它们对应的分组已被砍掉），
 *    但采集本身仍然照常（票务上报在 `state.ts`，事件采集在 `App.tsx`）。 */
const LIVE_STORES: Array<{
  subscribe: (listener: () => void) => () => void;
  load: () => Promise<unknown>;
}> = [
  { subscribe: onScreeningCountsChange, load: loadScreeningCounts },
  { subscribe: onWantCountsChange, load: loadWantCounts },
  { subscribe: onFilmVotesChange, load: loadFilmVotes },
];

/** 订阅三份计数并各拉一次（直链打开本页也能有数）。 */
function useLiveCounters(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const bump = () => setRevision((n) => n + 1);
    const stops = LIVE_STORES.map((source) => source.subscribe(bump));
    for (const source of LIVE_STORES) void source.load();
    return () => stops.forEach((stop) => stop());
  }, []);
  return revision;
}

export function RushAnalysisPage() {
  const { cat } = useCatalog();
  useLiveCounters();
  // 图表配色：从 style.css 的 token 运行时读取，并订阅 `data-theme`（切暗色时重读并重绘）
  const tokens = useChartTokens();

  if (cat.schedule.screenings.length === 0) {
    return (
      <section className="ra-page" aria-label="数据分析">
        <div className="empty-state">
          <h2>还没有排期数据</h2>
          <p>排期载入后，这里会给出「群体想看 / 口碑」与「我的观影画像 / 影片分析」。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="ra-page" aria-label="数据分析">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">群体口碑 · 我的画像 · 影片分析</p>
          <h1>数据分析</h1>
        </div>
        <span className="count" aria-live="polite">
          {cat.schedule.screenings.length} 场
        </span>
      </div>

      <RushCrowdPanel tokens={tokens} />
      <RushPortraitPanel tokens={tokens} />

      {/* 路由里保留了 `films/:filmKey` 子路由（与 /rush 同形）—— 不渲染 Outlet 的话它永远不会命中 */}
      <Outlet />
    </section>
  );
}
