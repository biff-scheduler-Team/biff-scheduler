#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""extract_films_2025.py — 从 BIFF Ticket Catalogue PDF 的「影片介绍页」抽取影片目录 → public/films.json

背景
----
2026 版的影片目录来自用户提供的 xlsx(tools/build_films.py),2025 版没有对应表格,
只能从官方 Catalogue 的影片介绍页抽。好在信息是结构化的,不需要编造。

版面(实测,2025 版 114 页 / 印刷页 2×)
--------------------------------------
- 影片介绍页 = **PDF p22–p97**(印刷页 42–194),共 75 页;印刷页 N → PDF index `N//2`
  (每张 PDF 页 = 一个跨页,页脚印着两个页码,如 PDF p60 → 印刷页 118|119)。
- 每页 **2 栏**:`x0 < 250` 为左栏,否则右栏;一栏内自上而下是
  韩文简介 / 英文简介 / 首映 note / **元数据行** / `Director …` / **场次行**。
- 元数据行 = `<国别> | <年> | <N>min | <格式> | <color>`(如 `Brazil/Mexico/Chile/Netherlands | 2025 | 86min | DCP | color`)。
- 场次行 = `<code> Sep <日> / <时> / <厅>`,同一行可能并排多个 code,也可能缩进换行续写。

★ 归属规则(本脚本的核心,已实测)
---------------------------------
一栏内按 `y` 排序,**每个元数据行开启一部片**,其后直到下一个元数据行之间的所有场次行
都归这部片。实测 p60 右栏:元数据#1 后跟 `010/142/559`(全 = The Blue Trail)、
元数据#2 后跟 `059/149/417`(全 = The Chronology of Water)—— 与排期逐条一致。
**不能用「y 窗口」**:一页内 2–3 部片,窗口切不准。

单元归属:目录页(PDF p18)给出每个单元的**起始印刷页**,取「最后一个 ≤ 本页印刷页」的单元。

片名不从这里取
--------------
影片页的片名行位置随版式漂移(首片在栏顶、后续片在栏尾成块),不如排期可靠 ——
排期的 `title_en` / `title_kr` 是逐场次解析出来的,直接按 `code` 关联即可。

**唯一例外 = 午夜场联映块**:块的场次 title 印的是**块名**(`Midnight Passion N`),
不是片名。只出现在块里的片(实测 Exterior Night 只挂 `244`)拿不到片名 ——
此时改从排期的 `midnight_members` 取(由 `extract_schedule.py` 从单元扉页
对照表解析,是「块里到底是哪几部片」的官方单一真相源)。见 `pick_title()`。

