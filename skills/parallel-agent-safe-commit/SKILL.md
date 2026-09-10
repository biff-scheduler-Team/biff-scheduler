---
name: parallel-agent-safe-commit
description: Use when several agents/sessions (or the user) are editing the SAME git working tree concurrently, and you must commit only YOUR change without sweeping in someone else's uncommitted work — especially when the other party's edits sit in the same file, on adjacent lines or in the same diff hunk, or when their half-finished code makes `tsc`/build fail so the normal commit-and-deploy path is unusable. Covers (a) waiting for the other party to finish via an mtime-idle watchdog rather than "git status is clean", (b) staging only your hunks via git blob surgery (`git show` + `git hash-object -w` + `git update-index --cacheinfo`), (c) deploying only your commit from an isolated `git worktree` so the build does not pick up the other party's on-disk WIP, and (d) verifying that the live site actually carries your change.
description_zh: 多会话并行时安全提交
description_en: Safe commit with parallel agents
disable: false
agent_created: true
---

# parallel-agent-safe-commit

## When to use

Trigger this skill when **all** of these hold:

- You are working in a git repo where another agent, session, tool, or the user has **uncommitted** changes in the same working tree (`git status --porcelain` shows ` M` entries you did not make).
- `git add <file>` would therefore stage **their** work along with yours. This is worst when their edit and yours are on adjacent lines (e.g. `index.html:50` vs `:51`) — git cannot split them into separate hunks, so `git add -p` is useless.
- You still need to land your change in history now (project convention requires commit + push, maybe + deploy).

Also trigger the deploy half of this skill when `npm run deploy` (or any build-then-upload pipeline) reads **the working tree**, so the other party's WIP would ship to production, or when their in-flight code makes the typecheck/build fail and deploy is impossible anyway.

Do **not** use this skill when: the other party's changes are in files you don't touch (plain `git add <your files>` is fine), or when they are already committed (`git status` clean for your files).

## Steps

### 0. Recon — know exactly what is in flight

```bash
date '+%H:%M:%S'
git log --oneline -3
git status --porcelain
stat -f '%Sm %N' -t '%H:%M:%S' <your files> <their files>   # macOS; Linux: stat -c '%y %n'
```

Record `HEAD` before you start. If HEAD moves or files keep getting written every few seconds, the other party is still actively working — the blob surgery below is still safe, but do it in one short command chain so you don't fight over `.git/index.lock`.

**Also read the other party's plan, if the repo has a plan convention.** In repos where each task drops a
`docs/plans/PLAN-<timestamp>.md`, `ls -t docs/plans/ | head` hands you an *enumeration of the files the other
session intends to touch* — often before they have touched them. This is the cheapest way to predict overlap.
Real case: my plan asserted "zero file overlap with the parallel session" and was wrong within minutes — the
other session's plan named `src/data.ts`, `src/types.ts`, `src/legend.ts`, `src/main.ts`, four files I was
editing, and their hunks landed on **adjacent lines inside the same hunk**, so `git add -p` could never have
split them. A plan-vs-plan diff up front would have flagged that immediately.

### 0b. Waiting for the other party to finish (when you are told to go last)

When the instruction is "wait until they're done, then do yours", you need a **termination signal**. Do **not** use `git status --porcelain` being empty — the other party often leaves a long-lived **untracked** artifact (a new offline tool/pipeline script, a scratch file) that never gets committed, so "clean" never happens and you wait forever.

Use an **mtime-idle watchdog** instead: the real signal is "nobody has written any source file for N seconds". Run it in the background and let it notify you.

```bash
cat > /tmp/watch_parallel.sh <<'EOF'
#!/bin/bash
cd <repo> || exit 1
QUIET_NEED=150; STEP=15
files=$( { git ls-files src index.html functions migrations tools public docs/plans 2>/dev/null; \
           echo tools/extract_schedule.py; } | sort -u )   # tracked sources + known untracked ones
while true; do
  now=$(date +%s); latest=0
  for f in $files; do
    [ -f "$f" ] || continue
    m=$(stat -f '%m' "$f" 2>/dev/null) || continue      # Linux: stat -c '%Y'
    [ "$m" -gt "$latest" ] && latest=$m
  done
  idle=$((now - latest))
  printf '[%s] head=%s idle=%ss\n' "$(date '+%H:%M:%S')" "$(git log --oneline -1 | cut -c1-8)" "$idle"
  if [ "$idle" -ge "$QUIET_NEED" ]; then
    echo "=== other party idle ==="; git log --oneline -5; git status --porcelain; exit 0
  fi
  sleep "$STEP"
done
EOF
chmod +x /tmp/watch_parallel.sh && /tmp/watch_parallel.sh   # run_in_background: true
```

Then cross-check before acting: `date` + `stat -f '%Sm %N' -t '%H:%M:%S' <their files>` must show them older than your threshold, and `git log --oneline -1` must still be the HEAD you saw.

