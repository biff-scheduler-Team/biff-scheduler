#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""extract_catalogue_films.py — 从官方 Ticket Catalogue PDF 的「影片介绍页」抽出官网没有的影片字段

为什么需要它
------------
官网片目页(`prog_view.asp`)只给片名 / 单元 / 年份 / 国别 / 片长 / 导演 / 备注;
**格式(DCP)/ 色彩 / 首映状态 / 官方英韩简介**只在付印册子的影片介绍页上印。
本脚本把这几项抽出来,按「场次编号 → schedule.json → 片名」反查身份后写进 `films.json`。

版面与识别(2026 版 p22–96 实测,别凭直觉改)
------------------------------------------
* 一页 1~4 个影片条目,版式是**杂志式多栏**,一页最多 4 列;每个条目 =
  「信息列(标题 / META / 场次索引)」+ 可能另有一列「简介列(韩文段 + 英文段)」。
* **条目的锚点是 META 行**(`国别 | 年份 | Nmin | 格式 | 色彩`),不是标题行 ——
  标题会被排版拆行,且单元名与片名同行(实测 `Gala Presentation` + 片名分块)。
* **按 line 而不是 block 归属**。block 会把跨栏内容粘在一起(实测 p29 一个 block
  x=(40,802) 同时含左栏的 `WP` 与右栏条目的 META + 场次索引),按 block 归属必然串条目。
* 归属规则(四步,缺一步就有条目串味):
  1. **含 META 行的 block,整块归该条目** —— 跨栏粘连的 block 靠这条自洽(p29);
  2. 其余行:先看 `x0` 是否落在某个「信息列」(META 行 x 区间 ± 40pt)里 ——
     落在里面按 **y 顺序分带**(取 y 中心不超过本行的最后一个 META)——
     简介在**另一列**时 y 距离会骗人(p72 的场次索引离下一个条目的 META 更近);
  3. 不在任何信息列里的行(简介列 / 图注):按 **|Δx| + |Δy| 最小**的 META 归属 ——
     简介列与它所属条目的 META 既不同 x 也不同 y,必须两轴一起算(p30/p34);
  4. 首映标记(`WP` / `IP`)额外要求**与本条目 META 的 y 差 ≤ 45pt** ——
     否则每页页首的图例(`World Premiere WP International Premiere IP`)会被当成条目标记。
* 简介按**谚文占比**分韩/英(阈值 0.2):韩文段里夹英文片名、英文段里夹韩文片名都是常态。

册页号 = **印刷页号,不是 PDF 页下标**(`printed_page()`)
------------------------------------------------------
一张 PDF 页 = 一个**跨页**,页脚印着两个印刷页号(实测 PDF p24 → `046 | 047`)。
排期格子末尾印的也是印刷页号(`Screening.page`),所以本脚本必须换算:`left → 2N-2` / `right → 2N-1`
(半页由条目 META 行的 x 中心判定)。忘了换算会**整体差一倍**且字段看着完全正常
(实测 217 条全错:`The Table` 写成 22,实际 43)—— 故自检 4 拿两个来源交叉核对,
`apps/web/tests/catalogue-data.test.ts` 里有同口径的哨兵。

用法
----
    python tools/extract_catalogue_films.py --pdf <册子> --schedule apps/web/public/schedule.json \\
        --films apps/web/public/films.json --out /tmp/films.enriched.json

自检(硬门禁,任一不过即退出码 1):
* 每个条目的场次索引必须**全部命中** `schedule.json` 的 code;
* 一个条目的索引必须指向**同一个片名**(否则说明归属串了);
* 命中 `films.json` 的条目数须 > 0。
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

import pymupdf

# 影片介绍页的印刷页范围(2026 版实测 43–206)
FILM_PAGES = range(22, 97)

