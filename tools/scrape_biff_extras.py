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
# `dateText` 里的「月 日」—— 用于判定该节目是否落在本届展期内(见 month_day_in_range)
RE_MONTH_DAY = re.compile(
    r"\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})\b", re.I
)
MONTH_NUM: dict[str, int] = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}


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


# ---------------------------------------------------------------- 票亭表(HTML 表格)
# 为什么不用 `page_lines` 那套扁平文本:票亭表靠 **rowspan/colspan 合并单元格**表达
# 「哪几行共用同一个值」(实测 Payment 一列 8 行合并、Place 两列合并),扁平化会把这个
# 唯一的语义丢掉 —— 剩下的行值对不上号。
RE_TABLE = re.compile(r"<table\b[\s\S]*?</table>", re.I)
RE_TR = re.compile(r"<tr\b[^>]*>([\s\S]*?)</tr>", re.I)
RE_CELL = re.compile(r"<t([hd])\b([^>]*)>([\s\S]*?)</t\1>", re.I)
RE_SPAN = re.compile(r"(rowspan|colspan)\s*=\s*\"?(\d+)", re.I)
RE_BR = re.compile(r"<br\s*/?>", re.I)
RE_TAG = re.compile(r"<[^>]+>")


def cell_text(frag: str) -> str:
    """单元格 HTML → 单行文本(`<br>` 折成空格,标签剥掉,空白归一)。"""
    return re.sub(r"\s+", " ", html.unescape(RE_TAG.sub("", RE_BR.sub(" ", frag)))).strip()


def table_rows(table_html: str) -> list[dict[str, str]]:
    """一张 `<table>` → 行字典列表(表头为键,rowspan/colspan 已展开)。

    表头行 = 首个含 `<td>` 的行**之前**的所有行(本页表头是两行:第一行有
    `Operating Hours` 跨列,第二行才是 `Open`/`Close`)。每列取**最靠下**的表头文本,
    故跨列标题会被更具体的子标题取代;同名多列(Place 占两列)合并成一个值。
    """
    grid: dict[tuple[int, int], str] = {}
    header_rows: list[int] = []
    body_rows: list[int] = []
    for r, row_html in enumerate(RE_TR.findall(table_html)):
        cells = RE_CELL.findall(row_html)
        if not cells:
            continue
        (header_rows if not any(tag == "d" for tag, _a, _b in cells) else body_rows).append(r)
        col = 0
        for _tag, attrs, body in cells:
            while (r, col) in grid:
                col += 1
            spans = {k.lower(): int(v) for k, v in RE_SPAN.findall(attrs)}
            text = cell_text(body)
            for dr in range(spans.get("rowspan", 1)):
                for dc in range(spans.get("colspan", 1)):
                    grid[(r + dr, col + dc)] = text
            col += spans.get("colspan", 1)
    if not grid or not body_rows:
        return []
    ncols = max(c for _r, c in grid) + 1
    headers: list[str] = []
    for c in range(ncols):
        texts = [grid[(r, c)] for r in header_rows if (r, c) in grid]
        headers.append(texts[-1] if texts else "")
    out: list[dict[str, str]] = []
    for r in body_rows:
        row: dict[str, str] = {}
        for c, name in enumerate(headers):
            if not name:
                continue
            val = grid.get((r, c), "")
            # 同名多列合并成一个值;`colspan` 让两列拿到**同一个**字符串时不能拼两遍
            # (实测 Place 跨两列,合并后会出现 `CGV Centum City 7F CGV Centum City 7F`)
            if not val or row.get(name) == val:
                continue
            row[name] = f"{row[name]} {val}".strip() if name in row else val
        if row:
            out.append(row)
    return out


def parse_ticket_boxes(raw: str) -> list[dict[str, str]]:
    """售票页「BIFF Ticket Box Place & Operating Hours」→ 每处票亭一行。

    锚点之后有两张表(第一张是「Online」单行表),取**正文行数更多**的那张 = 票亭表。
    """
    anchor = "BIFF Ticket Box Place & Operating Hours"
    at = raw.find(anchor)
    if at < 0:
        return []
    tables = [table_rows(m.group(0)) for m in RE_TABLE.finditer(raw, at)]
    tables = [t for t in tables if t]
    if not tables:
        return []
    boxes = max(tables, key=len)
    out: list[dict[str, str]] = []
    for row in boxes:
        out.append({
            "place": row.get("Place", ""),
            "period": row.get("Period", ""),
            "open": row.get("Open", ""),
            "close": row.get("Close", ""),
            "payment": row.get("Payment", ""),
        })
    return out


