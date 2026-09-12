#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_douban_related.py — 为已映射影片拉取豆瓣 Frodo `/recommendations`。

产出 `public/douban-related.json`,给资料弹层「本届也在放 / 豆瓣也推荐」用。
「是不是本届」由前端对照当前 `douban.json` 现查,本文件只存推荐条目本身。

为什么是 `/recommendations` 而不是 `/related_subjects`
----------------------------------------------------
交接文档两个口历史都是 200。本机 2026-09-12 对已映射影片实测:

* `/recommendations` → 长度 20 的 **movie** 数组,2026 新片同样有;
  抽样 12 部里 9 部的推荐能对上本届片目(开幕片 4 部,《天使之卵》3 部)。
* `/related_subjects` → 键是 `related_subjects` + `ost`,本届样例经常空,
  有内容时是「原著小说」一类跨类型,排片用不上。

用法
----
    python tools/build_douban_related.py
    python tools/build_douban_related.py --limit 5 --dry-run
    python tools/build_douban_related.py --delay 3          # 风控解除后的续跑
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

from douban_match import DoubanUnavailableError, rate_limited  # noqa: E402
from frodo_client import FrodoClient, error_hint  # noqa: E402

RECS_PATH = "/api/v2/movie/{id}/recommendations"
DOUBAN_SUBJECT_URL = "https://movie.douban.com/subject/{id}/"
RE_CARD_YEAR = re.compile(r"^\s*(\d{4})\b")


def unique_subject_ids(mappings: dict[str, Any]) -> list[str]:
    """映射表 → 去重后的 subject_id 列表(保插入序,便于续跑日志稳定)。"""
    seen: dict[str, None] = {}
    for entry in mappings.values():
        if not isinstance(entry, dict):
            continue
        sid = str(entry.get("subject_id") or "")
        if sid.isdigit():
            seen.setdefault(sid, None)
    return list(seen)


def year_of(card_subtitle: Any) -> Optional[str]:
    """`card_subtitle` 开头四位年份(`1992 / 日本 / 动画 / …`);取不到 → None。"""
    matched = RE_CARD_YEAR.match(str(card_subtitle or ""))
    return matched.group(1) if matched else None


def rating_of(raw: Any) -> Optional[float]:
    """详情同款:`count > 0` 且 `value > 0` 才算有评分,避免把「暂无」画成 0.0。"""
    if not isinstance(raw, dict):
        return None
    try:
        count = int(raw.get("count") or 0)
        value = float(raw.get("value") or 0)
    except (TypeError, ValueError):
        return None
    if count <= 0 or value <= 0:
        return None
    return round(value, 1)


def compact_rec(item: Any, source_id: str) -> Optional[dict[str, Any]]:
    """Frodo 推荐项 → 前端条目;非电影 / 缺 id / 自身 → None。"""
    if not isinstance(item, dict):
        return None
    if item.get("type") not in (None, "movie"):
        return None
    rec_id = str(item.get("id") or "")
    title = str(item.get("title") or "").strip()
    if not rec_id.isdigit() or not title or rec_id == source_id:
        return None
    url = str(item.get("url") or "").strip() or DOUBAN_SUBJECT_URL.format(id=rec_id)
    out: dict[str, Any] = {"id": rec_id, "title": title, "url": url}
    year = year_of(item.get("card_subtitle"))
    if year:
        out["year"] = year
    rating = rating_of(item.get("rating"))
    if rating is not None:
        out["rating"] = rating
    return out


def fetch_recs(client: FrodoClient, subject_id: str) -> list[dict[str, Any]]:
    """拉一部的推荐列表;风控抛 `DoubanUnavailableError`,其它失败返回空表。"""
    path = RECS_PATH.format(id=subject_id)
    status, data = client.get_json(path)
    if rate_limited(status, data):
        code = data.get("code") if isinstance(data, dict) else None
        msg = data.get("msg") if isinstance(data, dict) else ""
        raise DoubanUnavailableError(f"{path} 被风控 → HTTP {status} code={code} msg={msg}")
    if status != 200:
        hint = error_hint(data.get("code")) if isinstance(data, dict) else ""
        raise RuntimeError(f"{path} → HTTP {status}{(' ' + hint) if hint else ''}")
    if not isinstance(data, list):
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in data:
        rec = compact_rec(item, subject_id)
        if rec is None or rec["id"] in seen:
            continue
        seen.add(rec["id"])
        out.append(rec)
    return out


