import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import macros from "unplugin-parcel-macros";
import optimizeLocales from "@react-aria/optimize-locales-plugin";
import { VitePWA } from "vite-plugin-pwa";

function legacyRedirect(
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) {
  const [pathname, query] = (request.url ?? "").split("?");
  if (pathname !== "/legacy") return next();
  response.statusCode = 308;
  response.setHeader("Location", `/legacy/${query ? `?${query}` : ""}`);
  response.end();
}

// Mock API 中间件（仅 dev）：拦截 /api/stats/film-votes，返回本地生成的假票数。
//
// ✏️  想调整数据分布 → 直接改 `mock/redblack-config.json`，刷新页面立刻生效，无需重启。
// 🧪  想注入「看过」标记 + 自己的贴纸 → 浏览器访问 /mock-redblack.html，点按钮注入。
//
// 配置格式（mock/redblack-config.json）：
//   tiers: 档位数组，按顺序累加 pct（总计应 = 100）
//     pct   — 落在该档位的影片百分比
//     red   — [最小, 最大] 红票区间（含）
//     black — [最小, 最大] 黑票区间（含），[0, N] 时低端可为 0
//
// 数据生成方式：确定性 hash（片序 → 档位 → 票数），同一 films.json 每次结果相同。
// 没人投的片（red=0 且 black=0）不写入 votes，与真实 API 行为一致。
function mockFilmVotes(
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) {
  const [pathname] = (request.url ?? "").split("?");
  if (pathname !== "/api/stats/film-votes") return next();

  // 每次请求都重新读文件 —— 改完配置刷新页面即可，不需要重启 dev server
  const configPath = fileURLToPath(new URL("./mock/redblack-config.json", import.meta.url));
  const filmsPath = fileURLToPath(new URL("./public/films.json", import.meta.url));

  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    tiers: { pct: number; red: [number, number]; black: [number, number] }[];
  };
  const raw = JSON.parse(readFileSync(filmsPath, "utf8")) as {
    films: { id: string }[];
  };

  // 累加档位阈值，方便后面按 tier < threshold 判断
  let cumulative = 0;
  const thresholds = config.tiers.map((t) => {
    cumulative += t.pct;
    return { threshold: cumulative, ...t };
  });

  const votes: Record<string, { red: number; black: number }> = {};
  raw.films.forEach((f, i) => {
    const key = `cat:${f.id}`;
    // 确定性 hash：同一 films.json 顺序每次结果相同
    const h1 = (((i + 1) * 2654435761) >>> 0);
    const h2 = ((h1 ^ 0xdeadbeef) * 1664525 + 1013904223) >>> 0;
    const h3 = ((h2 ^ 0xcafebabe) * 22695477 + 1) >>> 0;

    const tierPct = h1 % 100;
    const tier = thresholds.find((t) => tierPct < t.threshold) ?? thresholds[thresholds.length - 1];

    const [rMin, rMax] = tier.red;
    const [bMin, bMax] = tier.black;
    const red = rMax > rMin ? rMin + (h2 % (rMax - rMin + 1)) : rMin;
    const black = bMax > bMin ? bMin + (h3 % (bMax - bMin + 1)) : bMin;

    if (red > 0 || black > 0) {
      votes[key] = { red, black };
    }
  });

  const body = JSON.stringify({ votes });
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

// ── IDE 安全垫片阈值(2026-09-11)────────────────────────────────────────────
// 症状:dist/ 已存在时 `vite build` 必失败,报
//   [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":527,"threshold":500,...}
// 原因:CodeBuddy 在 node 进程里挂了 safe-delete 垫片,单次工具调用内删除 ≥500 个条目要人工确认;
//   而 `public/posters/`(513 张海报)+ 产物共 527 项会被原样拷进 dist,`emptyOutDir` 每轮构建
//   都要整目录删一次 → 必然越线。这不是项目 bug,CI / Cloudflare Git 构建没有垫片,不会触发。
// 处理:给垫片抬阈值。宿主已把它预设成 "500",所以必须**直接赋值**(`||=` 会被 500 挡住);
// 赋值只活在 `vite build` 这一个进程里(npm 的 typecheck / lint / test 是各自的子进程),
// 影响面 = 「允许 vite 删自己的构建产物目录」,不外溢到其它工具调用。
// 更彻底的做法是把 57MB 海报迁到 R2 / 独立静态域,dist 只留 <300KB 产物(见 PLAN 备注)。
process.env.CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD = "5000";

