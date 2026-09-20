/**
 * 图表层（ECharts 6 + SVG 渲染）。
 *
 * ★ 2026-09-20 从 recharts 换成 ECharts，视觉做法照 `ma-agent-harness` 的
 *   `frontend/src/components/workspace/analytics/chart-design-tokens.ts`：
 *   · 颜色全部运行时读令牌（不写死），并订阅 `data-theme` 重建 option；
 *   · **统一 tooltip**（同一内边距 / 圆角 / 阴影 / 边框），不在每个图里各写一套；
 *   · 圆角柱、虚线网格、`containLabel` 网格留白 —— 「好看」的具体内容就是这几条。
 *
 * ★ 为什么保留 `CountBarChart` / `RankBarChart` / `StackedBarChart` 这三个**同名导出**：
 *   上层分组只关心「给我一组 label+value」；换绘图库不该让业务代码跟着改一遍。
 *   组件签名不变 = 换库这件事被关在这一层里（第 1 轮定的 `data-chart` / `data-points`
 *   契约也一并保留，E2E 断言不用动）。
 *
 * ⚠ 一律 `animation: false`：本站是**现场手机要用的工具**，而且动画中间帧会让
 *   「图里到底有没有东西」这类断言变得不确定。视觉上的精致靠圆角 / 间距 / 配色，
 *   不靠入场效果。
 */

import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { BarChart as EChartsBar, LineChart, PieChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import type { EChartsCoreOption, ECharts } from "echarts/core";
import type { ChartTokens } from "../../chart-theme";
import { ChartFrame } from "./frame";

// 按需注册（只引这三类图 + 三个组件 + SVG 渲染器）：全量 `import "echarts"` 会把
// 地图 / 关系图 / 日历图这些用不到的东西一起打进 chunk。
// ⚠ `TitleComponent` **必须注册**：环形图圆心那个合计数字是用 `title` 画的，
//   漏注册时它不会报错、只是不显示（2026-09-20 实测：SVG 里只有图例文本，圆心是空的）。
echarts.use([
  EChartsBar,
  LineChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  SVGRenderer,
]);

export interface BarDatum {
  label: string;
  value: number;
}

export interface StackDatum {
  label: string;
  [key: string]: string | number;
}

export interface DonutDatum {
  name: string;
  value: number;
}

/* ---------------- 通用：ECharts 实例的生命周期 ---------------- */

/** 统一的 tooltip —— 与参考项目的 `sharedTooltip` 同形（同一套间距 / 圆角 / 阴影）。
 *  ⚠ `appendTo: "body"`：否则 tooltip 会被卡片的 overflow / 层叠上下文裁掉。 */
function sharedTooltip(tokens: ChartTokens, overrides: Record<string, unknown> = {}) {
  return {
    padding: [10, 12],
    backgroundColor: tokens.surface,
    borderColor: tokens.line,
    borderWidth: 1,
    textStyle: { color: tokens.text, fontSize: 12 },
    extraCssText: "box-shadow: 0 4px 16px rgb(0 0 0 / 14%); border-radius: 6px;",
    appendTo: "body",
    confine: false,
    ...overrides,
  };
}

/** 坐标轴：轴线与刻度走 `--line` / `--muted`，不沿用 ECharts 默认灰蓝。 */
function axisCommon(tokens: ChartTokens) {
  return {
    axisLine: { lineStyle: { color: tokens.line } },
    axisTick: { show: false },
    axisLabel: { color: tokens.muted, fontSize: 11 },
  };
}

/** 网格：只留虚线横线（竖线在这个数据密度下是噪声）。 */
function splitLine(tokens: ChartTokens) {
  return { lineStyle: { color: tokens.line, type: "dashed" as const } };
}

/** 容器尺寸就绪后才 `setOption`：宽为 0 时初始化会画出一张空图（`ResponsiveContainer`
 *  时代踩过的同一个坑，换库后仍然存在 —— 只是报错形式不同）。 */
function useChart(ref: React.RefObject<HTMLDivElement | null>, option: EChartsCoreOption, ready: boolean) {
  const instance = useRef<ECharts | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const chart = echarts.init(node, undefined, { renderer: "svg" });
    instance.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(node);
    return () => {
      observer.disconnect();
      chart.dispose();
      instance.current = null;
    };
  }, [ref]);
  useEffect(() => {
    if (ready) instance.current?.setOption(option, { notMerge: true });
  }, [option, ready]);
}

