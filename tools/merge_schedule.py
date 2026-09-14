#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""merge_schedule.py — 把「官网活排期」与「官方付印册子」合成唯一 schedule.json / venues.json

为什么需要它
------------
2026 届有两个**互补**的数据源,谁单独用都不全:

* `tools/scrape_biff_web.py`(官网 `date.asp`)—— **活数据**:改时间 / 加场 / 活动场次
  (Actors' House / Master Class / Cine Class)/ `title_zh` 桥接,但**没有**
  MEGABOX Busan Theater 1–4(Community BIFF)。
  实测官网 10 天分组标题里没有 MEGABOX → 42 场凭空消失。
* `tools/extract_schedule.py`(官方 Ticket Catalogue PDF)—— **付印快照**:
  有 MEGABOX(印了官方场次编号 901–942),但没有活动场次,且 9/10 付印后
  官网的变更它看不到。
  ⚠ 册子排期页上还有 **BD(Indieplus)/ C7(CGV 7)** 两列,但它们整列归在
  `P&I(Press & Industry) Screenings` 粉底标题下 —— 记者/业界场,**不印编号、不对外售票**
  → 两个来源都**不含**它们(`extract_schedule.py` 直接跳过;2026-09-14 修正)。

合并策略(逐条都有理由,不靠猜)
------------------------------
1. **骨架 = 官网**。它是活的:改时间、加场、活动场次、`title_zh` 都在它这一侧;
   拿册子当骨架会把 9/10 之后的变更打回去(实测 831 Special Talk 册子印 60′、官网已改 120′)。
2. **补官网没有的场次**(按 code 判):册子里有、官网没有的一律补进来。
3. **共有 code 一律保留官网值**,只有 `CATALOGUE_WINS_DURATION` 里显式登记的例外 ——
   那些是官网**兜底值**的场次(见 `scrape_biff_web.py::FALLBACK_DURATION_MIN = 120`):
   册子印了真实片长,官网只能填 120。**不写通用规则**(「两源取大 / 取小」无口径依据),
   一律逐条登记 + 写理由。
4. **场馆**:以官网 venues.json 为底,补册子里的新厅;`br` 改名 `bt` —— 全仓口径是
   「id = 官方代码小写」(`docs/CONVENTIONS.md`),2026 册子图例 BT = Busan Cinema Center
   Roof Theater,`br` 是抓取脚本当年自造的(全仓无代码引用)。

用法
----
    python tools/extract_schedule.py --pdf <册子> --year 2026 --month 10 \\
        --schedule-pages 9-16 --out /tmp/catalogue.json --venues-out /tmp/catalogue-venues.json

    python tools/merge_schedule.py \\
        --catalogue /tmp/catalogue.json --catalogue-venues /tmp/catalogue-venues.json \\
        --web apps/web/public/schedule.json --web-venues apps/web/public/venues.json \\
        --films apps/web/public/films.json \\
        --out apps/web/public/schedule.json --venues-out apps/web/public/venues.json

冲突与统计一律打到 stderr;`--strict` 下出现**未登记的字段冲突**即退出码 1(CI 用)。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------- 口径常量

# 册子片长覆盖官网兜底值的**显式清单**(code → 理由)。
# 判据:官网这条的 duration_min 是 FALLBACK_DURATION_MIN(120)兜底,册子印了真实片长。
# 每条都必须能指到「为什么官网是兜底」—— 不写通用规则,避免把真实 120′ 的片也改掉。
CATALOGUE_WINS_DURATION: dict[str, str] = {
    "002": "闭幕式+釜山奖获奖作:官网无详情页 → 120′ 兜底;册子印 18:00~22:00(240′)",
    "731": "10/15 获奖片重映:官网无详情页 → 120′ 兜底;册子印 160′",
    "732": "10/15 获奖片重映:官网无详情页 → 120′ 兜底;册子印 150′",
    "733": "10/15 获奖片重映:官网无详情页 → 120′ 兜底;册子印 150′",
    "734": "10/15 获奖片重映:官网无详情页 → 120′ 兜底;册子印 150′",
    "735": "10/15 获奖片重映:官网无详情页 → 120′ 兜底;册子印 130′",
}

# 已知的「两源不同但都合法」的语义差异,保留官网值 —— 列在这里是为了让冲突报告可读,
# 不是为了静默:每次合并都会把它们打印出来。
KNOWN_KEEP_WEB: dict[str, str] = {
    "001": "开幕场:册子把「18:00 开幕仪式 + 20:00 影片」印成一格(18:00~21:20),"
           "官网按「影片 + GV」记(18:00~19:45)。前端 gvTalkMin = (end-start) - duration_min "
           "只认后者,取册子会凭空多出 120 分钟映后谈 → 保留官网",
    "494": "字幕:册子印 KK、官网印 KE+KK(叠加)。两源都合法,保留官网(更全)",
    "148": "片长:册子印 120′、官网详情页 123′。官网是逐片详情页口径,保留官网",
    "172": "片长:册子印 120′、官网详情页 123′。保留官网",
    "286": "片长:册子印 120′、官网详情页 123′。保留官网",
    "677": "片长:册子印 120′、官网详情页 123′。保留官网",
    "318": "end_time:册子印 16:50~18:16(未叠 GV 补时)、官网 18:41(叠了 25min)。"
           "全仓口径 = end_time 已含映后谈,保留官网",
    "489": "片长:册子印 100′、官网 99′。保留官网",
    "742": "GV:册子印 GV、官网未标。官网是活数据,保留官网(不额外加 GV)",
    "831": "片长:册子印 60′、官网 20:00~22:00(120′)。9/10 付印后官网改过,保留官网",
    "206": "片长:册子 120′、官网 120′(一致,2026 解析器修复前会读成 20′)",
    "313": "片长:册子 107′、官网 107′",
    "317": "片长:册子 101′、官网 101′",
}

# 新厅插入位置(插在哪个 id 之后);未登记的一律追加到末尾。
# 位置口径:同影院/同分区的厅挨着排 —— 甘特图泳道顺序 = venues.json 顺序,插错位置等于把
# MEGABOX 混进 CENTUM 主场区里。MEGABOX 在南浦洞(独立分区),故不设锚点、排在最后。
INSERT_AFTER: dict[str, str] = {
    "bt": "bh",
}

# 场馆改名(旧 id → 新 id)。数据里出现旧 id 时按新 id 的官方口径重写,位置不变。
VENUE_RENAMES: dict[str, str] = {
    "br": "bt",
}

# 参与冲突判定的字段 —— 只有这些字段不一致才算「两源真的对不上」。
# 片名与 tags 不在其中:
#   * 片名:官网是活数据、册子会被排版拆行/加注(实测 `1982` → `1982 1982`、
#     `A Place to Heal` → `A Place to Heal 15/18`),差异一律保留官网,只统计条数。
#   * tags:特性标记是**叠加**语义(一场可以既是 GV 又是联映),两源取并集而不是二选一。
CRITICAL_FIELDS = (
    "date", "start_time", "end_time", "duration_min",
    "venue_id", "is_gv", "rating", "subs",
)

# 官网**缺值**时用册子补的字段(册子是付印全量,官网偶有留空)。
FILL_FIELDS = ("title_en", "title_kr", "page")


def log(kind: str, msg: str) -> None:
    """统一日志出口(stderr,不污染 stdout)。"""
    print(f"[{kind}] {msg}", file=sys.stderr)


def norm_title(s: str) -> str:
    """片名归一(与 `scrape_biff_web.py::norm_title` 同口径):只留字母数字与谚文。"""
    return re.sub(r"[^0-9a-z\uac00-\ud7a3]+", "", (s or "").lower())


def load_json(path: str | Path) -> Any:
    """读 UTF-8 JSON。"""
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path: str | Path, payload: Any) -> None:
    """契约化写出:UTF-8 + `indent=2` + 末尾换行 —— 与 `scrape_biff_web.py` 逐字节同款。

    ⚠ 别改成 `indent=1`:`festival_common.write_json` 用的是 1(那是**中间产物**的口径),
    但 `apps/web/public/schedule.json` / `venues.json` 一直是 `indent=2` ——
    换缩进会把整份文件重排成几万行 diff,真正的改动全被淹没。
    """
    Path(path).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def build_title_index(films: list[dict]) -> dict[str, str]:
    """官网英文名 / 韩文名 / 原始名 → 目录中文名(补 `title_zh` 用)。

    与 `apps/web/src/data.ts::buildFilmIndex` 同口径:排期与片目之间只有**片名**这一座桥。
    """
    index: dict[str, str] = {}
    for f in films:
        zh = f.get("title_zh") or ""
        if not zh:
            continue
        for key in (f.get("title_en"), f.get("title_kr"), f.get("title_orig")):
            if key:
                index.setdefault(norm_title(key), zh)
    return index


