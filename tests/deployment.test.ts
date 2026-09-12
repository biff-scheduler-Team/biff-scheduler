import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
const script = resolve("scripts/prepare-cloudflare.mjs");
const targets = JSON.parse(readFileSync("scripts/cloudflare-targets.json", "utf8"));
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true }); });
function run(overrides: NodeJS.ProcessEnv = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "biff-deploy-test-"));
  directories.push(cwd);
  mkdirSync(join(cwd, "bin"));
  const log = join(cwd, "calls.jsonl");
  writeFileSync(join(cwd, "bin/npm"), `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),tag:process.env.WRANGLER_CI_MATCH_TAG,name:process.env.WRANGLER_CI_OVERRIDE_NAME})+'\\n');\n`, { mode: 0o755 });
  const env = { ...process.env };
  for (const key of ["WORKERS_CI", "WORKERS_CI_BRANCH", "WRANGLER_CI_MATCH_TAG", "WRANGLER_CI_OVERRIDE_NAME", "CLOUDFLARE_ACCOUNT_ID"]) delete env[key];
  const result = spawnSync(process.execPath, [script], { cwd, env: { ...env, ...overrides, PATH: `${join(cwd, "bin")}:${env.PATH}` }, encoding: "utf8" });
  let calls: {args: string[]; tag?: string; name?: string}[] = [];
  try { calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)); } catch { /* No cloud commands expected for local/preview builds. */ }
  return { result, calls, config: JSON.parse(readFileSync(join(cwd, ".wrangler/deploy/config.json"), "utf8")) };
}
it("local and preview builds emit config without cloud mutations", () => {
  for (const env of [{}, { WORKERS_CI: "1", WORKERS_CI_BRANCH: "preview" }]) {
    const { result, calls, config } = run(env);
    expect(result.status).toBe(0);
    expect(calls).toEqual([]);
    expect(config.configPath).toBe("../../apps/api/wrangler.jsonc");
  }
});
it("missing branch and mismatched production target fail before cloud writes", () => {
  for (const env of [{ WORKERS_CI: "1" }, { WORKERS_CI: "1", WORKERS_CI_BRANCH: "main", CLOUDFLARE_ACCOUNT_ID: "wrong" }]) {
    const { result, calls } = run(env);
    expect(result.status).not.toBe(0);
    expect(calls).toEqual([]);
  }
});
it("migrates first and deploys web with its own Wrangler identity guard", () => {
  const { result, calls } = run({ WORKERS_CI: "1", WORKERS_CI_BRANCH: "main", CLOUDFLARE_ACCOUNT_ID: targets.accountId, WRANGLER_CI_MATCH_TAG: targets["biff-scheduler"].tag });
  expect(result.status).toBe(0);
  expect(calls).toEqual([
    { args: ["run", "db:migrate:remote"], tag: targets["biff-scheduler"].tag },
    { args: ["run", "deploy", "-w", "@biff/web"], tag: targets["biff-scheduler-web"].tag, name: "biff-scheduler-web" },
  ]);
});
