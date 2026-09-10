#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""extract_schedule.py — BIFF Ticket Catalogue PDF → schedule.json / venues.json

用法
----
    python tools/extract_schedule.py \
        --pdf ~/Downloads/2025_BIFF_Ticket_Catalogue_web.pdf \
        --year 2025 --month 9 \
        --out /tmp/schedule.json --venues-out /tmp/venues.json

    # 只看某页解析结果(排查用)
    python tools/extract_schedule.py --pdf ... --year 2025 --dump-page 9

为什么用 PyMuPDF(fitz)而不是 pdfplumber / Camelot
--------------------------------------------------
* 文本层完整:InDesign 导出的 PDF,字体内嵌且带 unicode 映射,无需 OCR。
* 必须拿到 **line / span 级 bbox**:排期表其实是「旋转 90° 的表格」,
  一个单元格里每个字段(时间/编号/分级/字幕/GV/片长/页码)都是**独立的一行**,
  不拿到逐 span 坐标就无法还原。
* Camelot 依赖可见表格线;本 PDF 单元格靠灰底色块分隔、没有线 → 用不了。

版面陷阱(踩过的坑,别再踩)
----------------------------
1. **坐标已是显示坐标系**。排期页 /Rotate 有的 90、有的 0,但 PyMuPDF
   `get_text("dict")` 返回的 bbox 已经落在 `page.rect` 所在的坐标系里,
   **不要再乘 rotation_matrix**,否则整页转错、行列互换。
2. **单元格的文字是旋转 90° 的**(line 的 `dir == (0, -1)`),所以
   阅读顺序 = **y 递减**(时间在最大 y,页码在最小 y);同一 line 内
   不要按 x 排序。
3. **line 会把整个单元格粘成一行**。例如
   `'23:59~05:01 081 19 KE GV 302' 162, 164'` 是一个 line 对象,bbox 高约 92pt。
   所以必须下沉到 **span** 级。
4. **网格**:行 = 时间档 1..5(1 早 / 2 日 / 3 下午 / 4 晚 / 5 午夜),
   档位数字在最左侧竖排;列 = 场馆,场馆代码竖排在页面**底部**表头条
   (y≈556-580)。
5. **双日页**(p9 = 17+18,p16 = 25+26):底部表头里出现两个「日标签」
   (`'17 WED'` / `'18 THU'`),日标签的 x 位置即该日区域的**起点**。
   单日页只有一个日标签。→ 判天规则:`day = 最后一个 x <= 场次 x 的日标签`。
6. **场次编号按页连续递增**(p9:001-076,p10:077-159,…),是极好的交叉校验。
   注意 001 / 002 是**预留号**:001 = 开幕场(9/17),002 = 闭幕场(9/26),
   它们不在自己的页号段里。
7. **★ 单元格归属靠 line 的 y1,不靠 y 窗口**(v7 的关键修正)。
   单元格的 META line 与它的标题 line **共享同一个 line-bbox 下边缘 y1**
   (实测完全相等),且标题 line 的 x0 比 META line 的 x0 大 6~12pt
   (英文标题 +6.2、韩文标题 +11.4、备注如 `(개막식+개막작)` +11.4)。
   早期版本用「anchor.y0 - 78 .. anchor.y0 + 4」这种 y 窗口切单元格,
   会**漏掉标题**——因为标题在旋转文本流里排在时间**之前**,它的 y
   比时间 span 的 y **更大**(即更靠页面下方),落在窗口之外。
   症状:206 场 title_en 为空。改用「同 y1 + x 近邻」后归零。
   注意:标题 line 与 META line 的 x 间距必须卡在 (2, 18] 之间——
   下一列的 META 在 +21.5,下一列的标题在 +27.9,都被排除。
8. **同一个数字会被 PDF 拆成多个 span**,且**只能对末尾页码回拼**。
   实例:页码 191 在 p9 的 017 单元格里是两个 span
   `'1'`(y=445.0) + `'91'`(y=439.8)。正常 token 的 y 间距 ≥7.3pt,
   拆开的 ≤5.2pt。**不要写通用的「纯数字 + 纯数字」合并器**:实测
   code 与 rating 的间距在某些单元格只有 6pt 上下,一合就把
   `'101'`+`'32'` 粘成 `'10132'` —— code 全局重复 10 个、rating 掉到
   68 个 None。所以合并只发生在 `parse_meta` 里已识别出 `dur` 之后
   的**尾随页码字段**,用 `prev_page_y` 记录上一段的 y0 作判据。
   (`'116’'` 与后面 `'1'` 的间距只有 3.8pt,若做通用合并会成 `'116’1'`。)
9. **BD / C7 两列在 p9-p14 上不印场次编号**(原 PDF 就没有,不是解析丢了;
   用 `page.get_text("text")` 原始文本核对过)。这些场次用
   `X<页号2位><序号2位>`(如 `X0901`)兜底,保证 `code` 唯一
   (前端 `byCode` / `slots` / `cardEls` 都以 code 为键,空值会互相覆盖)。
