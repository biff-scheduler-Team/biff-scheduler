#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_douban_map.py — 用豆瓣官方 Frodo API 生成 `public/douban.json`(豆瓣映射表)。

为什么改走官方 API
------------------
旧的 `enrich_douban.py` 走网页匿名口 `movie.douban.com/j/subject_suggest`:
会**静默限流**(返回 `[]`)、最终撞 CAPTCHA,只能 60s/请求地慢跑(250 部要 7~10 小时,
见 `data/_run_2026.sh`)。官方 Frodo 口(见 `tools/frodo_client.py`)是签名请求,
稳定得多,且 `movie/{id}` 详情直接给中文名 / 评分 / 海报 / `aka`(英文名)/ 导演 / 年份 ——
足以**自我校验**,不必再靠模糊字符串猜。

本脚本产出的是**前端真正消费的那份**(`public/douban.json`,见 `src/data.ts::loadDoubanMappings`),
`enrich_douban.py` 产出的 `data/enriched_douban.json` 只服务海报下载,两者互不影响。

流程
----
    public/films.json(官网片目;`title_en` 是唯一身份)
      → /api/v2/search/subjects 逐片检索(英文名 → 中文名 → 原始名,命中即止)
      → /api/v2/movie/{id} 详情确认(标题 / aka / 原始名 / 年份)
      → mappings:键 = 影片 id(`f###`)**与它各场次的 code**(前端按场次 code 查表)

匹配口径(**宁可缺,不可错**)
------------------------------
* `high`   = 片名命中(中文名 / 英文名 / 原始名 / 豆瓣 `aka` 之一)**且**年份不矛盾;
* `medium` = 片名命中但年份不符(多半是同名翻拍/续集)—— 默认**不写入**,只计数;
* `miss`   = 没查到,或只查到同类型但片名对不上 → **不写**(前端本来就有豆瓣搜索兜底)。

写入的条目一律带 `title_en`:它是 `tools/prune_douban.py` 判定「跨届撞号」的自证签名。

用法
----
    python tools/build_douban_map.py --films public/films.json --out public/douban.json
    python tools/build_douban_map.py --films public/films.json --limit 5 --dry-run   # 冒烟
    python tools/build_douban_map.py --films public/films.json --no-resume           # 强制全量重查
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

from douban_match import (  # noqa: E402  (同目录工具,需先补 sys.path)
    CONFIDENCE_RANK,
    DOUBAN_SUBJECT_URL,
    DoubanUnavailableError,
    dedup_queries,
    name_forms,
    resolve_subject,
)
from frodo_client import FrodoClient  # noqa: E402


def title_forms(film: dict[str, Any]) -> set[str]:
    """影片在本届数据里的**全部**片名写法(官网英文名 / 韩文名 + 目录中文名 / 原始名)。"""
    return name_forms(
        film.get("title_en"),
        film.get("title_zh"),
        film.get("title_orig"),
        film.get("title_kr"),
    )


def queries_of(film: dict[str, Any]) -> list[str]:
    """检索词顺序:官网英文名 → 目录中文名 → 原始名。

    英文名优先,因为豆瓣对**海外片**的英文条目收录率最高(与 `src/library.ts` 的
    「豆瓣搜索 ↗」同口径);中文名只作兜底 —— 对中文片它才是命中率最高的那一个。
    """
    return dedup_queries(film.get("title_en"), film.get("title_zh"), film.get("title_orig"))