def merge_screenings(
    web: list[dict], cat: list[dict], title_index: dict[str, str], strict: bool
) -> tuple[list[dict], Counter]:
    """官网为骨架 + 册子补缺 / 补片长。返回 (合并结果, 统计)。"""
    stats: Counter = Counter()
    cat_by_code = {s["code"]: s for s in cat}
    web_codes = {s["code"] for s in web}

    merged: list[dict] = []
    conflicts: list[str] = []
    for item in web:
        row = dict(item)
        if row["venue_id"] in VENUE_RENAMES:
            # 场馆 id 统一到官方 2026 图例口径后再比对,否则每条 Roof Theater 场次都成「冲突」
            row["venue_id"] = VENUE_RENAMES[row["venue_id"]]
            stats["venue_renamed"] += 1
        other = cat_by_code.get(row["code"])
        if other is not None:
            for k in FILL_FIELDS:
                if not row.get(k) and other.get(k):
                    row[k] = other[k]
                    stats[f"filled_{k}"] += 1
            if norm_title(other.get("title_en", "")) != norm_title(row.get("title_en", "")):
                stats["title_differs"] += 1
            web_tags = list(row.get("tags") or [])
            for t in other.get("tags") or []:
                if t not in web_tags:
                    web_tags.append(t)
                    stats["tags_unioned"] += 1
            row["tags"] = web_tags
            diffs = [
                (k, other.get(k), row.get(k))
                for k in CRITICAL_FIELDS
                if other.get(k) != row.get(k)
            ]
            if diffs:
                code = row["code"]
                if code in CATALOGUE_WINS_DURATION:
                    row["duration_min"] = other["duration_min"]
                    row["end_time"] = other["end_time"]
                    stats["duration_from_catalogue"] += 1
                    conflicts.append(f"{code} 片长取册子({CATALOGUE_WINS_DURATION[code]}): "
                                     f"{other['duration_min']}′ {other['end_time']}")
                elif code in KNOWN_KEEP_WEB:
                    stats["known_keep_web"] += 1
                    conflicts.append(f"{code} 已知差异,保留官网({KNOWN_KEEP_WEB[code]}): "
                                     f"{[(k, a, b) for k, a, b in diffs]}")
                else:
                    stats["unregistered_conflict"] += 1
                    conflicts.append(f"{code} ⚠ 未登记冲突 {[(k, a, b) for k, a, b in diffs]}")
        merged.append(row)

    # 同一场次在两源里编号不同的兜底去重:册子里少数**无编号**的仪式/活动场次
    # (如 BAFA 毕展)与官网那条会各自成一行,只按 code 判会当成两场 → 用户看到重复条目。
    # 判据 = 日期 + 开始时间 + 归一化片名 + 场馆,四项全等才算同一场(保守,宁可漏判不误删)。
    web_identity = {
        (s["date"], s["start_time"], norm_title(s.get("title_en", "")), s["venue_id"])
        for s in merged
    }
    added: list[dict] = []
    for s in cat:
        if s["code"] in web_codes:
            continue
        row = dict(s)
        row["venue_id"] = VENUE_RENAMES.get(row["venue_id"], row["venue_id"])
        row["title_zh"] = title_index.get(norm_title(row.get("title_en", "")), "")
        ident = (row["date"], row["start_time"], norm_title(row.get("title_en", "")), row["venue_id"])
        if ident in web_identity:
            stats["duplicate_dropped"] += 1
            log("INFO", f"册子 {row['code']} 与官网同场次重复(同日期/时间/片名/场馆)→ 丢弃,保留官网编号")
            continue
        web_identity.add(ident)
        added.append(row)
        stats["added_from_catalogue"] += 1
    merged += added

    for line in conflicts:
        log("CONFLICT", line)
    if stats["unregistered_conflict"] and strict:
        log("FAIL", f"有 {stats['unregistered_conflict']} 条未登记冲突(--strict)")
    log("SANITY", f"合并场次: 官网 {len(web)} + 册子新增 {len(added)} "
                  f"(另有 {stats['duplicate_dropped']} 条与官网同场次重复被丢弃) = {len(merged)}")
    log("SANITY", f"册页号补齐 {stats['filled_page']} 条; title_kr 补齐 {stats['filled_title_kr']} 条; "
                  f"片长取册子 {stats['duration_from_catalogue']} 条; "
                  f"片名排版差异(保留官网){stats['title_differs']} 条; "
                  f"tags 并集新增 {stats['tags_unioned']} 条; "
                  f"场馆 id 改名 {stats['venue_renamed']} 条")
    return merged, stats


