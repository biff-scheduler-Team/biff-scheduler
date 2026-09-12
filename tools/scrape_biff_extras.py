#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""scrape_biff_extras.py — 从 BIFF 官网抓「排期之外」的辅助信息 → apps/web/public/festival-extras.json

背景
----
`tools/scrape_biff_web.py` 抓的是**排期**(时间 / 厅 / 片名)。本脚本抓的是排期页上
看不到、但**抢票要用**的那几块:

1. **售票信息**(Booking Information, `page_num=11402`)——
   开票批次 / 在线售票期 / 票价 / 折扣 / 购票须知 / 票亭地点。
2. **节目嘉宾**(Master Class 11219 · Actors' House 11218 · Cine Class 11366 ·
   Special Talk 11226 + 11223)—— 每场的主讲 / 嘉宾 / 简介 / 票价 / 语言。
3. **开闭幕式**(Opening & Closing Information, `page_num=11233`)——
   红毯 / 主活动 / 放映时间表 + 封路时段。

节目块只保留**在 `apps/web/public/schedule.json` 里真实存在**的 code(自动滤掉官网页面上的
往届遗留条目,如 2025 的 Camellia Award 得主)。

产物
----
    <out>   默认 apps/web/public/festival-extras.json

用法
----
    python tools/scrape_biff_extras.py
    python tools/scrape_biff_extras.py --offline     # 复用缓存 HTML,只重跑解析
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

BASE = "https://www.biff.kr"
PAGE_URL = BASE + "/eng/addon/10000001/page.asp?page_num={num}"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
)

# 活动页:kind → 官网 page_num(同一 kind 可有多页,如 Special Talk 两页)
PROGRAM_PAGES: list[tuple[str, str]] = [
    ("actors_house", "11218"),
    ("master_class", "11219"),
    ("cine_class", "11366"),
    ("special_talk", "11226"),
    ("special_talk", "11223"),
]

PAGE_BOOKING = "11402"
PAGE_CEREMONY = "11233"

# 嘉宾英文名 → 中文名(人工维护;查不到就只印英文名,不硬译)
GUEST_ZH: dict[str, str] = {
    "LEE Minho": "李敏镐",
    "KIM Goeun": "金高银",
    "KIM Minha": "金敏荷",
    "RYU Seung-ryong": "柳承龙",
    "JU Jihoon": "朱智勋",
    "SHIN Mina": "申敏儿",
    "NA Hong-jin": "罗泓轸",
    "Lav DIAZ": "拉夫·迪亚兹",
    "Bertrand MANDICO": "贝特朗·芒迪科",
    "Rintaro": "林太郎",
    "ZHANG Lu": "张律",
    "Seifollah SAMADIAN": "塞福拉·萨马迪安",
    "Judith GODRÈCHE": "朱迪丝·戈德雷什",
    "Billy ACUMEN": "比利·阿库门",
    "BI Gan": "毕赣",
    "SHIM Eun-kyoung": "沈恩京",
    "Ann HUI": "许鞍华",
    "BONG Joon-ho": "奉俊昊",
    "FAN Bingbing": "范冰冰",
    "HONG Kyung-pyo": "洪坰杓",
    "KIM Tae-ho": "金泰浩",
    "AHN Sung-ki": "安圣基",
    "JUNG Sung-il": "郑圣一",
}

# 节目页里会出现的「标签行」—— 解析时用于区分「标签」与「值」
LABELS = {
    "Date",
    "Code",
    "Venue",
    "Price",
    "Language",
    "Moderator",
    "Moderater",
    "Guest",
    "OPEN",
    "More Filmography",
}

KIND_LABELS = {"Actors’ House", "Actors' House", "Master Class", "Special Talk", "Cine Class", "Carte Blanche"}

RE_CODE = re.compile(r"^\d{3}$")
RE_DATE_TIME = re.compile(r"^([A-Z][a-z]{2} \d+ \([A-Za-z]{3}\))\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$")
RE_MONEY = re.compile(r"KRW\s*([\d,]+)")
RE_PERSON_PREFIX = re.compile(r"^(Actor|Director|Guest|Moderator)\s+(.+)$")


