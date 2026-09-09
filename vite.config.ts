import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/postcss";

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
});
