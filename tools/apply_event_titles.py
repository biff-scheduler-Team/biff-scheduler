#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""apply_event_titles.py — 给**已生成**的 schedule.json 就地补活动场次中文名

为什么要这个脚本
----------------
`scrape_biff_web.py --event-titles` 已能让**新产物**带上活动中文名,但重跑它要
**联网重抓**,会把官网当天的其它漂移(改时间 / 加场 / 换厅)一并带进来。本轮需求
只想补中文名 → 用同一份实现(`scrape_biff_web.py::build_event_index` / `norm_title`,
**不另写一套匹配口径**)对既有产物打补丁;下次正式重抓时那一侧同样会生效,两边不会漂。

为什么按**文本**改而不是 `json.dump`
------------------------------------
产物是 2 空格缩进 + **CRLF** 的 1.5 万行大文件。`json.dump` 重排会产出整文件 diff,
评审时真正要看的 17 行会被淹没。

用法
----
    python tools/apply_event_titles.py --schedule apps/web/public/schedule.json \
        --event-titles data/event-titles-2026.json            # 就地补
    python tools/apply_event_titles.py ... --dry-run          # 只打印
    python tools/apply_event_titles.py ... --check            # 有可补条目即退出码 1(哨兵)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from scrape_biff_web import build_event_index, norm_title  # noqa: E402  (路径注入后才可导入)

TITLE_ZH_EMPTY = '"title_zh": ""'


def event_zh_of(item: dict, index: dict[str, str]) -> str:
    """按「官网英文名 → 韩文名」顺序查活动译名表(与 scrape_biff_web.py 内联处同口径)。"""
    zh = index.get(norm_title(item.get("title_en") or ""))
    if not zh and item.get("title_kr"):
        zh = index.get(norm_title(item["title_kr"]))
    return zh or ""


def patch_text(text: str, code: str, zh: str) -> str:
    """把 `"code": "<code>"` 那条记录里**本记录内**的 `"title_zh": ""` 换成中文名。

    全文件 `"title_zh": ""` 有几百处,不能全局替换;搜索范围收紧到「本记录 → 下一条
    `"code"`」之间,避免改到邻居。找不到就原样返回,由调用方报警(不静默)。
    """
    anchor = f'"code": "{code}"'
    i = text.find(anchor)
    if i < 0:
        return text
    nxt = text.find('"code": "', i + len(anchor))
    seg_end = nxt if nxt >= 0 else len(text)
    j = text.find(TITLE_ZH_EMPTY, i, seg_end)
    if j < 0:
        return text
    head = text[:j]
    tail = text[j + len(TITLE_ZH_EMPTY):]
    return head + f'"title_zh": {json.dumps(zh, ensure_ascii=False)}' + tail


def main() -> int:
    parser = argparse.ArgumentParser(description="给已生成的 schedule.json 补活动场次中文名")
    parser.add_argument("--schedule", default="apps/web/public/schedule.json", help="目标产物")
    parser.add_argument("--event-titles", default="data/event-titles-2026.json", help="人工活动译名表")
    parser.add_argument("--dry-run", action="store_true", help="只打印,不写回")
    parser.add_argument("--check", action="store_true", help="有可补条目即退出码 1(不写回)")
    args = parser.parse_args()

    index = build_event_index(Path(args.event_titles))
    if not index:
        print(f"活动译名表为空或不存在:{args.event_titles}", file=sys.stderr)
        return 2

    path = Path(args.schedule)
    text = path.read_text(encoding="utf-8", newline="")
    screenings = json.loads(text)["screenings"]

    todo: list[tuple[str, str, str]] = []
    matched: set[str] = set()
    for item in screenings:
        for cand in (item.get("title_en"), item.get("title_kr")):
            k = norm_title(cand or "")
            if k and k in index:
                matched.add(k)
        if (item.get("title_zh") or "").strip():
            continue
        if not any((item.get("tags") or [])):
            continue  # 只补活动场次;纯排期片的缺口走 title-alias 那条线
        zh = event_zh_of(item, index)
        if zh:
            todo.append((item["code"], item["title_en"], zh))

    print(f"活动译名表    : {len(index)} 条({args.event_titles})")
    print(f"待补活动场次  : {len(todo)} 条")
    for code, en, zh in todo:
        print(f"  {code}  {en} → {zh}")

    unused = sorted(set(index) - matched)
    if unused:
        print(f"表内未命中    : {len(unused)} 条(英文名抄错?或该场次已从排期里消失)")
        for name in unused:
            print(f"  ! {name}")

    if args.check:
        return 1 if todo else 0
    if args.dry_run:
        print("dry-run:未写回")
        return 0

    for code, _en, zh in todo:
        new_text = patch_text(text, code, zh)
        if new_text == text:
            print(f"写入失败(产物里找不到该 code 的空 title_zh):{code}", file=sys.stderr)
            return 3
        text = new_text
    path.write_text(text, encoding="utf-8", newline="")
    print(f"已写回        : {path}({len(todo)} 处)")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