10. **场次特性 token 不止 GV**。实测 META 里出现:`GV`(347)、`Talk`(6)、
   `Commentary`(3)、`Event`(1)。`GV` 走 `is_gv`;其余按原义小写进
   `tags`(`talk` / `commentary` / `event`)。前端 `badges.ts` 只渲染已注册
   的键,未注册键**安全忽略** —— 2026-09-10 起 `talk` / `commentary` /
   `event` 三条已注册(青绿族 `--ev-teal`),想再加特性只需在 `BADGE_DEFS`
   里加一条 + `ABBR_LINES` 里补一行缩写说明。
11. **少数特别场册子里不印片长**。已知:002(闭幕式+获奖作联映)、
   BAFA 毕展。若把 `duration_min` 留 0,前端 `gvTalkMin()` =
   `(end - start) - duration_min` 会把整段时长当成「映后谈」,002 会凭空
   多出 240 分钟映后谈。→ 缺片长时回退成「印出来的整段时长」,
   映后谈自然归 0。(见 `stats['dur_missing']`,2025 版 = 1。)
12. **字幕标识可以同时印多个**,`subs` 必须是**数组**。实测 4 场印
   `KE KK`(028 / 029 / 109 / 268,全在 C3)。语义是叠加而非二选一:
   `KE` = 有韩字 + 有英字,`KK` = 配韩语对白。早期写法
   `if out["subs"] is None: out["subs"] = t` 只接第一个,第二个掉进
   `extra` 而被剥掉 → **静默丢数据**(自检里 `cells_with_extra` 恰好等于
   这些场次,就是它的哨兵)。现改为 `subs: list` 且逐个 append(去重)。
   前端 `SubsKey[]` + `legend.ts` 的 `subsKeys()` 归一化(兼容早期标量数据)。

输出对齐 src/types.ts 的 Screening / Venue。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from datetime import date, datetime
from pathlib import Path

import pymupdf

# ---------------------------------------------------------------- 常量

SCHEDULE_PAGES_DEFAULT = "9-16"

# 官方场馆代码 → (英文名, 韩文名, 分组, 所在区)
# 来源:2025 官方 Ticket Catalogue p8 图例(29 个场馆代码)
VENUE_NAME: dict[str, tuple[str, str, str, str]] = {
    "BT": ("Busan Cinema Center BIFF Theatre", "영화의전당 야외극장", "bcc", "centum"),
    "BH": ("Busan Cinema Center Haneulyeon Theatre", "영화의전당 하늘연극장", "bcc", "centum"),
    "B1": ("Busan Cinema Center Cinema 1", "영화의전당 중극장", "bcc", "centum"),
    "B2": ("Busan Cinema Center Cinema 2", "영화의전당 소극장", "bcc", "centum"),
    "B3": ("Busan Cinema Center Cinematheque", "영화의전당 시네마테크", "bcc", "centum"),
    "BD": ("Busan Cinema Center Indieplus", "영화의전당 인디플러스", "bcc", "centum"),
    "C1": ("CGV Centum City 1", "CGV센텀시티 1관", "cgv", "centum"),
    "C2": ("CGV Centum City 2", "CGV센텀시티 2관", "cgv", "centum"),
    "C3": ("CGV Centum City 3", "CGV센텀시티 3관", "cgv", "centum"),
    "C4": ("CGV Centum City 4", "CGV센텀시티 4관", "cgv", "centum"),
    "C5": ("CGV Centum City 5", "CGV센텀시티 5관", "cgv", "centum"),
    "C6": ("CGV Centum City 6", "CGV센텀시티 6관", "cgv", "centum"),
    "C7": ("CGV Centum City 7", "CGV센텀시티 7관", "cgv", "centum"),
    "CX": ("CGV Centum City IMAX", "CGV센텀시티 IMAX관", "cgv", "centum"),
    "L2": ("LOTTE CINEMA Centum City 2", "롯데시네마 센텀시티 2관", "lotte", "centum"),
    "L3": ("LOTTE CINEMA Centum City 3", "롯데시네마 센텀시티 3관", "lotte", "centum"),
    "L4": ("LOTTE CINEMA Centum City 4", "롯데시네마 센텀시티 4관", "lotte", "centum"),
    "L5": ("LOTTE CINEMA Centum City 5", "롯데시네마 센텀시티 5관", "lotte", "centum"),
    "L6": ("LOTTE CINEMA Centum City 6", "롯데시네마 센텀시티 6관", "lotte", "centum"),
    "L7": ("LOTTE CINEMA Centum City 7", "롯데시네마 센텀시티 7관", "lotte", "centum"),
    "L9": ("LOTTE CINEMA Centum City 9", "롯데시네마 센텀시티 9관", "lotte", "centum"),
    "L10": ("LOTTE CINEMA Centum City 10", "롯데시네마 센텀시티 10관", "lotte", "centum"),
    "KT": ("KOFIC Theater", "영화진흥위원회 표준시사실", "kofic", "centum"),
    "SH": ("Dongseo University Sohyang Theatre ShinhanCard Hall", "동서대학교 소향씨어터 신한카드홀", "sohyang", "nampo"),
    "BCM": ("Busan Community Media Center Open Hall", "부산시청자미디어센터 공개홀", "bcm", "nampo"),
    "M1": ("MEGABOX Busan Theater 1", "메가박스 부산극장 1관", "megabox", "nampo"),
    "M2": ("MEGABOX Busan Theater 2", "메가박스 부산극장 2관", "megabox", "nampo"),
    "M3": ("MEGABOX Busan Theater 3", "메가박스 부산극장 3관", "megabox", "nampo"),
    "M4": ("MEGABOX Busan Theater 4", "메가박스 부산극장 4관", "megabox", "nampo"),
}

