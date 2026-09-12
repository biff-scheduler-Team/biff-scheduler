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