# META 行:国别 | 年份 | Nmin | 格式 [| 色彩] [其余(导演行被排进同一块)]
# ⚠ 三处必须宽松,收紧就会漏整条条目(实测):
#   ① 国别可以很长(6 个以上,`Thailand/Singapore/…/Hong Kong, China/ Indonesia`)且会**换行**,
#      故 `[^|]+?` 且要允许与上一行拼接;
#   ② 色彩可以是 `color/b&w`,故不能写 `[A-Za-z]+`;
#   ③ 色彩后面常**紧跟导演行**(`DCP | color  Director  Carl …`),故末尾必须允许剩余文本。
RE_META = re.compile(
    r"^(?P<countries>[^|]+?)\s*\|\s*(?P<year>\d{4}(?:\s*,\s*\d{4})*)\s*\|\s*"
    r"(?P<minutes>\d+)\s*min\s*"
    r"\|\s*(?P<fmt>[^|]+?)(?:\s*\|\s*(?P<color>[^\s|]+))?(?:\s+.*)?$"
)
# META 行的判位标记 = 行内出现 4 位年份。**不能要求年份两侧都有竖线** ——
# 2026 版实测 META 会被排版切在三处任意一处,只认一种印法就会漏整条条目,
# 而漏掉锚点的后果是「该条目的场次索引全串给同列上一个条目」(实测 p51 / p35):
#   ① `…/Poland | 2026 | 137min | DCP | color`  年份夹在中间
#   ② `2026 | 137min | DCP | color`             国别整行换行,年份在行首
#   ③ `Singapore/…/Netherlands | 2026` + `| 100min | DCP | color`  年份在行尾、格式在下一行
RE_META_YEAR = re.compile(r"\b(?:19|20)\d{2}\b")
# 场次索引:编号 + 月 日 / 时:分 / 场馆码(2026 版每页每行独立,不跨行)
RE_REF = re.compile(r"(\d{3})\s+[A-Z][a-z]{2}\s+\d{2}\s*/\s*\d{2}:\d{2}\s*/\s*[A-Z0-9]{1,3}")
# 首映标记(2026 版只印 WP / IP)
RE_PREMIERE = re.compile(r"^(WP|IP)$")
# 页脚 / 印刷页号带(不是条目内容)
FOOTER_Y0 = 595.0
# 信息列的横向容差:行 x0 落在「META 行 x 区间 ± 该值」内即视为同一列。
# ⚠ 不能放大:简介列与信息列只差 ~39pt(实测 p34 信息列 x1=610、简介列 x0=649),
# 容差一大简介行就落进信息列,再被「y 分带」切给上一个条目 → 相邻两条目的简介互换。
# 10pt 足够容下排版抖动,又能把简介列挡在外面(场次索引行 x0 与 META 同列,实测差 ≤ 4pt)。
COL_X_TOL = 10.0
# 首映标记与本条目 META 的最大 y 差(超过就是页首图例,不是本条目的标记)
PREMIERE_DY = 45.0
# 谚文占比阈值:超过即判为韩文段
HANGUL_RATIO = 0.2
# 追加到 `films.json::source` 的后缀(幂等拼接,见 main)
SOURCE_SUFFIX = " ∪ 2026 官方 Ticket Catalogue PDF 影片介绍页"


def printed_page(page: pymupdf.Page, entry: dict) -> int:
    """PDF 页 + 条目所在半页 → **印刷页号**(= `Screening.page` 的坐标系)。

    ⚠ 一张 PDF 页 = 一个**跨页**,页脚印着两个印刷页号(实测 PDF p24 → `046 | 047`)。
    本工具按 PDF 页遍历、半页由条目 META 行的 x 中心判定,所以必须换算 ——
    直接写 PDF 下标会与 `Screening.page`(排期格子里印的印刷页号)差一倍
    (实测 217 条全错:`The Table` 写成 22,实际 43)。

    映射(2026 版实测,PDF p22→042|043 … p86→170|171):
        left  → `2N - 2`;right → `2N - 1`
    """
    xc = (entry["x0"] + entry["x1"]) / 2
    right = xc > page.rect.width / 2
    return 2 * entry["page"] - (1 if right else 2)
# 简介段落的最小长度(短于此的是标题 / 备注 / 图注)
SYNOPSIS_MIN_LEN = 200


def log(kind: str, msg: str) -> None:
    """统一日志出口(stderr)。"""
    print(f"[{kind}] {msg}", file=sys.stderr)


def hangul_ratio(text: str) -> float:
    """谚文字符占「字母类字符」的比例(空格/标点/数字不计)。"""
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return 0.0
    hangul = sum(1 for c in letters if "\uac00" <= c <= "\ud7a3")
    return hangul / len(letters)


def norm_title(s: str) -> str:
    """片名归一:只留字母数字与谚文(与 `tools/merge_schedule.py::norm_title` 同口径)。"""
    return re.sub(r"[^0-9a-z\uac00-\ud7a3]+", "", (s or "").lower())


