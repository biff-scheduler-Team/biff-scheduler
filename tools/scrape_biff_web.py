#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""scrape_biff_web.py — 从 BIFF 官网排期页抓排期 → schedule.json / venues.json

背景
----
`tools/extract_schedule.py` 解析的是官方 Ticket Catalogue **PDF**(付印版),
付印后到开幕前的改动(加场 / 改时间 / 换厅)它看不到。官网的
`/eng/html/schedule/date.asp?day1=<N>` 是**活的**排期,本脚本直接抓它。

抓什么
------
* 排期:10 个日期页(day1=6..15),每页按「影院/厅」分组,组内是场次格子
  (`div.sch_it`),带场次编号(`data-scode`)、时间、片名、详情页链接、
  观影等级、字幕标识、GV、联映块(`묶` + 成员片名)。
* 片长:排期页**不含**片长,要按详情页 `prog_view.asp?idx=..` 逐个回填
  (韩文页拿韩文片名,英文页拿国家 / 年份 / 片长 / 单元)。
* 场馆代码:官网英文页只给影院全名,不给 B1/C3/L10 这类代码 —— 由
  `VENUE_TABLE` 静态映射(与 2025 口径一致);表外的新厅会**报错退出**,
  逼你补表而不是静默丢数据。

三类特殊条目(都是官网真实存在、但结构不同的格子)
----------------------------------------------
1. **联映块**(`묶`,`div.pack` 里挂成员片名):时长 = 块内成员片长之和,
   成员片名进 `midnight_members`。
2. **活动场次**(`Actors' House` / `Master Class` / `Special Talk`):链接指向
   `addon/…/page.asp`,里面印了 `18:50 - 19:50` 这样的时间区间 → 直接算时长。
3. **开闭幕式 / 获奖片重映 / 官网未编号场**:既无详情页也无时间区间 ——
   `duration_min` 用 `FALLBACK_DURATION_MIN` 兜底,并在自检里**逐条列出**,
   绝不混进真实数据里。

用法
----
    python tools/scrape_biff_web.py --out-dir /tmp/biff2026

    # 已经下过一遍 HTML(缓存目录里),只想重跑解析
    python tools/scrape_biff_web.py --out-dir /tmp/biff2026 --offline

