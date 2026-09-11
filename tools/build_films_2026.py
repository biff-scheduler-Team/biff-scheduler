#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_films_2026.py — 合并「官网片目」与「xlsx 目录」→ public/films.json

为什么以官网为底座
------------------
xlsx 是「中文名 + 原始片名」,官网排期是「英文名 + 韩文名」。若拿 xlsx 当身份,
两套命名对不上的那批片在影片库里就会显示「有片、但没有排期」—— 而排期其实好端端
躺在 schedule.json 里,只是挂在了另一条英文名节点下(实测 127/250 部中招)。

现在反过来:**官网片目(246 部)是底座**,`title_en` 是唯一身份,前端优先按它匹配排期
→ 排片必然对得上,且结构上不可能出现「有片无排期」。

xlsx 降级为**富化源**:能对上就补中文名 / 豆瓣海报 / 豆瓣分 / 导演 / 国家;
对不上就留空,前端显示英文(用户口径:「片名不映射没问题,用英文就好」)。

同时**不丢片**:xlsx 里官网没有的条目仍然保留(可能是合集成员,或本届确实没排)。

合集块成员
----------
官网只印块名(Asian / Korean Short Film Competition 1-3、Midnight Passion 1-3 等),
成员短片没有独立场次。这里给「只在合集里出现」的成员单独建条目并写 `block_code`,
前端据此显示「收录于合集 XXX」而不是「暂无排期」。

用法
----
    python tools/build_films_2026.py \\
        --web     /tmp/biff2026/films-web.json \\
        --catalog data/films-catalog-2026.json \\
        --schedule public/schedule.json \\
        --out     public/films.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# 官网 section 名 → 与 xlsx 同口径的中文单元名(归并键见本文件 unit_key,须与前端 library.ts::unitKey 同口径)
WEB_UNIT: dict[str, str] = {
    "Wide Angle": "广角镜",
    "A Window on Asian Cinema": "亚洲电影之窗",
    "Competition": "主竞赛",
    "Icons": "Icons",
    "Vision": "Vision",
    "World Cinema": "World Cinema",
    "Flash Forward": "Flash Forward",
    "Korean Cinema Today": "Korean Cinema Today",
    "Open Cinema": "Open Cinema",
    "Midnight Passion": "Midnight Passion",
    "On Screen": "On Screen",
    "Gala Presentation": "Gala Presentation",
    "Special Program in Focus": "特别企划",
    "Special Screenings": "特别放映",
    "Opening/Closing": "开幕影片",
}

CATALOG_FIELDS = ("title_zh", "title_orig", "unit", "remark", "year", "rating", "rating_count", "country", "director")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import film_match  # noqa: E402  (同目录工具,需先补 sys.path)


def unit_key(raw: str) -> str:
    """与前端 `library.ts::unitKey` 同口径的单元归并键(展示与筛选用,保持细粒度)。

    2026-09-11 收窄:只归并同义脏写法,不再跨**真实子单元**归并 —— 旧规则按前缀
    `广角镜` / `Vision` / `Korean Cinema Today` 归并,会把「广角镜 - 亚洲短片竞赛 /
    纪录片放映 / 纪录片竞赛」「Vision–Korea / –Asia」压成一条,下拉选项与卡片副标题
    的中英对照因此对不上。收窄后筛选粒度与卡片文案重新对齐。

    ⚠ **配对已改用 `film_match.pair_unit_key`(粗归并)** —— 官网只有 section 名,
    xlsx 细到子单元,细粒度下同单元约束会把 12 部片直接跳过。本函数保留为与前端
    展示口径的对照实现,不再参与配对。
    """
    t = (raw or "").strip()
    m = re.match(r"^([A-Za-z][A-Za-z'&.\- ]*?)\s*(?=[\u4e00-\u9fa5])", t)
    if m and m.group(1).strip():
        return m.group(1).strip()
    if "年度亚洲电影人奖" in t:
        return "亚洲电影人奖"
    return t or "未标注单元"


def norm_title(raw: str) -> str:
    s = unicodedata.normalize("NFKC", raw or "").lower()
    for a, b in (("′", "'"), ("’", "'"), ("‘", "'"), ("–", "-"), ("—", "-")):
        s = s.replace(a, b)
    return re.sub(r"[^0-9a-z\u4e00-\u9fff\uac00-\ud7af]+", "", s)