用法
----
    python tools/extract_films_2025.py \
        --pdf   ~/Downloads/2025_BIFF_Ticket_Catalogue_web.pdf \
        --schedule public/schedule.json \
        --out   public/films.json [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import pymupdf

# ---- 版面常量 ---------------------------------------------------------------
COL_SPLIT_X = 250.0          # 左栏 / 右栏 的分界 x
PAGE_RANGE = (21, 97)        # PDF index 扫描范围(p22–p97 为影片介绍页)

MET = re.compile(
    r"^(?P<country>[^|]{0,80}?)\s*\|\s*(?P<year>(?:19|20)\d{2})\s*\|\s*(?P<runtime>\d+)\s*min\s*\|"
)
# 元数据行会换行:国别太长时独占一行,下一行才是 `| 2025 | 89min | DCP | color`
# (实测 PDF p43 右栏 Kyrgyzstan/Switzerland/… 7 国) → 国别为空时回看上一条同栏行。
COUNTRY_LIKE = re.compile(r"^[A-Za-z][A-Za-z ,/&'\.\-]{2,80}$")
DIR_LINE = re.compile(r"^Director\s+(?P<rest>.+)$")
CODE_ON_LINE = re.compile(r"([0-9X][0-9X]{2,4})\s+[A-Z][a-z]{2}\s+\d{1,2}\s*/")
HANGUL = re.compile(r"[가-힣]")

# ★ 午夜场联映块:排期表里 code `008/081/164/244` 的 title 印的是**块名**而不是片名。
# 块名会同时出现在块内各部片的影片页 code 清单里,若不排除,`en` 取值会命中块名,
# 把整块影片**合并成一条垃圾目录**(实测曾把 8 部片并成 `163, 165 Midnight Passion 1`)。
BLOCK_TITLE = re.compile(r"^(?:\d[\d,\s]*)?\s*Midnight\s+Passion\s+\d+\s*$", re.I)
# 块名 → 成员片名的**权威来源**是排期里的 `midnight_members`
# (由 extract_schedule.py 从单元扉页对照表解析;排期格子只印块名 + 页码列表)。

# `Director …` 一行里后面还并排着别的职务(实测「Isabelle KALANDAR    Executive
# Producer Isabelle KALANDAR    Co-producers …    Script …」)→ 遇到这些词就截断。
CREW_MARK = re.compile(
    r"\b(?:Executive\s+Producer|Co-?producers?|Producers?|Screenplay|Script|"
    r"Cinematography|Editing|Editor|Music|Cast|Production\s+Design|"
    r"Art\s+Director|Costume\s+Design)\b"
)

# 少数片(**不印** `Director` 前缀)的导演信息框 = 「英文名一行 + 韩文名一行 + 小传」。
# 实测:p22 Opening Film「No Other Choice」、p30 Competition「Without Permission」。
# 判据三连:① 英文行 2–4 个词且含一个全大写词(姓,如 `NAZER` / `PARK`)、
# ② 下一行**纯韩文**(`하산 나제르` / `박찬욱`)、③ 两行同 x 子栏(±20pt)且 y 间距 ≤14pt。
# 第 ③ 条是为了排掉**片名块**(如 `Frankenstein` / `프랑켄슈타인`,字号大、行距 ~20pt)。
BIO_NAME_EN = re.compile(r"^[A-Z][A-Za-z'.\-]*(?: [A-Z][A-Za-z'.\-]*){1,3}$")
BIO_NAME_KR = re.compile(r"^[가-힣]+(?: [가-힣]+)*$")
BIO_PAIR_MAX_DY = 14.0       # 英文名行 → 韩文名行 的最大行距
BIO_PAIR_MAX_DX = 20.0       # 必须同一 x 子栏(页面里并排着多个子栏)

# 单元 → 起始印刷页(来源:PDF p18「목차 Contents」)
SECTIONS: list[tuple[int, str]] = [
    (43, "Opening Film"),
    (44, "Competition"),
    (59, "Gala Presentation"),
    (64, "Icons"),
    (82, "Vision"),
    (96, "A Window on Asian Cinema"),
    (110, "Korean Cinema Today"),
    (118, "World Cinema"),
    (128, "Flash Forward"),
    (136, "Wide Angle"),
    (154, "Open Cinema"),
    (160, "Midnight Passion"),
    (166, "On Screen"),
    (170, "Special Program in Focus"),
    (190, "Special Screenings"),
    (193, "Program Events"),
    (198, "FORUM BIFF"),
    (202, "Community BIFF"),
    (206, "BIFF Everywhere"),
]

SOURCE = "2025_BIFF_Ticket_Catalogue_web.pdf 第 42–194 印刷页「影片介绍」"


def section_for(printed_page: int) -> str:
    """印刷页 → 单元(最后一个起始页 ≤ 本页的单元)。"""
    hit = ""
    for start, name in SECTIONS:
        if printed_page >= start:
            hit = name
        else:
            break
    return hit


def page_lines(page) -> list[tuple[float, float, str]]:
    """(x0, y0, text) —— 按行取,不用 blocks(块会跨栏粘在一起)。"""
    out: list[tuple[float, float, str]] = []
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            text = "".join(s["text"] for s in spans).strip()
            if not text:
                continue
            out.append(
                (
                    min(s["bbox"][0] for s in spans),
                    min(s["bbox"][1] for s in spans),
                    text,
                )
            )
    return out


def split_director(rest: str) -> str:
    """`Isabelle KALANDAR    Executive Producer …` / `Laura WANDEL 로라 완델 …` → 只留英文名。"""
    rest = CREW_MARK.split(rest, 1)[0]
    return re.split(r"(?=[가-힣])", rest)[0].strip().rstrip(",").strip()


def looks_like_bio_name_en(t: str) -> bool:
    """英文人名行:2–4 个词,且至少一个全大写词(姓)。"""
    if not BIO_NAME_EN.match(t):
        return False
    return any(w.isupper() and len(w) >= 2 for w in t.split())


def pick_title(scr: list[dict], key: str, blocks: dict[str, list[str]]) -> str:
    """从该片所有场次里取片名。

    ① 优先**非块名**的场次片名 —— 联映块的 title 印的是块名,不是片名;
    ② 若该片**只出现在联映块里**(实测 Exterior Night 只挂 `244`),块名不是片名,
       改从 `midnight_members`(单元扉页对照表)取 —— **块成员唯一时才认**;
    ③ 韩文名同理:只剩块名时宁缺勿错(成员表只有英文名),返回空串;
    ④ 实在拿不到才退回块名 —— 至少比空串有用。
    """
    vals = [s[key] for s in scr if s[key]]
    good = [v for v in vals if not BLOCK_TITLE.match(v.strip())]
    if good:
        return good[0]
    if key == "title_en":
        names = {n for s in scr for n in (blocks.get(s["code"]) or [])}
        if len(names) == 1:
            return names.pop()
        return (vals or [""])[0]
    return ""


def parse_page(page) -> list[dict]:
    """一页 → 若干部片(按栏分组、按 y 排序、元数据行开启新片)。"""
    cols: dict[int, list[tuple[float, float, str]]] = {0: [], 1: []}
    for x0, y0, text in page_lines(page):
        cols[0 if x0 < COL_SPLIT_X else 1].append((x0, y0, text))

    films: list[dict] = []
    for ci in (0, 1):
        seq = sorted(cols[ci], key=lambda r: r[1])
        cur: dict | None = None
        for i, (x0, y0, text) in enumerate(seq):
            m = MET.match(text)
            if m:
                country = m.group("country").strip()
                if not country:
                    # 国别换行到上一行。注意同一「栏」里还并排着另一个 x 的子栏
                    # (韩文简介 x≈656),所以不能只看上一条 —— 要按 **x 邻近** 回看。
                    for px, _py, ptxt in reversed(seq[:i]):
                        if abs(px - x0) > 20:
                            continue
                        if COUNTRY_LIKE.match(ptxt):
                            country = ptxt.strip()
                        break
                cur = {
                    "country": country,
                    "year": int(m.group("year")),
                    "runtime": int(m.group("runtime")),
                    "director": "",
                    "codes": [],
                }
                films.append(cur)
                continue
            if cur is None:
                continue
            # 导演:优先显式 `Director …` 行;**它可能排在场次行之后**(p23 实测
            # MET y=248.6 / CODE y=258.6 / DIR y=556.8),所以不能与 code 采集互斥。
            d = DIR_LINE.match(text)
            if d:
                if not cur["director"]:
                    cur["director"] = split_director(d.group("rest"))
                continue
            if not cur["director"] and looks_like_bio_name_en(text):
                # 不能只看 `seq[i+1]` —— 一栏里并排着多个 x 子栏(正文 x≈473.4、
                # 小传 x≈754.0),y 排序会把别的子栏的行插进来。要按 **同 x 子栏** 找下一行。
                for nx0, ny0, ntxt in seq[i + 1:]:
                    if ny0 - y0 > BIO_PAIR_MAX_DY:
                        break
                    if abs(nx0 - x0) > BIO_PAIR_MAX_DX:
                        continue
                    if BIO_NAME_KR.match(ntxt):
                        cur["director"] = text.strip()
                    break
            for code in CODE_ON_LINE.findall(text):
                if code not in cur["codes"]:
                    cur["codes"].append(code)
    return films


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--schedule", default="public/schedule.json")
    ap.add_argument("--out", default="public/films.json")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    doc = pymupdf.open(args.pdf)
    schedule = json.loads(Path(args.schedule).read_text(encoding="utf-8"))
    by_code = {s["code"]: s for s in schedule["screenings"]}
    # 联映块 code → 成员片名(排期侧从单元扉页对照表解析出来的权威表)
    blocks: dict[str, list[str]] = {
        s["code"]: s["midnight_members"]
        for s in schedule["screenings"]
        if s.get("midnight_members")
    }

    raw: list[dict] = []
    for idx in range(*PAGE_RANGE):
        if idx >= doc.page_count:
            break
        printed = 2 * idx + 1  # 跨页的后者,用于单元归属
        unit = section_for(printed)
        for f in parse_page(doc[idx]):
            f["unit"] = unit
            f["printed"] = printed
            raw.append(f)

    # ---- 去重:同一部片跨两页时按「场次 code 集合」判重 ----------------------
    seen: dict[tuple, dict] = {}
    dup = 0
    for f in raw:
        key = ("codes", tuple(sorted(f["codes"]))) if f["codes"] else (
            "meta", f["country"], f["year"], f["runtime"], f["director"],
        )
        if key in seen:
            dup += 1
            continue
        seen[key] = f
    films_raw = list(seen.values())

    # ---- 关联排期:取片名 / 评级 -------------------------------------------
    no_code = [f for f in films_raw if not f["codes"]]
    unknown = sorted({c for f in films_raw for c in f["codes"] if c not in by_code})

    out_films: list[dict] = []
    for f in films_raw:
        scr = [by_code[c] for c in f["codes"] if c in by_code]
        if not scr:
            continue  # 无排期场次 → 拿不到权威片名,本轮先不收
        # 片名:优先英文;英文缺失(2025 版 41 场只印韩文)则用韩文。
        # 同一部片的多个 code 里若混着**联映块 code**,它的 title 是块名 ——
        # 跳过块名再取;只出现在块里的片改从成员表取名(见 pick_title)。
        en = pick_title(scr, "title_en", blocks)
        kr = pick_title(scr, "title_kr", blocks)
        title = en or kr
        # 字段严格对齐 types.ts::FilmItem —— 不多写前端没声明的键
        # (片长 / 韩文名 / 场次 code 只用于自检日志,不进 JSON)
        out_films.append(
            {
                "unit": f["unit"],
                "remark": "",
                "title_zh": "",
                "title_orig": title,
                "year": f["year"],
                "rating": None,
                "rating_count": None,
                "country": f["country"],
                "director": f["director"],
                "_kr": kr,
                "_runtime": f["runtime"],
                "codes": f["codes"],
                "_printed": f["printed"],
            }
        )

    # 按片名去重(通宵场会让同一 code 被多片声称)
    by_title: dict[str, dict] = {}
    for f in out_films:
        t = f["title_orig"].lower()
        if t in by_title:
            by_title[t]["codes"] = sorted(set(by_title[t]["codes"]) | set(f["codes"]))
            continue
        by_title[t] = f
    out_films = sorted(by_title.values(), key=lambda f: (f["_printed"], f["title_orig"]))

    # ---- 自检(必须在剥掉内部字段之前算,因为要统计 code 覆盖) -------------
    covered = {c for f in out_films for c in f["codes"]}
    sched_codes = set(by_code)
    units = Counter(f["unit"] for f in out_films)
    no_dir = [f["title_orig"] for f in out_films if not f["director"]]
    no_year = [f["title_orig"] for f in out_films if not f["year"]]
    no_runtime = [f["title_orig"] for f in out_films if not f["_runtime"]]
    kr_only = [f["title_orig"] for f in out_films if not f["_kr"]]
    # 只出现在联映块里、没有自己场次的影片(片名只能靠成员表取)
    block_codes = set(blocks)
    only_block = [f["title_orig"] for f in out_films
                  if f["codes"] and set(f["codes"]) <= block_codes]

    # ---- 编号 + 剥掉内部字段,严格对齐 types.ts::FilmItem -------------------
    for i, f in enumerate(out_films, 1):
        f["id"] = f"f{i:03d}"
        for k in ("_printed", "_kr", "_runtime", "codes"):
            f.pop(k, None)

    def log(tag: str, msg: str) -> None:
        print(f"[{tag}] {msg}")

    log("SANITY", f"影片页扫描: PDF p{PAGE_RANGE[0]+1}–p{min(PAGE_RANGE[1], doc.page_count)}"
                  f"  抽出原始条目 {len(raw)}  判重丢弃 {dup}  去重后 {len(films_raw)}")
    log("SANITY", f"有场次的影片 {len(out_films)}  无场次(未收) {len(no_code)}")
    # ---- 联映块自检(2025 午夜场:4 块 / 10 部片)----
    log("SANITY", f"联映块 {len(blocks)} 块 / {sum(len(v) for v in blocks.values())} 部片"
                  f"  只出现在块里的影片 {len(only_block)}: {only_block}")
    # 回归哨兵:目录里绝不能有「块名当片名」的条目
    # (实测曾把 8 部午夜场并成 4 条 `163, 165 Midnight Passion 1` 之类的垃圾目录)
    junk = [f["title_orig"] for f in out_films if BLOCK_TITLE.match(f["title_orig"].strip())]
    if junk:
        log("WARN", f"⚠ 目录里仍有块名当片名的条目 {len(junk)}: {junk}")
    else:
        log("SANITY", "目录无块名当片名 ✓")
    log("SANITY", f"排期 code 覆盖: {len(covered)}/{len(sched_codes)}"
                  f"  未覆盖 {len(sched_codes - covered)}")
    if unknown:
        log("WARN", f"影片页出现但排期没有的 code({len(unknown)}): {unknown[:20]}")
    if no_dir:
        log("WARN", f"没抽到导演的影片 {len(no_dir)}: {no_dir[:12]}")
    if no_year:
        log("WARN", f"没抽到年份的影片 {len(no_year)}: {no_year[:12]}")
    if no_runtime:
        log("WARN", f"没抽到片长的影片 {len(no_runtime)}: {no_runtime[:12]}")
    if kr_only:
        log("INFO", f"只印韩文片名(排期 title_en 为空)的影片 {len(kr_only)}: {kr_only[:8]}")
    log("SANITY", f"单元分布: {dict(units.most_common())}")
    log("SANITY", f"国别分布 top10: {dict(Counter(f['country'] for f in out_films).most_common(10))}")

    uncovered = sorted(sched_codes - covered)
    if uncovered:
        log("WARN", f"未被任何影片页认领的排期 code: {uncovered[:30]}")

    if args.dry_run:
        log("DRY", "未写文件")
        return

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": SOURCE,
        "films": out_films,
    }
    Path(args.out).write_text(
        json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    log("OK", f"写出 {args.out}:{len(out_films)} 部影片")


if __name__ == "__main__":
    sys.exit(main())
