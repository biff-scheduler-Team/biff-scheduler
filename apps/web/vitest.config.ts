import { defineConfig } from "vitest/config";

// 单元测试只覆盖**纯函数**(conflict / gv / ics / ai 解析 / util / score)—— 见 PLAN-20260911000705。
// node 环境即可:被测模块在 **import 期**不访问 DOM / localStorage
// (`util.ts::el()` 等只在被调用时才用 `document`;`state.ts` 只在函数里读 localStorage)。
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