def entry_of(detail: dict[str, Any], film: dict[str, Any], confidence: str) -> dict[str, Any]:
    """详情 → `douban.json` 的一条映射(字段与 `src/data.ts::DoubanFile` 对齐,多带审计字段)。"""
    subject_id = str(detail.get("id") or "")
    rating = detail.get("rating") or {}
    value = rating.get("value")
    count = rating.get("count")
    return {
        "subject_id": int(subject_id) if subject_id.isdigit() else subject_id,
        "title_cn": detail.get("title") or film.get("title_zh") or "",
        "douban_url": DOUBAN_SUBJECT_URL.format(id=subject_id),
        # `title_en` = 防撞号自证签名(见 tools/prune_douban.py),prune 靠它判「跨届串号」
        "title_en": film.get("title_en") or "",
        "year": str(detail.get("year") or film.get("year") or ""),
        "rating": float(value) if isinstance(value, (int, float)) and value else None,
        "rating_count": int(count) if isinstance(count, (int, float)) and count else None,
        "confidence": confidence,
    }


def resolve_film(client: FrodoClient, film: dict[str, Any], delay: float) -> tuple[Optional[dict[str, Any]], str]:
    """单部影片 → `(映射条目 or None, 置信度)`;检索 / 确认口径见 `tools/douban_match.py`。"""
    detail, confidence = resolve_subject(
        client,
        queries_of(film),
        title_forms(film),
        film.get("year"),
        name_forms(film.get("director")),
        delay,
    )
    if detail is None:
        return None, "miss"
    return entry_of(detail, film, confidence), confidence


def resolve_film_with_backoff(
    client: FrodoClient,
    film: dict[str, Any],
    args: argparse.Namespace,
    index: int,
    total: int,
) -> tuple[Optional[dict[str, Any]], str]:
    """`resolve_film` + 风控退避:被限时按 `--wait-on-limit` 等一会儿再试**同一部**。

    `--wait-on-limit 0`(默认)不等待,直接把 `DoubanUnavailableError` 抛给调用方停轮 ——
    本站的常态是「手动跑一轮」,自动等几十分钟会让人以为卡死;要挂着跑再显式打开。
    """
    attempts = args.limit_retries if args.wait_on_limit else 1
    for attempt in range(1, attempts + 1):
        try:
            return resolve_film(client, film, args.delay)
        except DoubanUnavailableError as exc:
            if attempt >= attempts:
                raise
            print(f"[{index}/{total}] 被风控,等 {args.wait_on_limit} 分钟后重试"
                  f"({attempt}/{attempts - 1}):{exc}", flush=True)
            time.sleep(args.wait_on_limit * 60)
    # 循环体必然 return 或 raise,这行只为让类型检查满意
    raise DoubanUnavailableError("风控重试次数用尽")


def load_existing(path: Path) -> dict[str, Any]:
    """读已存在的 `douban.json`(`mappings` 段);文件缺失 / 损坏 → 空表。"""
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    mappings = payload.get("mappings")
    return mappings if isinstance(mappings, dict) else {}