# META 语法:HH:MM~HH:MM CODE RATING [SUBS] [FLAG] DUR' PAGES
RE_TIME = re.compile(r"^(\d{1,2}):(\d{2})~(\d{1,2}):(\d{2})$")
RE_CODE = re.compile(r"^\d{3}$")
RE_RATING = re.compile(r"^(All|ALL|12|15|19)$")
RE_SUBS = re.compile(r"^(KE|KN|KK|NO)$")
RE_DUR = re.compile(r"^(\d{1,3})['’]{1,2}$")
RE_PAGES = re.compile(r"^\d{1,3}(?:\s*,\s*\d{1,3})+$")
RE_PAGENUM = re.compile(r"^\d{1,3}$")
# 页码续行(陷阱 19):块格子的「页码」是**块内各片的介绍页页码列表**,排版换行时会自成一行 ——
# 与 META 行共享 y1、x 偏移 6.2pt,**恰好落进 cell_title_lines 的标题判据 (2,18]**,
# 于是被当标题拼进 title_en(实测 `008.title_en = "163, 165 Midnight Passion 1"`)。
# 这类行必须归并进 pages,不能进标题。
RE_PAGE_LINE = re.compile(r"^\d{1,3}(?:\s*,\s*\d{1,3})*,?$")
PAGE_NO_RANGE = (40, 230)   # 节目册「影片介绍页」的印刷页范围(2025 版实测 42–206)
# 午夜场联映块:单元扉页的对照表(见 parse_midnight_blocks)
MIDNIGHT_BLOCK_NAME = re.compile(r"^Midnight\s+Passion\s+(?P<n>\d+)$")
RE_BLOCK_ROW = re.compile(r"^(?P<code>\d{3})\s+[A-Za-z]{3}\s+\d{1,2}\s*/\s*\d{1,2}:\d{2}\s*/\s*[A-Z]{1,3}$")
RE_DAYNUM = re.compile(r"^\d{1,2}$")
RE_WEEKDAY = re.compile(r"^(MON|TUE|WED|THU|FRI|SAT|SUN)$")
RE_VENUE_CODE = re.compile(r"^[A-Z]{1,3}\d{0,2}$")

# 版面几何(单位 pt,基于 2025 版实测;2026 若版面微调改这里)
LINE_Y1_TOL = 2.5          # META line 与其标题 line 的 y1 容差(实测相等)
LINE_X_GAP_LO = 2.0        # 标题 line 相对 META line 的最小 x 间距
LINE_X_GAP_HI = 18.0       # 最大 x 间距(下一列 META 在 +21.5,故 18 安全)
TOKEN_MERGE_GAP = 6.5      # 拆开的同一数字间距 ≤5.2;正常 token 间距 ≥7.3
HEADER_Y = (556.0, 580.0)  # 底部表头条(场馆代码所在 y 带)
DAY_Y = (540.0, 585.0)     # 日标签 y 带
BODY_Y_MAX = 535.0         # 排期正文的 y 上限(其下是表头)

# META 里的「特性 token」→ tags 键(GV 单独走 is_gv,不在此表)
META_FLAG_TAGS = {
    "EVENT": "event",
    "TALK": "talk",
    "COMMENTARY": "commentary",
    "BATCH": "batch",
}

# 标题 / 备注里的关键词 → tags 键(键名尽量对齐 src/badges.ts 的注册表)
TITLE_TAGS = [
    (("개막", "opening ceremony", "opening night"), "opening"),
    (("폐막", "closing ceremony"), "closing"),
    (("master class", "masterclass", "마스터클래스"), "masterclass"),
    (("open talk", "오픈토크"), "open_talk"),
    (("world premiere", "월드 프리미어"), "premiere"),
    # 午夜场联映块:块名印在格子里(块内成员片另见单元扉页对照表 → parse_midnight_blocks)。
    # 靠标题关键词判定,**不硬编码 008/081/164/244** —— 换年份块号会变。
    (("midnight passion",), "midnight"),
]


# ---------------------------------------------------------------- 基础工具


def _has_hangul(s: str) -> bool:
    return any("\uac00" <= c <= "\ud7a3" for c in s)


def pages_only_line(text: str) -> list[int] | None:
    """该行是不是「纯页码列表」(块格子的页码续行)→ 页码列表;否则 None。

    守卫:数字必须落在节目册影片介绍页的印刷页范围内。这样「片名恰好是数字」的
    极端情形不会误伤 —— `1917` / `2046` 位数就不匹配,`9` / `42` 被范围挡掉。
    """
    if not RE_PAGE_LINE.match(text):
        return None
    nums = [int(v) for v in re.findall(r"\d{1,3}", text)]
    if not nums or any(not (PAGE_NO_RANGE[0] <= n <= PAGE_NO_RANGE[1]) for n in nums):
        return None
    return nums