def load_mappings(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    mappings = payload.get("mappings")
    return mappings if isinstance(mappings, dict) else {}


def load_existing(path: Path) -> dict[str, list[dict[str, Any]]]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    recs = payload.get("recs")
    if not isinstance(recs, dict):
        return {}
    out: dict[str, list[dict[str, Any]]] = {}
    for key, items in recs.items():
        if isinstance(items, list):
            out[str(key)] = [it for it in items if isinstance(it, dict) and it.get("id")]
    return out


def write_payload(path: Path, recs: dict[str, list[dict[str, Any]]]) -> None:
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": (
            "GET /api/v2/movie/{id}/recommendations。"
            "键 = 豆瓣 subject_id;「是否本届」由前端对照 douban.json 现查。"
            "生成脚本:tools/build_douban_related.py"
        ),
        "recs": {key: recs[key] for key in sorted(recs, key=lambda k: int(k) if k.isdigit() else k)},
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description="拉取豆瓣相关电影,写入 public/douban-related.json")
    ap.add_argument("--mappings", default="public/douban.json", help="已有豆瓣映射表")
    ap.add_argument("--out", default="public/douban-related.json", help="相关电影产物")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 个 subject(冒烟)")
    ap.add_argument("--delay", type=float, default=1.2, help="每个请求之间的间隔秒数")
    ap.add_argument("--no-resume", action="store_true", help="忽略已有产物,全部重抓")
    ap.add_argument("--dry-run", action="store_true", help="只打印,不写文件")
    args = ap.parse_args()

    mappings = load_mappings(Path(args.mappings))
    subjects = unique_subject_ids(mappings)
    if args.limit:
        subjects = subjects[: args.limit]
    out_path = Path(args.out)
    previous = {} if args.no_resume else load_existing(out_path)

    # 只保留当前映射里还在的 subject,避免换届 / prune 后留下孤儿键
    recs: dict[str, list[dict[str, Any]]] = {
        sid: previous[sid] for sid in subjects if sid in previous
    }
    print(f"共 {len(subjects)} 个 subject;已有 {len(recs)} 份推荐;间隔 {args.delay}s")

    client = FrodoClient()
    stats = {"ok": 0, "empty": 0, "skip": 0, "fail": 0}
    for index, sid in enumerate(subjects, 1):
        if sid in recs:
            stats["skip"] += 1
            continue
        try:
            items = fetch_recs(client, sid)
        except DoubanUnavailableError as exc:
            print(f"\n! 豆瓣按 IP 风控,本轮停止(进度已落盘,稍后重跑可续):{exc}")
            break
        except Exception as exc:  # noqa: BLE001  单部失败不拖整轮;记下继续
            stats["fail"] += 1
            print(f"[{index}/{len(subjects)}] {sid} ✘ {exc}", flush=True)
            time.sleep(args.delay)
            continue
        recs[sid] = items
        stats["ok" if items else "empty"] += 1
        tag = f"✔ {len(items)} 部" if items else "— 空"
        print(f"[{index}/{len(subjects)}] {sid} {tag}", flush=True)
        if not args.dry_run:
            write_payload(out_path, recs)
        time.sleep(args.delay)

    print(f"\n== 完成 == 新抓 {stats['ok']} / 空 {stats['empty']} / "
          f"复用 {stats['skip']} / 失败 {stats['fail']};产物 {len(recs)} 个 subject")
    if args.dry_run:
        print("--dry-run:不写文件")
        return 0
    write_payload(out_path, recs)
    print(f"写出 → {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