def page_lines(page: pymupdf.Page) -> tuple[list[dict], list[dict]]:
    """页面 → (line 列表, block 列表)。剔除页脚。

    line:`{x0,x1,y0,y1,text,block}`(`block` = 所属 block 的下标)
    block:`{lines:[line 下标…], text}`
    """
    lines: list[dict] = []
    blocks: list[dict] = []
    for b in page.get_text("dict")["blocks"]:
        if b.get("type") != 0 or b["bbox"][1] >= FOOTER_Y0:
            continue
        idx: list[int] = []
        for ln in b["lines"]:
            text = " ".join(s["text"] for s in ln["spans"]).strip()
            if not text:
                continue
            x0, y0, x1, y1 = ln["bbox"]
            lines.append({"x0": x0, "x1": x1, "y0": y0, "y1": y1, "text": text, "block": len(blocks)})
            idx.append(len(lines) - 1)
        if idx:
            blocks.append({"lines": idx, "text": " ".join(lines[i]["text"] for i in idx)})
    return lines, blocks


def meta_at(lines: list[dict], block: dict) -> tuple[dict, int] | None:
    """block 内找 META 行 → (解析结果, META 行下标);找不到返回 None。

    META 行**两头都可能被排版切断**,都要拼回来(2026 版实测):
    * 国别列表太长 → **上一行**以 `/` 结尾(实测 p49 `…/Hong Kong, China/` + `Indonesia/Qatar | 2026 | …`);
    * 国别列表 + 年份占满一行 → **下一行**接着 `146min | DCP | color`
      (实测 p35 `Romania/…/Sweden | 2026 |` + `146min | DCP | color`)。
    只拼上一行会漏掉第二种,那一条目就没有锚点,整块内容会串给邻居(实测 p35 Fatherland ↔ Fjord)。
    """
    idx = block["lines"]
    for k, i in enumerate(idx):
        line = lines[i]
        if not RE_META_YEAR.search(line["text"]):
            continue
        prev = lines[idx[k - 1]]["text"].rstrip() if k > 0 else None
        nxt = lines[idx[k + 1]]["text"] if k + 1 < len(idx) else None
        cands = [line["text"]]
        if prev is not None and prev.endswith(("/", "|")):
            cands.append(prev + line["text"])
        if nxt is not None:
            cands.append(line["text"] + nxt)
            if prev is not None and prev.endswith(("/", "|")):
                cands.append(prev + line["text"] + nxt)
        for cand in cands:
            m = RE_META.match(cand)
            if not m:
                continue
            g = m.groupdict()
            return ({
                "countries": g["countries"].strip(),
                # 年份可能是区间(实测 `France | 1952, 1980 | 83min …`,1980 重制版),
                # 取首个年份即可 —— 影片目录的 year 另有来源,这里只作交叉核对用。
                "year": int(re.match(r"\d{4}", g["year"]).group()),
                "runtime_min": int(g["minutes"]),
                "format": g["fmt"].strip(),
                "color": (g["color"] or "").strip() or None,
            }, i)
    return None


def cluster_columns(metas: list[dict], gap: float = 40.0) -> list[dict]:
    """META 行按 x 区间聚成「信息列」→ [{x0, x1, metas:[…]}]。"""
    cols: list[dict] = []
    for m in sorted(metas, key=lambda m: m["x0"]):
        if cols and m["x0"] <= cols[-1]["x1"] + gap:
            cols[-1]["x1"] = max(cols[-1]["x1"], m["x1"])
            cols[-1]["metas"].append(m)
        else:
            cols.append({"x0": m["x0"], "x1": m["x1"], "metas": [m]})
    return cols


def cluster_line_groups(items: list[dict], gap: float = 20.0) -> list[list[dict]]:
    """行(或任意带 x0/x1 的对象)按 x 区间聚成组 → [[item, …]]。"""
    groups: list[list[dict]] = []
    for it in sorted(items, key=lambda i: i["x0"]):
        if groups and it["x0"] <= max(x["x1"] for x in groups[-1]) + gap:
            groups[-1].append(it)
        else:
            groups.append([it])
    return groups


def band_assign(pool: list[dict], yc: float) -> dict:
    """y 分带:取 y 中心不超过 `yc` 的最后一个 META(都比它低则取最上面那个)。"""
    ordered = sorted(pool, key=lambda m: m["yc"])
    before = [m for m in ordered if m["yc"] <= yc]
    return before[-1] if before else ordered[0]