def main() -> int:
    ap = argparse.ArgumentParser(description="合并官网片目与 xlsx 目录")
    ap.add_argument("--web", required=True, help="scrape_biff_web.py 产出的 films-web.json")
    ap.add_argument("--catalog", default="data/films-catalog-2026.json")
    ap.add_argument("--schedule", default="public/schedule.json")
    ap.add_argument("--alias", default="data/title-alias-2026.json", help="人工别名表(官网片名 → 目录中文名)")
    ap.add_argument("--out", default="public/films.json")
    args = ap.parse_args()

    web = json.loads(Path(args.web).read_text(encoding="utf-8"))["films"]
    catalog = json.loads(Path(args.catalog).read_text(encoding="utf-8"))["films"]
    screenings = json.loads(Path(args.schedule).read_text(encoding="utf-8"))["screenings"]

    # 人工别名表:官网片名 → 目录中文名。**必须在 build 阶段也直查一遍** ——
    # scrape 阶段填的 schedule.title_zh 只覆盖「有独立场次」的片;合集成员
    # (Shiranui / Kakurenbo 这类只挂在块里的)没有 zh_of,只能靠本表接回中文名。
    alias_raw: dict[str, str] = {}
    if Path(args.alias).exists():
        alias_raw = json.loads(Path(args.alias).read_text(encoding="utf-8")).get("aliases") or {}
    alias_zh: dict[str, str] = {norm_title(k): v for k, v in alias_raw.items() if k and v}

    # ---- 排期侧索引:英文名 → 场次号 / 已桥接的中文名 ----
    codes_of: dict[str, list[str]] = {}
    zh_of: dict[str, str] = {}
    kr_of: dict[str, str] = {}
    for s in screenings:
        codes_of.setdefault(s["title_en"], []).append(s["code"])
        if s.get("title_zh"):
            zh_of.setdefault(s["title_en"], s["title_zh"])
        if s.get("title_kr"):
            kr_of.setdefault(s["title_en"], s["title_kr"])

    cat_by_title: dict[str, list[dict[str, Any]]] = {}
    for f in catalog:
        for key in (f.get("title_zh"), f.get("title_orig")):
            k = norm_title(key)
            if k:
                cat_by_title.setdefault(k, []).append(f)

    def find_catalog(
        title_en: str, title_kr: str, title_zh: str, unit: str = ""
    ) -> Optional[dict[str, Any]]:
        """官网片 → xlsx 目录条目。

        顺序即优先级:排期桥接来的中文名 → 人工别名表 → 英文名 → 韩文名。
        别名表排在英文名之前,是因为它**明确写着**「这条官网片名对应哪个目录中文名」,
        可信度高于「英文名恰好等于某条原始片名」的偶然命中。

        同一中文名在目录里**可能重复**(xlsx 把同一部片登记在两个单元,实测 4 组:
        《蓦然回首》《杰出的无名氏》《不速之母》《天使之卵》)—— 命中多条时**优先取
        `pair_unit_key` 与官网片一致的那条**,否则 Angel's Egg 会挂到 Midnight Passion
        那条《天使之卵》上,真正的「日本动画特别企划」条目永远认领不到。
        """
        alias = alias_zh.get(norm_title(title_en), "")
        want = film_match.pair_unit_key(unit)
        for cand in (title_zh, alias, title_en, title_kr):
            hits = cat_by_title.get(norm_title(cand)) if cand else None
            if not hits:
                continue
            same = [h for h in hits if film_match.pair_unit_key(h.get("unit")) == want]
            return (same or hits)[0]
        return None

    films: list[dict[str, Any]] = []
    used_catalog: set[str] = set()

    # ---- 1) 官网片目(底座;一部片一条,必有排期) ----
    for w in web:
        title_en = w.get("title_en") or ""
        if not title_en:
            continue
        item: dict[str, Any] = {
            "id": "",
            "title_en": title_en,
            "title_kr": w.get("title_kr") or kr_of.get(title_en, ""),
            "title_zh": "",
            "title_orig": "",
            "unit": WEB_UNIT.get(w.get("unit", ""), w.get("unit", "")),
            "remark": w.get("premiere") or "",
            "year": int(w["year"]) if str(w.get("year") or "").isdigit() else None,
            "rating": None,
            "rating_count": None,
            "country": w.get("country") or "",
            "director": w.get("director") or "",
            "duration_min": w.get("duration_min"),
            "screening_codes": codes_of.get(title_en, []),
        }
        hit = find_catalog(title_en, item["title_kr"], zh_of.get(title_en, ""), item["unit"])
        if hit:
            used_catalog.add(hit["id"])
            item["catalog_id"] = hit["id"]
            for k in CATALOG_FIELDS:
                v = hit.get(k)
                if v not in (None, "", 0):
                    item[k] = v
            if hit.get("poster"):
                item["poster"] = hit["poster"]
        films.append(item)

    have_en = {f["title_en"] for f in films}

    # ---- 1b) 未配上中文名的官网片 ↔ 未被认领的 xlsx 条目:同单元内做约束配对 ----
    # 按单元切分后两边余量几乎完全配平(见 tools/film_match.py 头部),说明完美配对存在,
    # 只差把顺序对上 —— 用「导演(罗马字/拼音)+ 国家 + 片名相似度」定序。
    # 单元用 `pair_unit_key`(粗归并):官网 `Vision` / `Wide Angle` 与 xlsx
    # `Vision–Asia` / `广角镜 - 纪录片竞赛` 口径不同,细粒度会把它们直接跳过。
    pending_web = [f for f in films if not f["title_zh"]]
    pending_cat = [f for f in catalog if f["id"] not in used_catalog]
    pairs, unmatched_web = film_match.assign(pending_web, pending_cat, film_match.pair_unit_key)
    # 第二轮:不限单元,但要求「导演 + 国家」这类强证据(≥2)才认 —— 接回 xlsx 单元名与官网
    # section 不同口径的那批(日本动画特别企划 / 亚洲电影人奖 / CARTE BLANCHE → Special Program in Focus)。
    cat_left = [f for f in catalog if f["id"] not in used_catalog]
    pairs2, unmatched_web = film_match.assign(
        unmatched_web, cat_left, film_match.pair_unit_key, same_unit=False, min_score=2.0
    )
    # 第三轮:同粗单元 + 国家命中 + 余量配平 的保守一对一(双向唯一才认)。
    # 专门接「片名是英文译名、导演是中文译名」那批(无字面证据,只剩国家可用)。
    cat_left = [f for f in catalog if f["id"] not in used_catalog]
    pairs3, unmatched_web = film_match.assign_balanced(unmatched_web, cat_left, film_match.pair_unit_key)
    for item, hit, sc in pairs + pairs2 + pairs3:
        used_catalog.add(hit["id"])
        item["catalog_id"] = hit["id"]
        for k in CATALOG_FIELDS:
            v = hit.get(k)
            if v not in (None, "", 0):
                item[k] = v
        if hit.get("poster"):
            item["poster"] = hit["poster"]
        item["match_score"] = round(sc, 2)
    print(
        f"[配对] 同单元 {len(pairs)} 对 + 跨单元兜底 {len(pairs2)} 对 + 配平唯一 {len(pairs3)} 对;"
        f"官网仍无中文名 {len(unmatched_web)} 部"
    )

    # ---- 2) 合集块成员(只在块里出现 → 挂 block_code,不当「无排期」) ----
    block_members = 0
    for s in screenings:
        for m in s.get("midnight_members") or []:
            if m in have_en:
                # 成员短片**有自己的官网详情页**(在 films-web.json 里),但没有独立场次 ——
                # 它只在块里放。给已有条目补 `block_code`,前端据此显示「收录于合集 XXX」
                # 而不是「暂无排期」。不计入 block_members(没新增条目)。
                for f in films:
                    if f["title_en"] == m:
                        f.setdefault("block_code", s["code"])
                        break
                continue
            have_en.add(m)
            block_members += 1
            item = {
                "id": "",
                "title_en": m,
                "title_kr": "",
                "title_zh": "",
                "title_orig": "",
                "unit": WEB_UNIT.get("", ""),
                "remark": "",
                "year": None,
                "rating": None,
                "rating_count": None,
                "country": "",
                "director": "",
                "screening_codes": [],
                "block_code": s["code"],
            }
            hit = find_catalog(m, "", "")
            if hit:
                used_catalog.add(hit["id"])
                item["catalog_id"] = hit["id"]
                for k in CATALOG_FIELDS:
                    v = hit.get(k)
                    if v not in (None, "", 0):
                        item[k] = v
                if hit.get("poster"):
                    item["poster"] = hit["poster"]
            films.append(item)

    # ---- 3) xlsx 里**没被认领**的条目:不单独成条 ----
    # 关键前提:xlsx 的 250 部**全部**能在官网片目里找到对应(已复核:未认领数为 0)。
    # 剩下的「没配上」只是**配对失败**,不是「官网没有这部片」—— 若照旧保留,就会
    # 出现「中文名一条(无排期)+ 英文名一条(有排期)」的重复对,正是用户要消灭的现象。
    # 所以这里**只报不写**:配不上的片以官网英文名出现在表里(用户口径:不映射就用英文)。
    leftover = [f for f in catalog if f["id"] not in used_catalog]

    # ---- 4) 编号:有排期的按首次开映时间排,其余(纯目录/合集成员)按目录序排在后面 ----
    first_code = {}
    for s in screenings:
        t = s["title_en"]
        if t not in first_code:
            first_code[t] = s["code"]
    for f in films:
        f["_sort"] = first_code.get(f["title_en"], "zzz")
    films.sort(key=lambda f: (f["_sort"], f["title_zh"] or f["title_en"]))
    for i, f in enumerate(films, start=1):
        f["id"] = f"f{i:03d}"
        f.pop("_sort", None)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "biff.kr 官网片目(prog_view.asp) ∪ 2026第31届釜山国际电影节影片信息.xlsx(富化)",
        "films": films,
    }
    Path(args.out).write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    with_screen = sum(1 for f in films if f["screening_codes"])
    with_zh = sum(1 for f in films if f["title_zh"])
    with_poster = sum(1 for f in films if f.get("poster"))
    print(f"写出 {len(films)} 部 → {args.out}")
    print(f"  官网片目 {len(web)} · 合集成员新增 {block_members} · xlsx 独有保留 {len(leftover)}")
    print(f"  有排期 {with_screen} · 有中文名 {with_zh} · 有海报 {with_poster}")
    print(f"  无排期 {len(films) - with_screen}(合集成员 {block_members} 已挂 block_code)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
