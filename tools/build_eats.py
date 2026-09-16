#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把《BIFF吃喝》表格导出的 CSV/XLSX 规范化成 `apps/web/public/eats.json`。

为什么走「离线管线 + 产物检入」而不是构建时实抓:
    源文档是腾讯文档的**只读分享**,单元格走 canvas 渲染 + 私有 protobuf 载荷,
    没有公开契约,不能在构建里依赖。导出一次、跑一次、把 JSON 检进仓库,才可 diff、可 review。

用法::

    python3 tools/build_eats.py data/_cache/biff-eats.csv

输入要求(与源表格同表头,顺序无关)::

    韩文名 / 英文名 / 中文名 / 营业时间 / 菜单 / 人均（人民币） / 韩文地址 / 英文地址 / 备注 / 链接

产物结构见 `apps/web/src/eats.ts::EatsFile` —— 两者必须同步改。
"""

from __future__ import annotations

import csv
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator, Mapping, Sequence

COLUMNS = (
    ("name_kr", "韩文名"),
    ("name_en", "英文名"),
    ("name_zh", "中文名"),
    ("hours", "营业时间"),
    ("menu", "菜单"),
    ("price", "人均（人民币）"),
    ("address_kr", "韩文地址"),
    ("address_en", "英文地址"),
    ("note", "备注"),
    ("link", "链接"),
)

# 分区判据:只看地址里的**区名**,不猜「센텀属于海云台」这类地理常识 —— 出现新前缀也不会误判。
DISTRICT_PATTERNS: tuple[tuple[str, str], ...] = (
    ("haeundae", "해운대"),
    ("haeundae", "Haeundae"),
    ("suyeong", "수영"),
    ("suyeong", "Suyeong"),
    ("junggu", "중구"),
    ("junggu", "Jung-gu"),
    ("donggu", "동구"),
    ("donggu", "Dong-gu"),
    ("busanjin", "부산진"),
    ("busanjin", "Busanjin"),
)

# 源表里同一格里塞了多段(用连续空格对齐),拆开比留着更像人话。
MULTI_SPACE = re.compile(r"\s{2,}")
# 首尾用于对齐/点缀的噪声标点(如 "고래사어묵 "、"103호, " 尾随逗号)
TRIM_CHARS = " \t\u00a0,、;；"
# 人均只认数字/区间 —— 源表该列存在串行到相邻格子的脏值(整段地址、菜名),
# 靠「长什么样」挡掉比事后人工挑更稳:人均本来就是数值列,非数值一律不是它的内容。
PRICE_RE = re.compile(r"^\d+(?:\.\d+)?(?:\s*[-~～]\s*\d+(?:\.\d+)?)?$")


def read_rows(path: Path) -> tuple[list[dict[str, str]], str]:
    """读入源表 → (行字典列表, 备注性提示行)。

    只支持 CSV —— xlsx 请先在腾讯文档里「导出为 CSV」。
    传 xlsx 会**明确报错**而不是静默产出空 JSON。
    """
    if path.suffix.lower() in {".xlsx", ".xls"}:
        raise SystemExit(
            f"{path} 是 Excel 文件,本管线只吃 CSV。请在腾讯文档里选「导出为 → CSV」后重跑。"
        )
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    return rows, "utf-8-sig"


def norm(value: object) -> str:
    """单元格归一:去首尾噪声标点 + 合并连续空白。"""
    if value is None:
        return ""
    text = str(value).replace("\r\n", "\n").strip()
    return text.strip(TRIM_CHARS).strip()


def join_segments(value: str) -> str:
    """把「多段用连续空格排开」的格子拆成 ` · ` 连接的一行。"""
    parts = [part.strip() for part in MULTI_SPACE.split(value) if part.strip()]
    return " · ".join(parts)


def district_of(*addresses: str) -> str:
    """从地址串推断分区;推不出来就是 `other`,**不瞎猜**。"""
    joined = " ".join(addresses)
    for district, needle in DISTRICT_PATTERNS:
        if needle in joined:
            return district
    return "other"


def slug_of(row: Mapping[str, str], seen: dict[str, int]) -> str:
    """稳定 id:优先用英文名转写,否则用韩文名的短哈希。同名自动加序号。"""
    basis = row["name_en"] or row["name_zh"] or row["name_kr"]
    ascii_basis = re.sub(r"[^a-z0-9]+", "-", basis.lower()).strip("-")
    if ascii_basis:
        base = ascii_basis
    else:
        digest = hashlib.sha1(basis.encode("utf-8")).hexdigest()[:8]
        base = f"kr-{digest}"
    seen[base] = seen.get(base, 0) + 1
    count = seen[base]
    return base if count == 1 else f"{base}-{count}"


def build_shops(
    rows: Iterable[Mapping[str, str]],
) -> tuple[list[dict[str, object]], str, list[str]]:
    """把原始行转成产物里的 shop 列表;顺带挑出 `*` 开头的提示行。"""
    shops: list[dict[str, object]] = []
    seen: dict[str, int] = {}
    notice = ""
    skipped: list[str] = []
    for raw in rows:
        row = {key: norm(raw.get(header)) for key, header in COLUMNS}
        if not any(row.values()):
            continue
        if row["name_zh"].startswith("*") or row["name_kr"].startswith("*"):
            notice = notice or row["name_zh"] or row["name_kr"]
            continue
        # 没有任何店名的行直接丢:它既没法显示、也没法做地图检索,
        # 硬留会在页面上渲染出一张**空白卡片**(id 还会退化成同一个哈希撞车)。
        if not (row["name_kr"] or row["name_en"] or row["name_zh"]):
            skipped.append(row["hours"] or row["menu"] or row["address_kr"])
            continue
        hours = join_segments(row["hours"])
        shops.append(
            {
                "id": slug_of(row, seen),
                "name_kr": row["name_kr"],
                "name_en": row["name_en"],
                "name_zh": row["name_zh"],
                "hours": hours,
                "menu": row["menu"],
                "price": row["price"] if PRICE_RE.match(row["price"]) else "",
                "address_kr": join_segments(row["address_kr"]),
                "address_en": join_segments(row["address_en"]),
                "note": join_segments(row["note"]),
                "link": row["link"],
                "district": district_of(row["address_kr"], row["address_en"]),
            }
        )
    return shops, notice, skipped


def main(argv: Sequence[str]) -> int:
    """命令行入口:CSV 路径 → `apps/web/public/eats.json`。"""
    if len(argv) != 2:
        print(__doc__)
        return 2
    source = Path(argv[1])
    if not source.exists():
        raise SystemExit(f"找不到输入文件:{source}")

    rows, note = read_rows(source)
    shops, notice, skipped = build_shops(rows)
    out = Path(__file__).resolve().parent.parent / "apps" / "web" / "public" / "eats.json"
    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "source": "腾讯文档《BIFF吃喝》 https://docs.qq.com/sheet/DRWpTTmpsc1dmRERy",
        "encoding": note,
        "notice": notice,
        "shops": shops,
    }
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    by_district: dict[str, int] = {}
    for shop in shops:
        key = str(shop["district"])
        by_district[key] = by_district.get(key, 0) + 1
    print(f"写入 {out} —— {len(shops)} 家,分区 {by_district}")
    if skipped:
        print(f"⚠ 跳过 {len(skipped)} 行没有店名的记录(表里就没有名字,无法显示/检索):{skipped}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
