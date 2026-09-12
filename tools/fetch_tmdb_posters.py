#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fetch_tmdb_posters.py — 用 TMDB 搜本届片目、下载海报、写回 films.json。

鉴权方式与 piecelet-api-relay 的 `/tmdb` 中继相同(Bearer v4 token),
token 只从环境变量 `TMDB_KEY` / `RELAY_TMDB_KEY` 读,不写任何检入文件。

图床 `image.tmdb.org` 不防盗链,但仍下到 `public/posters/` —— 本站 PWA 要离线、
也不想运行时打第三方。

命中口径(宁可缺,不可错)
------------------------
片名归一后与 TMDB `title` / `original_title` 之一相等,**且**年份一致
(差 1 年也认,应付「节日年 vs 制作年」)。只靠年份或只靠模糊相似不写。

用法
----
    TMDB_KEY=… python tools/fetch_tmdb_posters.py
    TMDB_KEY=… python tools/fetch_tmdb_posters.py --limit 5 --dry-run
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

import film_match  # noqa: E402
from tmdb_client import TmdbClient, poster_url  # noqa: E402

# 只下列表/卡片用的两档。original 单张常 >1MB,246 部会把仓库撑得没必要那么大。
POSTER_SIZES = (("w185", "s"), ("w500", "m"))

MIN_BYTES = 1024
DOUBAN_SUBJECT_URL_HINT = "/posters/"


def norm(raw: Any) -> str:
    if raw is None:
        return ""
    return film_match.norm_title(raw if isinstance(raw, str) else str(raw))


def name_forms(*values: Any) -> set[str]:
    return {norm(v) for v in values if norm(v)}