def assign_lines(lines: list[dict], blocks: list[dict]) -> list[dict]:
    """行 → 条目分组。返回 [{meta_line, meta, lines:[行下标…]}]。

    三步(见文件头):
    ① 含 META 行的 block 整块归该条目;
    ② 落在某个「信息列」里的行 → **y 分带**;
    ③ 其余(简介列) → **成对归属**:列内 ≥200 字的段落按 y 排成 (韩文, 英文) 对,
       第 i 对归该列**左侧最近信息列**里 y 序第 i 个 META。
       为什么不能用「两轴距离最近」:一个段落会横跨两个条目的 META y 区间,
       逐行算距离会把同一段韩文简介劈成两半(实测 p34/p35 的韩文段被上下两条目各分走一半)。
    """
    metas: list[dict] = []
    for bi, block in enumerate(blocks):
        hit = meta_at(lines, block)
        if hit is None:
            continue
        meta, li = hit
        metas.append({
            "block": bi, "line": li, "meta": meta,
            "x0": lines[li]["x0"], "x1": lines[li]["x1"],
            "meta_y0": lines[li]["y0"],
            "yc": (lines[li]["y0"] + lines[li]["y1"]) / 2,
            "xc": (lines[li]["x0"] + lines[li]["x1"]) / 2,
            "lines": [],
        })
    if not metas:
        return []

    by_block = {m["block"]: m for m in metas}
    assigned: set[int] = set()
    for bi, m in by_block.items():
        for li in blocks[bi]["lines"]:
            m["lines"].append(li)
            assigned.add(li)

    cols = cluster_columns(metas)
    rest: list[int] = []
    for li, line in enumerate(lines):
        if li in assigned:
            continue
        col = next((c for c in cols if c["x0"] - COL_X_TOL <= line["x0"] <= c["x1"] + COL_X_TOL), None)
        if col is not None:
            band_assign(col["metas"], (line["y0"] + line["y1"]) / 2)["lines"].append(li)
            assigned.add(li)
        else:
            rest.append(li)

    # ③ 简介列:按 x 聚组 → 找左侧最近的信息列 → 段落成对归属
    for group in (cluster_line_groups([lines[i] for i in rest]) if rest else []):
        gx0 = min(line["x0"] for line in group)
        owner = min(cols, key=lambda c: abs(gx0 - c["x1"]))
        pool = sorted(owner["metas"], key=lambda m: m["yc"])
        members = {i for i in rest if lines[i] in group}
        para_blocks = sorted(
            (blocks[bi] for bi in {lines[i]["block"] for i in members}
             if len(blocks[bi]["text"]) >= SYNOPSIS_MIN_LEN),
            key=lambda b: lines[b["lines"][0]]["y0"],
        )
        paired: set[int] = set()
        for k in range(0, len(para_blocks) - len(para_blocks) % 2, 2):
            target = pool[min(k // 2, len(pool) - 1)]
            for b in para_blocks[k:k + 2]:
                for li in b["lines"]:
                    target["lines"].append(li)
                    paired.add(li)
        for li in sorted(members - paired):
            band_assign(pool, (lines[li]["y0"] + lines[li]["y1"]) / 2)["lines"].append(li)
    return metas


def title_guess(lines: list[dict], entry: dict) -> str | None:
    """条目标题兜底:META 行**正上方**最近的一行「无谚文、长度 ≤ 80」文本。

    2026 版实测标题排在 META 之上(p72 `Baby Doe` / `신원미상` 分两行,韩文行带谚文)。
    ⚠ 在**整页**里找,不限于「已归属本条目的行」—— 短片竞赛页一行一个条目、标题块常被
    分带规则判给上一个条目,只看归属行会漏掉一半标题(实测 p72/p73)。
    只用于「场次索引全是联映块」的条目(短片竞赛的成员片没有自己的场次编号)。
    """
    above = [
        l for l in lines
        if l["y1"] <= entry["meta_y0"] and 0 <= entry["meta_y0"] - l["y1"] <= 45
        and len(l["text"]) <= 80 and hangul_ratio(l["text"]) == 0.0
        and min(l["x1"], entry["x1"]) - max(l["x0"], entry["x0"]) > 0
    ]
    if not above:
        return None
    return max(above, key=lambda l: l["y1"])["text"].strip()


def parse_page(page: pymupdf.Page, page_no: int) -> list[dict]:
    """一页 → 若干条目记录。"""
    lines, blocks = page_lines(page)
    out: list[dict] = []
    for m in assign_lines(lines, blocks):
        text = " ".join(lines[i]["text"] for i in m["lines"])
        refs = RE_REF.findall(text)
        if not refs:
            log("WARN", f"p{page_no} 条目 @x={m['x0']:.0f} 无场次索引 → 跳过")
            continue

        premiere = None
        for i in m["lines"]:
            line = lines[i]
            pm = RE_PREMIERE.match(line["text"].strip())
            if pm and abs((line["y0"] + line["y1"]) / 2 - m["yc"]) <= PREMIERE_DY:
                premiere = pm.group(1)
                break

        # 简介 = 该条目**完整拥有**的 block 里最长的两段,按谚文占比分韩 / 英。
        # ⚠ 必须要求 block **整块归本条目**:行级归属会把一个段落的两行分给相邻条目
        # (实测 p34 'Coward' 与 'Diary of a Chambermaid' 共用同一段英文简介的 block),
        # 只看「碰到的 block」会把邻居的简介一起算进来 → 韩文段被英文段挤掉。
        mine = set(m["lines"])
        paras = sorted(
            (
                blocks[bi] for bi in {lines[i]["block"] for i in m["lines"]}
                if set(blocks[bi]["lines"]) <= mine and len(blocks[bi]["text"]) >= SYNOPSIS_MIN_LEN
            ),
            key=lambda b: -len(b["text"]),
        )[:2]
        ko = en = None
        for b in paras:
            if hangul_ratio(b["text"]) > HANGUL_RATIO:
                ko = ko or b["text"]
            else:
                en = en or b["text"]

        out.append({
            **m["meta"],
            "page": printed_page(page, {"x0": m["x0"], "x1": m["x1"], "page": page_no}),
            "pdf_page": page_no,
            "refs": refs,
            # 标题兜底:META 行**正上方**最近的一行非韩文短文本 —— 只给「场次索引全是联映块」
            # 的条目用(短片竞赛的成员片没有自己的场次编号,身份只能从标题拿,实测 p72/p73)。
            "title_guess": title_guess(lines, m),
            "premiere": premiere,
            "synopsis_ko": ko,
            "synopsis_en": en,
        })
    return out


def main() -> int:
    """CLI 入口。"""
    ap = argparse.ArgumentParser(description="Ticket Catalogue PDF 影片介绍页 → films.json 富化")
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--schedule", required=True)
    ap.add_argument("--films", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    doc = pymupdf.open(args.pdf)
    schedule = json.loads(Path(args.schedule).read_text(encoding="utf-8"))["screenings"]
    by_code = {s["code"]: s for s in schedule}
    films_file = json.loads(Path(args.films).read_text(encoding="utf-8"))
    films = films_file["films"]
    film_by_en = {norm_title(f.get("title_en", "")): f for f in films if f.get("title_en")}

    raw: list[dict] = []
    for pno in FILM_PAGES:
        raw += parse_page(doc[pno - 1], pno)

    # 自检 1:场次索引必须全部命中 schedule.json
    unknown = Counter(c for e in raw for c in e["refs"] if c not in by_code)
    if unknown:
        log("FAIL", f"场次索引命中不了 schedule.json: {dict(unknown)}")
        return 1

    # 自检 2:一个条目的索引必须指向同一个片名(否则说明归属串了)。
    # ⚠ 联映块(묶)成员片的介绍页会把**块场次**也列为自己的一场(`types.ts::Screening.midnight_members`
    # 的注释写明这一条),所以块 code 先剔掉再判 —— 否则每个块成员都会被误判成「串了」(实测 p57)。
    bundle_codes = {s["code"] for s in schedule if s.get("midnight_members")}
    entries: list[dict] = []
    for e in raw:
        titles = {by_code[c]["title_en"] for c in e["refs"] if c not in bundle_codes}
        if not titles:
            # 短片竞赛的成员片没有自己的场次编号(只有「捆」的那一场)→ 身份从标题行拿
            if not e["title_guess"]:
                log("WARN", f"p{e['page']} 条目只有联映块索引且无标题 → 跳过")
                continue
            e["title_en"] = e["title_guess"]
            e["title_source"] = "title"
            entries.append(e)
            continue
        if len(titles) != 1:
            log("FAIL", f"p{e['page']} 条目索引指向 {len(titles)} 个片名: {sorted(titles)}")
            return 1
        e["title_en"] = titles.pop()
        e["title_source"] = "refs"
        entries.append(e)

    # 自检 3:条目数 / 命中率
    matched = [e for e in entries if norm_title(e["title_en"]) in film_by_en]
    if not matched:
        log("FAIL", "没有任何条目命中 films.json")
        return 1
    dup = [t for t, n in Counter(norm_title(e["title_en"]) for e in entries).items() if n > 1]
    if dup:
        log("INFO", f"{len(dup)} 个片名在册子里有多条介绍页(取册页号与排期对得上的那条): {dup[:6]}")

    # 排期格子末尾印的是**印刷页号**(`Screening.page`),本脚本按 PDF 页遍历 ——
    # 忘了换算会整体差一倍(实测 217 条全错,`The Table` 22 ↔ 43),而字段本身看着很正常。
    sch_pages: dict[str, set[int]] = {}
    for s in schedule:
        if s.get("page"):
            sch_pages.setdefault(norm_title(s.get("title_en", "")), set()).add(s["page"])

    # 同一部片有多条介绍页时(实测 8 条:重复场次 / 特别企划各印一页),
    # 取**册页号与排期对得上的那一条** —— 否则 `catalogue.page` 会指向另一页,
    # 与 `Screening.page` 冲突(实测 9 条)。都对不上(排期无页号)时保留首条。
    best: dict[str, dict] = {}
    for e in entries:
        key = norm_title(e["title_en"])
        if key not in film_by_en:
            continue
        if key not in best or (
            best[key]["page"] not in sch_pages.get(key, ())
            and e["page"] in sch_pages.get(key, ())
        ):
            best[key] = e

    # 自检 4:册页号坐标系必须与排期一致(在**去重之后**判,否则同片的多条介绍页会误报)。
    # 同一部片,两个来源的册页号必须落在同一集合里 —— 这是唯一能自动抓到坐标系错位的判据。
    mismatch = [
        (e["title_en"], e["page"], sorted(sch_pages[key]))
        for key, e in best.items()
        if sch_pages.get(key) and e["page"] not in sch_pages[key]
    ]
    if mismatch:
        log("FAIL", f"册页号与排期不一致 {len(mismatch)} 条(坐标系没换算?): {mismatch[:5]}")
        return 1

    enriched = 0
    for key, e in best.items():
        film_by_en[key]["catalogue"] = {
            "page": e["page"],
            "format": e["format"],
            "color": e["color"],
            "countries": e["countries"],
            "runtime_min": e["runtime_min"],
            "premiere": e["premiere"],
            "synopsis_ko": e["synopsis_ko"],
            "synopsis_en": e["synopsis_en"],
        }
        enriched += 1

    films_file["generated_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
    # 幂等:先剥掉上一次追加的后缀再拼 —— 本脚本支持就地重跑(输入 = 输出),
    # 否则连跑两次会拼成「… ∪ … ∪ …」。
    films_file["source"] = re.sub(r"(?: ∪ 2026 官方 Ticket Catalogue PDF 影片介绍页)+$", "",
                                  films_file.get("source", "")) + SOURCE_SUFFIX
    # 缩进与末尾换行对齐 `tools/build_films_2026.py`(indent=1 + `\n`)—— 换口径会把整份
    # films.json 重排成几千行 diff。
    Path(args.out).write_text(
        json.dumps(films_file, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )

    log("SANITY", f"介绍页条目 {len(entries)} 条;命中 films.json {len(matched)} 条;写入 {enriched} 条")
    log("SANITY", f"字段覆盖: 格式 {sum(1 for e in entries if e['format'])}; "
                  f"色彩 {sum(1 for e in entries if e['color'])}; "
                  f"首映 {sum(1 for e in entries if e['premiere'])}; "
                  f"韩文简介 {sum(1 for e in entries if e['synopsis_ko'])}; "
                  f"英文简介 {sum(1 for e in entries if e['synopsis_en'])}")
    log("SANITY", f"首映码分布: {dict(Counter(e['premiere'] for e in entries if e['premiere']))}")
    log("OK", f"写出 {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
