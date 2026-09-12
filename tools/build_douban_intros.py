#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_douban_intros.py — 为已映射影片拉取豆瓣详情里的 `intro`(简介)。

产出 `public/douban-intros.json`,给资料弹层用。键 = subject_id。
顺手把详情里的评分写回映射表**不在本脚本范围**(映射已有 rating 列)。

用法
----
    python tools/build_douban_intros.py
    python tools/build_douban_intros.py --limit 5 --dry-run
    python tools/build_douban_intros.py --delay 3
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

from douban_match import DoubanUnavailableError, fetch_movie_detail  # noqa: E402
from frodo_client import FrodoClient  # noqa: E402


def unique_subject_ids(mappings: dict[str, Any]) -> list[str]:
    seen: dict[str, None] = {}
    for entry in mappings.values():
        if not isinstance(entry, dict):
            continue
        sid = str(entry.get("subject_id") or "")
        if sid.isdigit():
            seen.setdefault(sid, None)
    return list(seen)


def compact_intro(detail: dict[str, Any]) -> Optional[str]:
    text = str(detail.get("intro") or "").strip()
    return text or None


def load_mappings(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    mappings = payload.get("mappings")
    return mappings if isinstance(mappings, dict) else {}


def load_existing(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    intros = payload.get("intros")
    if not isinstance(intros, dict):
        return {}
    out: dict[str, str] = {}
    for key, value in intros.items():
        text = str(value or "").strip()
        if text:
            out[str(key)] = text
    return out


def write_payload(path: Path, intros: dict[str, str]) -> None:
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": (
            "GET /api/v2/movie/{id} 的 intro。"
            "键 = 豆瓣 subject_id。生成脚本:tools/build_douban_intros.py"
        ),
        "intros": {key: intros[key] for key in sorted(intros, key=lambda k: int(k) if k.isdigit() else k)},
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description="拉取豆瓣简介,写入 public/douban-intros.json")
    ap.add_argument("--mappings", default="public/douban.json")
    ap.add_argument("--out", default="public/douban-intros.json")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--delay", type=float, default=1.2)
    ap.add_argument("--no-resume", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    mappings = load_mappings(Path(args.mappings))
    subjects = unique_subject_ids(mappings)
    if args.limit:
        subjects = subjects[: args.limit]
    out_path = Path(args.out)
    previous = {} if args.no_resume else load_existing(out_path)
    intros: dict[str, str] = {sid: previous[sid] for sid in subjects if sid in previous}
    print(f"共 {len(subjects)} 个 subject;已有 {len(intros)} 份简介;间隔 {args.delay}s")

    client = FrodoClient()
    stats = {"ok": 0, "empty": 0, "skip": 0, "fail": 0}
    for index, sid in enumerate(subjects, 1):
        if sid in intros:
            stats["skip"] += 1
            continue
        try:
            detail = fetch_movie_detail(client, sid)
        except DoubanUnavailableError as exc:
            print(f"\n! 豆瓣按 IP 风控,本轮停止(进度已落盘):{exc}")
            break
        except Exception as exc:  # noqa: BLE001
            stats["fail"] += 1
            print(f"[{index}/{len(subjects)}] {sid} ✘ {exc}", flush=True)
            time.sleep(args.delay)
            continue
        text = compact_intro(detail) if detail else None
        if text:
            intros[sid] = text
            stats["ok"] += 1
            tag = f"✔ {len(text)} 字"
        else:
            stats["empty"] += 1
            tag = "— 空"
        print(f"[{index}/{len(subjects)}] {sid} {tag}", flush=True)
        if not args.dry_run:
            write_payload(out_path, intros)
        time.sleep(args.delay)

    print(f"\n== 完成 == 新抓 {stats['ok']} / 空 {stats['empty']} / "
          f"复用 {stats['skip']} / 失败 {stats['fail']};产物 {len(intros)} 篇")
    if args.dry_run:
        print("--dry-run:不写文件")
        return 0
    write_payload(out_path, intros)
    print(f"写出 → {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
