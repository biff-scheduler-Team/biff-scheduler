#!/usr/bin/env python3
"""Stage only YOUR edits in a file, leaving another agent's uncommitted work untouched.

Why: when a parallel agent/session is editing the same working tree — even the same file,
on adjacent lines — `git add <file>` would stage their half-finished code too, and
`git add -p` cannot split adjacent changes. This script rebuilds "baseline ref + my edits"
as a standalone blob and puts ONLY that blob into the index via `git update-index
--cacheinfo`, so the working tree file (with their edits) is never written to.

Usage
-----
  python3 stage_file.py --ref HEAD --dry-run --edits edits.json index.html
  python3 stage_file.py --ref HEAD --edits edits.json index.html src/legend.ts

edits.json = list of literal replacements, applied in order, each `old` must match
exactly once in the baseline version of EVERY listed file unless you use --per-file:

  [ {"old": "exact text", "new": "replacement"} ]

  --per-file form (recommended when paths differ):
  { "index.html":    [ {"old": "...", "new": "..."} ],
    "src/legend.ts": [ {"old": "...", "new": "..."} ] }

Options
-------
  --ref REF       baseline git ref (default: HEAD)
  --edits PATH    JSON file with the replacements (required)
  --dry-run       only write /tmp/stage_<name> and print the diff vs the working tree
  --outdir DIR    where staged copies go (default: /tmp)
  --quiet         suppress the diff preview

Exit codes
----------
  0  ok (staged, or dry-run previewed)
  2  a replacement did not match exactly once -> baseline moved, regenerate edits
  3  git command failed (not a repo / bad ref / index locked)
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys


def run(args: list[str], check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, check=check)


def git_show(ref: str, path: str) -> str:
    p = subprocess.run(["git", "show", f"{ref}:{path}"], capture_output=True, text=True)
    if p.returncode != 0:
        print(f"!! cannot read {ref}:{path}\n{p.stderr.strip()}", file=sys.stderr)
        sys.exit(3)
    return p.stdout


def apply_edits(text: str, edits: list[dict], path: str) -> str:
    for i, e in enumerate(edits):
        old, new = e["old"], e.get("new", "")
        n = text.count(old)
        if n != 1:
            print(
                f"!! {path}: edit #{i} matched {n} times (need exactly 1)\n"
                f"   old = {old[:120]!r}",
                file=sys.stderr,
            )
            sys.exit(2)
        text = text.replace(old, new, 1)
    return text


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--ref", default="HEAD")
    ap.add_argument("--edits", required=True)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--outdir", default="/tmp")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()

    raw = json.load(open(a.edits, encoding="utf-8"))
    per_file = isinstance(raw, dict)

    staged: list[tuple[str, str]] = []
    for path in a.paths:
        edits = raw.get(path) if per_file else raw
        if not edits:
            print(f"!! no edits given for {path}", file=sys.stderr)
            return 2
        base = git_show(a.ref, path)
        mine = apply_edits(base, edits, path)

        out = os.path.join(a.outdir, "stage_" + os.path.basename(path))
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(mine)

        print(f"== {path}")
        print(f"   staged copy : {out}")
        print(f"   bytes       : {len(mine)} (baseline {len(base)})")

        if not a.quiet:
            # show what remains in the working tree that is NOT ours == the other party's edits
            p = subprocess.run(["diff", "-u", out, path], capture_output=True, text=True)
            if p.stdout:
                print("   --- diff(staged-copy -> working tree): should be ONLY the other party's edits ---")
                for line in p.stdout.splitlines()[:80]:
                    print("   " + line)
            else:
                print("   --- working tree == staged copy (no other party edits in this file) ---")

        staged.append((path, out))

    if a.dry_run:
        print("\n(dry run — index untouched)")
        return 0

    for path, out in staged:
        blob = run(["git", "hash-object", "-w", out]).stdout.strip()
        run(["git", "update-index", "--cacheinfo", f"100644,{blob},{path}"])
        print(f"staged {path}  blob={blob[:12]}")

    print("\nNow: git add <your new files>; git diff --cached --stat; git commit -m '...'  (no -a!)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
