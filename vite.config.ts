import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/postcss";
import { VitePWA } from "vite-plugin-pwa";

// 构建产物输出到 dist/（wrangler pages 部署目录）；public/ 下的
// schedule.json / venues.json 会被 vite 原样拷贝进 dist 根目录。
export default defineConfig({
  base: "./",
  css: {
    postcss: {
      plugins: [tailwindcss()],
    },
  },
  build: {
    outDir: "dist",
    assetsDir: "assets",
  },
  plugins: [
    // PWA(2026-09-11,PLAN-20260911000705):电影节现场(Centum / 南浦洞)网络不稳 ——
    // 预缓存产物与三个只读 JSON → 离线可用;manifest → 可加到主屏(从「网页」变「App」)。
    // 构建期依赖,主包 +0 字节。
    VitePWA({
      registerType: "autoUpdate", // 有新版自动接管,自用工具不需要用户确认弹窗
      injectRegister: "auto", // 插件往 index.html 注入注册脚本 → 零 TS 改动
      devOptions: { enabled: false }, // 开发期不装 SW(否则热更新会被缓存干扰)
      includeAssets: ["brand/favicon.ico", "brand/biff-2026-wordmark.png", "brand/apple-touch-icon.png", "robots.txt"],
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
        // 预缓存:产物资源 + 三个只读 JSON —— 没排期数据离线打开等于空表,必须进缓存
        globPatterns: ["**/*.{js,css,html,ico,png,json}"],
        navigateFallback: "index.html",
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