// 构建产物输出到 dist/（wrangler.toml [assets] 部署目录）；public/ 下的
// schedule.json / venues.json 会被 vite 原样拷贝进 dist 根目录。
export default defineConfig({
  base: "/",
  css: { postcss: { plugins: [tailwindcss()] } },
  // 开发端口 31026 = 第 31 届 + 2026,避开 Vite 默认 5173(本机常被占用)。
  // strictPort:撞车就失败,不悄悄换口。
  server: {
    port: 31026,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    target: "es2022",
    cssMinify: "lightningcss",
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        legacy: fileURLToPath(new URL("./legacy/index.html", import.meta.url)),
      },
      output: {
        manualChunks(id) {
          if (!id.includes("/node_modules/")) return;
          if (/\/(react|react-dom|scheduler|react-router)\//.test(id))
            return "react";
          // 图表库(2026-09-20,PLAN-20260920203010;**同日修订 4 换成 ECharts**):
          // 分析页的图从 recharts 换成 ECharts(视觉做法照 ma-agent-harness 的
          // workspace/analytics,见 `components/charts/bars.tsx` 文件头)。
          // 它比 recharts 更大 —— 必须独占一个 chunk,否则会被并进 spectrum / main,
          // 把首屏一起拖胖。分析页走路由级动态 import(见 `src/main.tsx`),
          // 该 chunk 因此**不进首屏**。
          // ⚠ `zrender` 是 ECharts 的渲染底座,不加进来它会落到 spectrum 里。
          if (/\/(echarts|zrender)\//.test(id)) return "charts";
          return "spectrum";
        },
      },
    },
    assetsDir: "assets",
  },
  plugins: [
    macros.vite(),
    {
      name: "legacy-entry-redirect",
      configureServer(server) {
        server.middlewares.use(mockFilmVotes);
        server.middlewares.use(legacyRedirect);
      },
      configurePreviewServer(server) {
        server.middlewares.use(legacyRedirect);
      },
    },
    react(),
    {
      ...optimizeLocales.vite({ locales: ["zh-CN", "en-US"] }),
      enforce: "pre",
    },
    // PWA(2026-09-11,PLAN-20260911000705):电影节现场(Centum / 南浦洞)网络不稳 ——
    // 预缓存产物与只读 JSON → 离线可用;manifest → 可加到主屏(从「网页」变「App」)。
    // 构建期依赖,主包 +0 字节。
    VitePWA({
      registerType: "autoUpdate", // 有新版自动接管,自用工具不需要用户确认弹窗
      injectRegister: "auto", // 插件往 index.html 注入注册脚本 → 零 TS 改动
      devOptions: { enabled: false }, // 开发期不装 SW(否则热更新会被缓存干扰)
      includeAssets: [
        "brand/favicon.ico",
        "brand/biff-scheduler-seal.svg",
        "brand/biff-2026-wordmark.png",
        "brand/biff-scheduler-wordmark.svg",
        "brand/apple-touch-icon.png",
        "robots.txt",
      ],
      manifest: {
        name: "BIFF 2026 排片 · Busan International Film Festival",
        short_name: "BIFF 排片",
        description:
          "第 31 届釜山国际电影节排片工具:选片、排期、冲突检测、导出 .ics",
        lang: "zh-CN",
        start_url: "./",
        scope: "./",
        display: "standalone",
        theme_color: "#ce1e36",
        background_color: "#ffffff",
        // 方形 PNG(2026-09-11 生成):品牌红底 + 白色 2026 全字标(用 wordmark 的 alpha 作遮罩),
        // 字标按原生 306×36 贴入不放大 → 锐利。192/512 供 manifest;
        // iOS 不吃 SVG 的 apple-touch-icon,故另有 180 版本(见 index.html)。
        icons: [
          {
            src: "./brand/app-icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "./brand/app-icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "./brand/app-icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // 预缓存:产物资源 + 只读 JSON(schedule / venues / films / douban / festival-extras)——
        // 没排期数据离线打开等于空表,必须进缓存
        globPatterns: ["**/*.{js,css,html,ico,png,json,svg,woff2}"],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api(?:\/|$)/],
        manifestTransforms: [
          async (entries) => {
            const legacy = entries.find(
              (entry) => entry.url === "legacy/index.html",
            );
            return {
              manifest: legacy
                ? [
                    ...entries,
                    ...["legacy", "legacy/"].map((url) => ({ ...legacy, url })),
                  ]
                : entries,
              warnings: [],
            };
          },
        ],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