def write_payload(path: Path, mappings: dict[str, Any]) -> None:
    """落盘(键排序,便于 diff / 人工复核)。"""
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": (
            "豆瓣 Frodo API(/api/v2/search/subjects + /api/v2/movie/{id})。"
            "键 = 影片 id(f###)或场次 code,**带 title_en 自证**(见 tools/prune_douban.py)。"
            "生成脚本:tools/build_douban_map.py"
        ),
        "mappings": {key: mappings[key] for key in sorted(mappings)},
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def expand_mappings(
    films: list[dict[str, Any]],
    resolved: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """把「影片 id → 条目」展开成最终映射表:影片 id **与它全部场次 code** 指向同一条。

    前端查表用的是**场次 code**(`src/grid.ts::mappingOf` / `modal.ts::buildDoubanBlock`),
    只有无排期的目录片才按影片 id 查(`library.ts`)—— 两个键都写,两条路径才都命中。
    """
    mappings: dict[str, Any] = {}
    for film in films:
        entry = resolved.get(str(film.get("id") or ""))
        if entry is None:
            continue
        mappings[str(film["id"])] = entry
        for code in film.get("screening_codes") or []:
            mappings[str(code)] = dict(entry)
    return mappings


def main() -> int:
    ap = argparse.ArgumentParser(description="用豆瓣官方 API 生成 public/douban.json")
    ap.add_argument("--films", default="public/films.json", help="影片目录(官网片目底座)")
    ap.add_argument("--out", default="public/douban.json", help="映射表产物路径")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 部(冒烟用)")
    ap.add_argument("--delay", type=float, default=1.2, help="每个豆瓣请求之间的间隔秒数")
    ap.add_argument("--min-confidence", choices=("high", "medium"), default="high",
                    help="写入阈值(默认 high:片名命中且年份不矛盾)")
    ap.add_argument("--include-medium", action="store_true",
                    help="等同 --min-confidence medium(把「片名同、年份不符」也写进去)")
    ap.add_argument("--no-resume", action="store_true", help="忽略已有产物,全部重查")
    ap.add_argument("--dry-run", action="store_true", help="只打印结果,不写文件")
    ap.add_argument("--wait-on-limit", type=float, default=0.0,
                    help="被风控时先等 N 分钟再重试同一部(0 = 立即停轮,默认);适合挂着长跑")
    ap.add_argument("--limit-retries", type=int, default=6, help="--wait-on-limit 的最多等待次数")
    args = ap.parse_args()

    threshold = "medium" if args.include_medium else args.min_confidence
    films: list[dict[str, Any]] = json.loads(Path(args.films).read_text(encoding="utf-8"))["films"]
    if args.limit:
        films = films[: args.limit]
    out_path = Path(args.out)
    previous = {} if args.no_resume else load_existing(out_path)
    print(f"共 {len(films)} 部影片;阈值 {threshold};间隔 {args.delay}s;已有产物 {len(previous)} 键")

    client = FrodoClient()
    stats = {"high": 0, "medium": 0, "miss": 0, "skip": 0}
    # 逐片结果(只存 film id → 条目);场次 code 在收尾时统一展开
    resolved: dict[str, dict[str, Any]] = {}

    for index, film in enumerate(films, 1):
        film_id = str(film.get("id") or "")
        cached = previous.get(film_id)
        if cached and cached.get("title_en") == film.get("title_en"):
            resolved[film_id] = cached
            stats["skip"] += 1
            continue
        try:
            entry, confidence = resolve_film_with_backoff(client, film, args, index, len(films))
        except DoubanUnavailableError as exc:
            # 风控 / 断网:停轮,已落盘的进度保留(下次重跑自动续)。
            # 绝不能继续 —— 继续只会把整张表写成「全部未命中」,比不跑更糟。
            print(f"\n! 豆瓣按 IP 风控,本轮停止(进度已落盘,稍后重跑可续):{exc}")
            break
        stats[confidence] += 1
        if entry is not None and CONFIDENCE_RANK[confidence] >= CONFIDENCE_RANK[threshold]:
            resolved[film_id] = entry
            tag = f"✔ {entry['subject_id']} 《{entry['title_cn']}》 {entry['year']} [{confidence}]"
        else:
            tag = "✘ 未命中" if confidence == "miss" else f"— {confidence}(低于阈值,不写)"
        print(f"[{index}/{len(films)}] {film_id} {str(film.get('title_en'))[:42]:<42} {tag}", flush=True)
        # 逐部落盘(而非收尾一次性写):250 部要跑十几分钟,中途 Ctrl-C / 超时后重跑能接着跑
        # (续跑按 `film id + title_en` 认缓存 —— title_en 变了说明本届数据换过,必须重查)
        if not args.dry_run:
            write_payload(out_path, expand_mappings(films, resolved))

    mappings = expand_mappings(films, resolved)
    print(f"\n== 完成 == 命中 {stats['high']} high / {stats['medium']} medium / "
          f"{stats['miss']} miss / {stats['skip']} 复用缓存")
    print(f"映射表 {len(mappings)} 键(影片 {len(resolved)} 部 + 场次 code)")
    if args.dry_run:
        print("--dry-run:不写文件")
        return 0
    print(f"写出 → {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
