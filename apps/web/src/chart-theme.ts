/**
 * 图表配色：**从既有 CSS token 读**，不新建色板
 * （2026-09-20，PLAN-20260920203010，第 1 轮）。
 *
 * ★ 为什么需要这一层：
 *   recharts 的 `fill` / `stroke` 吃的是**具体色值**，不认 CSS 变量；而本仓库的色源唯一 ——
 *   `style.css` 的 `:root` / `:root[data-theme="dark"]` 两套 token（红线：token 是唯一色源）。
 *   所以必须在运行时把 token 读成色值。**任何图表代码里出现十六进制都算违规**：
 *   写死的颜色在暗色主题下必然不可读，而这份数据的读者会在手机暗色下看它。
 *
 * ★ 为什么还要订阅 `data-theme`：
 *   `apps/web/src/app/App.tsx` 把主题写到 `document.documentElement.dataset.theme`，
 *   CSS 因此自动换色 —— 但 recharts 拿到的是**上一次读出来的色值快照**，
 *   不重读就会出现「切暗色后图上还是浅色」。
 *
 * ⚠ 本模块的纯逻辑部分（`resolveChartTokens`）**不碰 DOM**，node 直接可测；
 *   只有 `readChartTokens` / `useChartTokens` 才是浏览器侧。
 */

import { useEffect, useState } from "react";

/** 图表需要的那几个 token —— 与 `style.css` 的 `:root` 一一对应，不新增任何语义。 */
export interface ChartTokens {
  /** 主色：柱体 / 折线 / 结论点 */
  brand: string;
  /** 主色淡底：帕累托柱的填充 */
  brandSoft: string;
  /** 正文色：折线与强调文字 */
  text: string;
  /** 次要色：未知 / 样本不足的点、次要标签 */
  muted: string;
  /** 网格与坐标轴 */
  line: string;
  /** tooltip 底 */
  surface: string;
  /** 与 `surface` 拉开一层的底（tooltip 内的格子 / 空态） */
  raised: string;
  /** 难度「极高」/ 结果「没抢到」 */
  conflictLine: string;
  /** 难度「高」/ 结果「转票」（独立一段，不与抢到混色） */
  tightLine: string;
  /** 难度「中」/ 结果「已抢到」 */
  selectedLine: string;
  /** 空态骨架色（环形图的占位环、图表空数据背景） */
  emptySkeleton: string;
  /**
   * **分类色板**（国家 / 单元 / 影院品牌这类「没有语义排序」的维度用）。
   *
   * ★ 为什么它不来自 CSS 变量：站点 token 只有一套**语义色**（红=冲突 / 黄=紧 / 绿=有余量），
   *   而分类维度需要 6~8 个「互相区分、彼此不等价」的色相 —— 用语义色去画「国家」
   *   会把「法国」画成「有冲突」的意思。故这里为浅深两套各定一组（**只此一处**，
   *   与 `CHART_TOKEN_FALLBACK` 同一个文件），不往 `style.css` 里加变量
   *   （那会命中 TEST-MAP 的 allOn，触发三浏览器全量 E2E）。
   * ★ `palette[0]` 恒为品牌色，保证「只有一两个分类」时外观仍是本站的主色。
   */
  palette: string[];
}

/** 走 CSS 变量的那部分 token（**分类色板不在其中** —— 它按主题取表，见 `ChartTokens.palette`）。 */
export type ChartTokenKey = keyof Omit<ChartTokens, "palette">;

/** token 名 → CSS 变量名。改这里就是改图表的取色来源，别处不要再拼字符串。 */
export const CHART_TOKEN_NAMES: Readonly<Record<ChartTokenKey, string>> = {
  brand: "--brand",
  brandSoft: "--brand-soft",
  text: "--text",
  muted: "--muted",
  line: "--line",
  surface: "--surface",
  raised: "--raised",
  conflictLine: "--conflict-line",
  tightLine: "--tight-line",
  selectedLine: "--selected-line",
  // 空态骨架直接用「拉开一层的底」，不新增变量
  emptySkeleton: "--raised",
};

