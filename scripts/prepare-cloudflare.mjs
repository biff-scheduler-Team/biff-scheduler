import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";

// Preserve the existing Workers Builds `npx wrangler deploy` command at repo root.
// Wrangler resolves configPath relative to this generated deployment file.
//
// ⚠ 2026-10-16(§6):这条「根 npx wrangler deploy」与下面第 3 步的 api 部署是**同一个 Worker**
//   —— 本文件已经按「迁移 → api → web」把它部署过一次,构建结束后那条命令再幂等重发一次。
//   删掉它需要改 **Cloudflare 控制台**里的构建命令(仓库改不了),见 AGENTS.md §6「待控制台改的一条」。
await mkdir(".wrangler/deploy", { recursive: true });
await writeFile(".wrangler/deploy/config.json", JSON.stringify({
  configPath: "../../apps/api/wrangler.jsonc",
}) + "\n");

/** 构建身份:Cloudflare Workers Builds 给环境变量,本地退回 git;都没有就记 unknown。 */
function buildInfo() {
  const fromGit = (args) => {
    const result = spawnSync("git", args, { encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  return {
    sha: process.env.WORKERS_CI_COMMIT_SHA ?? fromGit(["rev-parse", "HEAD"]) ?? "unknown",
    branch: process.env.WORKERS_CI_BRANCH ?? fromGit(["rev-parse", "--abbrev-ref", "HEAD"]) ?? "unknown",
    builtAt: new Date().toISOString(),
  };
}

// 交付证据:把构建 SHA 写进 web 产物(§6)。
// 为什么:在此之前「这次提交上线了吗」**没有可观测证据** —— asset hash 只在应用产物变化时才变,
// 纯文档 / 工具链提交的 hash 与上一版逐字相同,而线上**区分不了**「构建成功但产物相同」与
// 「构建失败、压根没发布」。写进 version.json 之后,`npm run verify:deploy -- --sha HEAD`
// 就能一句话断言「线上跑的就是本轮 HEAD」。
// ⚠ 写在 dist/ 而不是仓库源码目录:dist/ 已在 .gitignore 里,不污染工作树。
async function writeVersion() {
  const file = new URL("../apps/web/dist/version.json", import.meta.url);
  try {
    await access(new URL("../apps/web/dist/", import.meta.url));
  } catch {
    // dist 不存在 = web 那一侧压根没构建成功,真正的问题不在这里,别把它变成噪音。
    console.log("prepare-cloudflare:没有 apps/web/dist,跳过写 version.json");
    return;
  }
  await writeFile(file, JSON.stringify(buildInfo(), null, 2) + "\n");
  console.log("prepare-cloudflare:已写 apps/web/dist/version.json(交付证据)");
}

await writeVersion();

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
  } else {
    // 预览分支(§6「预览环境」):这里**不迁移、不部署生产**。
    // 可看的预览 URL 由 Workers Builds 自己对非生产分支产出版本预览 —— 前提是它在控制台开着
    // 「Builds for non-production branches」,且 apps/*/wrangler.jsonc 的 preview_urls 为 true。
    // 本文件只负责把「没碰生产」这件事说清楚,不在这里瞎猜控制台的状态。
    console.log(`prepare-cloudflare:预览分支 ${process.env.WORKERS_CI_BRANCH} —— 不迁移、不部署生产`);
  }
}
