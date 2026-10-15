#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_awards.py — 官网获奖信息 → apps/web/public/awards.json

背景
----
`schedule.json` 只有「谁在什么时候放」,没有「谁得了奖」。而获奖是排片决策里
**实打实的一条信息**(得奖片往往更难抢;用户也想按获奖挑片)。本脚本把官网
两侧的获奖来源抓下来,与本站影片目录对齐,**一片一条**地落成离线产物。

两个来源
--------
1. **颁奖礼新闻稿**(`mboard.asp?...intSeq=<seq>`,默认 103339 = 2026-10-14
   「Busan Vision Awards」名单)—— 正文是规整的三行块:
   `奖项名` / `Recipient: …` / `Director: …`(`Film: …` 表示这是演员奖,不是影片奖)。
2. **官网 Award Winners 页**(`page.asp?page_num=…`)—— 荣誉奖(人物):
   `h3.aw-header-title` = 奖项名,`h4.aw-accent-title` = 得主,`span.aw-lbl` = 国家 / 职业。
   页面正文为空 = 该奖**尚未公布**(主竞赛 `New Currents` / `Busan Award` 系列即如此,
   不占位、不猜)。

关联口径
--------
排期侧只有**片名**这一座桥(与 `scrape_biff_web.py::build_title_index` 同款):
官网给的获奖片名 → 归一后查 `films.json` 的 `title_en` / `title_orig` / `title_zh` →
拿到目录 id 与 `screening_codes`(**双键都进产物**,前端只查表,不重算)。
查不到的条目**照原样保留**(`filmIds` / `codes` 为空数组)并在自检里列出 ——
绝不静默丢弃,也绝不猜。

奖项中文名
----------
`AWARD_ZH` 是**人工表**(与 `scrape_biff_extras.py::GUEST_ZH` 同款先例):
赞助商冠名的奖(如 `Hylife Vision Award`)不硬译,保留品牌词 + 中文类别词;
查不到的一律只印英文原文。

用法
----
    python tools/build_awards.py
    python tools/build_awards.py --offline          # 复用缓存 HTML,只重跑解析

产物
----
    apps/web/public/awards.json
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

BASE = "https://www.biff.kr"
PRESS_URL = BASE + "/eng/artyboard/mboard.asp?Action=view&strBoardID=9611_05&intSeq={seq}"
PAGE_URL = BASE + "/eng/addon/10000001/page.asp?page_num={num}"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
)

# 颁奖礼新闻稿:段号 → 届内口径说明(多段时按顺序抓,合并成一份 awards 列表)。
PRESS_SEQS: tuple[str, ...] = ("103339",)

# 荣誉奖(人物)页面:page_num → 该页的奖项名(官网页面正文为空时视为未公布)。
PEOPLE_PAGES: tuple[tuple[str, str], ...] = (
    ("11098", "The Asian Filmmaker of the Year"),
    ("11099", "Korean Cinema Award"),
    ("11100", "Camellia Award"),
)

# 奖项英文名 → 中文名(人工维护)。**拿不准就别登记** —— 未登记的条目在产物里
# `awardZh` 为 null,前端回落英文原文,不会印出错误译名。
AWARD_ZH: dict[str, str] = {
    "BIFF Mecenat Award (Asia)": "BIFF Mecenat 奖（亚洲）",
    "BIFF Mecenat Award (Korea)": "BIFF Mecenat 奖（韩国）",
    "BIFF Mecenat Award (Special Mention)": "BIFF Mecenat 奖（特别提及）",
    "Sonje Award (Asia)": "善才奖（亚洲）",
    "Sonje Award (Korea)": "善才奖（韩国）",
    "Sonje Award (Special Mention)": "善才奖（特别提及）",
    "NETPAC Award": "NETPAC 奖",
    "FIPRESCI Award": "国际影评人联盟奖（FIPRESCI）",
    "Bishkek International Film Festival-Central Asia Cinema Award": "比什凯克国际电影节·中亚电影奖",
    "Face of the Future Award": "未来面孔奖",
    "The Heart of Eurasia Award": "欧亚之心奖",
    "Hylife Vision Award": "Hylife 视野奖",
    "International Film Festival of India - Vision Asia Award": "印度国际电影节·Vision Asia 奖",
    "Songwon Vision Audience Award - Asia": "Songwon 视野观众奖（亚洲）",
    "Songwon Vision Audience Award - Korea": "Songwon 视野观众奖（韩国）",
    "Taipei Film Commission Award": "台北市电影委员会奖",
    "Vision of Jiseok Award": "智奭视野奖",
    "Actor of the Year": "年度演员",
    "DGK PLUS M Award": "韩国电影导演协会 PLUS M 奖",
    "CGV Award": "CGV 奖",
    "KBS Independent Film Award": "KBS 独立电影奖",
    "Critic b Award": "Critic b 影评人奖",
    "K-MOVIE Award": "K-MOVIE 奖",
    "Jeong-in Award": "Jeong-in 奖",
    "Citizen Critics' Award": "市民影评人奖",
    "Busan Cinephile Award": "釜山影迷奖",
    "Documentary Audience Award": "纪录片观众奖",
    "Flash Forward Audience Award": "Flash Forward 观众奖",
    "The Asian Filmmaker of the Year": "年度亚洲电影人",
    "Camellia Award": "山茶花奖",
    "Korean Cinema Award": "韩国电影奖",
}

