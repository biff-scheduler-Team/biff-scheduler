#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""festival_common.py — 电影节排期册 PDF 解析的通用底座。

从 `extract_schedule.py` 抽出「与具体电影节无关」的部分，供各电影节的适配层复用：

* 页面 → line / span 结构（`build_lines`）
* 版面几何选择器（`find_day_labels` / `find_venue_codes` / `nearest_venue` /
  `day_for_x` / `closest` / `cell_title_lines`）
* token 规格驱动的 META 扫描（`parse_meta`）与「纯页码行」识别（`pages_only_line`）
* 场次特性标签汇总（`tags_for`）
* 自检哨兵（`check_code_unique` / `check_code_continuity` / `check_title_page_prefix`）
* 契约化 JSON 写出（`strip_internal` / `write_json`）

各电影节的差异（页段、场馆表、token 正则与枚举、版面几何、特殊板块）
由调用方以 `LayoutSpec` / `MetaSyntax` 注入 —— 本模块**不硬编码任何电影节常量**。

新增电影节时的做法：复制 `extract_schedule.py` 作为适配层，替换 `VENUE_NAME`、
`RE_*`、`LAYOUT` / `META_SYNTAX` 与特殊板块解析，通用逻辑一律 import 本模块。
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------- 规格


@dataclass
class LayoutSpec:
    """版面几何（单位 pt）。各电影节册子不同，由适配层注入。"""

    line_y1_tol: float
    line_x_gap_lo: float
    line_x_gap_hi: float
    header_y: tuple[float, float]
    day_y: tuple[float, float]
    body_y_max: float


@dataclass
class MetaSyntax:
    """单元格 META 行的 token 语法。

    排期格子里每个字段（时间/编号/分级/字幕/特性/片长/页码）都是独立 span，
    本规格描述「怎么认」；认不出的 token 一律进 `extra`，由调用方报 WARN。

    约定：`time_re` 必须含 4 个捕获组 —— （起时, 起分, 终时, 终分）。
    """

    time_re: re.Pattern[str]
    code_re: re.Pattern[str]
    rating_re: re.Pattern[str]
    subs_re: re.Pattern[str]
    dur_re: re.Pattern[str]
    pages_re: re.Pattern[str]
    pagenum_re: re.Pattern[str]
    page_line_re: re.Pattern[str]
    page_no_range: tuple[int, int]
    gv_token: str = "GV"
    flag_tags: dict[str, str] = field(default_factory=dict)
    token_merge_gap: float = 6.5


# ---------------------------------------------------------------- 基础工具


def log(kind: str, msg: str) -> None:
    """统一日志出口（一律 stderr，不污染 stdout 的 JSON）。"""
    print(f"[{kind}] {msg}", file=sys.stderr)


def parse_pages_arg(s: str) -> list[int]:
    """`"9-16"` / `"9,11,13"` / `"9-11,14"` → 页号列表。"""
    pages: list[int] = []
    for part in s.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-", 1)
            pages += list(range(int(a), int(b) + 1))
        elif part:
            pages.append(int(part))
    return pages