def merge_venues(web: list[dict], cat: list[dict], used_ids: set[str]) -> list[dict]:
    """官网场馆表为底 + 册子新厅;按 `INSERT_AFTER` 定位,其余追加到末尾。

    被改名的旧 id(如 `br`)不再有任何场次引用 → 自然从结果里消失,
    新 id(`bt`)按锚点插回原位置(同影院的其他厅旁边)。
    """
    cat_by_id = {v["id"]: v for v in cat}

    out: list[dict] = [v for v in web if v["id"] in used_ids]
    have = {v["id"] for v in out}
    for vid in sorted(used_ids - have):
        entry = cat_by_id.get(vid)
        if entry is None:
            log("WARN", f"合并后出现的场馆 {vid} 在两份 venues 里都没有 → 跳过(请补场馆表)")
            continue
        anchor = INSERT_AFTER.get(vid)
        pos = next((i + 1 for i, v in enumerate(out) if v["id"] == anchor), len(out))
        out.insert(pos, entry)
        log("INFO", f"新增场馆 {vid} = {entry['name']}(插在 {anchor or '末尾'})")

    # 场次里出现的厅必须全部登记,否则甘特图会出现没有行标签的泳道
    missing = used_ids - {v["id"] for v in out}
    if missing:
        log("FAIL", f"场馆表缺 {sorted(missing)}")
    return out