def guest_zh(name: str) -> Optional[str]:
    return GUEST_ZH.get(name)


def month_day_in_range(text: str, first: tuple[int, int], last: tuple[int, int]) -> bool:
    """`dateText` 里的「月 日」是否落在展期内 —— 挡往届遗留节目的通用闸门。

    为什么需要它:节目页(11218 / 11219 / 11223 / 11226 / 11366)会**同时挂着往届条目**。
    只按 code 过滤挡不住 —— 2026 排期恰好复用了 2025 用过的编号(实测 338 / 408),
    于是 2025 的 Carte Blanche 会串到今年的场次上,前端把去年的嘉宾挂到今年的片子上。
    按日期判定与编号无关,编号怎么复用都不会再漏。

    解析不出日期的条目**一律丢弃**(宁可少一条,也不显示一个错的时间)。
    """
    m = RE_MONTH_DAY.search(text or "")
    if not m:
        return False
    mon = MONTH_NUM.get(m.group(1).lower())
    if not mon:
        return False
    return first <= (mon, int(m.group(2))) <= last


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


def parse_sales_period(lines: list[str]) -> dict[str, str]:
    """在线售票期 / 时长 / 支付方式。

    ⚠ 定位靠**期段模式**(`9.17` + `~` + `10.15`),不要用 `lines.index("Online")` ——
    页内 `Online` 先出现在票亭表的**列头**(在含期段的数据行之前),`index` 会取到列头,
    从那里往后切出来的片段里根本没有期段(实测解析为空)。按模式找与行的先后无关。
    """
    out = {"period": "", "hours": "", "payment": ""}
    for i in range(len(lines) - 2):
        if not re.fullmatch(r"\d{1,2}\.\d{1,2}", lines[i]):
            continue
        if lines[i + 1] != "~" or not re.fullmatch(r"\d{1,2}\.\d{1,2}", lines[i + 2]):
            continue
        out["period"] = f"{lines[i]} ~ {lines[i + 2]}"
        seg = lines[i + 3 : i + 8]
        out["hours"] = "24 Hours" if "24 Hours" in seg else ""
        out["payment"] = " / ".join(x for x in seg if x in ("Credit card", "Debit card", "Cash"))
        break
    return out


def parse_refunds(lines: list[str]) -> dict[str, Any]:
    """取消与退款:截止口径 / 取消方式 / 三档取消费。

    费用表以「…before screening」结尾的行为锚点,紧跟一行是费用(可能带括号的典礼加价),
    再一行可能是 `※` 备注 —— 三条恰好覆盖官网表格的三行。
    """
    deadline = ""
    for line in lines:
        if line.startswith("Cancellations are accepted"):
            deadline = line
            break
    how_to: list[str] = []
    if "How to Cancel" in lines:
        i = lines.index("How to Cancel")
        for j in range(i + 1, min(len(lines), i + 6)):
            if lines[j] == "Cancellation Fee":
                break
            how_to.append(lines[j])
    fees: list[dict[str, str]] = []
    for i, line in enumerate(lines):
        if not line.endswith("before screening") or i + 1 >= len(lines):
            continue
        fee = lines[i + 1]
        k = i + 2
        if k < len(lines) and lines[k].startswith("("):
            fee = f"{fee} {lines[k]}"
            k += 1
        note = lines[k] if k < len(lines) and lines[k].startswith("※") else ""
        fees.append({"when": line, "fee": fee, "note": note})
    notes: list[str] = []
    if "Cancellation Fee" in lines:
        i = lines.index("Cancellation Fee")
        notes = [
            x
            for x in lines[i:]
            if x.startswith(("Reservations are possible", "(For combined", "In the case of screening"))
        ]
    return {"deadline": deadline, "howTo": how_to, "fees": fees, "notes": notes}