def _split_members(text: str) -> list[str]:
    """`Exit 8 8번 출구 | Weapons 웨폰 | Honey Don't! 허니 돈트!` → ['Exit 8', 'Weapons', "Honey Don't!"]。

    成员行是「英文片名 + 韩文片名」并排,按 `|` 切段后在首个韩文字符处截断。
    韩文片名可能以数字开头(实测 `8번 출구`)→ 截断后会粘一个数字,需回剥
    (`'Exit 8 8'` → `'Exit 8'`)。只剥**紧贴韩文**的那一串数字,所以
    `Blade Runner 2049` 这类「片名以数字结尾」的不会被误伤。
    """
    out: list[str] = []
    for part in re.split(r"\s*[|｜]\s*", text):
        name = re.split(r"(?=[가-힣])", part)[0]
        name = re.sub(r"\d*$", "", name).strip().rstrip(",|").strip()
        if name:
            out.append(name)
    return out


def _log(kind: str, msg: str) -> None:
    print(f"[{kind}] {msg}", file=sys.stderr)


def build_lines(page: pymupdf.Page) -> list[dict]:
    """把页面拆成 line 级结构(已按显示坐标系,见 docstring 陷阱 1)。

    每个 line:{x0, y0, x1, y1, spans, is_meta}
    * `y1` = line bbox 的下边缘 —— **单元格归属的关键**(陷阱 7)
    * `is_meta` = 该 line 内是否含 `HH:MM~HH:MM` 时间 span
    """
    out: list[dict] = []
    for blk in page.get_text("dict")["blocks"]:
        if blk.get("type") != 0:
            continue
        for ln in blk.get("lines", []):
            spans: list[dict] = []
            for sp in ln["spans"]:
                t = sp["text"].strip()
                if not t:
                    continue
                x0, y0, x1, y1 = sp["bbox"]
                spans.append({"x0": x0, "y0": y0, "x1": x1, "y1": y1, "t": t})
            if not spans:
                continue
            bb = ln["bbox"]
            out.append({
                "x0": bb[0], "y0": bb[1], "x1": bb[2], "y1": bb[3],
                "spans": spans,
                "is_meta": any(RE_TIME.match(s["t"]) for s in spans),
            })
    return out


# ---------------------------------------------------------------- 版面识别


def find_day_labels(spans: list[dict]) -> list[dict]:
    """底部表头的日标签 → [{'day': 17, 'wd': 'WED', 'x': 29.5}, ...] 按 x 升序。

    版面上「星期」在上、「日号」在下,同 x 相邻(如 WED@(31.9,553.9) / 17@(29.5,567.3))。
    """
    wds = [s for s in spans if RE_WEEKDAY.match(s["t"]) and DAY_Y[0] <= s["y0"] <= DAY_Y[1]]
    nums = [s for s in spans if RE_DAYNUM.match(s["t"]) and DAY_Y[0] <= s["y0"] <= DAY_Y[1]]
    labels: list[dict] = []
    for w in wds:
        cand = [n for n in nums if abs(n["x0"] - w["x0"]) <= 12 and abs(n["y0"] - w["y0"]) <= 25]
        if not cand:
            continue
        n = min(cand, key=lambda n: abs(n["x0"] - w["x0"]))
        labels.append({"day": int(n["t"]), "wd": w["t"], "x": min(n["x0"], w["x0"])})
    labels.sort(key=lambda d: d["x"])
    return labels


def find_venue_codes(spans: list[dict]) -> list[dict]:
    """底部表头的场馆代码 → [{'code': 'BT', 'x': 47.2}, ...] 按 x 升序。"""
    out: list[dict] = []
    seen: set[tuple[str, int]] = set()
    for s in spans:
        if not (HEADER_Y[0] <= s["y0"] <= HEADER_Y[1]):
            continue
        t = s["t"]
        if not RE_VENUE_CODE.match(t) or t not in VENUE_NAME:
            continue
        k = (t, round(s["x0"] / 4))
        if k in seen:
            continue
        seen.add(k)
        out.append({"code": t, "x": s["x0"]})
    out.sort(key=lambda v: v["x"])
    return out


def nearest_venue(venue_codes: list[dict], x: float) -> str | None:
    if not venue_codes:
        return None
    return min(venue_codes, key=lambda v: abs(v["x"] - x))["code"]


def day_for_x(labels: list[dict], x: float) -> dict | None:
    """场次 x 落在哪个日标签区域:取最后一个 x_label <= x 的标签。"""
    if not labels:
        return None
    hit = [d for d in labels if d["x"] <= x + 6]
    return (hit[-1] if hit else labels[0])


def cell_title_lines(lines: list[dict], meta_line: dict) -> list[dict]:
    """单元格的标题/备注行 = 与 META line **共享 y1** 且 x 近邻的那些 line。

    见 docstring 陷阱 7。x 间距卡在 (LINE_X_GAP_LO, LINE_X_GAP_HI]:
    下一列的 META line 在 +21.5、下一列的标题在 +27.9,都被排除;
    本列的英文标题 +6.2 / 韩文标题 +11.4 / 备注 +11.4,都被收进来。
    """
    out: list[dict] = []
    for l in lines:
        if l["is_meta"]:
            continue
        if abs(l["y1"] - meta_line["y1"]) > LINE_Y1_TOL:
            continue
        gap = l["x0"] - meta_line["x0"]
        if not (LINE_X_GAP_LO < gap <= LINE_X_GAP_HI):
            continue
        out.append(l)
    out.sort(key=lambda l: l["x0"])
    return out


# ---------------------------------------------------------------- 单元格解析