### 1. Make your edits in the working tree as usual

Edit the real files. Their changes stay untouched — never `git checkout -- <file>`, `git stash`, or `git restore` a file the other party is editing; you would destroy their work.

**Serialize edits to the same file.** Never send two `Edit` calls for the *same* file in one message: each call reads the file, applies its change, and writes the **whole file** back — so the later write silently reverts the earlier one, and *both* calls report success. Lost edits look exactly like "I already fixed that", which is the worst possible failure mode in a shared tree (you then commit a half-change and blame the other party's WIP). One file → one edit per message → re-read before the next. Always finish with a `typecheck`/`build`; do not trust the Edit success receipt.

Also note: in some sandboxes the Bash `grep`/`rg` is blocked and returns **empty output with exit 0** — indistinguishable from "no match". Use the dedicated `Grep` tool for all searching, including auditing `git diff` output.

**A second, nastier grep trap: `\|` alternation in BSD/macOS `grep` silently matches nothing.** `grep -c "venueShort\|short"` on a file that *does* contain `venueShort` printed `0` and exited 1 — no error, no warning. Because the audit grep in step 2 relies on "0 hits = clean", this failure mode reports **clean** for a dirty index. Rules: (a) use the `Grep` tool (ripgrep) for every assertion that gates a commit; (b) if you must use shell grep with alternatives, use `grep -E "a|b"` or `grep -e a -e b`; (c) whenever a negative result would let you proceed, add a **positive control** — grep for a marker you *know* is present and confirm it is found (in the incident above, `midnight_members` — committed, therefore certainly present — also returned 0, which is what exposed the bug).

### 2. Rebuild "baseline + only my changes"

First split your touched files in two — surgery is the exception, not the default:

- **pure-yours** (the whole `git diff <file>` is yours): plain `git add <file>` is safe; just prove it with `git diff --cached` (step 3).
- **mixed** (their hunks interleave with yours, even on adjacent lines): blob surgery below.

For a mixed file, take the **committed baseline**, re-apply just your edits to it, and diff it against the working tree. The diff must show **exactly the other party's changes** and nothing else — that proves the split is clean.

**Pick the direction with fewer edits — reverse surgery is usually cheaper and safer.** The forward path (baseline + *my* edits) requires you to re-transcribe every line you wrote, and a transcription slip in a `new` string is exactly how the "ate the next line" bug above happens. When the other party's footprint in a shared file is small (a couple of localized blocks), go the other way: start from the **working tree** file and *revert their* hunks back to the baseline text, yielding `baseline + mine` directly. Verified case: a file with 12 of my edits and 2 of theirs — reverse surgery needed 2 revert points instead of 12 replay points, and every revert could be **anchored on text lifted programmatically out of `git show HEAD:<path>`** (never hand-typed, so no CJK/whitespace transcription risk). Derive the replacement text from the baseline by locating a unique nearby line, e.g. `head_line_containing("src/grid.ts", "const vname = venue ? venue.name")`, and assert the anchors around each revert (`assert lines[i-2].strip().startswith("// 行标签走短名")`) so a moved baseline fails loudly instead of silently deleting the wrong block. Both directions are audited identically by the step-2 invariant — only the *construction* differs.

```bash
python3 scripts/stage_file.py --ref HEAD --dry-run --edits /tmp/my-edits.json <path>
```

`/tmp/my-edits.json` is a list of literal string replacements (order matters, each `old` must match exactly once):

```json
[
  {"old": "addRow(tbody, [\"GV\", \"Guest Visit ...\"]);", "new": "addRow(tbody, [badgeEl(\"gv\"), \"Guest Visit ...\"]);"},
  {"old": "const lines: [string, string][] = [", "new": "// note\nconst gvKey = el(\"span\", \"x\");\nconst lines: [string | HTMLElement, string][] = ["}
]
```

If a replacement misses, the baseline moved (someone committed the file) — re-read the file and regenerate the edits. Do not force it.

**Build the `old` string from the baseline by exact anchoring, not by naive line ranges.** Reading a block as "anchor line .. the line where depth returns to 0" is the reliable way; slicing `start..start+N` silently swallows the line *after* the block (e.g. the following `titles.appendChild(...);`) and then your replacement deletes it. Symptom: the dry-run diff shows a `+` line that is really *your* accidental deletion, not the other party's work.

**Always audit the dry-run diff for your own markers.** Pick a distinctive string you added and grep the diff output for it: every hit must be a **context** line (leading spaces), never a `-`/`+` line. Example that passed:

```bash
grep -nE "^\s+[-+].*(<my marker strings>)" /tmp/dryrun.txt   # must print nothing
```

If anything of yours shows up as `-`/`+`, your edit spec is wrong — fix it and re-run before touching the index.

**Then run the stronger invariant — it catches a bug the marker grep cannot.** Marker grepping only proves your
*added* lines survived. It says nothing about lines you **accidentally deleted**: if your `new` string forgot to
re-emit a line that `old` swallowed, that deletion contains no marker and the grep stays silent. Assert instead:

> **every `-` line in `diff(staged-copy, working-tree)` must exist in the baseline ref.**

A `-` line absent from the baseline is, by definition, a line *you* added that your own replacement deleted.
Real case: an insertion whose `old` was `openModal("设置", body);\n}\n\nfunction clampNum(...)` and whose `new`
started straight at the new function — it silently ate the `openModal(...)` call **and** the closing `}` of the
previous function. Marker grep: 0 hits, looked perfect. `tsc`: `error TS1005: '}' expected`. One-line check:

```bash
# for each staged copy: every '-' line must be present in the baseline version
python3 - <<'PY'
import subprocess
for p in ["src/main.ts", "src/grid.ts"]:                 # your mixed files
    base = set(subprocess.run(["git","show",f"HEAD:{p}"],capture_output=True,text=True).stdout.splitlines())
    d = subprocess.run(["diff","-u",f"/tmp/stage_{p.split('/')[-1]}",p],capture_output=True,text=True).stdout
    for l in d.splitlines():
        if l[:1]=="-" and not l.startswith("---") and l[1:] not in base:
            print(f"!! {p}: edit deleted a line that is not in HEAD -> {l[1:][:120]}")
PY
```

**Pair it with the complementary *orphan* check — the `-`-line rule only polices deletions.** Add the reverse
invariant, asserted on the **staged copy itself**:

> **every non-blank line of the staged copy must appear in either the baseline ref or one of your `new` strings.**

An orphan is a line that came from neither — so the spec or the staging script did something you never described.
Verified use (5 replacements into `src/main.ts`): build `newblob = "\n".join(e["new"] for e in edits)`, then
`orphan = [l for l in staged.splitlines() if l not in head_lines and l not in new_lines and l.strip()]` and assert
`len(orphan) == 0`. It is stronger than the `-`-line rule in one respect: a `new` string can be *multi-line*, and
the `-`-line rule says nothing about lines such a block contributes.

**Assert the marker pair in both directions — it is one line of output that states the whole split.** Choose
strings only *you* added and strings only *they* added; the first must be **present** in the staged copy, the second
must be **absent** from it (both present in the working tree). Verified set: mine `openPriorityPicker` /
`pickScreening` → `staged=True`; theirs `labelMetrics` / `from "./ai"` / `readout` / `1:1` → `staged=False,
wt=True`. Run orphan + marker-pair + `-`-line together in one probe — three independent witnesses that the split is
clean, for the cost of one script.

Corollary for writing the specs: **`new` must re-emit every line of `old`** — only add or rewrite, never drop a
line you did not intend to touch. Anchor `old` on a *bounded* run of whole lines and reproduce them verbatim.

### 2b. The reverse case — you are REVERTING your own earlier commit

When the task is "undo what I landed earlier" (`git revert`-like, but the file is shared), the construction is
different and much cheaper. Verified on a 6-file revert (`d536668` undoing `58d8af9` + `e19bc93`):

**Try `git apply -R <your forward diff>` across ALL files first; hand-fix only the failures.**

```bash
git diff <mycommit>^ <mycommit> -- src/ > /tmp/fwd.patch
git apply -R --check --verbose /tmp/fwd.patch        # see which files fail
git apply -R --exclude=src/main.ts /tmp/fwd.patch    # apply the clean majority
```

- `git apply -R` reproduces the exact inverse, so the per-file line counts must come out **symmetric** to the
  forward diff — assert that (`+34/-7` forward ⇒ `7 insertions, 34 deletions` staged). It is a free correctness
  proof you do not get from hand-written specs.
- Files fail only where the other party edited your *context* lines (here: they added an import 2 lines above
  mine). That is typically 1 file out of 6 — hand-write specs for that one only. Do **not** hand-write all of
  them "to be safe"; you trade a machine-exact inverse for 6 chances at a transcription slip.

**⚠️ Blob surgery on a mixed file: revert the WORKING TREE too, not just the index.** When you are *adding*
changes the skill's model is "index = baseline + mine, worktree = theirs + mine", and the difference is exactly
their hunk. When you are *removing* your own lines, if you only rewrite the index the worktree still contains
the lines you just deleted from HEAD — so the other party's next `git add <file>` **re-adds your reverted
lines** (their bare commit then resurrects what you removed). Fix: apply the same replacement to the
working-tree file as well. The acceptance test is unchanged and still decisive —
`diff(staged-copy, working-tree)` must show **only the other party's hunk**; if your own deleted block shows up
as `+` lines, you forgot the worktree half.

**⚠️ Choose audit markers that are unique to YOUR change, not words the reverted-back original also uses.**
Reverting restores the original comments, so a marker like `未设档位` (which the *pre-change* text legitimately
said) reported FAIL on 3 files — pure false positive, and a wasted debugging round. Pick literals that exist
**only** in the change being removed (a function name you invented, a phrase you coined). Pair it with the
positive control described in §1.

**For a pure revert, byte-identity beats a headless interaction test.** After committing, assert

```bash
for f in <files you reverted>; do git diff <mycommit>^ HEAD -- "$f" | wc -l; done   # expect 0
```

`0` means the file is now *identical to the pre-change state*, so behaviour is provably equivalent — stronger
than any scripted click-through, and it needs no local server. For the files you *cannot* get to zero (the other
party's committed edits are in the way), assert instead that `git diff <mycommit>^ HEAD -- <file>` contains
**none of your markers**. Keep this as the acceptance criterion for the revert class of task.

### 3. Stage exactly those blobs, then commit

```bash
python3 scripts/stage_file.py --ref HEAD --edits /tmp/my-edits.json <path>   # hashes + update-index
git add <your new files, e.g. docs/plans/PLAN-*.md>
git diff --cached --stat        # ONLY your files/hunks
git status --porcelain          # your files should read "MM" (mine staged, theirs in worktree)
git commit -m "..."             # no -a!
git push
```

**Do not skip this: un-stage anything the other party had already staged.** Blob surgery only rewrites the
paths *you* list. Every file they `git add`ed that you do not touch stays staged and **rides into your commit**
— `git diff --cached --stat` will show their files alongside yours. Undo just those, non-destructively:

```bash
git restore --staged <their file> <their plan doc>   # index -> HEAD; their content stays in the worktree
git diff --cached --stat                             # re-assert: ONLY your files now
```

`git restore --staged` is safe here because their work is also on disk (`MM`/`A ` files) or is an untracked new
file that simply returns to `??`. Never reach for `git checkout --`/`git stash` — those *do* destroy their work.

**Bonus: this also defuses a nastier variant.** If you leave their staged blob in place and they later run a bare
`git commit` (no re-`add`), the index is still *their* pre-surgery blob — so their commit silently **reverts your
change** in every file you share. Un-staging means that after your commit the index equals HEAD for your paths, so
their bare `git commit` is a harmless no-op and they must re-`add` (picking up your committed version) to proceed.

Use `git commit` **without `-a`** and without pathspecs — the index is already exactly right.

### 3b. If HEAD moved under you, discard the index and re-base

A parallel session finishing and committing *while you are doing surgery* is the norm, not the exception. Two
things break at once, and both are silent:

1. **Your surgery baseline is stale.** The script above reads `HEAD:<path>` at run time — if you built the index
   *before* their commit, every mixed file's staged blob is `oldHEAD + mine`, i.e. it is **missing their commit's
   changes to that file**. Committing it **reverts their work**. Verified case: the third session committed
   `ce9cca5` (midnight-block parser), which touched `src/types.ts`; my index predated it, so committing would have
   deleted their 7-line `midnight_members` field.
2. **Their commit may have swept in your edits** (see the pitfall below) — so you may owe *less* than you think.

Recon and re-base:

```bash
git log --oneline -3                        # did HEAD move?
git show --stat --oneline <newHEAD>         # which files did they touch?
# for every file you BOTH touch, ask: is my marker already in their commit?
git show <newHEAD>:src/types.ts | grep -n 'gvTalkMin'      # in sandboxes use the Grep tool, not grep
```

Then rebuild from scratch — **`git reset` is the safe primitive here** (mixed is the default: it rewrites the
index only, the working tree is untouched, so the other party's work survives):

```bash
cp .git/index /tmp/index.<slug>-pre-rebase   # keep the old one for forensics
git reset -q                                 # index := HEAD (working tree untouched)
<re-run your dynamic-baseline staging script> # it now anchors on the NEW HEAD
git add <your pure files> <your new plan doc>
git diff --cached --stat                     # assert ONLY your files, and the per-file counts you expect
```

Because the script reads `HEAD:<path>` dynamically, re-running is enough — but **check that every replacement still
matches exactly once**. That is itself a useful signal: if their commit landed *outside* your anchors, all
replacements still hit once and the re-base is purely mechanical. If one misses, they edited your lines — read the
file and regenerate that edit.

**Assert per-file staged line counts against your own expectation — that is how you catch a contaminated index.**
After re-basing, `src/types.ts` was `+3 −0` (exactly my 3 added lines). The index I had been *about to commit*
showed `+14`; the extra 10 lines were **another session's `short?: string` doc block sitting inside my own file's
staged blob**. A second reading of that same index showed a 19-file `--stat` including a `−125` deletion of a file I
never touched. Conclusion: **in a multi-session tree the index is not trustworthy state** — never commit it as
found; rebuild it from the current HEAD every time, and treat "this file's diff is bigger than what I wrote" as a
hard stop rather than a formatting curiosity.

### 3c. After YOUR commit lands, repair the shared index — or their next commit reverts you

This is the mirror image of 3b, and it is the one that actually bit. 3b is "HEAD moved while I was staging".
This is "I committed and pushed while *they* were holding a staged index built from the **old** HEAD".

The moment you push, their index entries for your files still point at **the old HEAD's blob**. Git does not
care that the file changed on disk or that HEAD moved — an index entry is just `(path, blob, mode)`.

**Symptom — check `git status --porcelain` immediately after your commit, before anything else:**

```
 M src/library.ts          <- theirs, unstaged, fine
MM src/types.ts            <- theirs is staged, but the staged blob is MY FILE AS OF THE OLD HEAD
D  docs/plans/PLAN-<mine>.md   <- the plan file I just added reads as DELETED
```

`D` on a file you just created is the tell. `MM` on a file you just committed is the second tell.

**Consequence if you walk away:** their next commit silently **reverts your changes** to every `MM` file and
**deletes** every `D` file you added. Worse, it is self-consistent for them — the tree still compiles if they
didn't touch your consumers. If they *did* (my `src/modal.ts` reads `midnight_members`, which lives in
`src/types.ts`), their commit breaks the build and they have no idea why. **Your push is not finished until
this is repaired.**

**Repair — forward only the entries they did not touch. Never blanket-`git reset` here** (`git reset` would
throw away *their* staged work, which is the opposite of the goal):

```python
# /tmp/fix_index.py <oldHEAD> <newHEAD>
import subprocess, sys
OLD, NEW = sys.argv[1], sys.argv[2]
def sh(*a): return subprocess.run(a, capture_output=True, text=True).stdout
def blobs(rev):
    return {l.split("\t", 1)[1]: l.split()[2]
            for l in sh("git", "ls-tree", "-r", rev).splitlines() if l.strip()}
old, new, cur = blobs(OLD), blobs(NEW), {}
for line in sh("git", "ls-files", "-s").splitlines():
    meta, path = line.split("\t", 1)
    cur[path] = meta.split()[1]
for path, b in cur.items():
    # staged blob still equals OLD HEAD's blob => they never staged this path => safe to forward
    if old.get(path) == b and path in new and new[path] != b:
        sh("git", "update-index", "--cacheinfo", f"100644,{new[path]},{path}")
        print("set", path)
for path, b in new.items():
    if path not in cur:
        sh("git", "update-index", "--add", "--cacheinfo", f"100644,{b},{path}")
        print("add", path)
```

Two things this teaches:

- **The guard is `staged blob == old HEAD's blob`**, i.e. "this path is pristine as of the commit I just made".
  That is what distinguishes "untouched, safe to forward" from "they have real staged work here, hands off".
- **`update-index --cacheinfo` refuses new paths** — you get `cannot add to the index - missing --add option?`.
  New-in-my-commit files need the separate `--add` branch. (Expect the script to exit 1 on this and finish the
  rest; just handle the remainder explicitly.)

**Second half: files you BOTH touched.** Their entry now predates your field, so it is *missing your delta* —
committing it would delete your addition from HEAD. Here the fix is the opposite of 3c's guard: `git add <file>`
(their working tree is `newHEAD + theirs`, so this **re-bases their staged delta onto your commit**). Then assert:

```bash
git diff --cached                    # must show ONLY their additions
git diff --cached | grep '^[-+].*<my marker>'   # must be EMPTY
```

Generalised rule: **in a multi-session tree, your push is not done when `git push` returns — it is done when
`git status --porcelain` no longer shows your own files.** Bake that check into step 5.

### 4. Deploy only your commit (when the build reads the working tree)

`npm run deploy` = build from disk + upload, so it would ship their WIP. Build your commit in isolation instead:

```bash
git worktree add --detach /tmp/deploy-<slug> <your-commit>
ln -sfn "$PWD/node_modules" /tmp/deploy-<slug>/node_modules
(cd /tmp/deploy-<slug> && npm run deploy)
rm -f /tmp/deploy-<slug>/node_modules
git worktree remove --force /tmp/deploy-<slug>
git worktree list     # confirm the temp tree is gone
```

`git worktree add` writes only under `.git/worktrees/` — the other party's worktree is untouched.

**Two verified gotchas with the temp worktree:**

- **macOS `/tmp` is a symlink to `/private/tmp`.** `git worktree remove --force /tmp/deploy-x` fails with
  `fatal: '/tmp/deploy-x' is not a working tree` even though you created it at that exact path. Copy the path
  verbatim from `git worktree list` (it will read `/private/tmp/deploy-x`) and remove *that*.
- **In a sandboxed agent harness, `git worktree add` can be silently rolled back.** The command reports success
  and the subsequent `cd` + build genuinely run inside the new tree — but when the Bash call returns, both the
  worktree directory and the `.git/worktrees/<name>` metadata are gone. Symptom: a later `git worktree list`
  shows only the main worktree and `ls` says the directory never existed, so you cannot tell whether your
  verification actually happened. Fix: run worktree creation **and** the deploy in one `dangerouslyDisableSandbox`
  call (wrangler needs the sandbox off anyway), and background the deploy. If you only needed the worktree for a
  *read-only* check (typecheck / build), staying sandboxed is fine — just don't be surprised when it vanishes.

**Verify the staged snapshot compiles before committing.** Blob surgery produces a tree that no one has ever
built: `HEAD + your edits`, *without* the other party's half-finished work. That combination can fail typecheck
even though the working tree (which has both) is green, and you would only find out at deploy time — after the
commit is already public.

```bash
TREE=$(git write-tree)                     # writes the current index as a tree object
# ⚠ worktree add needs a COMMIT, not a tree: passing "$TREE" dies with
#   `error: object <sha> is a tree, not a commit` / `fatal: invalid reference` (exit 128).
#   Wrap the tree in a throwaway commit first (unsigned is fine — it is never pushed):
TMP=$(git commit-tree "$TREE" -p HEAD -m "tmp: verify staged snapshot")
git worktree add --detach /private/tmp/verify-stage "$TMP"
ln -sfn "$PWD/node_modules" /private/tmp/verify-stage/node_modules
(cd /private/tmp/verify-stage && npm run typecheck)
# also assert their work is absent: grep -rn '<their marker>' src/
rm -f /private/tmp/verify-stage/node_modules && git worktree remove --force /private/tmp/verify-stage
```

Then commit and push; deploy separately from a worktree at the new commit (step 4).

**Run the deploy in the background.** Build+upload easily exceeds a couple of minutes (wrangler alone ~1 min); a long foreground command in an agent harness can be killed (SIGTERM / exit 137) *even with the sandbox disabled*, which looks like a deploy failure but is just the harness reaping it. Redirect to a log file and poll the task instead:

```bash
(cd /tmp/deploy-<slug> && npm run deploy) > /tmp/deploy-<slug>.log 2>&1   # run_in_background: true
tail -14 /tmp/deploy-<slug>.log      # ends with "Deployment complete! Take a peek over at https://<hash>.<project>.pages.dev"
```

Note the temp worktree builds from **your commit only**, so its asset hashes will legitimately differ from the ones your local `dist/` produced while their WIP was still on disk. Do not treat that as "the build didn't pick up my change" — assert on your marker classes/strings inside the fetched artifact instead.

### 5. Verify the live result, then check whether you still need to deploy at all

```bash
curl -sL -o /tmp/live.html -w 'http=%{http_code} bytes=%{size_download}\n' <production-url>
```

Assert on the fetched HTML/JS/CSS: your marker string gone / present as expected. If the other party commits after you and their own deploy already includes your commit (it is an ancestor), **do not deploy again** — just confirm the live artifact.

Two assertions that are cheap and worth always making:

- **Match the served asset hash to the build log.** The build prints `dist/assets/index-<hash>.js`; the served `index.html` must reference the *same* hash. That single check proves the live bundle is your build and not a stale edge cache — stronger than any content grep, because their deploy would carry a different hash.
- **Grep the minified bundle, not just the source.** A class you added as a string literal in a `.ts` file can be dropped by the CSS build (Tailwind only emits complete literals it can see). Fetch the built CSS and assert the rule exists, e.g. `.bg-ev-teal{background-color:var(--color-ev-teal)}`.

And the closing check for 3c — **your push is not finished until this is clean**:

```bash
git status --porcelain        # none of MY files may appear here, and no 'D' on files I just added
```

## Pitfalls

- `git add <file>` / `git add -A` is the whole trap. It stages their half-finished code, which then ships on your deploy.
- `git add -p` cannot help when their hunk is adjacent to yours — git merges adjacent changes into one hunk. Blob surgery is the only clean split.
- Never `git stash`, `git checkout -- <file>`, or `git restore` a file the other party is editing: it silently deletes their work from the tree.
- Do not "wait for quiet" forever. If their typecheck is red, deploy is impossible no matter how long you wait; isolated-worktree deploy unblocks you immediately.
- **Their WIP typechecking green does NOT make the working-tree deploy safe.** A half-finished feature often compiles fine (it is the *behaviour* that is incomplete), so `npm run deploy` from the shared tree would publish it. "Wait until they finish" is not a real option when you were asked to land your change now — go straight to the isolated worktree.
- A detached worktree without `node_modules` fails the build — symlink it (or `npm ci`) before deploying.
- Forgetting `git worktree remove` leaves stale trees in `git worktree list` and confuses later runs.
- `git update-index --cacheinfo` must run in the repo root and use `<mode>,<object>,<path>` (comma form on modern git).
- If HEAD moved between your recon and your commit, your baseline is stale — **do not just re-run step 2 in place**:
  `git reset` first and rebuild (§3b). Committing a pre-their-commit index silently **reverts their commit's changes
  to any file you share**.
- **`find ... -newermt '-90 seconds'` is not portable — and it fails *silently* in the worst way.** BSD `find`
  rejects relative offsets (`find: bad date -90 seconds`, exit 1) and prints **no files**, which is byte-identical to
  "nothing was written recently". A quiet-period check built on it can never fail, so it always "passes". Use
  `find <paths> -type f -mmin -N` (works on GNU and BSD) or compare `stat -f '%m'` epoch values yourself — and
  **always run a positive control** (point the same command at a file you *just* wrote; it must be listed) before
  you trust a negative result.
- Parallel `Edit` calls on one file clobber each other (silently, both reporting success) — see step 1. This bites hardest exactly here, because a lost edit is easy to mistake for the other party's WIP and then "commit only your hunk" ships the half-change.
- Before committing, re-read the file(s) you just edited and re-run `typecheck`. A green Edit receipt is not evidence the change is on disk.
- After the other party commits, their work moves into HEAD — so `git diff` for a file you both touched may collapse to **only your hunks** and plain `git add <file>` becomes safe. Re-check `git diff <file>` right before staging instead of assuming surgery is still needed.
- **The reverse also happens: their commit can sweep YOUR in-flight edits into it.** If they stage while your edits are already on disk (`git add <file>` / `git add -A`), your change rides along into *their* commit — verified case: they committed at 12:12 and the commit already contained the `filmModalCtx()` change made at 12:10. Symptom: `git status` shows a file you edited as **clean**, and `git diff HEAD -- <file>` shows only the tail of your work. Handle it by re-reconning before you commit — `git show HEAD:<file> | grep <your marker>` tells you whether your change is already in HEAD (then **do not re-commit it**; only commit what is still uncommitted) — and re-state your remaining scope in the commit message instead of blindly staging the file again.
- **Their commit may omit a companion file, leaving HEAD internally inconsistent.** Real case: `pick.ts` (committed) used `bg-pri-*-soft`, but the `--color-pri-*-soft` tokens lived only in the *uncommitted* `style.css` — so HEAD built CSS that silently dropped those classes (Tag rendered with no background). Since a shared tree's `npm run deploy` reads the working tree, this stays invisible until someone deploys from a clean snapshot. Before/after committing, compare `git show HEAD:<file>` against the working tree for the *paired* files, and when your own change lands in one of them, prefer committing the whole file (tokens + your change) over a hand-split hunk that leaves HEAD broken — then say explicitly in the commit message and the reply which foreign lines rode along.
- **Reviewing their merged work is part of your job here.** After they commit, re-assert that *your* earlier contributions survived the merge (grep for your helper/function names) — a big refactor by them can quietly inline or drop your abstractions. Also scan their new user-facing strings for markup that the renderer does not understand: in a `textContent` app, Markdown like `**bold**` ships literal asterisks. Audit by searching **string literals** (double-quote / single-quote / template patterns), never bare `**` — that drowns in `/**` JSDoc and `node_modules`.
- After a text-only change, the CSS artifact hash stays identical and only the JS hash changes (Tailwind's used-class set did not move). That is correct, not a failed build — assert on the JS hash and the marker strings, not on "all hashes changed".
- **Grepping the production bundle: assert on user-visible STRINGS, never on function names.** esbuild mangles local and cross-module identifiers, so `grep toggleScreening` on the served JS returns nothing even though the code is there — a false FAIL that looks like a failed deploy. Use UI text (`选择档位` / `取消(不加入)` / `回到未设`) and `title` strings. Equally, do not treat a hit as proof of your change: a generic phrase like `标为「` or `还没定档` may live in unrelated help/legend copy. Before concluding anything from a bundle grep, fetch the **previous** deployment's bundle (`https://<old-deploy-hash>.<project>.pages.dev/assets/...`) and confirm the string is present there — that is the positive control that separates "my change shipped" from "this string was always in the app".
- **The orphan invariant needs one correction for a REVERT.** In §2 it is "every non-blank line of the staged copy appears in the baseline or one of my `new` strings". When reverting, the working tree legitimately contains lines that are in *neither* `HEAD` nor the older ref — namely the other party's in-flight hunk. So assert set equality instead: `orphan_lines == {+ lines of git diff HEAD -- <file>} − {lines my revert restored from the older ref}`. Also skip the check for a file where you are deliberately leaving their WIP in the worktree, and run it as an explicit two-sided comparison rather than a "must be empty" test — "empty" is simply wrong there.
- **Signed commits: the signing agent is a second, independent failure point — and it can block you *after* all the
  surgery is done.** If `commit.gpgsign=true` with `gpg.format=ssh`, the commit needs the SSH agent, which in a
  sandboxed harness is unavailable: `git commit` dies with `failed to fill whole buffer` / `failed to write commit
  object`. Re-run it outside the sandbox with the agent socket exported (this repo's users keep the key in 1Password):
  `export SSH_AUTH_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"`. Distinguish the two
  states: **inside the sandbox** → `failed to fill whole buffer`; **outside, agent locked/unhealthy** →
  `agent refused operation`, or `ssh-keygen -Y sign` hanging until killed. Note `ssh-add -l` can succeed (a read)
  while signing (a write) hangs — do not read a working `ssh-add -l` as "the agent is fine". Probe with
  `echo x | SSH_AUTH_SOCK=... ssh-keygen -Y sign -n git -f <pubkey>` before blaming git.
- **`%G?` == `N` does NOT mean the repo's commits are unsigned.** Without `gpg.ssh.allowedSignersFile`, git cannot
  *verify* SSH signatures and reports `N` for perfectly good signed commits. Check the raw object instead —
  `git cat-file -p <sha> | head` showing a `gpgsig -----BEGIN SSH SIGNATURE-----` header proves it was signed, so
  the project convention is signed commits and bypassing signing (`--no-gpg-sign`) is not yours to decide.
- **Your own push is what turns the other party's index into a weapon — check `git status` the second it lands.**
  Their index was built from the HEAD that existed *before* your commit, so every path you just committed still
  carries your file's **old** blob. Symptom: `MM` on files you just committed, and `D` on files you just *added*
  (the new plan doc reads as deleted). Left alone, their next commit reverts your changes to the `MM` files and
  deletes the `D` files — silently, and while looking like a normal commit on their side. Repair with the
  blob-guarded forward in 3c (`staged blob == old HEAD's blob` ⇒ pristine ⇒ safe to forward); do **not**
  `git reset` the shared index, that destroys their staged work. This is the inverse of the "their commit swept my
  edits in" case: there, you owe less than you think; here, **they are about to owe you a revert**. Same discipline
  either way — after every commit in a shared tree, re-run the recon rather than assuming the tree is now yours.
- Staging is **cheap and idempotent** — make the surgery re-runnable. Keep the edit specs in a script that rebuilds
  `baseline + mine` from scratch (so a stray `git add` by the other party can be undone by re-running it), and save
  `cp .git/index /tmp/index.<slug>-backup` plus the `git write-tree` hash before committing. With three sessions
  live, the index can be disturbed at any moment and you do not want to redo the forensics.
- **When the shared file is a doc you are *replacing* text in (not pure-appending), assert the removal left no
  dangling references.** Lift `old` from `git show HEAD:<path>`, assert `c.count(old) == 1`, then assert the
  *concept* you deleted is gone from the rest of the file — e.g. after rewriting a bullet that named a now-removed
  constant, `assert "LABEL_W" not in c.replace(old, "")`. A doc that still names something you deleted is worse
  than no doc. Verified case: the zoom block had four sub-bullets, three referencing a constant the same commit
  deleted; blindly *appending* a new bullet would have left the file self-contradictory, so the stale one had to be
  replaced. Do not fall back to append-only just because the file is shared.
- **State the split as a *countable* invariant: `diff(staged-copy, working-tree)` must be exactly the other
  party's hunk.** Not merely "contains their changes" — `diff -u` it and assert the `+`/`-` line count equals what
  they wrote (verified: 10 lines = their one bullet). Together with "every `-` line exists in HEAD" and the marker
  pair, that is three independent witnesses for the cost of one script. This invariant also *is* the acceptance
  criterion for the worktree copy: because the worktree holds `theirs + mine` while the index holds
  `baseline + mine`, their next bare `git add <file>` yields a diff of only their hunk — so they cannot silently
  revert your addition to the shared file. (The tempting alternative — writing only the index and leaving the
  worktree untouched — produces a reverse diff that deletes your lines on their next commit.)

## Verification

1. `git diff --cached --stat` lists only files/hunks you authored.
2. `git diff /tmp/stage_<file> <working-tree file>` shows **only** the other party's changes — and a grep for your own markers across that diff returns **no `-`/`+` lines** (context lines are fine).
3. `git status --porcelain` still shows their files as modified (their work survived) and yours as `MM`.
4. `git log --oneline -3` contains your commit; `git push` reported the expected `old..new main -> main`.
5. The fetched production page/asset contains your marker (and the temp worktree is gone from `git worktree list`).
6. Every staged file's `--stat` count matches what you actually wrote — a file showing **more** lines than you wrote
   means the index is contaminated with someone else's hunks (→ §3b). After committing, `git diff <parent> HEAD
   --stat` must list only your files, with `+N −0` on files where you only added lines.
