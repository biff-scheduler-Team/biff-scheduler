/**
 * 图表外壳与稳定契约（2026-09-20，第 1 轮建立；同日修订 4 精简）。
 *
 * ★ 保留这一层只为一件事：**`data-chart` / `data-points` 契约挂在我们的容器上**，
 *   不挂绘图库的内部类名。ECharts 的 DOM（`canvas` / 一堆 path）与 recharts 完全不同，
 *   但 E2E 的断言从第 1 轮起就只认这两个属性 —— 换库时它们**一行都不用改**。
 *
 * ⚠ 画布高度**必须显式给定**：容器高 0 时绘图库什么都不画（ECharts 与 recharts 同病）。
 * ⚠ 图例走 `legend` prop 渲染在画布**之外** —— 塞进固定高度的画布里会压住图形
 *   （第 1 轮在真实浏览器里实测到过）。
 *
 * ★ `footnote` 从「画布下方那行小字」改成「**画布右上角的 ⓘ**」（2026-09-20，
 *   PLAN-20260920193412，用户：「太多解释性文案了，全部放到图的右上角的 tooltip 里面」）：
 *   每张图下面都挂一行口径说明，整页读起来就是「图 + 小字 + 图 + 小字」—— 图自己能说话，
 *   解释应当是**按需再取**的东西。
 *   ⚠ 用原生 `<details>` 而不是纯 CSS `:hover`：这一页的主要读者在**现场用手机**，
 *     点击是手机上唯一可靠的打开方式；`<details>` 同时白送键盘可达与 toggle 语义，
 *     不必自造弹层与「点外面关闭」的收尾逻辑。
 *   ⚠ 内容仍留在 DOM 里（未展开只是不可见），所以「说明写没写」这件事仍可被断言。
 */

import type { ReactNode } from "react";
import "./charts.css";

/** 默认画布高度（px）。 */
export const CHART_HEIGHT = 240;

/** 图表外壳：容器 + 稳定契约 + 可选图例与脚注。 */
export function ChartFrame({
  chart,
  points,
  label,
  children,
  legend,
  footnote,
  height = CHART_HEIGHT,
}: {
  /** 契约名（`crowd-want` 等）—— E2E 按它定位 */
  chart: string;
  /** 画进去的数据点数 —— E2E 按它断言「图真的有数据」 */
  points: number;
  /** 无障碍名（图对读屏用户等于不存在，至少给一句它在画什么） */
  label: string;
  children: ReactNode;
  /** 图例（渲染在画布之外） */
  legend?: ReactNode;
  /** 图下的说明（口径 / 数据缺口） */
  footnote?: ReactNode;
  height?: number;
}) {
  return (
    <figure className="ra-chart" data-chart={chart} data-points={points} aria-label={label}>
      <div className="ra-chart-canvas" style={{ height }}>
        {children}
        {/* 右上角的 ⓘ：点开才显示口径说明（见文件头「为什么用 details」） */}
        {footnote && (
          <details className="ra-note" data-chart-note={chart}>
            <summary className="ra-note-btn" aria-label={`${label}：口径说明`}>
              i
            </summary>
            <p className="ra-note-body">{footnote}</p>
          </details>
        )}
      </div>
      {legend}
    </figure>
  );
}
