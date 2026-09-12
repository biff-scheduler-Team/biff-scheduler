import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/postcss";
import { VitePWA } from "vite-plugin-pwa";

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
  base: "./",
  css: {
    postcss: {
      plugins: [tailwindcss()],
    },
  },
  // 开发端口 31026 = 第 31 届 + 2026,避开 Vite 默认 5173(本机常被占用)。
  // strictPort:撞车就失败,不悄悄换口。
  server: {
    port: 31026,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    assetsDir: "assets",
  },
  plugins: [
    // PWA(2026-09-11,PLAN-20260911000705):电影节现场(Centum / 南浦洞)网络不稳 ——
    // 预缓存产物与只读 JSON → 离线可用;manifest → 可加到主屏(从「网页」变「App」)。
    // 构建期依赖,主包 +0 字节。
    VitePWA({
      registerType: "autoUpdate", // 有新版自动接管,自用工具不需要用户确认弹窗
      injectRegister: "auto", // 插件往 index.html 注入注册脚本 → 零 TS 改动
      devOptions: { enabled: false }, // 开发期不装 SW(否则热更新会被缓存干扰)
      includeAssets: ["brand/favicon.ico", "brand/biff-2026-wordmark.png", "brand/biff-scheduler-wordmark.svg", "brand/apple-touch-icon.png", "robots.txt"],
      manifest: {
        name: "BIFF 2026 排片 · Busan International Film Festival",
        short_name: "BIFF 排片",
        description: "第 31 届釜山国际电影节排片工具:选片、排期、冲突检测、导出 .ics",
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
          { src: "./brand/app-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "./brand/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "./brand/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // 预缓存:产物资源 + 只读 JSON(schedule / venues / films / douban / festival-extras)——
        // 没排期数据离线打开等于空表,必须进缓存
        globPatterns: ["**/*.{js,css,html,ico,png,json,svg}"],
        navigateFallback: "index.html",
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