def build_lines(page: Any, syntax: MetaSyntax) -> list[dict]:
    """把页面拆成 line 级结构（坐标已是显示坐标系，勿再乘 rotation_matrix）。

    每个 line：{x0, y0, x1, y1, spans, is_meta}
    * `y1` = line bbox 的下边缘 —— **单元格归属的关键**（靠共享 y1，不靠 y 窗口）
    * `is_meta` = 该 line 内是否含时间 span（由 `syntax.time_re` 判定）
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
                "is_meta": any(syntax.time_re.match(s["t"]) for s in spans),
            })
    return out


# ---------------------------------------------------------------- 版面识别


def find_day_labels(
    spans: list[dict],
    layout: LayoutSpec,
    weekday_re: re.Pattern[str],
    daynum_re: re.Pattern[str],
) -> list[dict]:
    """底部表头的日标签 → [{'day': 17, 'wd': 'WED', 'x': 29.5}, ...] 按 x 升序。

    版面上「星期」在上、「日号」在下，同 x 相邻。双日页会出现两个日标签。
    """
    wds = [s for s in spans if weekday_re.match(s["t"]) and layout.day_y[0] <= s["y0"] <= layout.day_y[1]]
    nums = [s for s in spans if daynum_re.match(s["t"]) and layout.day_y[0] <= s["y0"] <= layout.day_y[1]]
    labels: list[dict] = []
    for w in wds:
        cand = [n for n in nums if abs(n["x0"] - w["x0"]) <= 12 and abs(n["y0"] - w["y0"]) <= 25]
        if not cand:
            continue
        n = min(cand, key=lambda n: abs(n["x0"] - w["x0"]))
        labels.append({"day": int(n["t"]), "wd": w["t"], "x": min(n["x0"], w["x0"])})
    labels.sort(key=lambda d: d["x"])
    return labels


def find_venue_codes(
    spans: list[dict],
    layout: LayoutSpec,
    venue_code_re: re.Pattern[str],
    venue_names: dict[str, tuple],
) -> list[dict]:
    """底部表头的场馆代码 → [{'code': 'BT', 'x': 47.2}, ...] 按 x 升序。

    `venue_names` 同时充当白名单：只认登记过的代码，避免把表头里的杂项当场馆。
    """
    out: list[dict] = []
    seen: set[tuple[str, int]] = set()
    for s in spans:
        if not (layout.header_y[0] <= s["y0"] <= layout.header_y[1]):
            continue
        t = s["t"]
        if not venue_code_re.match(t) or t not in venue_names:
            continue
        k = (t, round(s["x0"] / 4))
        if k in seen:
            continue
        seen.add(k)
        out.append({"code": t, "x": s["x0"]})
    out.sort(key=lambda v: v["x"])
    return out


def nearest_venue(venue_codes: list[dict], x: float) -> str | None:
    """x 最接近的场馆代码（列归属）。"""
    if not venue_codes:
        return None
    return min(venue_codes, key=lambda v: abs(v["x"] - x))["code"]


def day_for_x(labels: list[dict], x: float) -> dict | None:
    """场次 x 落在哪个日标签区域：取最后一个 x_label <= x 的标签。"""
    if not labels:
        return None
    hit = [d for d in labels if d["x"] <= x + 6]
    return (hit[-1] if hit else labels[0])


def closest(cands: list[dict], y: float) -> dict | None:
    """y 最接近的一条（平局取先出现的）。"""
    return min(cands, key=lambda l: abs(l["y0"] - y)) if cands else None


def cell_title_lines(lines: list[dict], meta_line: dict, layout: LayoutSpec) -> list[dict]:
    """单元格的标题/备注行 = 与 META line **共享 y1** 且 x 近邻的那些 line。

    x 间距卡在 (line_x_gap_lo, line_x_gap_hi]：下一列的 META line 必须落在其外，
    本列的英文/韩文标题与备注则被收进来。用 y 窗口切单元格会漏标题 ——
    旋转文本流里标题排在时间**之前**，y 比时间更大，落在窗口之外。
    """
    out: list[dict] = []
    for l in lines:
        if l["is_meta"]:
            continue
        if abs(l["y1"] - meta_line["y1"]) > layout.line_y1_tol:
            continue
        gap = l["x0"] - meta_line["x0"]
        if not (layout.line_x_gap_lo < gap <= layout.line_x_gap_hi):
            continue
        out.append(l)
    out.sort(key=lambda l: l["x0"])
    return out


# ---------------------------------------------------------------- 单元格解析


def pages_only_line(text: str, syntax: MetaSyntax) -> list[int] | None:
    """该行是不是「纯页码列表」（块格子的页码续行）→ 页码列表；否则 None。

    守卫：数字必须落在节目册影片介绍页的印刷页范围内。这样「片名恰好是数字」的
    极端情形不会误伤 —— `1917` / `2046` 位数就不匹配，`9` / `42` 被范围挡掉。
    """
    if not syntax.page_line_re.match(text):
        return None
    nums = [int(v) for v in re.findall(r"\d{1,3}", text)]
    lo, hi = syntax.page_no_range
    if not nums or any(not (lo <= n <= hi) for n in nums):
        return None
    return nums


def parse_meta(meta_spans: list[dict], syntax: MetaSyntax) -> dict | None:
    """META 阅读顺序 = y 递减（单元格文字旋转 90°，见适配层 docstring）。

    只对**末尾的页码**做「拆号回拼」：同一个数字被 PDF 拆成多个 span 时，
    相邻两段的 y 间距明显小于正常 token 间距。不能对整行做通用合并 ——
    实测 code 与 rating 的间距在某些单元格只有 6pt 上下，一合就把
    `'101'`+`'32'` 粘成 `'10132'`，code 与 rating 全废。
    """
    items = sorted(meta_spans, key=lambda s: -s["y0"])
    if not items:
        return None
    m = syntax.time_re.match(items[0]["t"])
    if not m:
        return None
    h1, m1, h2, m2 = (int(v) for v in m.groups())
    start = h1 * 60 + m1
    end = h2 * 60 + m2
    if end <= start:
        end += 24 * 60  # 跨午夜（如 23:59~05:10）
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
        if out["code"] is None and syntax.code_re.match(t):
            out["code"] = t
            continue
        if out["rating"] is None and syntax.rating_re.match(t):
            out["rating"] = "ALL" if t.upper() == "ALL" else t
            continue
        if syntax.subs_re.match(t):
            # 官方会**同时印多个**字幕标识（实测 `KE KK`），两者是叠加关系，
            # 不是二选一 —— 只接第一个会让第二个掉进 extra 被静默剥掉。
            if t not in out["subs"]:
                out["subs"].append(t)
            continue
        if t.upper() == syntax.gv_token.upper():
            out["gv"] = True
            continue
        flag = syntax.flag_tags.get(t.upper())
        if flag:
            if flag not in out["flags"]:
                out["flags"].append(flag)
            continue
        d = syntax.dur_re.match(t)
        if d and out["dur"] is None:
            out["dur"] = int(d.group(1))
            continue
        if syntax.pages_re.match(t):
            out["pages"] += [int(v) for v in re.findall(r"\d{1,3}", t)]
            prev_page_y = sp["y0"]
            continue
        if syntax.pagenum_re.match(t) and out["dur"] is not None:
            # 被拆开的同一个页码（如 '1'+'91' = 191）按 y 间距回拼
            if prev_page_y is not None and (prev_page_y - sp["y0"]) < syntax.token_merge_gap:
                out["pages"][-1] = int(f"{out['pages'][-1]}{t}")
            else:
                out["pages"].append(int(t))
            prev_page_y = sp["y0"]
            continue
        prev_page_y = None
        out["extra"].append(t)
    return out


def tags_for(
    title_en: str,
    title_kr: str,
    notes: list[str],
    flags: list[str],
    title_tags: list[tuple[tuple[str, ...], str]],
) -> list[str]:
    """汇总场次特性键：标题/备注关键词 + META 特性 token。"""
    blob = " ".join([title_en, title_kr, *notes]).lower()
    tags: list[str] = []
    for needles, tag in title_tags:
        if any(n in blob for n in needles) and tag not in tags:
            tags.append(tag)
    for f in flags:
        if f not in tags:
            tags.append(f)
    return tags


# ---------------------------------------------------------------- 自检哨兵


def check_code_unique(rows: list[dict]) -> list[str]:
    """返回重复的 code 列表（前端 byCode / slots 以 code 为键，重复会互相覆盖）。"""
    return [c for c, n in Counter(r["code"] for r in rows).items() if n > 1]


def check_code_continuity(rows: list[dict], pages: list[int]) -> list[tuple[int, list]]:
    """每页的 code 段应基本连续（缺号 = 该时段无排片/取消）→ [(页号, 缺口对)]。"""
    out: list[tuple[int, list]] = []
    for pno in pages:
        cs = sorted(int(r["code"]) for r in rows if r["_page"] == pno and r["code"].isdigit())
        if not cs:
            continue
        gaps = [(a, b) for a, b in zip(cs, cs[1:]) if b - a > 1]
        if gaps:
            out.append((pno, gaps))
    return out


def check_title_page_prefix(rows: list[dict], syntax: MetaSyntax) -> list[tuple[str, str]]:
    """回归哨兵：title_en 不得以「页码列表 + 空格」开头 ——

    那说明块格子的页码续行又漏进标题了。判据复用 `pages_only_line` 的范围守卫，
    故「片名本身以数字开头」不会误报（单数字 5 不在影片页范围内）。
    """
    dirty: list[tuple[str, str]] = []
    for r in rows:
        m = re.match(r"^(?P<lst>\d{1,3}(?:\s*,\s*\d{1,3})*)\s+\S", r["title_en"])
        if m and pages_only_line(m.group("lst"), syntax):
            dirty.append((r["code"], r["title_en"]))
    return dirty


# ---------------------------------------------------------------- 输出


def strip_internal(row: dict) -> dict:
    """剥掉 `_` 前缀的内部字段（`_page` / `_wd` / `_extra`），只留契约字段。"""
    return {k: v for k, v in row.items() if not k.startswith("_")}


def write_json(path: str | Path, payload: dict) -> None:
    """契约化写出：UTF-8 + `indent=1`（与仓库既有产物逐字节一致）。"""
    Path(path).write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
