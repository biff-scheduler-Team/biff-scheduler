import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";

// Preserve the existing Workers Builds `npx wrangler deploy` command at repo root.
// Wrangler resolves configPath relative to this generated deployment file.
await mkdir(".wrangler/deploy", { recursive: true });
await writeFile(".wrangler/deploy/config.json", JSON.stringify({
  configPath: "../../apps/api/wrangler.jsonc",
}) + "\n");

// Local builds and preview branches must never migrate or deploy production.
if (process.env.WORKERS_CI) {
  if (!process.env.WORKERS_CI_BRANCH)
    throw new Error("Cloudflare build branch is required before deploying production.");
  if (process.env.WORKERS_CI_BRANCH === "main") {
    const targets = JSON.parse(await readFile(new URL("./cloudflare-targets.json", import.meta.url), "utf8"));
    const api = targets["biff-scheduler"];
    const web = targets["biff-scheduler-web"];
    if (process.env.CLOUDFLARE_ACCOUNT_ID !== targets.accountId || process.env.WRANGLER_CI_MATCH_TAG !== api.tag)
      throw new Error("Production build must belong to the configured BIFF API Worker and account.");
    const steps = [
      { args: ["run", "db:migrate:remote"], env: process.env },
      // ⚠ **API 必须先于前端上线**（2026-10-05，PLAN-20261005182415 修订 5）。
      // 原顺序是「迁移 → web」，API 留给构建结束后那条 `npx wrangler deploy` ——
      // 于是**新前端会先于新 API 生效几分钟**。那段时间里新前端发的增量载荷会被旧 API 的
      // `.strict()` 判成 422（用户看到「服务端拒绝了这次上报」），
      // 而反向（旧前端 + 新 API）本来就是安全的（API 保留了整份替换那条路径）。
      // 提到 web 之前之后，构建结束那条命令会**再部署一次 API** —— 同一份代码、幂等，无害；
      // 保留它是为了不动 CI 侧那条既有命令（它同时是「构建产物能上线」的兜底）。
      { args: ["run", "deploy", "-w", "@biff/api"], env: {
        ...process.env, WRANGLER_CI_MATCH_TAG: api.tag, WRANGLER_CI_OVERRIDE_NAME: api.name,
      } },
      // Each child retains Wrangler's identity guard, using its own known Worker ID.
      // The parent environment remains scoped to the API for the final CI deploy.
      { args: ["run", "deploy", "-w", "@biff/web"], env: {
        ...process.env, WRANGLER_CI_MATCH_TAG: web.tag, WRANGLER_CI_OVERRIDE_NAME: web.name,
      } },
    ];
    for (const { args, env } of steps) {
      const result = spawnSync("npm", args, { stdio: "inherit", env });
      if (result.error) throw result.error;
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
  }
}
