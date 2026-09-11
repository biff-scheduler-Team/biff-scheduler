// ESLint 扁平配置(2026-09-10 加,见 docs/plans/PLAN-20260910232833.md)。
// 目标:兜住 tsc 管不到的导出死代码与常见陷阱;**刻意不引入 prettier 自动重排** ——
// 本仓库有大量刻意保留的长行 / 手工对齐,`prettier --write` 会产生数千行无意义 diff。
import tseslint from "typescript-eslint";

export default tseslint.config(
  // 产物 / 依赖 / 离线管线 / Cloudflare Functions(独立 JS 运行时,另有一套全局)
  { ignores: ["dist/**", "node_modules/**", ".wrangler/**", "tools/**", "functions/**", "skills/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    rules: {
      // tsc 的 noUnusedLocals / noUnusedParameters 已覆盖,这里不重复报
      "@typescript-eslint/no-unused-vars": "off",
      // 空 catch 块内一律有注释说明;允许空 catch,仍报真正的空块
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  }
);