/** 容器是否已经有非零宽度（`ResizeObserver` 第一次回调即代表有实际布局）。 */
function useSized(ref: React.RefObject<HTMLDivElement | null>): boolean {
  const [sized, setSized] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (node.clientWidth > 0) setSized(true);
    const observer = new ResizeObserver((entries) => {
      if ((entries[0]?.contentRect.width ?? 0) > 0) setSized(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return sized;
}

/** 画布外壳：`ChartFrame` 提供 `data-chart` / `data-points` 契约与固定高度，这里只放容器。 */
function Canvas({
  chart,
  label,
  points,
  option,
  height,
  legend,
  footnote,
  aria,
}: {
  chart: string;
  label: string;
  points: number;
  option: EChartsCoreOption;
  height: number;
  legend?: React.ReactNode;
  footnote?: React.ReactNode;
  aria: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const sized = useSized(ref);
  useChart(ref, option, sized);
  return (
    <ChartFrame chart={chart} points={points} label={label} legend={legend} footnote={footnote} height={height}>
      <div ref={ref} className="ra-echart" role="img" aria-label={aria} />
    </ChartFrame>
  );
}

/* ---------------- 竖柱：有限个分类（日期 / 时段 / 票档） ---------------- */

export function CountBarChart({
  chart,
  label,
  data,
  tokens,
  valueName,
  footnote,
  color,
  height,
  rotate = false,
}: {
  chart: string;
  label: string;
  data: BarDatum[];
  tokens: ChartTokens;
  valueName: string;
  footnote?: React.ReactNode;
  color?: string;
  rotate?: boolean;
  height?: number;
}) {
  const option: EChartsCoreOption = {
    animation: false,
    grid: { left: 4, right: 8, top: 16, bottom: 4, containLabel: true },
    tooltip: sharedTooltip(tokens, {
      trigger: "axis",
      axisPointer: { type: "shadow", shadowStyle: { color: tokens.raised } },
      valueFormatter: (value: number) => `${value}`,
    }),
    xAxis: {
      type: "category",
      data: data.map((row) => row.label),
      ...axisCommon(tokens),
      axisLabel: {
        color: tokens.muted,
        fontSize: 11,
        rotate: rotate ? 30 : 0,
        interval: 0,
        hideOverlap: true,
      },
    },
    yAxis: {
      type: "value",
      minInterval: 1,
      ...axisCommon(tokens),
      splitLine: splitLine(tokens),
    },
    series: [
      {
        type: "bar",
        name: valueName,
        data: data.map((row) => row.value),
        barMaxWidth: 34,
        itemStyle: { color: color ?? tokens.brand, borderRadius: [4, 4, 0, 0] },
      },
    ],
  };
  return (
    <Canvas
      chart={chart}
      label={label}
      points={data.length}
      option={option}
      height={height ?? 240}
      footnote={footnote}
      aria={`${label}（${data.length} 项，${valueName}）`}
    />
  );
}

/* ---------------- 横柱排行：标签很长（片名 / 影厅名）时用 ---------------- */

export function RankBarChart({
  chart,
  label,
  data,
  tokens,
  valueName,
  footnote,
  color,
  rowHeight = 24,
}: {
  chart: string;
  label: string;
  data: BarDatum[];
  tokens: ChartTokens;
  valueName: string;
  footnote?: React.ReactNode;
  color?: string;
  rowHeight?: number;
}) {
  // 类目在 ECharts 里是**自下而上**排的 —— 想让人第一眼看到最大的那根，就得把数组反过来。
  const ordered = [...data].reverse();
  const height = Math.max(120, data.length * rowHeight + 24);
  const option: EChartsCoreOption = {
    animation: false,
    grid: { left: 4, right: 28, top: 8, bottom: 4, containLabel: true },
    tooltip: sharedTooltip(tokens, {
      trigger: "axis",
      axisPointer: { type: "shadow", shadowStyle: { color: tokens.raised } },
    }),
    xAxis: { type: "value", minInterval: 1, ...axisCommon(tokens), splitLine: splitLine(tokens) },
    yAxis: {
      type: "category",
      data: ordered.map((row) => row.label),
      ...axisCommon(tokens),
      axisLabel: { color: tokens.muted, fontSize: 11, width: 130, overflow: "truncate" },
    },
    series: [
      {
        type: "bar",
        name: valueName,
        data: ordered.map((row) => row.value),
        barMaxWidth: 16,
        itemStyle: { color: color ?? tokens.brand, borderRadius: [0, 4, 4, 0] },
      },
    ],
  };
  return (
    <Canvas
      chart={chart}
      label={label}
      points={data.length}
      option={option}
      height={height}
      footnote={footnote}
      aria={`${label}（${data.length} 项，${valueName}）`}
    />
  );
}

/* ---------------- 堆叠条：几段互斥的取值合成一条 ---------------- */

export function StackedBarChart({
  chart,
  label,
  data,
  series,
  tokens,
  footnote,
  height,
  horizontal = false,
}: {
  chart: string;
  label: string;
  data: StackDatum[];
  series: Array<{ key: string; name: string; color: string }>;
  tokens: ChartTokens;
  footnote?: React.ReactNode;
  height?: number;
  /** 横放：类目上 Y 轴。
   *  ★ 片名当类目时**必须**横放 —— 竖柱的横轴放 10 个中文片名会被 ECharts 抽稀成
   *    只剩一两个可见（2026-09-20 实测：图下只剩「The Sorry Generation」一条），
   *    等于把「哪一条是谁」这条信息整个丢掉。 */
  horizontal?: boolean;
}) {
  const ordered = horizontal ? [...data].reverse() : data;
  const labels = ordered.map((row) => row.label);
  const category = { type: "category" as const, data: labels, ...axisCommon(tokens) };
  const value = { type: "value" as const, minInterval: 1, ...axisCommon(tokens), splitLine: splitLine(tokens) };
  const option: EChartsCoreOption = {
    animation: false,
    grid: { left: 4, right: horizontal ? 16 : 8, top: 16, bottom: 4, containLabel: true },
    tooltip: sharedTooltip(tokens, {
      trigger: "axis",
      axisPointer: { type: "shadow", shadowStyle: { color: tokens.raised } },
    }),
    xAxis: horizontal
      ? value
      : { ...category, axisLabel: { color: tokens.muted, fontSize: 11, interval: 0, hideOverlap: true } },
    yAxis: horizontal
      ? { ...category, axisLabel: { color: tokens.muted, fontSize: 11, width: 130, overflow: "truncate" } }
      : value,
    series: series.map((item, index) => ({
      type: "bar" as const,
      name: item.name,
      stack: "total",
      data: ordered.map((row) => Number(row[item.key] ?? 0)),
      barMaxWidth: horizontal ? 16 : 46,
      itemStyle: {
        color: item.color,
        // 只有最后一段（横放时是最右段）做圆角，否则每段都圆会像一串胶囊
        borderRadius:
          index === series.length - 1
            ? horizontal
              ? [0, 4, 4, 0]
              : [4, 4, 0, 0]
            : 0,
      },
    })),
  };
  return (
    <Canvas
      chart={chart}
      label={label}
      points={data.length}
      option={option}
      height={height ?? (horizontal ? Math.max(120, data.length * 24 + 24) : 200)}
      legend={<Legend items={series.map((item) => ({ label: item.name, color: item.color }))} />}
      footnote={footnote}
      aria={`${label}（${data.length} 项，${series.length} 段）`}
    />
  );
}

/* ---------------- 环形图：分类占比（国家 / 单元 / 影院） ----------------
 * ★ 为什么加它：占比这件事用横排柱读起来要「比长度」，用环形一眼就是份额；
 *   参考项目的 `donut-chart.tsx` 也是同一取舍（`innerRadius` 让中间留白给总数）。
 */

export function DonutChart({
  chart,
  label,
  data,
  tokens,
  footnote,
  height = 240,
  centerLabel,
}: {
  chart: string;
  label: string;
  data: DonutDatum[];
  tokens: ChartTokens;
  footnote?: React.ReactNode;
  height?: number;
  /** 圆心文案（通常是「合计 N」） */
  centerLabel?: string;
}) {
  const total = data.reduce((sum, row) => sum + row.value, 0);
  const centerText = centerLabel ?? (total > 0 ? String(total) : "");
  const option: EChartsCoreOption = {
    animation: false,
    tooltip: sharedTooltip(tokens, {
      trigger: "item",
      formatter: (param: { name: string; value: number; percent: number }) =>
        `${param.name}<br/><b>${param.value}</b>（${param.percent}%）`,
    }),
    // ⚠ 图例放**底部横向**而不是右侧竖向：面板宽度只有 ~460px 时，右侧竖排图例
    //   （右对齐、宽度由最长分类名决定）会直接压在环上（2026-09-20 截图实测：
    //   「单元」那张环的扇区被图例盖住）。横向滚动图例高度固定，不侵占扇区。
    legend: {
      type: "scroll",
      orient: "horizontal",
      bottom: 0,
      left: "center",
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 10,
      textStyle: { color: tokens.muted, fontSize: 11 },
    },
    // 圆心文案：ECharts 的 pie 没有「中心聚合标签」，用 title 定位到圆心是最稳的做法
    title: centerText
      ? {
          text: centerText,
          left: "50%",
          top: "38%",
          textAlign: "center",
          textStyle: { color: tokens.text, fontSize: 16, fontWeight: 650 },
        }
      : undefined,
    series: [
      {
        type: "pie",
        radius: ["46%", "68%"],
        center: ["50%", "44%"],
        avoidLabelOverlap: true,
        // 扇区本身不带标签（标签会互相压），圆心文案交给 `title` —— 见下
        label: { show: false },
        labelLine: { show: false },
        emphasis: { scale: true, scaleSize: 4 },
        itemStyle: { borderColor: tokens.surface, borderWidth: 2, borderRadius: 3 },
        data: data.map((row, index) => ({
          name: row.name,
          value: row.value,
          itemStyle: { color: tokens.palette[index % tokens.palette.length] },
        })),
      },
    ],
  };
  return (
    <Canvas
      chart={chart}
      label={label}
      points={data.length}
      option={option}
      height={height}
      footnote={footnote}
      aria={`${label}（${data.length} 项，合计 ${total}）`}
    />
  );
}

/** 图例：颜色 + 人话标签。**图例必须把颜色说清楚**，否则读者只能猜哪一色是哪一类。 */
function Legend({ items }: { items: Array<{ label: string; color: string }> }) {
  return (
    <ul className="ra-legend">
      {items.map((item) => (
        <li key={item.label}>
          <span className="ra-legend-dot" style={{ background: item.color }} aria-hidden="true" />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