产物
----
    <out-dir>/schedule.json        与 apps/web/public/schedule.json 同契约
    <out-dir>/venues.json          与 apps/web/public/venues.json 同契约
    <out-dir>/film-meta.json       idx → 片名 / 单元 / 年份 / 国家 / 片长(交叉核对用)
    <out-dir>/_cache/*.html        原始页缓存(--offline 复用;可随时删)

抓完直接看自检输出(场次总数 / 编号唯一性 / 未知场馆),再决定要不要
`cp` 进 `public/`。
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

BASE = "https://www.biff.kr"
DATE_URL = BASE + "/eng/html/schedule/date.asp?day1={day}"
PROG_URL = BASE + "/{lang}/html/program/prog_view.asp?idx={idx}&c_idx={c_idx}"
NAV_URL = BASE + "/eng/html/schedule/date.asp?day1=6"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
)

# 场馆表:官网英文全名 → (id, 官方代码, 短名, 影院组, 分区, 韩文名)
# id 口径与 2025 一致:`<影院代码小写>`(b1 / c3 / l10 …);官方没给新厅代码时按同族顺延。
VENUE_TABLE: dict[str, tuple[str, str, str, str, str, str]] = {
    "Busan Cinema Center Cinema 1": ("b1", "B1", "BCC Cinema 1", "bcc", "centum", "영화의전당 중극장"),
    "Busan Cinema Center Cinema 2": ("b2", "B2", "BCC Cinema 2", "bcc", "centum", "영화의전당 소극장"),
    "Busan Cinema Center Cinematheque": ("b3", "B3", "BCC Cinematek", "bcc", "centum", "영화의전당 시네마테크"),
    "Busan Cinema Center Haneulyeon Theatre": ("bh", "BH", "BCC Haneulyeon", "bcc", "centum", "영화의전당 하늘연극장"),
    "Busan Cinema Center Roof Theater": ("br", "BR", "BCC Roof", "bcc", "centum", "영화의전당 야외극장"),
    "CGV Centum City 1": ("c1", "C1", "CGV 1", "cgv", "centum", "CGV 센텀시티 1관"),
    "CGV Centum City 2": ("c2", "C2", "CGV 2", "cgv", "centum", "CGV 센텀시티 2관"),
    "CGV Centum City 3": ("c3", "C3", "CGV 3", "cgv", "centum", "CGV 센텀시티 3관"),
    "CGV Centum City 4": ("c4", "C4", "CGV 4", "cgv", "centum", "CGV 센텀시티 4관"),
    "CGV Centum City 5": ("c5", "C5", "CGV 5", "cgv", "centum", "CGV 센텀시티 5관"),
    "CGV Centum City 6": ("c6", "C6", "CGV 6", "cgv", "centum", "CGV 센텀시티 6관"),
    "CGV Centum City IMAX": ("cx", "CX", "CGV IMAX", "cgv", "centum", "CGV 센텀시티 IMAX관"),
    "LOTTE CINEMA Centum City 2": ("l2", "L2", "LOTTE 2", "lotte", "centum", "롯데시네마 센텀시티 2관"),
    "LOTTE CINEMA Centum City 3": ("l3", "L3", "LOTTE 3", "lotte", "centum", "롯데시네마 센텀시티 3관"),
    "LOTTE CINEMA Centum City 4": ("l4", "L4", "LOTTE 4", "lotte", "centum", "롯데시네마 센텀시티 4관"),
    "LOTTE CINEMA Centum City 5": ("l5", "L5", "LOTTE 5", "lotte", "centum", "롯데시네마 센텀시티 5관"),
    "LOTTE CINEMA Centum City 6": ("l6", "L6", "LOTTE 6", "lotte", "centum", "롯데시네마 센텀시티 6관"),
    "LOTTE CINEMA Centum City 7": ("l7", "L7", "LOTTE 7", "lotte", "centum", "롯데시네마 센텀시티 7관"),
    "LOTTE CINEMA Centum City 8": ("l8", "L8", "LOTTE 8", "lotte", "centum", "롯데시네마 센텀시티 8관"),
    "LOTTE CINEMA Centum City 9": ("l9", "L9", "LOTTE 9", "lotte", "centum", "롯데시네마 센텀시티 9관"),
    "LOTTE CINEMA Centum City 10": ("l10", "L10", "LOTTE 10", "lotte", "centum", "롯데시네마 센텀시티 10관"),
    "KOFIC Theater": ("kt", "KT", "KOFIC Theater", "kofic", "centum", "영화진흥위원회 시사실"),
    "Culture Hall(9F), Shinsegae Centum City": ("sc", "SC", "Shinsegae Hall", "shinsegae", "centum", "신세계 센텀시티 문화홀"),
    "Sohyang Theatre Woori Bank Hall": ("sh", "SH", "Sohyang Theatre", "sohyang", "nampo", "소향씨어터 우리은행홀"),
    "Busan Community Media Center Open Hall": ("bcm", "BCM", "Busan Media Ctr", "bcm", "nampo", "부산영상위원회 오픈홀"),
    "DSU-KIT Centum Campus": ("dm", "DM", "DSU-KIT", "dsumedia", "centum", "동서대-KIT 센텀캠퍼스"),
    "Book Cafe Lounge, 4F, DSU-KIT Centum Campus": ("dk", "DK", "DSU Book Cafe", "dsumedia", "centum", "동서대 북카페 라운지"),
}

# 泳道顺序:分区 → 影院 → 厅号。前端按 venues.json 的出现顺序分泳道,顺序即泳道顺序。
GROUP_ORDER = ["bcc", "cgv", "lotte", "kofic", "shinsegae", "dsumedia", "sohyang", "bcm"]

RE_GROUP = re.compile(r'<div class="sch_li"><div class="sch_li_tit">([^<]*)</div>')
RE_SLOT = re.compile(r'<div class="sch_it([^"]*)">')
RE_CODE = re.compile(r'data-scode="(\d+)"')
RE_TIME = re.compile(r'<p class="time en">(\d{1,2}:\d{2})</p>')
RE_TITLE = re.compile(r'class="film_tit_kor">([^<]*)')
RE_PROG = re.compile(r'prog_view\.asp\?idx=(\d+)&(?:amp;)?c_idx=(\d+)')
RE_RATING = re.compile(r'ico_grade ico_(g|12|15|19)"')
RE_SUBS = re.compile(r'ico_grade ico_(ke|kn|kk|no)"')
RE_GV = re.compile(r'ico_grade ico_gv"')
RE_BUNDLE = re.compile(r'ico_grade ico_bundle"')
RE_REMARK = re.compile(r"</a></div>\s*([^<]+)")
RE_RUNTIME = re.compile(r"러닝타임</span>\s*(\d+)\s*min")
RE_KR_TITLE = re.compile(r'<span class="h2 tit_h1">([^<]*)</span>')
# 导演名(罗马字,如 "OKITA Shuichi")—— 影片详情页唯一的跨语言可用字段
RE_DIRECTOR = re.compile(r'<strong class="dir_name">([^<]*)</strong>')
RE_EN_TITLE = re.compile(r'<small class="film_tit_en">([^<]*)</small>')
RE_COUNTRY = re.compile(r"국가</span>\s*([^<]*)")
RE_YEAR = re.compile(r"제작연도</span>\s*([^<]*)")
RE_SECTION = re.compile(r"prog_list\.asp\?c_idx=(\d+)'[^>]*>(?:<span>)?([^<]+)")
RE_ADDON = re.compile(r"addon/10000001/page\.asp\?page_num=(\d+)")
# 活动页(`Actors' House` / `Master Class` / `Special Talk` 这类非影片场次)印的是时间区间:
#   <em>Date</em> <span>Oct 7 (Wed) 18:50 - 19:50</span>
RE_ADDON_RANGE = re.compile(r"<em>Date</em>\s*<span>[^<]*?(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})</span>")

RATING_MAP = {"g": "ALL", "12": "12", "15": "15", "19": "19"}

# 无链接条目(开闭幕式 / 获奖片重映 / 官网未编号场)官网**不给任何片长**。
# 这里给兜底值并在自检里单列,绝不假装成真实数据。
FALLBACK_DURATION_MIN = 120

FESTIVAL_NOTE = (
    "数据来源:官方排期页 www.biff.kr/eng/html/schedule/date.asp(由 tools/scrape_biff_web.py 抓取),"
    "场馆按「厅」建 id(id = 官方影院代码小写,如 b1/c3/l10);"
    "GV 场次的 end_time 已含 25min 映后谈;片长取自官方影片详情页;"
    "联映块(묶)的 duration_min 为块内成员片长之和,midnight_members 为成员片名;"
    "活动场次(Actors' House / Master Class / Special Talk)取活动页印的时间区间;"
    "开闭幕式与获奖片重映官网未给片长,duration_min 为 120min 估算值;"
    "官网排期会持续变动,以开映前官方页面为准。"
)


def fetch(url: str, cache_dir: Path, sleep: float, offline: bool, retries: int = 3) -> str:
    """带磁盘缓存的 GET。缓存命中直接读盘(--offline 时不发请求)。"""
    key = re.sub(r"[^A-Za-z0-9]+", "_", url.replace(BASE, "")).strip("_")[:120] + ".html"
    path = cache_dir / key
    if path.exists() and path.stat().st_size > 0:
        return path.read_text(encoding="utf-8", errors="replace")
    if offline:
        raise RuntimeError(f"--offline 但缓存缺失: {path}")

    last: Optional[Exception] = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as resp:
                text = resp.read().decode("utf-8", errors="replace")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
            time.sleep(sleep)
            return text
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = exc
            time.sleep(sleep * (attempt + 2))
    raise RuntimeError(f"抓取失败 {url}: {last}")


def strip_tags(raw: str) -> str:
    """去标签 + 反转义 + 压空白 —— 详情页的小字段(国家 / 年份)用。"""
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", raw))).strip()


def split_slots(group_body: str) -> list[str]:
    """把一组影院里的 `div.sch_it` 兄弟节点切开(含首尾边界)。"""
    marks = [m.start() for m in RE_SLOT.finditer(group_body)]
    chunks = []
    for i, start in enumerate(marks):
        end = marks[i + 1] if i + 1 < len(marks) else len(group_body)
        chunks.append(group_body[start:end])
    return chunks


def parse_schedule_page(page_html: str, day: date) -> list[dict[str, Any]]:
    """解析一个日期页 → 场次原始记录(片长 / 韩文名待回填)。"""
    rows: list[dict[str, Any]] = []
    parts = page_html.split('<div class="sch_li">')[1:]
    for part in parts:
        m = RE_GROUP.match('<div class="sch_li">' + part)
        if not m:
            continue
        venue_name = html.unescape(m.group(1)).strip()
        # m 是在「补回被 split 吃掉的 <div class="sch_li"> 前缀」后的串上匹配的,
        # 减掉前缀长度即得 body 在 part 里的真实偏移。
        body = part[len(m.group(0)) - len('<div class="sch_li">'):]

        for chunk in split_slots(body):
            head = RE_SLOT.match(chunk)
            if head is None or "blank_wrap" in head.group(1):
                continue
            time_m = RE_TIME.search(chunk)
            title_m = RE_TITLE.search(chunk)
            if not (time_m and title_m):
                continue

            # 官网有个别场次没印编号(如 BAFA 毕业典礼,`<span class="code en">-</span>`),
            # 先留空,主流程统一补合成编号(X01…,与 2025 口径一致)。
            code_m = RE_CODE.search(chunk)
            progs = RE_PROG.findall(chunk)
            is_bundle = bool(RE_BUNDLE.search(chunk))
            rating_m = RE_RATING.search(chunk)
            remark_m = RE_REMARK.search(chunk)
            addon_m = RE_ADDON.search(chunk)
            titles = [html.unescape(t).strip() for t in RE_TITLE.findall(chunk)]

            rows.append({
                "code": code_m.group(1) if code_m else "",
                "date": day.isoformat(),
                "start_time": time_m.group(1).zfill(5),
                "title_en": html.unescape(title_m.group(1)).strip(),
                "venue_name": venue_name,
                "film_idx": None if is_bundle else (progs[0][0] if progs else None),
                "film_c_idx": None if is_bundle else (progs[0][1] if progs else None),
                "member_progs": [list(p) for p in progs] if is_bundle else [],
                "member_titles": titles[1:] if is_bundle else [],
                "addon_page": addon_m.group(1) if addon_m else None,
                "is_bundle": is_bundle,
                "is_gv": bool(RE_GV.search(chunk)),
                "rating": RATING_MAP.get(rating_m.group(1)) if rating_m else None,
                "subs": [s.upper() for s in RE_SUBS.findall(chunk)],
                "remark": html.unescape(remark_m.group(1)).strip() if remark_m else "",
            })
    return rows


def infer_tags(title: str, remark: str) -> list[str]:
    """按标题 / 备注关键词判场次特性键 —— 只输出 badges.ts 已注册的键。"""
    low = f"{title} {remark}".lower()
    tags: list[str] = []
    if "opening" in low:
        tags.append("opening")
    if "closing" in low:
        tags.append("closing")
    if "[master class]" in low or "masterclass" in low:
        tags.append("masterclass")
    if "[open talk]" in low or "open talk" in low:
        tags.append("open_talk")
    if "[special talk]" in low or "talk-to-talk" in low or "cine class" in low:
        tags.append("talk")
    if "actors' house" in low or "actors’ house" in low:
        tags.append("event")
    return tags


def parse_addon_range(page_html: str) -> Optional[tuple[str, str]]:
    """活动页 → (开始, 结束) HH:MM;拿不到返回 None。"""
    m = RE_ADDON_RANGE.search(page_html)
    if not m:
        return None
    return (m.group(1).zfill(5), m.group(2).zfill(5))


def parse_sections(nav_html: str) -> dict[str, str]:
    """从导航菜单抓 c_idx → 单元名(片单页的 prog_list.asp?c_idx=N)。"""
    out: dict[str, str] = {}
    for idx, name in RE_SECTION.findall(nav_html):
        out.setdefault(idx, html.unescape(name).strip())
    return out


def parse_film_meta(eng_html: str, kor_html: Optional[str]) -> dict[str, Any]:
    """详情页 → 片长 / 单元 / 年份 / 国家 / 韩文片名。"""
    meta: dict[str, Any] = {}
    rt = RE_RUNTIME.search(eng_html)
    meta["duration_min"] = int(rt.group(1)) if rt else None
    sec = re.search(r'<span class="sectionName">([^<]*)</span>', eng_html)
    meta["premiere"] = html.unescape(sec.group(1)).strip() if sec else ""
    country = RE_COUNTRY.search(eng_html)
    meta["country"] = strip_tags(country.group(1)) if country else ""
    year = RE_YEAR.search(eng_html)
    meta["year"] = strip_tags(year.group(1)) if year else ""
    en = RE_EN_TITLE.search(eng_html)
    meta["title_en"] = html.unescape(en.group(1)).strip() if en else ""
    dr = RE_DIRECTOR.search(eng_html)
    meta["director"] = html.unescape(dr.group(1)).strip() if dr else ""
    if kor_html:
        kr = RE_KR_TITLE.search(kor_html)
        meta["title_kr"] = html.unescape(kr.group(1)).strip() if kr else ""
    else:
        meta["title_kr"] = ""
    return meta


def add_minutes(start: str, minutes: int) -> str:
    """HH:MM + N 分钟 → 24+ 时制 HH:MM(跨午夜保留 ≥24 的小时,与前端口径一致)。"""
    hh, mm = (int(x) for x in start.split(":"))
    total = hh * 60 + mm + minutes
    return f"{total // 60:02d}:{total % 60:02d}"


def minutes_between(start: str, end: str) -> int:
    """两个 HH:MM 之间的分钟数;结束早于开始视为跨午夜(+24h)。"""
    sh, sm = (int(x) for x in start.split(":"))
    eh, em = (int(x) for x in end.split(":"))
    delta = (eh * 60 + em) - (sh * 60 + sm)
    return delta + 24 * 60 if delta < 0 else delta


def ordinal(n: int) -> str:
    """1 → 1st / 2 → 2nd / 11 → 11th / 31 → 31st。"""
    if 10 <= n % 100 <= 20:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def norm_title(raw: str) -> str:
    """片名归一:NFKC + 弯引号 / 破折号统一 + 只留字母数字与 CJK / 谚文。

    官网用的是排版撇号(`Angel′s Egg`),目录里是直引号(`Angel's Egg`)——
    不归一就整条对不上。
    """
    s = unicodedata.normalize("NFKC", raw or "").lower()
    for a, b in (("′", "'"), ("’", "'"), ("‘", "'"), ("–", "-"), ("—", "-")):
        s = s.replace(a, b)
    return re.sub(r"[^0-9a-z\u4e00-\u9fff\uac00-\ud7af]+", "", s)


def build_title_index(films_path: Path, alias_path: Optional[Path] = None) -> dict[str, str]:
    """目录 → {归一化片名: 中文名}。收 `title_en` / `title_orig` / `title_zh` 三个键。

    官网排期给的是**英文名 + 韩文名**,目录给的是**中文名 + 原始名**;
    两者只有部分重合(BIFF 2026 实测约五成),对不上的场次 title_zh 留空 ——
    前端 `filmNodeKey` 会把它当「纯排期片」单独成条,不会串片,但影片库里会出现
    「中文条目无排期 + 英文条目有排期」的一对。见 SKILL 的「片名桥接」一节。

    2026-09-11 新增 `title_en` 键:films.json 的 `title_zh` 已由
    「官网片目 ∪ xlsx 目录 ∪ 人工别名表」三路合并而来,这里按官网英文名回灌,
    保证**排期与影片库用同一个中文名**(否则自动配对得到的中文名只进影片库,
    排期侧仍是空,前端 `filmNodeKey` 会把同一部片拆成两条)。
    """
    data = json.loads(films_path.read_text(encoding="utf-8"))
    index: dict[str, str] = {}
    for f in data.get("films", []):
        zh = f.get("title_zh") or ""
        if not zh:
            continue
        index.setdefault(norm_title(f.get("title_en")), zh)
        for key in (f.get("title_orig"), zh):
            k = norm_title(key)
            if k:
                index.setdefault(k, zh)
    # 人工别名表:官方片名 → 目录中文名。只放「自动手段确实对不上」的,
    # 且**必须写明理由**(见 data/title-alias-2026.json 的 _note)。
    if alias_path and alias_path.exists():
        extra = json.loads(alias_path.read_text(encoding="utf-8"))
        for name, zh in (extra.get("aliases") or {}).items():
            k = norm_title(name)
            if k and zh:
                index[k] = zh
    return index


def venue_sort_key(name: str) -> tuple[int, str, int]:
    """泳道排序键:影院组 → 字母段 → 数字段(自然序)。

    纯字符串序会把 `l10` 排到 `l2` 前,纯数字序又会把 `bh`/`br` 挤到 `b1` 前 ——
    拆成 (字母, 数字) 两段才既保 B1<B2<B3<BH<BR,又保 L2<L3<…<L10。
    """
    vid, _code, _short, group, _region, _kr = VENUE_TABLE[name]
    m = re.match(r"([A-Za-z]*)(\d*)", vid)
    alpha, digits = (m.group(1), m.group(2)) if m else (vid, "")
    return (
        GROUP_ORDER.index(group) if group in GROUP_ORDER else len(GROUP_ORDER),
        alpha,
        int(digits) if digits else 0,
    )


def build_venues(venue_names: list[str]) -> list[dict[str, Any]]:
    venue_names = sorted(set(venue_names))
    unknown = [n for n in venue_names if n not in VENUE_TABLE]
    if unknown:
        raise SystemExit(
            "以下场馆不在 VENUE_TABLE 里,请先补表(否则会静默丢数据):\n  " + "\n  ".join(sorted(unknown))
        )
    ordered = sorted(venue_names, key=venue_sort_key)
    venues = []
    for name in ordered:
        vid, code, short, group, region, kr = VENUE_TABLE[name]
        venues.append({
            "id": vid,
            "name": name,
            "name_kr": kr,
            "short": short,
            "group": group,
            "region": region,
            "code": code,
            "lat": None,
            "lng": None,
        })
    return venues


def main() -> int:
    parser = argparse.ArgumentParser(description="BIFF 官网排期页 → schedule.json / venues.json")
    parser.add_argument("--out-dir", required=True, help="产物目录")
    parser.add_argument("--day-from", type=int, default=6, help="起始 day1(默认 6)")
    parser.add_argument("--day-to", type=int, default=15, help="结束 day1(默认 15)")
    parser.add_argument("--year", type=int, default=2026, help="届次年份(默认 2026)")
    parser.add_argument("--edition", type=int, default=31, help="届数(默认 31,用于 festival.name)")
    parser.add_argument("--month", type=int, default=10, help="月份(默认 10)")
    parser.add_argument("--gv-extra-min", type=int, default=25, help="GV 映后谈时长(默认 25)")
    parser.add_argument("--sleep", type=float, default=0.2, help="每次请求间隔秒数(默认 0.2)")
    parser.add_argument("--offline", action="store_true", help="只用缓存,不发请求")
    parser.add_argument("--no-kr", action="store_true", help="跳过韩文详情页(省一半请求,韩文片名留空)")
    parser.add_argument("--films-json", help="影片目录(apps/web/public/films.json);给了就回填 title_zh 并报匹配率")
    parser.add_argument("--alias", default="data/title-alias-2026.json", help="人工别名表(官方片名 → 目录中文名)")
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    cache_dir = out_dir / "_cache"
    out_dir.mkdir(parents=True, exist_ok=True)

    # 1) 抓 10 个日期页
    pages: list[tuple[date, str]] = []
    for day_num in range(args.day_from, args.day_to + 1):
        day = date(args.year, args.month, day_num)
        text = fetch(DATE_URL.format(day=day_num), cache_dir, args.sleep, args.offline)
        pages.append((day, text))
        print(f"[抓取] {day.isoformat()}  {len(text):>7} bytes")

    # 2) 解析排期 + 给官网未编号的场次补合成编号(X01…,与 2025 口径一致)
    rows: list[dict[str, Any]] = []
    for day, text in pages:
        got = parse_schedule_page(text, day)
        rows.extend(got)
        print(f"[解析] {day.isoformat()}  {len(got):>3} 场")
    auto_code = 0
    for r in rows:
        if not r["code"]:
            auto_code += 1
            r["code"] = f"X{auto_code:02d}"
    print(f"[合计] {len(rows)} 场 / {len({r['venue_name'] for r in rows})} 厅 / 合成编号 {auto_code} 条")

    # 3) 回填片长 / 韩文名 / 单元(按 film_idx 去重,只抓一次)
    sections = parse_sections(pages[0][1])
    idx_to_cidx: dict[str, str] = {}
    for r in rows:
        if r["film_idx"]:
            idx_to_cidx.setdefault(r["film_idx"], r["film_c_idx"] or "")
        # 联映块成员链接自带 c_idx,必须带上 —— 传 c_idx=0 会拿到一张空壳页、片长全丢。
        for mid, mcidx in r["member_progs"]:
            idx_to_cidx.setdefault(mid, mcidx)
    print(f"[详情] 需回填 {len(idx_to_cidx)} 部影片" + ("" if args.no_kr else " (含韩文页)"))

    film_meta: dict[str, Any] = {}
    for n, (idx, cidx) in enumerate(sorted(idx_to_cidx.items()), 1):
        eng = fetch(PROG_URL.format(lang="eng", idx=idx, c_idx=cidx or "0"), cache_dir, args.sleep, args.offline)
        kor = None
        if not args.no_kr:
            try:
                kor_url = PROG_URL.format(lang="kor", idx=idx, c_idx=cidx or "0")
                kor = fetch(kor_url, cache_dir, args.sleep, args.offline)
            except RuntimeError as exc:
                print(f"  ! 韩文页失败 idx={idx}: {exc}")
        meta = parse_film_meta(eng, kor)
        meta["c_idx"] = cidx
        meta["unit"] = sections.get(cidx or "", "")
        film_meta[idx] = meta
        if n % 50 == 0 or n == len(idx_to_cidx):
            print(f"  回填 {n}/{len(idx_to_cidx)}")

    # 3b) 活动页(`Actors' House` / `Master Class` / `Special Talk`)印了时间区间,单独取
    addon_ranges: dict[str, Optional[tuple[str, str]]] = {}
    addon_pages = sorted({r["addon_page"] for r in rows if r["addon_page"]})
    if addon_pages:
        print(f"[活动] 需回填 {len(addon_pages)} 个活动页")
    for page_num in addon_pages:
        url = f"{BASE}/eng/addon/10000001/page.asp?page_num={page_num}"
        addon_ranges[page_num] = parse_addon_range(fetch(url, cache_dir, args.sleep, args.offline))

    # 4) 组装 schedule.json
    title_index: dict[str, str] = {}
    if args.films_json:
        title_index = build_title_index(Path(args.films_json), Path(args.alias))
        print(f"[目录] {args.films_json} → {len(title_index)} 个片名键")

    screenings: list[dict[str, Any]] = []
    estimated: list[str] = []
    zh_missed: list[str] = []
    for r in rows:
        vid = VENUE_TABLE[r["venue_name"]][0]
        meta = film_meta.get(r["film_idx"] or "", {}) or {}
        need_fallback = False

        if r["is_bundle"]:
            # 联映块 = 一张票连看多部 → 时长取块内成员之和
            durations = [film_meta.get(m, {}).get("duration_min") for m, _ in r["member_progs"]]
            duration = sum(d for d in durations if d)
            title_en = r["title_en"]
            title_kr = ""
        elif r["film_idx"]:
            duration = meta.get("duration_min") or 0
            title_en = meta.get("title_en") or r["title_en"]
            title_kr = meta.get("title_kr", "")
        elif r["addon_page"]:
            span = addon_ranges.get(r["addon_page"])
            duration = minutes_between(*span) if span else 0
            title_en = r["title_en"]
            title_kr = ""
        else:
            # 开闭幕式 / 获奖片重映:官网既无详情页也无时间区间,只能兜底
            duration = 0
            title_en = r["title_en"]
            title_kr = ""
            need_fallback = True

        if duration <= 0:
            need_fallback = True
            duration = FALLBACK_DURATION_MIN
        if need_fallback:
            estimated.append(f"{r['code']} {r['title_en']}")

        # title_zh 是「排期 ↔ 中文目录」的唯一桥:命中则影片库按目录条目归并,
        # 否则前端当「纯排期片」单独成条(不串片,但会出现一对重复)。
        title_zh = ""
        if title_index:
            title_zh = title_index.get(norm_title(title_en), "")
            if not title_zh and title_kr:
                title_zh = title_index.get(norm_title(title_kr), "")
            if not title_zh and not r["is_bundle"]:
                zh_missed.append(title_en)

        total = duration + (args.gv_extra_min if r["is_gv"] else 0)
        item: dict[str, Any] = {
            "code": r["code"],
            "title_en": title_en,
            "title_kr": title_kr,
            "title_zh": title_zh,
            "date": r["date"],
            "start_time": r["start_time"],
            "end_time": add_minutes(r["start_time"], total),
            "duration_min": duration,
            "venue_id": vid,
            "venue_display": r["venue_name"],
            "is_gv": r["is_gv"],
            "tags": infer_tags(title_en, r["remark"]),
            "rating": r["rating"],
            "subs": r["subs"] or None,
        }
        if r["is_bundle"]:
            item["midnight_members"] = r["member_titles"]
        screenings.append(item)

    screenings.sort(key=lambda s: (s["date"], s["start_time"], s["code"]))

    # 5) 自检
    codes = [s["code"] for s in screenings]
    dup = sorted({c for c in codes if codes.count(c) > 1})
    print("\n===== 自检 =====")
    print(f"场次总数      : {len(screenings)}")
    print(f"编号唯一      : {'OK' if not dup else '重复 ' + ','.join(dup)}")
    print(f"编号范围      : {min(codes)} ~ {max(codes)}" if codes else "编号范围      : -")
    print(f"厅数          : {len({s['venue_id'] for s in screenings})}")
    print(f"日期跨度      : {min(s['date'] for s in screenings)} ~ {max(s['date'] for s in screenings)}")
    print(f"GV 场次       : {sum(1 for s in screenings if s['is_gv'])}")
    print(f"联映块        : {sum(1 for s in screenings if s.get('midnight_members'))}")
    print(f"估算片长      : {len(estimated)} 条(按 {FALLBACK_DURATION_MIN}min 兜底)"
          + (f" → {estimated}" if estimated else ""))
    if title_index:
        uniq = sorted(set(zh_missed))
        print(f"目录匹配      : {len(screenings) - len(zh_missed)}/{len(screenings)} 场命中中文名"
              f";未命中 {len(uniq)} 个片名(前端按「纯排期片」处理)")

    # 6) 落盘
    venues = build_venues([r["venue_name"] for r in rows])
    festival = {
        "name": f"{ordinal(args.edition)} Busan International Film Festival",
        "year": args.year,
        "dates": sorted({s["date"] for s in screenings}),
        "note": FESTIVAL_NOTE,
        "generated_at": datetime.now(timezone(timedelta(hours=9))).isoformat(timespec="seconds"),
    }
    (out_dir / "schedule.json").write_text(
        json.dumps({"festival": festival, "screenings": screenings}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (out_dir / "venues.json").write_text(
        json.dumps({"venues": venues}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (out_dir / "film-meta.json").write_text(
        json.dumps(film_meta, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    # 官网片目:一部片一条(idx 去重)。**这是影片目录的唯一真源** —— 排期与它同源,
    # 故「片单有、没有排期」在结构上不可能出现(见 tools/build_films_2026.py)。
    web_films = sorted(
        (
            {
                "idx": idx,
                "title_en": m.get("title_en", ""),
                "title_kr": m.get("title_kr", ""),
                "unit": m.get("unit", ""),
                "country": m.get("country", ""),
                "year": m.get("year", ""),
                "duration_min": m.get("duration_min"),
                "premiere": m.get("premiere", ""),
                "director": m.get("director", ""),
            }
            for idx, m in film_meta.items()
        ),
        key=lambda x: x["idx"],
    )
    (out_dir / "films-web.json").write_text(
        json.dumps({"source": "biff.kr prog_view.asp", "films": web_films}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"[片目] 官网影片 {len(web_films)} 部 → films-web.json")
    print(f"\n写出 → {out_dir}/schedule.json · venues.json · film-meta.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
