import { defineConfig } from "vitest/config";

// `apps/api` 的单测**必须留在本 workspace 里**,不能放进根 `tests/`:
// 本包的类型环境是 Cloudflare Workers(`apps/api/tsconfig.json` 的 `types: []` +
// `worker-configuration.d.ts`),而根 `tests/` 继承 `apps/web/tsconfig.json`(DOM lib)。
// 把 `src/crypto.ts` 拉进 DOM 程序会立刻报 `Uint8Array<ArrayBufferLike>` 不满足 `BufferSource`,
// 同时 `worker-configuration.d.ts` 会污染根程序的 `NodeJS.ProcessEnv`。
// 详见 PLAN-20260913201727 的修订 1。
export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