def parse_discounts(lines: list[str]) -> list[dict[str, Any]]:
    """折扣三档(无障碍/高龄/退伍 · BCC 付费会员 · 轮椅位)及各自适用条件。

    结构是「组名 → 条件若干 → `※` 备注若干」。组名与条件的区分靠**开头词**:
    条件行一律以 Applies/Applicable/Pre-registration/Discount/ID 起头,组名是短名词短语。
    """
    if "Discount Policy" not in lines:
        return []
    # ⚠ 取「正文标题」而非「左侧菜单锚点」:菜单里那个 `Discount Policy` 在页首,
    # 紧跟的是 `Ticket Booking Information`,循环会当场 break(实测返回 0 组)。
    # 正文标题的判据 = 下一行以 `Discount Amount` 开头。
    i = -1
    for j, line in enumerate(lines):
        if line == "Discount Policy" and j + 1 < len(lines) and lines[j + 1].startswith("Discount Amount"):
            i = j
            break
    if i < 0:
        return []
    groups: list[dict[str, Any]] = []
    who = ""
    terms: list[str] = []
    for j in range(i + 1, len(lines)):
        cand = lines[j]
        if cand == "Ticket Booking Information":
            break
        if cand.startswith("Discount Amount"):
            continue
        if cand.startswith("※"):
            if who:
                terms.append(cand)
            continue
        if cand.startswith(("Applies to", "Applicable", "Pre-registration", "Discount applicable", "ID,")):
            if who:
                terms.append(cand)
            continue
        if who:
            groups.append({"who": who, "terms": terms})
        who = cand
        terms = []
    if who:
        groups.append({"who": who, "terms": terms})
    return groups


def parse_service_desk(lines: list[str]) -> dict[str, Any]:
    """数字弱势群体服务台:地点 / 适用人群 / 可购场次 / 备注。"""
    title = "Service Desks for Digitally Excluded Audiences"
    if title not in lines:
        return {}
    tail = lines[lines.index(title) :]

    def after(label: str) -> str:
        return tail[tail.index(label) + 1] if label in tail else ""

    notes = [
        x
        for x in tail
        if x.startswith("※")
        or x.startswith(("On the Opening day", "Community BIFF screenings", "Operating hours"))
    ]
    return {
        "location": after("Location"),
        "eligible": after("Eligible Users"),
        "screenings": after("Screenings Available for Purchase"),
        "notes": notes,
    }


def parse_venue_rules(pdf_path: str) -> dict[str, Any]:
    """官方册子 p20「Theater Regulations」→ 入场 / 年龄 / 场内规则(册子原文)。

    ⚠ 这一节**只在付印册子上有**:官网售票页 grep `screening begins` = 0 命中
    (实测 2026-09-14)→ 不能像其他字段那样从网页取,只能读 PDF。

    版式(实测):左栏是标题(竖排 `Theater Regulations`),正文在 x ≥ 540;
    每条以项目符号起行(首字符非字母数字),`※` 起行的是**上一条的附注**,
    其余行是**上一条的续行**。y ≥ 245 起是 Lost-and-Found 一节。
    """
    import pymupdf

    page = pymupdf.open(pdf_path)[19]  # 0-based 19 = 印刷页 20(票务信息英文页)
    rows: list[tuple[float, str]] = []
    for blk in page.get_text("dict")["blocks"]:
        if blk.get("type") != 0:
            continue
        for ln in blk["lines"]:
            text = " ".join(s["text"] for s in ln["spans"]).strip()
            if text and ln["bbox"][0] >= 540 and 20 <= ln["bbox"][1] <= 260:
                rows.append((ln["bbox"][1], text))
    rows.sort()

    items: list[dict[str, Any]] = []
    lost: list[str] = []
    in_note = False
    for y, text in rows:
        clean = re.sub(r"^[\uf0ec\u2fec\x07\u00b7\s]+", "", text)
        if y >= 245:
            lost.append(clean)
            continue
        if text.startswith("※"):
            if items:
                items[-1]["notes"].append(re.sub(r"^[※\x07\u00b7\s]+", "", text))
                in_note = True
            continue
        # 判据用**原始行首字符**,不是 lstrip 之后的:`lstrip` 会把项目符号剥掉,
        # 于是每条都变成「字母开头」而被当成上一条的续行(实测会把 7 条并成 1 条)。
        if clean and text[0].isalnum() and items:
            # 续行归谁:上一条若是附注(`※`)就续到附注上,否则续到正文 ——
            # 否则附注的第二行会被拼进正文(实测 `…are not allowed. Sohyang Theatre …`)
            if in_note:
                items[-1]["notes"][-1] = f"{items[-1]['notes'][-1]} {clean}".strip()
            else:
                items[-1]["text"] = f"{items[-1]['text']} {clean}".strip()
            continue
        items.append({"text": clean, "notes": []})
        in_note = False
    return {
        "source": "2026 官方 Ticket Catalogue PDF p20「Theater Regulations」",
        "items": items,
        "lostAndFound": lost,
    }