def fetch(page_num: str, cache_dir: Path, offline: bool, delay: float) -> str:
    """取某页 HTML;`--offline` 时只读缓存,缓存缺失即报错退出(不静默抓网)。"""
    cache = cache_dir / f"p{page_num}.html"
    if offline:
        if not cache.exists():
            raise SystemExit(f"缓存缺失: {cache}(先不带 --offline 跑一次)")
        return cache.read_text(encoding="utf-8", errors="replace")
    req = urllib.request.Request(PAGE_URL.format(num=page_num), headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as exc:  # 网络层失败必须显式暴露,不能产出半份 JSON
        raise SystemExit(f"抓取 page_num={page_num} 失败: {exc}") from exc
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache.write_text(raw, encoding="utf-8")
    time.sleep(delay)
    return raw


def page_lines(raw: str) -> list[str]:
    """HTML → 正文行(只取 CONTENTS AREA;该注释缺失时退回整页)。

    块级标签一律转成换行,故「标签」与「值」天然落在相邻两行 —— 解析全靠这一点。
    """
    m = re.search(r"<!--//START: CONTENTS AREA-->(.*?)(?:<!--//END: CONTENTS AREA-->|</body>)", raw, re.S)
    body = m.group(1) if m else raw
    body = re.sub(r"<script.*?</script>", " ", body, flags=re.S | re.I)
    body = re.sub(r"<style.*?</style>", " ", body, flags=re.S | re.I)
    body = re.sub(r"<(?:br|/p|/div|/li|/dd|/dt|/h[1-6]|/tr|/td|/table|/section|/dl)[^>]*>", "\n", body, flags=re.I)
    body = re.sub(r"<[^>]+>", " ", body)
    body = html.unescape(body)
    out: list[str] = []
    for line in body.split("\n"):
        clean = re.sub(r"\s+", " ", line).strip()
        if clean:
            out.append(clean)
    return out


def money(text: str) -> Optional[int]:
    m = RE_MONEY.search(text)
    return int(m.group(1).replace(",", "")) if m else None


def guest_zh(name: str) -> Optional[str]:
    return GUEST_ZH.get(name)


def next_value(lines: list[str], start: int, limit: int = 6) -> str:
    """从 `start` 之后取第一个「非标签」行作为某标签的值(最多看 limit 行)。"""
    for i in range(start + 1, min(len(lines), start + 1 + limit)):
        if lines[i] not in LABELS:
            return lines[i]
    return ""


def parse_programs(lines: list[str], kind: str) -> list[dict[str, Any]]:
    """从活动页正文抽出节目块 —— **以 `Date` 标签为块边界**(每个节目恰好一个 Date)。

    官网三种活动页的字段顺序**并不一致**(Actors' House 的 Price/Venue 在 `Code` 之前,
    Master Class 在其之后),故以 `Code` 为块中心会串行;以 `Date` 切块则三种都覆盖:

        标题 / 嘉宾 / 简介  ← 落在**上一个块**尾部(本 Date 之前)
        Date 值 / Code / Venue / Price / Language  ← 落在本块内
    """
    date_anchors = [
        i for i in range(len(lines) - 1) if lines[i] == "Date" and lines[i + 1] not in LABELS
    ]
    out: list[dict[str, Any]] = []
    for n, d in enumerate(date_anchors):
        end = date_anchors[n + 1] if n + 1 < len(date_anchors) else len(lines)
        block = lines[d:end]
        code = ""
        venue = ""
        price: Optional[int] = None
        language = ""
        moderator = ""
        for j, line in enumerate(block):
            if line == "Code" and j + 1 < len(block) and RE_CODE.match(block[j + 1]):
                code = block[j + 1]
            elif line == "Venue":
                venue = next_value(block, j)
            elif line == "Price":
                price = money(next_value(block, j))
            elif line == "Language":
                language = next_value(block, j)
            elif line in ("Moderator", "Moderater"):
                moderator = next_value(block, j)
        if not code:
            continue

        # 标题 / 嘉宾 / 简介:从本 Date 向前找(边界 = 上一个 Date 的值之后)
        start = date_anchors[n - 1] + 2 if n > 0 else 0
        title = ""
        guest = ""
        for i in range(d - 1, max(start - 1, d - 16), -1):
            cand = lines[i]
            if cand in LABELS or cand in KIND_LABELS or RE_DATE_TIME.match(cand):
                continue
            if ":" in cand and len(cand) <= 120:
                title = cand
                break
        bio: list[str] = []
        if title:
            # 标题在页内常出现两次(简介前一次、`Special Talk` 标签后一次)—— 取**最靠近 Date** 的那次
            positions = [i for i in range(start, d) if lines[i] == title]
            tpos = positions[-1] if positions else start
            for i in range(tpos - 1, max(start - 1, tpos - 4), -1):
                cand = lines[i]
                if cand in LABELS or cand in KIND_LABELS:
                    continue
                pm = RE_PERSON_PREFIX.match(cand)
                if pm:
                    guest = pm.group(2).strip()
                    break
                if re.match(r"^[A-Z][\w'’.\-]*( [A-Za-z][\w'’.\-]*)+$", cand):
                    guest = cand
                    break
            bio = [x for x in lines[tpos + 1 : d] if x not in LABELS and not x.endswith("Filmography")]
        # Carte Blanche 系列标题形如「Carte Blanche: 片名 X 嘉宾名」(x 大小写不固定)—— 嘉宾从标题尾段取
        if not guest and title.startswith("Carte Blanche: "):
            m = re.search(r"\s[xX]\s", title)
            if m:
                guest = title[m.end() :].strip()
        # Cine Class 一类标题就是「人名: 讲题」—— 冒号前那段即嘉宾(排除 kind 标签与含逗号的讲题)。
        # ⚠ 只对 cine_class 生效:Special Talk 的「片名 : 说明」冒号前是片名,不是人名(如 Mother Mary)。
        if not guest and kind == "cine_class" and ":" in title:
            head = title.split(":", 1)[0].strip()
            if head and head not in KIND_LABELS and "," not in head and 1 <= len(head.split()) <= 4:
                guest = head

        out.append(
            {
                "code": code,
                "kind": kind,
                "title": title,
                "guest": guest,
                "guestZh": guest_zh(guest),
                "dateText": block[1] if len(block) > 1 else "",
                "priceKrw": price,
                "language": language,
                "venue": venue,
                "moderator": moderator,
                "bio": " ".join(bio)[:600],
            }
        )
    return out


def parse_ticketing(lines: list[str]) -> dict[str, Any]:
    """售票页 → 开票批次 / 售票期 / 票价 / 折扣 / 须知。"""
    batches: list[dict[str, Any]] = []
    for i, line in enumerate(lines):
        if line == "OPEN" and i > 0 and i + 1 < len(lines):
            batches.append({"includes": lines[i - 1], "openText": lines[i + 1]})
    # 票价表:页内有多处 `Price`(左侧菜单锚点也算一个),取**第一个能解析出 ≥2 档 KRW** 的
    prices: list[dict[str, Any]] = []
    for i, line in enumerate(lines):
        if line != "Price":
            continue
        probe: list[dict[str, Any]] = []
        j = i + 1
        while j < len(lines) - 1 and len(probe) < 8:
            if lines[j] in ("Discount Policy", "Ticket Booking Information", "Notice on Reservations"):
                break
            val = money(lines[j + 1])
            if val is not None and lines[j] not in LABELS:
                probe.append({"label": lines[j], "krw": val})
                j += 2
            else:
                j += 1
        if len(probe) >= 2:
            prices = probe
            break
    discount = None
    for i, line in enumerate(lines):
        if line.startswith("Discount Amount"):
            discount = money(line)
            break
    notes: list[str] = []
    if "Online Ticket Booking Guidelines & Notices" in lines:
        i = lines.index("Online Ticket Booking Guidelines & Notices")
        for j in range(i + 1, min(len(lines), i + 20)):
            cand = lines[j]
            if cand in ("BIFF Ticket Box Place & Operating Hours", "Price"):
                break
            if len(cand) > 12:
                notes.append(cand)
    call_center = ""
    for line in lines:
        m = re.search(r"Call Center\(([\d-]+)\)", line)
        if m:
            call_center = m.group(1)
            break
    return {
        "batches": batches,
        "prices": prices,
        "discountKrw": discount,
        "notes": notes,
        "callCenter": call_center,
        "url": PAGE_URL.format(num=PAGE_BOOKING),
    }


def parse_ceremony(lines: list[str]) -> dict[str, Any]:
    """开闭幕式页 → 开 / 闭幕日期 + 公共时间表(入场 / 红毯 / 主活动 / 放映)+ 封路时段。"""
    slots: list[dict[str, str]] = []
    for i, line in enumerate(lines):
        m = re.match(r"^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s+(.+)$", line)
        if not m:
            continue
        text = m.group(3)
        # 「20:20 - 21:40 Screening of」这类在官网被换行断开 → 与下一行合并(下一行不是时间行时)
        if text.endswith((" of", " the", " and")) and i + 1 < len(lines):
            nxt = lines[i + 1]
            if not re.match(r"^\d{1,2}:\d{2}", nxt):
                text = f"{text} {nxt}"
        slots.append({"time": f"{m.group(1)}–{m.group(2)}", "text": text})
    dates = [m.group(1) for line in lines if (m := re.match(r"^(Oct \d+\([A-Za-z]{3}\))$", line))]
    traffic: list[dict[str, str]] = []
    for i, line in enumerate(lines):
        m = re.match(r"^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$", line)
        if not m:
            continue
        road = ""
        for j in range(i - 1, max(-1, i - 4), -1):  # 向上找第一个「不以括号开头」的行 = 路名
            if lines[j] and not lines[j].startswith("("):
                road = lines[j]
                break
        traffic.append({"window": f"{m.group(1)}–{m.group(2)}", "road": road})
    return {
        "openingDate": dates[0] if dates else "",
        "closingDate": dates[1] if len(dates) > 1 else "",
        "slots": slots,
        "traffic": traffic,
        "url": PAGE_URL.format(num=PAGE_CEREMONY),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="抓 BIFF 官网辅助信息(售票 / 嘉宾 / 开闭幕式)")
    ap.add_argument("--out", default="apps/web/public/festival-extras.json", help="产物 JSON 路径")
    ap.add_argument("--cache-dir", default="data/_cache/extras", help="HTML 缓存目录")
    ap.add_argument("--offline", action="store_true", help="只用缓存,不联网")
    ap.add_argument("--delay", type=float, default=0.4, help="每页抓取间隔(秒)")
    args = ap.parse_args()

    cache_dir = Path(args.cache_dir)
    out_path = Path(args.out)

    # 有效 code 集合:以排期为准,自动滤掉官网页面上的往届遗留节目
    schedule_path = out_path.parent / "schedule.json"
    valid_codes: set[str] = set()
    if schedule_path.exists():
        data = json.loads(schedule_path.read_text(encoding="utf-8"))
        valid_codes = {str(s.get("code")) for s in data.get("screenings", [])}
    else:
        print(f"⚠ 未找到 {schedule_path} —— 不做 code 过滤", file=sys.stderr)

    programs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for kind, num in PROGRAM_PAGES:
        lines = page_lines(fetch(num, cache_dir, args.offline, args.delay))
        got = parse_programs(lines, kind)
        for p in got:
            if p["code"] in seen:
                continue
            if valid_codes and p["code"] not in valid_codes:
                continue  # 往届遗留(如 2025 的 Camellia Award)
            seen.add(p["code"])
            programs.append(p)
    programs.sort(key=lambda p: p["code"])

    ticketing = parse_ticketing(page_lines(fetch(PAGE_BOOKING, cache_dir, args.offline, args.delay)))
    ceremony = parse_ceremony(page_lines(fetch(PAGE_CEREMONY, cache_dir, args.offline, args.delay)))

    payload = {
        "source": BASE + "/eng/",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "ticketing": ticketing,
        "programs": programs,
        "ceremony": ceremony,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # 自检:关键字段缺失要当场看见,而不是留到前端才发现是空壳
    print(f"✓ 写出 {out_path}")
    print(f"  开票批次 {len(ticketing['batches'])} · 票价 {len(ticketing['prices'])} 档 · 须知 {len(ticketing['notes'])} 条")
    print(f"  节目 {len(programs)} 场(Actors' House / Master Class / Cine Class / Special Talk)")
    for p in programs:
        missing = [k for k in ("title", "dateText", "priceKrw") if not p.get(k)]
        flag = f"  ⚠ 缺 {'/'.join(missing)}" if missing else ""
        print(f"    {p['code']} {p['kind']:<13} {p.get('guest') or '-':<22}{flag}")
    print(f"  开闭幕式时间点 {len(ceremony['slots'])} · 封路 {len(ceremony['traffic'])} 条")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