/**
 * 兜底色板 —— **只在读不到 CSS 变量时**使用（node 单测、样式尚未加载、极端环境）。
 *
 * ⚠ 它必须与 `style.css` 的**浅色** token 逐字一致。这不是第二份色源：
 *   正常路径永远走 CSS 变量，这里只是「读不到时别把 `undefined` 塞进 SVG」的最后一道闸。
 *   浅色作为兜底是因为本站在现场主要用手机、且默认跟随系统 —— 读不到 token 时
 *   默认按浅色渲染，比渲染出一堆透明图形强。
 */
/** 分类色板（浅色）—— 见 `ChartTokens.palette` 的说明：语义色画不了「国家」这种中立维度。 */
export const CHART_PALETTE_LIGHT: readonly string[] = [
  "#ce1e36", // 品牌红
  "#2f6fd0", // 蓝
  "#388452", // 绿
  "#916e14", // 琥珀
  "#8a4dbf", // 紫
  "#0e8a8a", // 青
  "#c2521a", // 橙
  "#67676e", // 灰（第 8 类之后仍有区分度）
];

/** 分类色板（深色）—— 同一批色相提亮，保证暗底上对比度够、且与品牌红仍是一家人。 */
export const CHART_PALETTE_DARK: readonly string[] = [
  "#e9485f",
  "#5b9be8",
  "#4fb673",
  "#c79a26",
  "#a874db",
  "#2fb3b3",
  "#e0762f",
  "#9a9aa3",
];

export const CHART_TOKEN_FALLBACK: Readonly<ChartTokens> = {
  brand: "#ce1e36",
  brandSoft: "#fff0f2",
  text: "#242427",
  muted: "#67676e",
  line: "#dcdce1",
  surface: "#fff",
  raised: "#f7f7f8",
  conflictLine: "#be3346",
  tightLine: "#916e14",
  selectedLine: "#388452",
  emptySkeleton: "#f7f7f8",
  palette: [...CHART_PALETTE_LIGHT],
};

/** 一个值是否可以直接喂给 SVG（非空、非 `undefined` / `null` 字面量）。
 *  `getPropertyValue` 对未定义的变量返回空串，直接拿去当 `fill` 会画出透明图形。 */
function usable(value: string | undefined | null): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== "undefined" && trimmed !== "null";
}

/** 由「变量名 → 值」的读取器构造色板。缺失 / 空值 / 非法值一律回退到 {@link CHART_TOKEN_FALLBACK}。
 *  纯函数，测试里塞一个假读取器即可覆盖全部降级分支。
 *
 *  `isDark` 只影响**分类色板**（CSS 变量那条路自己就带明暗两套，无需参数）。 */
export function resolveChartTokens(
  read: (name: string) => string | undefined | null,
  isDark = false,
): ChartTokens {
  const out: ChartTokens = {
    ...CHART_TOKEN_FALLBACK,
    palette: [...(isDark ? CHART_PALETTE_DARK : CHART_PALETTE_LIGHT)],
  };
  for (const key of Object.keys(CHART_TOKEN_NAMES) as ChartTokenKey[]) {
    const value = read(CHART_TOKEN_NAMES[key]);
    if (usable(value)) out[key] = value.trim();
  }
  return out;
}

/** 当前是不是暗色。`App.tsx` 把主题写进 `data-theme`（与 `style.css` 的
 *  `:root[data-theme="dark"]` 同一个开关）；属性还没写（首帧 / 跟随系统时）退到媒体查询。 */
export function isDarkTheme(): boolean {
  if (typeof document === "undefined") return false;
  const attr = document.documentElement.dataset.theme;
  if (attr === "dark") return true;
  if (attr === "light") return false;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

/** 运行时读取：从 `documentElement` 的 computed style 取 token（浅深两套由 CSS 自己换）。 */
export function readChartTokens(): ChartTokens {
  return resolveChartTokens(
    (name) => getComputedStyle(document.documentElement).getPropertyValue(name),
    isDarkTheme(),
  );
}

/**
 * 订阅主题变化后的图表色板。
 *
 * ⚠ 观察 `data-theme` **属性**即可覆盖浅深两套 —— 它就是 `style.css` 里
 *   `:root[data-theme="dark"]` 的开关（见 `App.tsx` 的主题 effect）；
 *   观察 `class` 或整棵子树是白看。
 */
export function useChartTokens(): ChartTokens {
  const [tokens, setTokens] = useState<ChartTokens>(readChartTokens);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => setTokens(readChartTokens()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return tokens;
}
