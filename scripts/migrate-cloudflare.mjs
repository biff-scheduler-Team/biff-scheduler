import { spawnSync } from "node:child_process";

// Cloudflare's existing Git integration runs `npm run build` then `npx wrangler deploy`.
// Apply migrations only after a successful production build, never during local builds or previews.
if (process.env.WORKERS_CI) {
  if (!process.env.WORKERS_CI_BRANCH)
    throw new Error(
      "Cloudflare build branch is required before selecting a database migration target.",
    );
  if (process.env.WORKERS_CI_BRANCH === "main") {
    const result = spawnSync(
      "npx",
      ["wrangler", "d1", "migrations", "apply", "biff-account-data", "--remote"],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
