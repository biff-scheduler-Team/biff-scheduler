---
name: cloudflare-pages-d1-deploy
description: Deploy a Cloudflare Pages + D1 + Pages Functions full-stack project end-to-end in non-interactive (CI / agent) mode. Trigger when user wants to ship a static frontend with serverless API endpoints backed by SQLite (D1) on Cloudflare — typically a small web app, demo, MVP, or game. Captures the gotchas: project must be pre-created via `pages project create` (because `pages deploy` blocks non-interactively for first-time deploy), D1 binding is auto-applied to Functions when declared in wrangler.toml, `d1 execute --command` only runs the first SQL statement, and local D1 debug requires no `--d1` flag.
description_zh: 部署 Cloudflare Pages + D1 + Functions 全栈
description_en: Deploy Pages + D1 + Functions stack
disable: false
agent_created: true
---

# cloudflare-pages-d1-deploy

## When to use

- User wants to ship a static frontend + serverless API + SQLite (D1) backend on Cloudflare with **zero server cost**.
- Common shape: a small game, demo, leaderboard app, or MVP. Architecture is Pages (static) + Pages Functions (one JS file per `/api/*` route) + D1 (SQLite).
- The deploy must run **non-interactively** (CI, agent session, headless tool) — i.e. no human to confirm prompts.
- The user has a Cloudflare account already logged in on this machine via OAuth (so `wrangler whoami` succeeds and shows the email).

## Steps

Assume project root = `<PROJECT>` (a folder with `public/`, `functions/`, `migrations/`, `wrangler.toml`).

### 1. Pre-flight: confirm OAuth + project layout

```bash
cd <PROJECT>
npx wrangler whoami                # must show a logged-in email; if not, stop
npx wrangler d1 list               # confirm D1 database name + uuid
```

If the D1 database does not exist yet, create it (D1 names are globally unique per account):

```bash
npx wrangler d1 create <DB_NAME>   # returns a uuid; capture it
```

### 2. Wire wrangler.toml

`wrangler.toml` must include both the pages build output dir and the D1 binding. The D1 binding is auto-applied to all Functions during `pages deploy` — no per-function `env.DB` setup needed.

```toml
name = "<PAGES_PROJECT_NAME>"
compatibility_date = "<today YYYY-MM-DD>"
pages_build_output_dir = "./public"

[[d1_databases]]
binding = "DB"
database_name = "<DB_NAME>"
database_id = "<uuid from step 1>"
migrations_dir = "./migrations"
```

### 3. Apply migrations to remote D1

```bash
npx wrangler d1 migrations apply <DB_NAME> --remote
```

Wrangler auto-detects the database from `wrangler.toml`, lists pending migrations, and asks `About to apply N migration(s) … continue?`. In agent mode it falls back to "yes" automatically (it prints `🤖 Using fallback value in non-interactive context: yes`).

Check what is pending first (read-only, safe):

```bash
npx wrangler d1 migrations list <DB_NAME> --remote
```

**Changing a column constraint = rebuild the table.** D1 is SQLite, and SQLite does **not** support `ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL` (it only supports `RENAME TABLE` / `RENAME COLUMN` / `ADD COLUMN` / `DROP COLUMN`). Writing the obvious `ALTER COLUMN` migration fails at apply time with `near "ALTER": syntax error`. Use the official 12-step-style rebuild:

```sql
DROP TABLE IF EXISTS t_new;                       -- guard against a re-run
CREATE TABLE t_new ( ...col TEXT, ... );          -- new shape (constraint relaxed)
INSERT INTO t_new (cols...) SELECT cols... FROM t;-- copy existing rows verbatim
DROP TABLE t;
ALTER TABLE t_new RENAME TO t;
CREATE INDEX IF NOT EXISTS idx_x ON t (a, b);     -- recreate every index
```

Before touching remote data, replay `0001` + all new migrations against a throwaway local sqlite and assert: old rows survive, `typeof(col)` is what you expect, indexes exist, sibling tables untouched:

```bash
python3 - <<'PY'
import sqlite3
c = sqlite3.connect("/tmp/mig-test.db")
c.executescript(open("migrations/0001_init.sql").read())
# insert a couple of representative rows first
for f in ("0002_....sql",):
    c.executescript(open(f"migrations/{f}").read())
# then SELECT to verify
PY
```

After applying remotely, verify the live schema and that data survived:

```bash
npx wrangler d1 execute <DB_NAME> --remote --json \
  --command "SELECT sql FROM sqlite_master WHERE type='table' AND name='t'"
npx wrangler d1 execute <DB_NAME> --remote --json \
  --command "SELECT COUNT(*) AS n, SUM(col IS NULL) AS nulls FROM t"
```

Piping `--json` into `python3 -c "import sys,json; ..."` gives much cleaner output than the default table renderer.

> **Never** relax a constraint *and* backfill old default values in the same pass unless you can distinguish "user chose this value" from "old default". When you can't, keep the historical values and only stop *new* rows from getting the forced default.

### 4. Pre-create the Pages project (mandatory for first deploy)