RE_RECIPIENT = re.compile(r"^Recipient:\s*(.+)$")
RE_FIELD = re.compile(r"^(Director|Film):\s*(.+)$")
RE_AW_TITLE = re.compile(r'<h3 class="aw-header-title">([^<]*)</h3>')
RE_AW_PERSON = re.compile(r'<h4 class="aw-accent-title">([^<]*)</h4>')
RE_AW_META = re.compile(r'<div class="aw-accent-meta">(.*?)</div>', re.S)
RE_AW_LBL = re.compile(r'<span class="aw-lbl">([^<]*)</span>')

# 颁奖礼(2026-10-14 Busan Vision Awards;新闻稿正文自己印了时间与地点)。
CEREMONY_DATE = "2026-10-14"
CEREMONY_VENUE = "SIGNIEL BUSAN Grand Ballroom"


def fetch(url: str, cache_dir: Path, offline: bool, retries: int = 3) -> str:
    """带磁盘缓存的 GET(缓存命中直接读盘;--offline 时不发请求)。"""
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
            return text
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = exc
    raise RuntimeError(f"抓取失败 {url}: {last}")


def visible_lines(raw: str) -> list[str]:
    """HTML → 可见文本行(去 script/style、块级标签转换行、压缩空白)。"""
    src = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", raw)
    src = re.sub(r"(?is)<br\s*/?>", "\n", src)
    src = re.sub(r"(?is)</(p|div|li|tr|h[1-6]|td|dt|dd)>", "\n", src)
    text = html.unescape(re.sub(r"(?s)<[^>]+>", " ", src))
    return [re.sub(r"[ \t]+", " ", line).strip() for line in text.split("\n") if line.strip()]


def parse_press_release(raw: str) -> list[dict[str, Any]]:
    """颁奖礼新闻稿 → 获奖条目(影片奖 + 演员奖都在这张表里)。

    正文块固定三行,判据是 `Recipient:`(导航文本里不会出现这个前缀):
        <奖项名>
        Recipient: <片名 或 演员名>
        Director: <导演>   |   Film: <影片>
    """
    lines = visible_lines(raw)
    out: list[dict[str, Any]] = []
    for i, line in enumerate(lines):
        m = RE_RECIPIENT.match(line)
        if not m:
            continue
        award = lines[i - 1] if i > 0 else ""
        recipient = m.group(1).strip()
        director = ""
        film = ""
        for nxt in lines[i + 1:i + 3]:
            f = RE_FIELD.match(nxt)
            if not f:
                break
            if f.group(1) == "Director":
                director = f.group(2).strip()
            else:
                film = f.group(2).strip()
        out.append({
            "award": award,
            "recipient": recipient,
            "director": director,
            # 演员奖:`Recipient` 是人名,`Film` 才是影片;影片奖反之。
            "film": film or recipient,
            "person": recipient if film else "",
        })
    return out


def parse_people_page(raw: str) -> list[dict[str, Any]]:
    """官网 Award Winners 页 → **本届**荣誉奖得主;页面正文为空返回空列表(未公布)。

    ⚠ 这些页面把「本届得主」与「历届得主」印在同一页,中间隔一条
    `aw-history-divider`(标题形如 `Past Camellia Award Winners`)—— 不切掉就会把
    往届得主(如 2025 Sylvia CHANG / 2024 RYU Seong-hie)当成本届获奖发出去。
    """
    head = raw.split("aw-history-divider")[0]
    title = RE_AW_TITLE.search(head)
    if not title:
        return []
    award = html.unescape(title.group(1)).strip()
    people: list[dict[str, Any]] = []
    for m in RE_AW_PERSON.finditer(head):
        body = head[m.end():m.end() + 400]
        meta = RE_AW_META.search(body)
        labels = RE_AW_LBL.findall(meta.group(1)) if meta else []
        people.append({
            "award": award,
            "name": html.unescape(m.group(1)).strip(),
            "labels": [html.unescape(x).strip() for x in labels],
        })
    return people