def queries_of(film: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for value in (film.get("title_en"), film.get("title_orig"), film.get("title_zh")):
        text = str(value or "").strip()
        if text and text not in out:
            out.append(text)
    return out


def year_of_result(item: dict[str, Any]) -> str:
    date = str(item.get("release_date") or "")
    return date[:4] if len(date) >= 4 and date[:4].isdigit() else ""


def score_result(film: dict[str, Any], item: dict[str, Any]) -> float:
    forms = name_forms(film.get("title_en"), film.get("title_zh"), film.get("title_orig"), film.get("title_kr"))
    theirs = name_forms(item.get("title"), item.get("original_title"))
    title_hit = bool(forms & theirs)
    expect = str(film.get("year") or "")
    got = year_of_result(item)
    year_hit = bool(expect and got == expect)
    year_close = False
    if expect.isdigit() and got.isdigit():
        year_close = abs(int(expect) - int(got)) <= 1
    if title_hit and year_hit:
        return 4.0
    if title_hit and year_close:
        return 3.0
    return 0.0


def pick_result(film: dict[str, Any], results: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    best: Optional[dict[str, Any]] = None
    best_score = 0.0
    for item in results:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        s = score_result(film, item)
        if s > best_score:
            best_score, best = s, item
    return best if best_score >= 3.0 else None


def search_movie(client: TmdbClient, film: dict[str, Any]) -> Optional[dict[str, Any]]:
    year = str(film.get("year") or "") or None
    seen: set[int] = set()
    pool: list[dict[str, Any]] = []
    for query in queries_of(film):
        for params in (
            {"query": query, "year": year, "include_adult": "false", "language": "zh-CN"},
            {"query": query, "year": year, "include_adult": "false", "language": "en-US"},
        ):
            if not params.get("year"):
                params.pop("year", None)
            status, data = client.get("/3/search/movie", params)
            if status != 200 or not isinstance(data, dict):
                continue
            for item in data.get("results") or []:
                tid = item.get("id") if isinstance(item, dict) else None
                if not isinstance(tid, int) or tid in seen:
                    continue
                seen.add(tid)
                pool.append(item)
        hit = pick_result(film, pool)
        if hit:
            return hit
    return pick_result(film, pool)


def download(url: str, dest: Path) -> tuple[bool, str]:
    req = urllib.request.Request(url, headers={"User-Agent": "biff-scheduler/tmdb-posters"})
    with urllib.request.urlopen(req, timeout=25) as resp:
        data = resp.read()
    if len(data) < MIN_BYTES:
        return False, f"{len(data)} bytes"
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(dest)
    return True, f"{len(data) // 1024} KB"


def load_map(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    films = payload.get("films")
    return films if isinstance(films, dict) else {}


def write_map(path: Path, films: dict[str, Any]) -> None:
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "TMDB /3/search/movie; posters from image.tmdb.org. Token never stored.",
        "films": {k: films[k] for k in sorted(films)},
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def patch_films_json(films_path: Path, mapping: dict[str, Any], posters_dir: Path) -> int:
    payload = json.loads(films_path.read_text(encoding="utf-8"))
    films = payload.get("films") or []
    changed = 0
    for film in films:
        fid = str(film.get("id") or "")
        entry = mapping.get(fid)
        if not entry or not entry.get("tmdb_id"):
            continue
        dest = posters_dir / f"tmdb-{entry['tmdb_id']}-m.jpg"
        if not dest.exists() or dest.stat().st_size < MIN_BYTES:
            continue
        path = f"/posters/tmdb-{entry['tmdb_id']}-m.jpg"
        if film.get("poster") != path:
            film["poster"] = path
            changed += 1
    payload["films"] = films
    films_path.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return changed


def main() -> int:
    ap = argparse.ArgumentParser(description="用 TMDB 海报填 films.json(token 只读环境变量)")
    ap.add_argument("--films", default="public/films.json")
    ap.add_argument("--map", default="data/tmdb_map.json")
    ap.add_argument("--out-dir", default="public/posters")
    ap.add_argument("--delay", type=float, default=0.35)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-resume", action="store_true")
    args = ap.parse_args()

    films: list[dict[str, Any]] = json.loads(Path(args.films).read_text(encoding="utf-8"))["films"]
    if args.limit:
        films = films[: args.limit]
    map_path = Path(args.map)
    previous = {} if args.no_resume else load_map(map_path)
    posters_dir = Path(args.out_dir)
    posters_dir.mkdir(parents=True, exist_ok=True)
    client = TmdbClient()
    print(f"共 {len(films)} 部;已有映射 {len(previous)};间隔 {args.delay}s")

    mapping: dict[str, Any] = dict(previous)
    stats = {"hit": 0, "miss": 0, "skip": 0, "dl": 0, "fail": 0}
    for index, film in enumerate(films, 1):
        fid = str(film.get("id") or "")
        cached = mapping.get(fid)
        if cached and cached.get("tmdb_id") and not args.no_resume:
            stats["skip"] += 1
            continue
        try:
            hit = search_movie(client, film)
        except Exception as exc:  # noqa: BLE001
            print(f"[{index}/{len(films)}] {fid} 检索失败:{exc}", flush=True)
            stats["fail"] += 1
            time.sleep(args.delay)
            continue
        time.sleep(args.delay)
        if not hit:
            mapping[fid] = {"tmdb_id": None, "title_en": film.get("title_en") or ""}
            stats["miss"] += 1
            print(f"[{index}/{len(films)}] {fid} {str(film.get('title_en'))[:40]:<40} ✘ 未命中", flush=True)
            if not args.dry_run:
                write_map(map_path, mapping)
            continue
        tid = int(hit["id"])
        entry = {
            "tmdb_id": tid,
            "title": hit.get("title") or "",
            "original_title": hit.get("original_title") or "",
            "year": year_of_result(hit),
            "poster_path": hit.get("poster_path") or "",
            "title_en": film.get("title_en") or "",
        }
        mapping[fid] = entry
        stats["hit"] += 1
        tag = f"✔ tmdb:{tid} {entry['title'][:28]} {entry['year']}"
        print(f"[{index}/{len(films)}] {fid} {str(film.get('title_en'))[:36]:<36} {tag}", flush=True)
        if args.dry_run or not entry["poster_path"]:
            if not args.dry_run:
                write_map(map_path, mapping)
            continue
        for size, suffix in POSTER_SIZES:
            dest = posters_dir / f"tmdb-{tid}-{suffix}.jpg"
            if dest.exists() and dest.stat().st_size >= MIN_BYTES:
                continue
            try:
                ok, info = download(poster_url(entry["poster_path"], size), dest)
            except Exception as exc:  # noqa: BLE001
                ok, info = False, str(exc)
            if ok:
                stats["dl"] += 1
            else:
                stats["fail"] += 1
                print(f"    {dest.name} FAIL {info}", flush=True)
            time.sleep(min(args.delay, 0.2))
        if not args.dry_run:
            write_map(map_path, mapping)

    print(f"\n== 检索 == 命中 {stats['hit']} / 未命中 {stats['miss']} / 复用 {stats['skip']}")
    print(f"== 下载 == 新下 {stats['dl']} / 失败 {stats['fail']}")
    if args.dry_run:
        print("--dry-run:不改 films.json")
        return 0
    write_map(map_path, mapping)
    changed = patch_films_json(Path(args.films), mapping, posters_dir)
    print(f"films.json 海报改写 {changed} 部")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
