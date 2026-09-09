#!/usr/bin/env python3
"""离线管线(M1 前置):BIFF 影片信息 xlsx → public/films.json(影片目录)。

只接影片目录(片名/单元/年份/国家/导演),海报与豆瓣信息留待 enrich_douban.py 慢速补齐。
排期(code/时间/影院)由官方 Catalogue PDF → tools/extract_schedule.py 产出后再做「目录 × 排期」关联。

用法:
  python build_films.py --xlsx <影片信息.xlsx> [--out public/films.json]
"""
import argparse
import json
import re
from datetime import datetime, timezone

from openpyxl import load_workbook


def clean_unit(u: str) -> str:
    """『亚洲电影之窗』单元 / 【Icons】/ (Flash Forward)→ 亚洲电影之窗 / Icons / Flash Forward"""
    u = str(u or "").strip()
    u = re.sub(r"[『』【】\[\]()（）]", "", u)
    u = re.sub(r"单元$", "", u).strip()
    return u


def to_num(v) -> int | None:
    if v is None:
        return None
    s = str(v).strip()
    if not s or s in {"暂无", "暂无评分", "-"}:
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


def to_rating(v) -> float | None:
    if v is None:
        return None
    s = str(v).strip()
    if not s or s in {"暂无", "暂无评分", "-"}:
        return None
    try:
        return round(float(s), 1)
    except ValueError:
        return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--xlsx", required=True)
    ap.add_argument("--out", default="public/films.json")
    args = ap.parse_args()

    wb = load_workbook(args.xlsx, read_only=True, data_only=True)
    ws = wb[wb.sheetnames[0]]
    rows = ws.iter_rows(values_only=True)
    header = [str(h).strip() if h else "" for h in next(rows)]
    col = {name: i for i, name in enumerate(header)}

    films = []
    for r in rows:
        if not any(c is not None and str(c).strip() for c in r):
            continue
        zh = str(r[col["中文片名"]] or "").strip()
        orig = str(r[col["原始片名"]] or "").strip()
        if not zh and not orig:
            continue
        films.append(
            {
                "id": f"f{len(films) + 1:03d}",
                "unit": clean_unit(r[col["单元"]]),
                "remark": str(r[col["备注"]] or "").strip(),
                "title_zh": zh,
                "title_orig": orig,
                "year": to_num(r[col["年份"]]),
                "rating": to_rating(r[col["评分"]]),
                "rating_count": to_num(r[col["评价人数"]]),
                "country": str(r[col["国家/地区"]] or "").strip(),
                "director": str(r[col["导演"]] or "").strip(),
            }
        )

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "2026第31届釜山国际电影节影片信息.xlsx(用户提供)",
        "films": films,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    print(f"wrote {len(films)} films -> {args.out}")


if __name__ == "__main__":
    main()
