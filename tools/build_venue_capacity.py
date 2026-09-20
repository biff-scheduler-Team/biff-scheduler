#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把人工查证的影厅座位数并入 ``apps/web/public/venues.json``（抢票分析模块，2026-09-20）。

为什么需要它
------------
「抢票分析」的难度 = 抢票人数 ÷ 影厅座位数。座位数是**人工从影院 / 官方公开资料查来**的
数据，既不是官网排期页抓来的，也会随影院改造而变 —— 所以它必须有自己的、可以重跑的家。

⚠ 为什么**不写进** ``tools/scrape_biff_web.py::VENUE_TABLE``
    那个表是「官网英文全名 → id / 代码 / 短名」的映射，来源性质是**抓取**；容量是**人工查证**。
    更实际的原因是它已经与已发货的 ``venues.json`` 漂移：脚本里露天场是 ``br``、东西大是 ``dm``，
    而产物里是 ``bt`` / ``dk``，且产物含 MEGABOX ``m1``–``m4``（那 4 个厅来自册子，不在抓取表里）。
    把容量挂在那张表上，要么得先修漂移（超出本需求），要么一跑就警告 —— 都不如一张独立表干净。

用法
----
    python3 tools/build_venue_capacity.py            # 写回 apps/web/public/venues.json
    python3 tools/build_venue_capacity.py --check     # 只校验产物与表是否一致（CI / 本地自检）

幂等：表里没有的厅会被**删掉** capacity / capacityNote（表是唯一来源），
故想改数字只改这张表再跑一次即可。
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Optional

DEFAULT_VENUES = Path(__file__).resolve().parent.parent / "apps" / "web" / "public" / "venues.json"

# 厅 id → (座位数, 口径说明)。座位数 `None` = 已知该厅但容量未查到（**不估数**）。
#
# ⚠ 每一条都必须能回溯到来源；查不到就写 None，让前端走「未收录座位数 → 只给相对排名」的降级分支。
#   编一个数字进去比留空危险得多：难度会看着精确、实则错得无法察觉。
#
# 来源（2026-09-20 查证）：
#   · b1 / b2 / b3 / bh —— 电影殿堂官网「시설소개 / 좌석배치도」原文：
#       중극장 413석、소극장 212석、시네마테크 212석、하늘연극장 841석
#   · bt —— 露天剧场，座位数**随布置可变**：馆方设施页记「고정석 2,486석 / 가변석 500~1,500석」，
#       而本届 BIFF 露天放映的官方口径是 **4,000 席**（见 apps/web/src/batch.ts 文件头引的报道，
#       与本站 venue_id = "bt" 的 8 场 20:00 逐部吻合）。这里取本届口径，并把可变性写进口径说明。
#   · cx —— CGV 센텀시티 IMAX 422 席（第三方影院资料，**待复核**）
#   · 其余厅（c1–c6 / l2–l10 / m1–m4 / kt / sc / dk / sh / bcm）—— 尚未查到可回溯的逐厅数字，
#       故**不入表**（= 产物里不带 capacity，前端降级）。
VENUE_CAPACITY: dict[str, tuple[Optional[int], Optional[str]]] = {
    "b1": (413, None),
    "b2": (212, None),
    "b3": (212, None),
    "bh": (841, None),
    "bt": (4000, "露天放映，本届官方口径 4,000 席；馆方设施页记固定座 2,486 + 可变 500~1,500，随场次布置变化"),
    "cx": (422, "第三方影院资料，待复核"),
}


def load_venues(path: Path) -> dict[str, Any]:
    """读产物。文件缺失 / 结构不对时直接报错退出，不静默产出一份空文件。"""
    if not path.exists():
        raise SystemExit(f"找不到 {path}")
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict) or not isinstance(data.get("venues"), list):
        raise SystemExit(f"{path} 结构不对：期望 {{'venues': [...]}}")
    return data


def apply_capacity(data: dict[str, Any]) -> tuple[list[str], list[str]]:
    """把表并进产物（原地改）。

    :return: (产物里有、表里没有的 id, 表里有、产物里没有的 id)
    """
    present: set[str] = set()
    missing_from_table: list[str] = []
    for venue in data["venues"]:
        venue_id = venue.get("id")
        if not isinstance(venue_id, str) or not venue_id:
            continue
        present.add(venue_id)
        entry = VENUE_CAPACITY.get(venue_id)
        # 先删后写：表是唯一来源，从表里删掉一条就该从产物里消失
        venue.pop("capacity", None)
        venue.pop("capacityNote", None)
        if entry is None:
            missing_from_table.append(venue_id)
            continue
        capacity, note = entry
        if capacity is not None:
            venue["capacity"] = capacity
        if note:
            venue["capacityNote"] = note
    unknown = sorted(set(VENUE_CAPACITY) - present)
    return sorted(missing_from_table), unknown


def dump(data: dict[str, Any], path: Path) -> None:
    """按仓库既有产物风格落盘：2 空格缩进、不转义非 ASCII、末尾恰好一个换行。"""
    with path.open("w", encoding="utf-8") as handle:
        handle.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="把人工查证的影厅座位数并入 venues.json")
    parser.add_argument("--venues", type=Path, default=DEFAULT_VENUES, help="venues.json 路径")
    parser.add_argument("--check", action="store_true", help="只校验是否已同步，不写回")
    args = parser.parse_args()

    data = load_venues(args.venues)
    before = json.dumps(data["venues"], ensure_ascii=False, sort_keys=True)
    missing_from_table, unknown = apply_capacity(data)
    after = json.dumps(data["venues"], ensure_ascii=False, sort_keys=True)

    if unknown:
        # 表里有产物里没有的 id：多半是改名 / 换版。只是告警 —— 别让一个过期条目挡住整条管线
        print(f"⚠ 容量表里有 {len(unknown)} 个 id 不在产物中（表过期？）：{', '.join(unknown)}")
    if missing_from_table:
        print(f"ℹ 产物里有 {len(missing_from_table)} 个厅未收录座位数：{' '.join(missing_from_table)}")

    if args.check:
        if before != after:
            print(f"✗ {args.venues} 与容量表不一致，请跑一次 python3 tools/build_venue_capacity.py")
            return 1
        print(f"✓ {args.venues} 与容量表一致（收录 {len(VENUE_CAPACITY)} 个厅）")
        return 0

    if before == after:
        print(f"✓ 无需改动（收录 {len(VENUE_CAPACITY)} 个厅）")
        return 0
    dump(data, args.venues)
    print(f"✓ 已写回 {args.venues}（收录 {len(VENUE_CAPACITY)} 个厅）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