def norm_title(raw: str) -> str:
    """片名归一(与 `scrape_biff_web.py::norm_title` 同口径)。"""
    s = unicodedata.normalize("NFKC", raw or "").lower()
    for a, b in (("′", "'"), ("’", "'"), ("‘", "'"), ("–", "-"), ("—", "-")):
        s = s.replace(a, b)
    return re.sub(r"[^0-9a-z\u4e00-\u9fff\uac00-\ud7af]+", "", s)


def build_film_index(films: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """归一化片名 → 影片目录条目;收 `title_en` / `title_orig` / `title_zh` 三键。"""
    index: dict[str, dict[str, Any]] = {}
    for f in films:
        for key in (f.get("title_en"), f.get("title_orig"), f.get("title_zh")):
            k = norm_title(key or "")
            if k:
                index.setdefault(k, f)
    return index


def add_award_zh(items: list[dict[str, Any]]) -> None:
    """就地补 `awardZh`(人工表;查不到写 None,前端回落英文)。"""
    for item in items:
        item["awardZh"] = AWARD_ZH.get(item["award"])


def main() -> int:
    parser = argparse.ArgumentParser(description="官网获奖信息 → apps/web/public/awards.json")
    parser.add_argument("--out", default="apps/web/public/awards.json", help="产物路径")
    parser.add_argument("--films", default="apps/web/public/films.json", help="影片目录(匹配用)")
    parser.add_argument("--schedule", default="apps/web/public/schedule.json", help="排期(校验 codes)")
    parser.add_argument("--cache-dir", default="data/_cache/awards", help="HTML 缓存目录")
    parser.add_argument("--offline", action="store_true", help="只用缓存,不发请求")
    args = parser.parse_args()

    cache_dir = Path(args.cache_dir)
    print(f"[抓取] 颁奖礼新闻稿 {len(PRESS_SEQS)} 段 / 荣誉奖页 {len(PEOPLE_PAGES)} 个")

    awards: list[dict[str, Any]] = []
    for seq in PRESS_SEQS:
        raw = fetch(PRESS_URL.format(seq=seq), cache_dir, args.offline)
        got = parse_press_release(raw)
        print(f"[解析] intSeq={seq} → {len(got)} 条")
        awards.extend(got)

    people: list[dict[str, Any]] = []
    for page_num, fallback_award in PEOPLE_PAGES:
        raw = fetch(PAGE_URL.format(num=page_num), cache_dir, args.offline)
        got = parse_people_page(raw)
        if not got:
            print(f"[荣誉] page_num={page_num} 正文为空 → 视为未公布,跳过")
            continue
        for item in got:
            item.setdefault("award", fallback_award)
        print(f"[荣誉] page_num={page_num} → {len(got)} 条")
        people.extend(got)

    # ---- 匹配影片目录(片名是排期与目录之间唯一的桥)----
    films = json.loads(Path(args.films).read_text(encoding="utf-8")).get("films", [])
    film_index = build_film_index(films)
    schedule = json.loads(Path(args.schedule).read_text(encoding="utf-8"))
    known_codes = {s["code"] for s in schedule.get("screenings", [])}

    unmatched: list[str] = []
    for item in awards:
        hit = film_index.get(norm_title(item["film"]))
        item["filmIds"] = [hit["id"]] if hit else []
        item["filmZh"] = (hit or {}).get("title_zh") or ""
        item["codes"] = [
            c for c in (hit or {}).get("screening_codes", []) if c in known_codes
        ]
        if not hit:
            unmatched.append(f"{item['award']}: {item['film']}")

    # 演员奖:人名不是片名,`film` 才是 —— `person` 有值时保留人名,影片侧照旧匹配。
    for item in people:
        item["filmIds"] = []
        item["codes"] = []

    add_award_zh(awards)
    add_award_zh(people)

    payload = {
        "source": " ∪ ".join(
            [PRESS_URL.format(seq=s) for s in PRESS_SEQS]
            + [PAGE_URL.format(num=n) for n, _ in PEOPLE_PAGES]
        ),
        "generated_at": datetime.now(timezone(timedelta(hours=9))).isoformat(timespec="seconds"),
        "ceremony": {"date": CEREMONY_DATE, "venue": CEREMONY_VENUE},
        "awards": awards,
        "people": people,
    }
    Path(args.out).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    print("\n===== 自检 =====")
    print(f"影片奖        : {len(awards)} 条(匹配到目录 {sum(1 for a in awards if a['filmIds'])} 条)")
    print(f"关联场次      : {sum(1 for a in awards if a['codes'])} 条有场次 code")
    print(f"荣誉奖        : {len(people)} 条")
    if unmatched:
        print(f"未匹配影片    : {len(unmatched)} 条(片名对不上目录,已原样保留 filmIds=[])")
        for line in unmatched:
            print(f"  - {line}")
    print(f"\n写出 → {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
