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
import sys
from datetime import datetime, timezone
from pathlib import Path

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


def load_posters(enriched_path: str, posters_dir: str) -> dict[int, str]:
    """enriched_douban.json + 已下载的海报文件 → {xlsx 行号: 海报路径}。

    海报按豆瓣 **subject_id** 命名(`<id>-m.jpg`),不是 `f###` —— 后者是按 xlsx 行序
    现编的编号,换届会撞号(2025 的 f001 与 2026 的 f001 是两部不同的片)。
    这里只认**已经下载到本地**的档位(`fetch_posters.py` 的产物),没下到的就不给字段,
    前端按「无海报」渲染 —— 宁可缺图,不给一个必然 418 的豆瓣外链(防盗链)。
    """
    if not enriched_path or not posters_dir:
        return {}
    try:
        rows = json.loads(Path(enriched_path).read_text(encoding="utf-8"))
    except OSError as exc:
        print(f"! 读不到 {enriched_path}: {exc}", file=sys.stderr)
        return {}
    out: dict[int, str] = {}
    for r in rows:
        # 只认 high(标题精确 + 年份一致);medium 是标题同但年份不符,实测全是另一部同名片
        if r.get("confidence") != "high":
            continue
        sid = str(r.get("douban_id") or "").strip()
        row = r.get("row")
        if not sid or not isinstance(row, int):
            continue
        # 档位优先 m(540×762,列表缩略图与弹层共用一档,少一次请求)
        for suffix in ("m", "s", "l"):
            name = f"{sid}-{suffix}.jpg"
            if (Path(posters_dir) / name).exists():
                out[row] = f"/posters/{name}"
                break
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--xlsx", required=True)
    ap.add_argument("--out", default="public/films.json")
    ap.add_argument("--enriched", default="data/enriched_douban.json", help="豆瓣富化产物(取 subject_id)")
    ap.add_argument("--posters-dir", default="public/posters", help="已下载的海报目录")
    args = ap.parse_args()

    posters = load_posters(args.enriched, args.posters_dir)
    wb = load_workbook(args.xlsx, read_only=True, data_only=True)
    ws = wb[wb.sheetnames[0]]
    rows = ws.iter_rows(values_only=True)
    header = [str(h).strip() if h else "" for h in next(rows)]
    col = {name: i for i, name in enumerate(header)}

    films = []
    # 行号从 2 起(第 1 行是表头)—— 与 enriched_douban.json 的 `row` 同口径,海报靠它对齐
    for row_no, r in enumerate(rows, start=2):
        if not any(c is not None and str(c).strip() for c in r):
            continue
        zh = str(r[col["中文片名"]] or "").strip()
        orig = str(r[col["原始片名"]] or "").strip()
        if not zh and not orig:
            continue
        item = {
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
        poster = posters.get(row_no)
        if poster:
            item["poster"] = poster
        films.append(item)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "2026第31届釜山国际电影节影片信息.xlsx(用户提供)",
        "films": films,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    with_poster = sum(1 for f in films if f.get("poster"))
    print(f"wrote {len(films)} films -> {args.out}(其中 {with_poster} 部有海报,缺 {len(films) - with_poster} 部)")


if __name__ == "__main__":
    main()
