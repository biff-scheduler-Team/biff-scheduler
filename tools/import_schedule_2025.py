#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""import_schedule_2025.py — 把 extract_schedule.py 的产物接进 public/

背景(PLAN-20260910122007)
------------------------
`tools/extract_schedule.py` 把 BIFF Ticket Catalogue PDF 解析成 schedule.json /
venues.json,但默认落在 /tmp,而且产出的场馆顺序是「按影院全名字母序」,泳道排出来
电影殿堂的 6 个厅会被 BCM / CGV / LOTTE 插花打散。本脚本做两件收尾工作:

1. **泳道重排**:按「分区(centum → nampo)→ 影院(bcc → cgv → lotte → kofic →
   megabox → sohyang → bcm)→ 厅号」重排 `venues` 数组。前端
   `data.ts::screeningsByVenue()` 就是按 venues.json 的出现顺序分泳道的,
   顺序即泳道顺序,不需要改前端。
2. **festival 元信息换成真实口径**:解析器写的是技术性 note(「lat/lng 需另行
   补全」这类),这里换成给用户看的届次/场馆/数据来源说明。

用法
----
    python tools/import_schedule_2025.py \
        --schedule /tmp/biff2025/schedule.json \
        --venues   /tmp/biff2025/venues.json \
        --dest     public
"""

from __future__ import annotations

import argparse
import json
import shutil
from datetime import datetime, timezone, timedelta
from pathlib import Path

# 泳道顺序:分区 → 影院 → 厅号。不在此表的 id 排到最后(按 id 兜底)。
VENUE_ORDER = [
    # CENTUM 主场区 —— 电影殿堂(Busan Cinema Center)
    "b1", "b2", "b3", "bd", "bh", "bt",
    # CENTUM 主场区 —— CGV Centum City
    "c1", "c2", "c3", "c4", "c5", "c6", "c7", "cx",
    # CENTUM 主场区 —— LOTTE CINEMA Centum City
    "l2", "l3", "l4", "l5", "l6", "l7", "l9", "l10",
    # CENTUM 主场区 —— KOFIC Theater
    "kt",
    # 南浦洞 —— MEGABOX Busan Theater / 东西大学 Sohyang Theatre / 市民媒体中心
    "m1", "m2", "m3", "m4", "sh", "bcm",
]

FESTIVAL_NAME = "30th Busan International Film Festival"
FESTIVAL_YEAR = 2025
FESTIVAL_NOTE = (
    "数据来源:官方 Ticket Catalogue(2025-08-28 付印)第 9–16 页「Screening Schedule」,"
    "由 tools/extract_schedule.py 解析;场馆按「厅」建 id(id = 官方影院代码小写,如 b1/c2/l10),"
    "共 29 厅 / 7 家影院 / 2 个分区(CENTUM 主场区 23 厅、南浦洞 6 厅)。"
    "code 以 X 开头者为原册未印场次编号、由解析器合成兜底(BD / C7 两列);"
    "GV 场次的 end_time 已含官方映后谈时长(册子只印到正片结束,解析时 +25min);"
    "午夜场 Midnight Passion 1–4 是「联映块」(一张票连看 2–3 部,共 4 块 / 10 部):"
    "格子只印块名,块内成员片名另见单元扉页对照表 → 场次的 midnight_members;"
    "成员片的介绍页会把所属块 CODE 列为自己的一场;"
    "册子付印后的变更以官网 www.biff.kr 为准。"
)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--schedule", required=True, help="extract_schedule.py 的 --out 产物")
    ap.add_argument("--venues", required=True, help="extract_schedule.py 的 --venues-out 产物")
    ap.add_argument("--dest", default="apps/web/public", help="目标目录(默认 public)")
    ap.add_argument("--backup-suffix", default="", help="目标文件已存在时另存的后缀(如 .bak)")
    args = ap.parse_args()

    schedule = json.loads(Path(args.schedule).read_text(encoding="utf-8"))
    venues = json.loads(Path(args.venues).read_text(encoding="utf-8"))

    # ---- 泳道重排 -------------------------------------------------------
    rank = {vid: i for i, vid in enumerate(VENUE_ORDER)}
    vs = venues["venues"]
    vs.sort(key=lambda v: (rank.get(v["id"], len(VENUE_ORDER)), v["id"]))
    missing = [v["id"] for v in vs if v["id"] not in rank]
    if missing:
        print(f"[WARN] 不在 VENUE_ORDER 里的场馆(排在最后):{missing}")

    # ---- festival 元信息 ------------------------------------------------
    fest = schedule.setdefault("festival", {})
    fest["name"] = FESTIVAL_NAME
    fest["year"] = FESTIVAL_YEAR
    fest["note"] = FESTIVAL_NOTE
    kst = timezone(timedelta(hours=9))
    fest["generated_at"] = datetime.now(kst).replace(microsecond=0).isoformat()

    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)

    for name, payload in (("schedule.json", schedule), ("venues.json", {"venues": vs})):
        out = dest / name
        if out.exists() and args.backup_suffix:
            shutil.copy2(out, out.with_suffix(out.suffix + args.backup_suffix))
        out.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"[OK] 写出 {out}")

    sc = schedule["screenings"]
    print(f"[INFO] {len(sc)} 场 / {len(vs)} 厅 / {len({s['date'] for s in sc})} 天")
    print(f"[INFO] 泳道顺序:{' → '.join(v['code'] for v in vs)}")


if __name__ == "__main__":
    main()