def main() -> int:
    """CLI 入口。"""
    ap = argparse.ArgumentParser(description="官网排期 + 官方册子 → schedule.json / venues.json")
    ap.add_argument("--catalogue", required=True, help="extract_schedule.py 产出的册子排期")
    ap.add_argument("--catalogue-venues", required=True)
    ap.add_argument("--web", required=True, help="当前 schedule.json(官网抓取产物)")
    ap.add_argument("--web-venues", required=True)
    ap.add_argument("--films", required=True, help="films.json(补 title_zh 用)")
    ap.add_argument("--out", default="schedule.json")
    ap.add_argument("--venues-out", default=None)
    ap.add_argument("--strict", action="store_true", help="有未登记冲突时退出码 1")
    args = ap.parse_args()

    cat_file = load_json(args.catalogue)
    web_file = load_json(args.web)
    cat = cat_file["screenings"]
    web = web_file["screenings"]
    films = load_json(args.films).get("films", [])

    log("INFO", f"册子 {len(cat)} 场 / 官网 {len(web)} 场")
    title_index = build_title_index(films)

    merged, stats = merge_screenings(web, cat, title_index, args.strict)

    # code 唯一性:前端 byCode / slots / cardEls 都以 code 为键
    dup = [c for c, n in Counter(s["code"] for s in merged).items() if n > 1]
    if dup:
        log("FAIL", f"code 重复 {dup[:10]}")
        return 1

    per_day = Counter(s["date"] for s in merged)
    log("SANITY", f"每日场次: {dict(sorted(per_day.items()))}")
    log("SANITY", f"场馆场次: {dict(Counter(s['venue_id'] for s in merged).most_common())}")

    schedule = {
        "festival": {
            **web_file["festival"],
            "note": (
                "数据来源:官方排期页 www.biff.kr/eng/html/schedule/date.asp(由 tools/scrape_biff_web.py 抓取)"
                " ∪ 2026 官方 Ticket Catalogue PDF(2026-09-10 付印,由 tools/extract_schedule.py 解析,"
                "由 tools/merge_schedule.py 合成)。以官网为骨架(活数据:改时间/加场/活动场次),"
                "册子补官网完全没有的场次(MEGABOX Busan Theater 1–4 Community BIFF,官方编号 901–942)与册页号;"
                "**不含 P&I(Press & Industry)场次** —— 册子排期页的 BD/C7 两列是记者/业界场,不对外售票;"
                "场馆按「厅」建 id(id = 官方影院代码小写,如 b1/c3/l10);"
                "GV 场次的 end_time 已含 25min 映后谈;联映块(묶)的 duration_min 为块内成员片长之和;"
                "开闭幕式与获奖片重映的片长以册子印的为准(官网无详情页时是 120min 兜底值);"
                "两源会持续变动,以开映前官方页面为准。"
            ),
            "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        },
        "screenings": merged,
    }
    write_json(args.out, schedule)
    log("OK", f"写出 {args.out}:{len(merged)} 场")

    if args.venues_out:
        venues = merge_venues(load_json(args.web_venues)["venues"],
                              load_json(args.catalogue_venues)["venues"],
                              {s["venue_id"] for s in merged})
        write_json(args.venues_out, {"venues": venues})
        log("OK", f"写出 {args.venues_out}:{len(venues)} 场馆")

    if stats["unregistered_conflict"] and args.strict:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