def parse_ticketing(lines: list[str], raw: str = "") -> dict[str, Any]:
    """售票页 → 开票批次 / 售票期 / 票价 / 折扣 / 退款 / 须知。

    `raw` = 原始 HTML:**购票入口与客服邮箱只存在于 `href` 里**,`page_lines` 已把标签剥掉,
    所以这两项必须回原始 HTML 取 —— 取不到就留空(前端自动隐藏),绝不编造链接。
    """
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
    m = re.search(r'href="(https://ticket\.biff\.kr/[^"]*)"', raw)
    booking_url = m.group(1) if m else ""
    m = re.search(r'href="mailto:([^"]+)"', raw)
    email = m.group(1) if m else ""
    return {
        "batches": batches,
        "prices": prices,
        "discountKrw": discount,
        "ticketBoxes": parse_ticket_boxes(raw),
        "discounts": parse_discounts(lines),
        "refund": parse_refunds(lines),
        "salesPeriod": parse_sales_period(lines),
        "serviceDesk": parse_service_desk(lines),
        "notes": notes,
        "callCenter": call_center,
        "email": email,
        "bookingUrl": booking_url,
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
    ap.add_argument(
        "--catalogue-pdf",
        default=None,
        help="官方 Ticket Catalogue PDF 路径 —— 补「入场与观影规则」(官网售票页不印这一节)",
    )
    args = ap.parse_args()

    cache_dir = Path(args.cache_dir)
    out_path = Path(args.out)

    # 有效 code 集合 + 展期:以排期为准,自动滤掉官网页面上的往届遗留节目
    schedule_path = out_path.parent / "schedule.json"
    valid_codes: set[str] = set()
    fest_days: list[str] = []
    if schedule_path.exists():
        data = json.loads(schedule_path.read_text(encoding="utf-8"))
        screenings = data.get("screenings", [])
        valid_codes = {str(s.get("code")) for s in screenings}
        fest_days = sorted({str(s["date"]) for s in screenings if s.get("date")})
    else:
        print(f"⚠ 未找到 {schedule_path} —— 不做 code 过滤", file=sys.stderr)

    # 展期从排期推导(不硬编码年份):`YYYY-MM-DD` → `(月, 日)`
    first_md = (int(fest_days[0][5:7]), int(fest_days[0][8:10])) if fest_days else (0, 0)
    last_md = (int(fest_days[-1][5:7]), int(fest_days[-1][8:10])) if fest_days else (0, 0)
    if not fest_days:
        print("⚠ 排期无日期 —— 不做展期过滤", file=sys.stderr)

    programs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for kind, num in PROGRAM_PAGES:
        lines = page_lines(fetch(num, cache_dir, args.offline, args.delay))
        got = parse_programs(lines, kind)
        for p in got:
            if p["code"] in seen:
                continue
            if valid_codes and p["code"] not in valid_codes:
                continue  # 往届遗留(如 2025 的 Camellia Award 得主)
            if not month_day_in_range(p.get("dateText", ""), first_md, last_md):
                continue  # 编号被本届复用 → code 过滤失效,改按日期拦(如 338 / 408)
            seen.add(p["code"])
            programs.append(p)
    programs.sort(key=lambda p: p["code"])

    booking_html = fetch(PAGE_BOOKING, cache_dir, args.offline, args.delay)
    ticketing = parse_ticketing(page_lines(booking_html), booking_html)
    if args.catalogue_pdf:
        # 「入场与观影规则」只在付印册子上印(官网售票页没有)→ 必须额外读 PDF
        ticketing["venueRules"] = parse_venue_rules(args.catalogue_pdf)
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
    print(
        f"  售票期 {ticketing['salesPeriod']['period'] or '-'}"
        f" · 退款档 {len(ticketing['refund']['fees'])} · 折扣组 {len(ticketing['discounts'])}"
        f" · 购票入口 {'有' if ticketing['bookingUrl'] else '缺'}"
        f" · 邮箱 {'有' if ticketing['email'] else '缺'}"
    )
    print(f"  票亭 {len(ticketing['ticketBoxes'])} 处"
          f" · 入场与观影规则 {len(ticketing.get('venueRules', {}).get('items', []))} 条"
          f"{'' if ticketing.get('venueRules') else '(未传 --catalogue-pdf)'}")
    print(f"  节目 {len(programs)} 场(Actors' House / Master Class / Cine Class / Special Talk)")
    for p in programs:
        missing = [k for k in ("title", "dateText", "priceKrw") if not p.get(k)]
        flag = f"  ⚠ 缺 {'/'.join(missing)}" if missing else ""
        print(f"    {p['code']} {p['kind']:<13} {p.get('guest') or '-':<22}{flag}")
    print(f"  开闭幕式时间点 {len(ceremony['slots'])} · 封路 {len(ceremony['traffic'])} 条")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