def parse_meta(meta_spans: list[dict]) -> dict | None:
    """META 阅读顺序 = y 递减(陷阱 2)。

    只对**末尾的页码**做「拆号回拼」(陷阱 8):同一个数字被 PDF 拆成
    多个 span 时,相邻两段的 y 间距(≤5.2)明显小于正常 token 间距(≥7.3)。
    不能对整行做通用合并 —— 实测 code 与 rating 的间距在某些单元格
    只有 6pt 上下,一合就把 `'101'`+`'32'` 粘成 `'10132'`,code 与 rating 全废。
    """
    items = sorted(meta_spans, key=lambda s: -s["y0"])
    if not items:
        return None
    m = RE_TIME.match(items[0]["t"])
    if not m:
        return None
    h1, m1, h2, m2 = (int(v) for v in m.groups())
    start = h1 * 60 + m1
    end = h2 * 60 + m2
    if end <= start:
        end += 24 * 60  # 跨午夜(如 23:59~05:10)
    out = {
        "start": f"{h1:02d}:{m1:02d}",
        "end": f"{h2:02d}:{m2:02d}",
        "start_min": start,
        "end_min": end,
        "code": None,
        "rating": None,
        "subs": [],
        "gv": False,
        "flags": [],
        "dur": None,
        "pages": [],
        "extra": [],
    }
    prev_page_y: float | None = None
    for sp in items[1:]:
        t = sp["t"].strip().strip(",，、")
        if not t:
            continue
        if out["code"] is None and RE_CODE.match(t):
            out["code"] = t
            continue
        if out["rating"] is None and RE_RATING.match(t):
            out["rating"] = "ALL" if t.upper() == "ALL" else t
            continue
        if RE_SUBS.match(t):
            # 陷阱 12:官方会**同时印多个**字幕标识(实测 `KE KK`),两者是叠加关系
            # (KE = 有韩字 + 有英字;KK = 配韩语对白),不是二选一。
            # 早期写法 `if out["subs"] is None` 只接第一个,第二个掉进 extra
            # 被剥掉 → 静默丢数据(自检里 cells_with_extra 恰好 = 这些场次)。
            if t not in out["subs"]:
                out["subs"].append(t)
            continue
        if t.upper() == "GV":
            out["gv"] = True
            continue
        flag = META_FLAG_TAGS.get(t.upper())
        if flag:
            if flag not in out["flags"]:
                out["flags"].append(flag)
            continue
        d = RE_DUR.match(t)
        if d and out["dur"] is None:
            out["dur"] = int(d.group(1))
            continue
        if RE_PAGES.match(t):
            out["pages"] += [int(v) for v in re.findall(r"\d{1,3}", t)]
            prev_page_y = sp["y0"]
            continue
        if RE_PAGENUM.match(t) and out["dur"] is not None:
            # 陷阱 8:被拆开的同一个页码(如 '1'+'91' = 191)按 y 间距回拼
            if prev_page_y is not None and (prev_page_y - sp["y0"]) < TOKEN_MERGE_GAP:
                out["pages"][-1] = int(f"{out['pages'][-1]}{t}")
            else:
                out["pages"].append(int(t))
            prev_page_y = sp["y0"]
            continue
        prev_page_y = None
        out["extra"].append(t)
    return out


def split_title(title_spans: list[dict]) -> tuple[str, str, list[str]]:
    """返回 (title_en, title_kr, notes)。同语言多 span 按 y 递减拼接。"""
    en, kr, notes = [], [], []
    for s in sorted(title_spans, key=lambda s: -s["y0"]):
        t = s["t"].strip()
        if not t:
            continue
        if t[0] in "(（[※·":
            notes.append(t)
        elif _has_hangul(t):
            kr.append(t)
        else:
            en.append(t)
    return " ".join(en).strip(), " ".join(kr).strip(), notes


def tags_for(title_en: str, title_kr: str, notes: list[str], flags: list[str]) -> list[str]:
    """汇总场次特性键:标题/备注关键词 + META 特性 token。"""
    blob = " ".join([title_en, title_kr, *notes]).lower()
    tags: list[str] = []
    for needles, tag in TITLE_TAGS:
        if any(n in blob for n in needles) and tag not in tags:
            tags.append(tag)
    for f in flags:
        if f not in tags:
            tags.append(f)
    return tags


def _closest(cands: list[dict], y: float) -> dict | None:
    """y 最接近的一条(平局取先出现的)。"""
    return min(cands, key=lambda l: abs(l["y0"] - y)) if cands else None


