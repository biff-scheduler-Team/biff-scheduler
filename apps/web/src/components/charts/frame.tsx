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
 */

import type { ReactNode } from "react";

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
      </div>
      {legend}
      {footnote && <figcaption className="ra-chart-note">{footnote}</figcaption>}
    </figure>
  );
}
