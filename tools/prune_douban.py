#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""prune_douban.py — 清掉 `apps/web/public/douban.json` 里**跨届失效**的映射

为什么需要它
------------
`douban.json` 的键是**场次 code**(`006`)或**目录序号**(`f002`)—— 两者都是**按届现编**的:

* `code` 是官方场次编号,每届从 001 重新开始;
* `f###` 是 xlsx 行序,换届后同一序号是另一部片。

于是换届后旧映射会**按编号撞号**,把上一届的中文名 / 豆瓣链接静默套到这一届不相干的片上。
实测(2026-09-11):`apps/web/public/douban.json` 里 5 条映射(`f002` / `006` / `088` / `462` / `X0904`)
全部指向同一个豆瓣条目「第二次诞生」,而 `006`/`088`/`462` 在 2026 分别是
《The First Taste of Loneliness》/《Too Many Beasts》/《The Scar-Faced Cat》——
界面上表现为**两部毫不相干的片共用同一个中文名**。

判定规则(**只认能自证的映射**)
--------------------------------
* 键不存在于本届排期 code / 目录 id → **丢弃**(纯属上一届遗留,如 `X0904`);
* 键存在,但映射带了 `title_en` 且与本届该场次的英文名不符 → **丢弃**(撞号);
* 键存在但映射**没带 `title_en`** → **丢弃**(无法自证 —— 宁可少一条映射,
  也不能让「第二次诞生」这种错名挂上去;前端本来就有豆瓣搜索兜底)。

结论:想保留映射,就在条目里写 `title_en`;它是这张表的「防撞号签名」。

用法
----
    python tools/prune_douban.py [--douban apps/web/public/douban.json] \\
        --schedule apps/web/public/schedule.json --films apps/web/public/films.json [--dry-run]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def main() -> int:
    ap = argparse.ArgumentParser(description="清理跨届失效的豆瓣映射")
    ap.add_argument("--douban", default="apps/web/public/douban.json")
    ap.add_argument("--schedule", default="apps/web/public/schedule.json")
    ap.add_argument("--films", default="apps/web/public/films.json")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    path = Path(args.douban)
    payload: dict[str, Any] = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    mappings: dict[str, Any] = payload.get("mappings") or {}
    if not mappings:
        print("douban.json 无映射,无需清理")
        return 0

    codes = {
        s["code"]: s["title_en"]
        for s in json.loads(Path(args.schedule).read_text(encoding="utf-8"))["screenings"]
    }
    film_ids = {f["id"] for f in json.loads(Path(args.films).read_text(encoding="utf-8"))["films"]}

    kept: dict[str, Any] = {}
    for key, m in mappings.items():
        if key not in codes and key not in film_ids:
            print(f"  丢弃 {key}:本届既无此场次 code,也无此目录 id(上一届遗留)")
            continue
        want = m.get("title_en")
        got = codes.get(key)
        if not want:
            print(f"  丢弃 {key}:未带 title_en,无法自证是否撞号(该键本届对应「{got or '目录片'}」)")
            continue
        if got and want != got:
            print(f"  丢弃 {key}:title_en 不符(表里「{want}」/ 本届「{got}」)")
            continue
        kept[key] = m

    print(f"保留 {len(kept)} / {len(mappings)} 条")
    if args.dry_run:
        return 0
    payload["mappings"] = kept
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"写出 → {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