def parse_midnight_blocks(doc: pymupdf.Document) -> dict[str, list[str]]:
    """扫全册找「午夜场联映块」单元扉页的对照表 → {块 code: [成员片名…]}。

    扉页版式(实测 2025 版 PDF p81 = 印刷页 160「Midnight Passion」单元扉页):

        x92.1  y169.2  Midnight Passion 1
        x92.1  y177.3  미드나잇 패션 1
        x146.0 y168.5  Exit 8 8번 출구 | Weapons 웨폰 | Honey Don't! 허니 돈트!
        x146.0 y178.6  008 Sep 18 / 23:59 / BH

    即:块名行 → **同一 x 子栏、块名正下方**的 `code … / … / 场馆` 行 → 该行**正上方**的成员行。

    为什么必须另立一张表:排期格子只印**块名 + 页码列表**,块里到底是哪几部片
    只有这张表说得清(2025:MP1=3 / MP2=3 / MP3=3 / MP4=1,共 10 部)。
    纯按页码反查会**过收** —— 一个印刷页放 2 部片,`163` 同时是 Honey Don't! 与
    The Holy Boy 的介绍页。

    取行一律取「**最近**」而不是「第一个同高」:同一页右侧还有图注 / 正文
    (实测 MP3 的成员行曾被 `© 2025 ”Exit 8” Film Partners` 以 2.4pt 之差抢走)。
    再加一道 `|成员行.y − 块名.y| ≤ 6` 的贴合校验兜底。
    """
    out: dict[str, list[str]] = {}
    for pno in range(1, doc.page_count + 1):
        lines = build_lines(doc[pno - 1])
        rows = [(l, " ".join(s["t"] for s in l["spans"]).strip()) for l in lines]
        for ln, head in rows:
            if not MIDNIGHT_BLOCK_NAME.match(head):
                continue
            best: tuple[float, str, list[str]] | None = None
            for row, rowtxt in rows:
                # ① code 行:块名右侧、正下方 16pt 内(实测 +9.4pt)
                if row["x0"] <= ln["x0"] + 20 or not (0 < row["y0"] - ln["y0"] <= 16):
                    continue
                m = RE_BLOCK_ROW.match(rowtxt)
                if not m:
                    continue
                # ② 成员行 = code 行正上方、同一 x 子栏的最近一行(实测 +10.1pt)
                mem = _closest(
                    [l for l, _t in rows
                     if abs(l["x0"] - row["x0"]) <= 20 and 0 < row["y0"] - l["y0"] <= 16],
                    row["y0"],
                )
                if mem is None:
                    continue
                # ③ 贴合校验:成员行必须与块名同高(排除页面别处的同形行)
                score = abs(mem["y0"] - ln["y0"])
                if score > 6:
                    continue
                if best is None or score < best[0]:
                    best = (score, m.group("code"), _split_members(" ".join(s["t"] for s in mem["spans"])))
            if best and best[2]:
                out[best[1]] = best[2]
    return out


# ---------------------------------------------------------------- 页面主流程


def parse_page(page: pymupdf.Page, page_no: int, args, stats: Counter) -> list[dict]:
    lines = build_lines(page)
    spans = [s for l in lines for s in l["spans"]]
    labels = find_day_labels(spans)
    venue_codes = find_venue_codes(spans)

    if labels:
        stats["pages_with_day_label"] += 1
    else:
        stats["pages_without_day_label"] += 1

    meta_lines = [l for l in lines if l["is_meta"] and l["y0"] < BODY_Y_MAX]
    meta_lines.sort(key=lambda l: (l["x0"], -l["y1"]))

    rows: list[dict] = []
    no_code_seq = 0
    for m in meta_lines:
        meta = parse_meta(m["spans"])
        if not meta:
            stats["meta_unparsed"] += 1
            _log("WARN", f"p{page_no} meta 解析失败 @x={m['x0']:.0f},y={m['y1']:.0f}: "
                         f"{[s['t'] for s in m['spans']]}")
            continue

        dl = day_for_x(labels, m["x0"])
        if dl is None:
            stats["no_day_anchor"] += 1
            _log("WARN", f"p{page_no} 找不到日标签,跳过 1 场 @x={m['x0']:.0f}")
            continue

        # 标题行里会混进「页码续行」—— 块格子的页码列表换行自成一行,几何上落进标题判据
        # (陷阱 19)。它不是标题:并入 pages,否则会成为 title_en 的前缀。
        tl = cell_title_lines(lines, m)
        title_spans: list[dict] = []
        for l in tl:
            pg = pages_only_line(" ".join(s["t"] for s in l["spans"]).strip())
            if pg:
                meta["pages"] += pg
                stats["page_line_absorbed"] += 1
                continue
            title_spans += l["spans"]
        title_en, title_kr, notes = split_title(title_spans)
        notes += [t for t in meta["extra"] if t not in notes]
        if not title_en and not title_kr:
            stats["empty_title"] += 1
            _log("WARN", f"p{page_no} 空标题 code={meta['code']} @x={m['x0']:.0f}")
        if not title_en:
            stats["no_title_en"] += 1

        if meta["code"]:
            code = meta["code"]
        else:
            # 陷阱 9:BD / C7 列在 2025 版上不印编号 → 兜底保证 code 唯一
            no_code_seq += 1
            code = f"X{page_no:02d}{no_code_seq:02d}"
            stats["code_synthesized"] += 1

        vcode = nearest_venue(venue_codes, m["x0"])

        # end_time:官方印的 end 一般 = start + 片长;GV 场次再补一段映后占用。
        # 陷阱 11:少数「特别场」(如 002 闭幕式+获奖作联映、BAFA 毕展)册子里
        # **不印片长**。此时不能留 0 —— 前端 gvTalkMin = (end-start) - duration_min
        # 会把整段时长算成「映后谈 240 分钟」。回退成印出来的整段时长,
        # 语义 = 「这一段占用的总时长」,且映后谈自然为 0。
        end_min = meta["end_min"]
        printed_span = end_min - meta["start_min"]
        dur = meta["dur"] if meta["dur"] is not None else printed_span
        if meta["dur"] is None:
            stats["dur_missing"] += 1
        if meta["gv"] and meta["dur"] and printed_span == meta["dur"]:
            end_min += args.gv_add_min
            stats["gv_end_adjusted"] += 1
        elif meta["dur"] and abs(printed_span - meta["dur"]) > 2:
            stats["end_ne_dur"] += 1

        # 跨午夜场:end_min ≥ 1440 **保留 24+ 时制**(输出 "29:35" = 次日 05:35),绝不 %24 折回 ——
        # 前端 hmsToMin / 轴界 / 卡片宽度 / 冲突 / ICS 进位全靠 end > start。
        # (2025 版实测 4 场 Midnight Passion:23:59 → 次日 05:26~06:04)
        if end_min >= 24 * 60:
            stats["cross_midnight"] += 1
            _log("INFO",
                 f"p{page_no} code={code} 跨午夜 {meta['start']}–"
                 f"{end_min // 60:02d}:{end_min % 60:02d}(24+ 时制)")

        rows.append({
            "code": code,
            "title_en": title_en,
            "title_kr": title_kr,
            "title_zh": "",
            "date": date(args.year, args.month, dl["day"]).isoformat(),
            "start_time": meta["start"],
            # 24+ 时制:跨午夜场保留 ≥24 的小时(如 "29:35" = 次日 05:35),前端按「次日」渲染
            "end_time": f"{end_min // 60:02d}:{end_min % 60:02d}",
            "duration_min": dur,
            "venue_id": (vcode or "unknown").lower(),
            "venue_display": VENUE_NAME.get(vcode, ("", "", "", ""))[0] if vcode else "",
            "is_gv": meta["gv"],
            "tags": tags_for(title_en, title_kr, notes, meta["flags"]),
            "rating": meta["rating"],
            # 空数组落 null:与前端 `subs?: SubsKey[]` 的可选语义一致(不用 [] 表示未标注)
            "subs": meta["subs"] or None,
            "page": meta["pages"][0] if meta["pages"] else None,
            "_page": page_no,
            "_wd": dl["wd"],
            "_extra": meta["extra"],
        })
        if meta["extra"]:
            # 陷阱 12 修完后,2025 版这里应为 0(原 4 个 = KE KK 的第二值)。
            # 非 0 = META 里有解析器没认领的 token(新特性 / 新标识 / 版式变化)
            # → 大声报出来,不要再让它静默丢进 extra。
            stats["cells_with_extra"] += 1
            _log("WARN", f"p{page_no} code={code} 未认领 token {meta['extra']} (title_en={title_en!r})")
        stats[f"day_{dl['day']}"] += 1

    return rows