**Gotcha:** `wrangler pages deploy` is non-interactive-blocking when the project does not exist (it tries to ask a confirmation prompt and aborts with `This command cannot be run in a non-interactive context`). Solution: create the project in a separate, non-interactive command first.

```bash
npx wrangler pages project create <PAGES_PROJECT_NAME> --production-branch production
```

The output includes the assigned URL: `https://<name>-<hash>.pages.dev/`. The hash is auto-generated (e.g. `fuwafuwa-89m`).

### 5. Deploy

```bash
npx wrangler pages deploy public \
  --project-name <PAGES_PROJECT_NAME> \
  --branch production \
  --commit-dirty=true
```

- `--branch production` matches the production branch set in step 4; without it the deploy lands on a preview URL instead of the main site.
- `--commit-dirty=true` skips the "you have uncommitted changes" prompt.

**Deploying a *specific commit* instead of the working tree.** `pages deploy` uploads a build output dir, and that build reads whatever is on disk — so any uncommitted / half-finished edits in the working tree get shipped too. If the repo is dirty for reasons unrelated to this deploy (other people or agents editing the same checkout), build from an isolated snapshot rather than stashing (never `git stash` / `git checkout` someone else's files):

```bash
git worktree add --detach /tmp/deploy-src <TARGET_SHA>
ln -s "$PWD/node_modules" /tmp/deploy-src/node_modules   # avoid a full reinstall
cd /tmp/deploy-src && npm run build
npx wrangler pages deploy dist --project-name <NAME> --branch production --commit-dirty=true
cd - && rm -f /tmp/deploy-src/node_modules && git worktree remove --force /tmp/deploy-src && git worktree prune
```

Tip: fingerprint the artifact (`grep -c '<new string>' dist/assets/*.js`, or just compare the `index-<hash>.js` filename against a working-tree build) so you can prove the isolated build is the one that went live.

**Gotcha: the isolated snapshot can be *incomplete*.** A clean `TARGET_SHA` build is not automatically a *correct* build — if committed code depends on a file that is only modified in someone else's dirty working tree, the snapshot silently ships the broken half. Real case: committed `src/pick.ts` referenced `bg-pri-*-soft` utilities whose `@theme` tokens (`--pri-*-soft`) existed only in an uncommitted `src/style.css` → the snapshot built fine but every 档位 Tag lost its background. So before deploying the snapshot, **grep the built artifact for each new dependency**:

```bash
npx vite build && grep -c -- 'pri-must-soft' dist/assets/*.css   # 0 = 依赖没进产物,快照不完整
```

If a required file is missing from the snapshot, copy just that file in (`cp "$REPO/src/style.css" /tmp/deploy-src/src/style.css`), rebuild, and re-grep. `--commit-dirty=true` already covers the resulting dirty worktree. This is not "shipping someone else's work" — it is completing an already-committed dependency. Tell the user which extra file went into the build.

### 5b. Wrangler needs real network egress

In an agent sandbox that routes traffic through a local HTTP proxy, `wrangler` fails with `fetch failed` / `A fetch request failed, likely due to a connectivity issue` while `curl` to the same host also returns `000`. That is the sandbox, not Cloudflare. Re-run the `wrangler` command with the sandbox disabled (or from a normal terminal). A quick probe:

```bash
curl -s -o /dev/null -m 15 -w "%{http_code}\n" https://api.cloudflare.com/client/v4/user/tokens/verify
```

`000` = blocked; `400` (unauthenticated verify) = reachable, wrangler will work.

### 6. Verify end-to-end (no exceptions)

Run a curl-based smoke test on the live URL — never trust a successful deploy output alone.

```bash
BASE="https://<name>-<hash>.pages.dev"

# Static page
curl -s -o /dev/null -w "HTTP %{http_code}\n" "$BASE/"

# One round-trip per API endpoint
curl -s -X POST "$BASE/api/register" -H "Content-Type: application/json" -d '{"username":"smoke","password":"secret123"}'
curl -s -X POST "$BASE/api/login"    -H "Content-Type: application/json" -d '{"username":"smoke","password":"secret123"}'
# … and so on for /api/score, /api/leaderboard, /api/me, /api/logout
```

If any endpoint returns 500 or `D1 binding not found`, the wrangler.toml binding is wrong — recheck `binding = "DB"` matches the env name used in code (`env.DB`).

### 7. Clean up smoke-test data (optional but recommended for shared DBs)

`wrangler d1 execute` with `--command` runs **only the first SQL statement**. Use a loop or `--file`:

```bash
for tbl in scores sessions users; do
  npx wrangler d1 execute <DB_NAME> --remote --command "DELETE FROM $tbl;"
done
```

## Pitfalls

- **First-time `pages deploy` is non-interactive-blocking.** Always pre-create with `pages project create`. Don't try `--branch` / `--commit-dirty` on the deploy to fix this — it won't help.
- **`d1 execute --command "A; B;"` only runs A.** Multi-statement strings get truncated; either loop per statement or pass a file with `--file`.
- **Local D1 debug: do NOT pass `--d1 DB=<name>`** to `wrangler pages dev`. The flag creates a *separate* local sqlite instance from the one `wrangler d1 migrations apply` writes to — leading to `no such table` at runtime. Let `wrangler.toml` be the only source of truth for the binding.
- **Pages project name must be unique across the account.** If `pages project create` fails with name taken, pick another; the URL hash also changes.
- **Clean project names are possible**: if `<name>.pages.dev` is not already taken anywhere, you get `<name>.pages.dev` directly (e.g. `biff-scheduler.pages.dev`), not `<name>-<hash>.pages.dev`. Don't promise a hash suffix up front.
- **OAuth must already be set up on the host** before any `wrangler` command can hit the API. In agent mode you can't run `wrangler login` interactively; the user must have logged in earlier (or you must guide them through `wrangler login` in their own terminal first).
- **D1 binding is read from `wrangler.toml` automatically** by `pages deploy` for the Functions bundle — you do **not** need to add the binding again in the Cloudflare dashboard for the project (dashboard binding is for `pages dev` parity or for projects imported from Git, not for `wrangler pages deploy`-driven deploys).
- **`compatibility_date` matters.** Set it to today or the project will warn / fail on stale runtimes.
- **Network from China mainland is poor for `*.pages.dev`.** Tell the user up front if they expect domestic traffic — the free tier has no CN edge nodes.
- **Vite/TS projects (not plain static):** build to `dist/`, keep `functions/` and `wrangler.toml` at project root, set `pages_build_output_dir = "./dist"` in wrangler.toml, and deploy with `wrangler pages deploy dist --project-name <name>`. Put static data that must live at site root (`schedule.json`, `robots.txt`) in Vite's `public/` — it is copied into `dist/` automatically. In `index.html` set Vite `base: "./"` so built asset URLs are relative.
- **`wrangler pages dev` needs the `workerd` runtime binary**, downloaded on first use into the wrangler cache. In a restricted/headless environment the download can hang silently (proxy listens, all requests return `502 upstream connect failed`). If local preview hangs like this, skip local dev and go straight to `d1 migrations apply --remote` + `pages deploy` for the smoke test; local dev can be done later by the user in their own terminal.
- **Pages Functions with URL params**: dynamic routes use bracket files, e.g. `functions/api/plan/[code].js` handles `/api/plan/:code` with `params.code`; keep the collection route in `functions/api/plan.js` (a bare file only matches its exact path).
- **Validate enum-ish fields as a tri-state, not a string.** A handler written as `String(body.x ?? "default").toLowerCase()` silently coerces a deliberate `null` into the default — so a frontend that means "unset" can never persist it. Handle three cases explicitly: `null` → SQL `NULL`, `undefined` → legacy default (old cached clients), string → validate against the allow-list. Then assert all three against the live endpoint.
- **Probing a live write endpoint without polluting user data**: PUT to a code/id that does not exist yet, GET to confirm it round-tripped, then DELETE it and re-GET to confirm the row count is back to the original. Print the row list before/after so the cleanup is provable.

## Verification

- `curl /` returns 200 + non-empty HTML.
- Each `/api/*` endpoint returns the expected JSON shape (no 500, no `D1 binding not found`).
- A headless browser pass via playwright-core confirms the page actually renders and that state round-trips, not just that the server returns bytes.
  - Find the real binary before hardcoding a path — the layout under `~/Library/Caches/ms-playwright/` differs by revision. `ls -d ~/Library/Caches/ms-playwright/*chromium*` then look inside; recent revisions ship `chromium_headless_shell-<rev>/chrome-headless-shell-mac-arm64/chrome-headless-shell`, **not** `chromium-<rev>/chrome-mac-arm64/Chromium.app/...` (that dir may hold `Google Chrome for Testing.app` instead). A wrong path fails with ENOENT, not a helpful message.
  - Serve the build over `http://127.0.0.1:<port>` (e.g. `python3 -m http.server <port> -d dist`). Launch it as a *managed background task* — a `(cmd &)` subshell dies between tool calls and the next step hits `ERR_CONNECTION_REFUSED`.
  - Seed state through `localStorage` before asserting: `page.goto(...)` → `page.evaluate(() => localStorage.setItem(k, v))` → `page.reload()`. Reading `localStorage` back after a click is the cheapest way to prove what the app persisted.
  - Prefer a table of named scenarios with `✅/❌` lines and a non-zero exit code on failure over ad-hoc assertions, so the run is self-documenting.
- After verification, delete smoke-test rows so the user opens a clean leaderboard.

## References

- Cloudflare D1 free-tier limits (5 GB, 100k writes/day, 5M reads/day) — verified from official Cloudflare docs at time of writing.
- Pages Functions: each file in `functions/` becomes a route. `functions/api/foo.js` → `POST /api/foo` (or any other method) automatically.
- Wrangler 4.x: `wrangler pages deploy` reads `wrangler.toml` bindings; `pages project create` is a separate command.
