#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_changelog.py — 对比两版 schedule.json → apps/web/public/changelog.json

为什么需要它
------------
排期会持续变(册子并入 / 官网加场 / 改时间)。对**已经选好片**的用户,这些变化是隐形的 ——
行程里那场可能悄悄改了片长,而新增的场次里可能正好有他早就选过的影片。
前端只持有一版数据,**算不出「上一版长什么样」**,所以差异必须在构建期算好、产物化。

对比什么(逐条都有理由)
----------------------
* **只记用户可见且影响行程的字段**:`date` / `start_time` / `end_time` / `duration_min` /
  `venue_display` / `is_gv` / `rating` / `subs` / `tags`。
* **不记 `venue_id`**:2026-09-14 那次 `br`→`bt` 是**内部 id 改名**,`venue_display` 一字未动 ——
  记进去就是 10 条用户根本看不见的噪声。
* **不记 `page` / `title_kr`**:那是「信息补全」不是「排期变了」;本轮 725 + 35 条会把真正的 9 条淹没。

用法
----
    # 对比「上一个已发布版本」(= git HEAD 里的那份)与工作区当前版本
    python tools/build_changelog.py

    # 显式指定基线
    python tools/build_changelog.py --base /tmp/schedule.old.json

自检:`added` / `changed` 条数打到 stderr;两版都为 0 条时不写文件(避免「空更新」也让用户看到提示)。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

# 参与差异判定的字段 → 中文标签(顺序 = 弹层里的展示顺序)
TRACKED_FIELDS: list[tuple[str, str]] = [
    ("date", "日期"),
    ("start_time", "开始"),
    ("end_time", "结束"),
    ("duration_min", "片长"),
    ("venue_display", "场馆"),
    ("is_gv", "映后谈"),
    ("rating", "等级"),
    ("subs", "字幕"),
    ("tags", "场次标记"),
]

# `added` 里保留的字段(够弹层展示与「加入行程」用,不搬整条 screening)
ADDED_FIELDS = (
    "code", "title_en", "title_zh", "title_kr", "date", "start_time", "end_time",
    "duration_min", "venue_id", "venue_display", "is_gv", "tags", "rating", "subs",
)


def log(kind: str, msg: str) -> None:
    """统一日志出口(stderr)。"""
    print(f"[{kind}] {msg}", file=sys.stderr)


def fmt(value: Any) -> str:
    """字段值 → 可读文本(布尔 / 列表各按前端口径折成短串)。"""
    if value is None or value == "":
        return "—"
    if isinstance(value, bool):
        return "有" if value else "无"
    if isinstance(value, list):
        return "/".join(str(v) for v in value) if value else "—"
    return str(value)


def load_schedule(spec: str) -> dict:
    """`git:<rev>:<path>` / `git:HEAD` / 文件路径 → schedule.json 内容。"""
    if spec.startswith("git:"):
        rev_path = spec[4:]
        rev, _, path = rev_path.partition(":")
        path = path or "apps/web/public/schedule.json"
        out = subprocess.run(
            ["git", "show", f"{rev}:{path}"],
            capture_output=True, text=True, check=False,
        )
        if out.returncode != 0:
            raise SystemExit(f"git show {rev}:{path} 失败:{out.stderr.strip()}")
        return json.loads(out.stdout)
    return json.loads(Path(spec).read_text(encoding="utf-8"))


def diff(base: list[dict], new: list[dict]) -> tuple[list[dict], list[dict]]:
    """返回 (added, changed)。`changed` 只含 tracked 字段真的不同的场次。"""
    old_by_code = {s["code"]: s for s in base}
    added: list[dict] = []
    changed: list[dict] = []
    for s in new:
        prev = old_by_code.get(s["code"])
        if prev is None:
            added.append({k: s.get(k) for k in ADDED_FIELDS})
            continue
        fields = [
            {"key": key, "label": label, "from": fmt(prev.get(key)), "to": fmt(s.get(key))}
            for key, label in TRACKED_FIELDS
            if prev.get(key) != s.get(key)
        ]
        if fields:
            changed.append({
                "code": s["code"],
                "title_en": s.get("title_en", ""),
                "title_zh": s.get("title_zh", ""),
                "date": s.get("date", ""),
                "venue_display": s.get("venue_display", ""),
                "fields": fields,
            })
    return added, changed


def main() -> int:
    """CLI 入口。"""
    ap = argparse.ArgumentParser(description="两版 schedule.json → changelog.json")
    ap.add_argument("--base", default="git:HEAD",
                    help="基线:`git:<rev>[:<path>]`(默认 `git:HEAD`)或文件路径")
    ap.add_argument("--new", default="apps/web/public/schedule.json")
    ap.add_argument("--out", default="apps/web/public/changelog.json")
    args = ap.parse_args()

    base_doc = load_schedule(args.base)
    new_doc = json.loads(Path(args.new).read_text(encoding="utf-8"))
    added, changed = diff(base_doc["screenings"], new_doc["screenings"])

    log("SANITY", f"新增场次 {len(added)} 条;影响行程的字段变化 {len(changed)} 条")
    for c in changed:
        log("SANITY", f"  {c['code']} {c['title_en'][:40]} → "
                      + "; ".join(f"{f['label']} {f['from']}→{f['to']}" for f in c["fields"]))

    if not added and not changed:
        log("INFO", "两版无差异 → 不写 changelog(避免让用户看到「空更新」)")
        return 0

    payload = {
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        # 版本号 = 排期自身的生成时间:前端拿它跟本地已确认版本比
        "schedule_generated_at": new_doc.get("festival", {}).get("generated_at", ""),
        "base_schedule_generated_at": base_doc.get("festival", {}).get("generated_at", ""),
        "added": added,
        "changed": changed,
    }
    Path(args.out).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    log("OK", f"写出 {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
