import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const accountPath = process.env.IFFDAY_ACCOUNT_PATH;
if (!accountPath)
  throw new Error("Set IFFDAY_ACCOUNT_PATH to a local checkout of IFF-Day/account.");
const accountRoot = resolve(accountPath);
const root = process.cwd();
const accountOrigin = process.env.IFFDAY_TEST_ORIGIN ?? "http://127.0.0.1:5183";
const biffOrigin = process.env.BIFF_TEST_ORIGIN ?? "http://localhost:31028";
const env = {
  ...process.env,
  E2E_BASE_URL: accountOrigin,
  E2E_API_PORT: process.env.E2E_API_PORT ?? "8793",
  E2E_MAILBOX_PORT: process.env.E2E_MAILBOX_PORT ?? "8035",
  BIFF_TEST_ORIGIN: biffOrigin,
};
await readFile(join(accountRoot, "scripts/provision-biff-client.mjs"));
await mkdir(join(accountRoot, ".local"), { recursive: true });
const secretPath = join(accountRoot, ".local/biff-client-secret");
try {
  await readFile(secretPath);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await writeFile(secretPath, randomBytes(48).toString("base64url"), { mode: 0o600, flag: "wx" });
}
const secret = (await readFile(secretPath, "utf8")).trim();
const varsPath = join(root, ".dev.vars");
try {
  await readFile(varsPath);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await writeFile(
    varsPath,
    `APP_ENV=local\nAPP_ORIGIN=${biffOrigin}\nIFFDAY_ORIGIN=${accountOrigin}\nOIDC_CLIENT_ID=biff-scheduler-local\nOIDC_CLIENT_SECRET=${secret}\nSESSION_SECRET=${randomBytes(48).toString("base64url")}\n`,
    { mode: 0o600, flag: "wx" },
  );
}
const vars = await readFile(varsPath, "utf8");
for (const [key, value] of Object.entries({
  APP_ENV: "local",
  APP_ORIGIN: biffOrigin,
  IFFDAY_ORIGIN: accountOrigin,
  OIDC_CLIENT_ID: "biff-scheduler-local",
  OIDC_CLIENT_SECRET: secret,
})) {
  if (!vars.split(/\r?\n/).some((line) => line === `${key}=${value}`))
    throw new Error(
      `Existing .dev.vars differs for ${key}. Align the local integration configuration before starting.`,
    );
}
async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`)),
    );
  });
}
await run("pnpm", ["run", "setup:e2e"], accountRoot);
await run("node", ["scripts/provision-biff-client.mjs", "local", secretPath], accountRoot);
await run(
  "pnpm",
  [
    "--filter",
    "@iff-day/api",
    "exec",
    "wrangler",
    "d1",
    "execute",
    "iff-day-auth",
    "--local",
    "--persist-to",
    ".wrangler/e2e",
    "--file",
    join(accountRoot, ".local/biff-client-local.sql"),
  ],
  accountRoot,
);
await run("npm", ["run", "db:migrate"], root);
await run("pnpm", ["run", "build"], accountRoot);
await run("npm", ["run", "build"], root);
const registry = join(accountRoot, ".local/e2e-registry");
const children = [];
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}
function start(command, args, cwd, environment) {
  const child = spawn(command, args, { cwd, env: environment, stdio: "inherit", detached: true });
  children.push(child);
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
    stop();
  });
  child.on("exit", (code) => {
    if (!stopping) {
      process.exitCode = code ?? 1;
      stop();
    }
  });
}
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, stop);
start("node", ["scripts/dev.mjs", "--e2e"], accountRoot, env);
const deadline = Date.now() + 30_000;
while (true) {
  try {
    const response = await fetch(`${accountOrigin}/api/v1/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (response.ok) break;
  } catch {
    /* Wait for the provider's local Worker. */
  }
  if (Date.now() > deadline) {
    stop();
    throw new Error("Local identity service did not start.");
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
start("npx", ["wrangler", "dev", "--ip", "127.0.0.1", "--port", new URL(biffOrigin).port], root, {
  ...env,
  WRANGLER_REGISTRY_PATH: registry,
  MINIFLARE_REGISTRY_PATH: registry,
});
console.log(`BIFF account integration: ${biffOrigin}`);