def build_venues(codes: set[str]) -> list[dict]:
    out = []
    for c in sorted(codes, key=lambda c: (VENUE_NAME.get(c, ("",))[0], c)):
        en, kr, grp, region = VENUE_NAME.get(c, (c, c, "unknown", "unknown"))
        out.append({
            "id": c.lower(),
            "name": en,
            "name_kr": kr,
            "group": grp,
            "region": region,
            "code": c,
            "lat": None,
            "lng": None,
        })
    return out


# ---------------------------------------------------------------- CLI


def parse_pages_arg(s: str) -> list[int]:
    pages: list[int] = []
    for part in s.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-", 1)
            pages += list(range(int(a), int(b) + 1))
        elif part:
            pages.append(int(part))
    return pages


def main() -> int:
    ap = argparse.ArgumentParser(description="BIFF Ticket Catalogue PDF → schedule.json")
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--year", type=int, required=True)
    ap.add_argument("--month", type=int, default=9)
    ap.add_argument("--schedule-pages", default=SCHEDULE_PAGES_DEFAULT)
    ap.add_argument("--out", default="schedule.json")
    ap.add_argument("--venues-out", default=None)
    ap.add_argument("--gv-add-min", type=int, default=25)
    ap.add_argument("--dump-page", type=int, default=None, help="只打印该页解析结果,不写文件")
    ap.add_argument("--festival-name", default=None)
    args = ap.parse_args()

    doc = pymupdf.open(args.pdf)
    pages = parse_pages_arg(args.schedule_pages)
    stats: Counter = Counter()

    if args.dump_page:
        rows = parse_page(doc[args.dump_page - 1], args.dump_page, args, stats)
        for r in sorted(rows, key=lambda r: (r["_page"], r["venue_id"], r["start_time"])):
            print(json.dumps({k: v for k, v in r.items() if not k.startswith("_")},
                             ensure_ascii=False))
        _log("INFO", f"dump p{args.dump_page}: {len(rows)} 场; stats={dict(stats)}")
        return 0

    _log("INFO", f"{Path(args.pdf).name}: {doc.page_count} 页,扫描 p{pages[0]}-p{pages[-1]}")
    all_rows: list[dict] = []
    for pno in pages:
        rows = parse_page(doc[pno - 1], pno, args, stats)
        all_rows += rows
        days = sorted({r["_wd"] for r in rows})
        print(f"  p{pno}: {len(rows):3d} 场  days={days}", file=sys.stderr)

    # 午夜场联映块:块场次挂上成员片名(单元扉页对照表;块名本身不含成员信息)
    blocks = parse_midnight_blocks(doc)
    for r in all_rows:
        if r["code"] in blocks:
            r["midnight_members"] = blocks[r["code"]]
    hit = [c for c in blocks if c in {r["code"] for r in all_rows}]
    _log("SANITY", f"联映块成员表: {len(blocks)} 块 / {sum(len(v) for v in blocks.values())} 部片"
                   f"  已挂到排期: {hit}")
    miss = [c for c in blocks if c not in hit]
    if miss:
        _log("WARN", f"成员表里的块 code 在排期里找不到: {miss}")

    # 交叉校验 1:每页的 code 段应基本连续(缺号 = 该时段无排片/取消)
    for pno in pages:
        cs = sorted(int(r["code"]) for r in all_rows
                    if r["_page"] == pno and r["code"].isdigit())
        if cs:
            gaps = [(a, b) for a, b in zip(cs, cs[1:]) if b - a > 1]
            if gaps:
                _log("SANITY", f"p{pno} code 不连续: {gaps[:6]}")

    # 交叉校验 2:code 必须全局唯一(前端 byCode / slots 以它为键)
    dup = [c for c, n in Counter(r["code"] for r in all_rows).items() if n > 1]
    if dup:
        _log("SANITY", f"⚠ code 重复 {len(dup)} 个: {dup[:10]}")
    else:
        _log("SANITY", "code 全局唯一 ✓")

    used_codes = {r["venue_id"].upper() for r in all_rows if r["venue_id"] != "unknown"}
    schedule = {
        "festival": {
            "name": args.festival_name or f"{args.year} Busan International Film Festival",
            "year": args.year,
            "dates": sorted({r["date"] for r in all_rows}),
            "note": ("由 tools/extract_schedule.py 从官方 Ticket Catalogue PDF 解析;"
                     "venue_id = 官方影院代码小写(如 b1/c2/l10),lat/lng 需另行补全;"
                     "code 以 X 开头者为原 PDF 未印编号的场次(合成兜底)"),
            "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        },
        "screenings": [
            {k: v for k, v in r.items() if not k.startswith("_")}
            for r in sorted(all_rows, key=lambda r: (r["date"], r["start_time"], r["code"]))
        ],
    }
    Path(args.out).write_text(json.dumps(schedule, ensure_ascii=False, indent=1), encoding="utf-8")
    _log("OK", f"写出 {args.out}:{len(schedule['screenings'])} 场")

    if args.venues_out:
        venues = build_venues(used_codes)
        Path(args.venues_out).write_text(
            json.dumps({"venues": venues}, ensure_ascii=False, indent=1), encoding="utf-8")
        _log("OK", f"写出 {args.venues_out}:{len(venues)} 场馆")

    per_day = Counter(r["date"] for r in all_rows)
    per_venue = Counter(r["venue_id"] for r in all_rows)
    _log("SANITY", f"每日场次: {dict(sorted(per_day.items()))}")
    _log("SANITY", f"每馆场次 top12: {per_venue.most_common(12)}")
    _log("SANITY", f"空 title_en: {sum(1 for r in all_rows if not r['title_en'])}"
                   f"  全空(中英韩皆空): {sum(1 for r in all_rows if not r['title_en'] and not r['title_kr'])}")
    # 回归哨兵(陷阱 19):title_en 绝不能以「页码列表 + 空格」开头 ——
    # 那说明块格子的页码续行又漏进标题了(实测曾出现 `163, 165 Midnight Passion 1`)。
    # 判据复用 pages_only_line 的范围守卫,故「片名本身以数字开头」不会误报
    # (实测 `5 Centimeters Per Second` —— 单数字 5 不在影片页范围内)。
    dirty: list[tuple[str, str]] = []
    for r in all_rows:
        m = re.match(r"^(?P<lst>\d{1,3}(?:\s*,\s*\d{1,3})*)\s+\S", r["title_en"])
        if m and pages_only_line(m.group("lst")):
            dirty.append((r["code"], r["title_en"]))
    if dirty:
        _log("WARN", f"title_en 仍带页码前缀 {len(dirty)} 条(页码续行漏网?): {dirty[:6]}")
    else:
        _log("SANITY", "title_en 无页码前缀 ✓")
    _log("SANITY", f"页码续行归并: {stats['page_line_absorbed']} 行")
    _log("SANITY", f"rating 分布: {dict(Counter(r['rating'] for r in all_rows))}")
    # subs 已是列表 → Counter 不能直接吃。按「每个标识各计一次」统计,
    # 另外单报未标注场次与**多值场次**(陷阱 12 的回归哨兵:2025 版应为 4 场 KE KK)。
    subs_flat = Counter(t for r in all_rows for t in (r["subs"] or []))
    subs_multi = [r["code"] for r in all_rows if r["subs"] and len(r["subs"]) > 1]
    _log("SANITY", f"subs 分布: {dict(subs_flat)}  未标注: {sum(1 for r in all_rows if not r['subs'])}"
                   f"  多值场次: {len(subs_multi)} {subs_multi}")
    _log("SANITY", f"GV 场次: {sum(1 for r in all_rows if r['is_gv'])} / {len(all_rows)}")
    _log("SANITY", f"tags 分布: {dict(Counter(t for r in all_rows for t in r['tags']))}")
    _log("SANITY", f"统计: {dict(stats)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
