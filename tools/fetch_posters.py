#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""海报下载器:把豆瓣海报的三档尺寸抓到本地(供静态站点直接引用)。

为什么必须下载而不能直接外链
------------------------------
豆瓣图床有 **Referer 防盗链**:不带 `Referer: https://movie.douban.com/` 会返回
HTTP 418 + 13 字节占位文件(实测),直接 `<img src>` 引用必然破图。本站已无后端可代理,
故只能离线抓下来、随站点部署。

命名(溯源锚点)
---------------
    apps/web/public/posters/<subject_id>-s.jpg   270 x 381   ~16 KB
    apps/web/public/posters/<subject_id>-m.jpg   540 x 762   ~46 KB
    apps/web/public/posters/<subject_id>-l.jpg  1075 x 1518  ~219 KB

用豆瓣 **subject_id** 而非 `f###`:后者是按 xlsx 行序现编的编号,换届会撞号
(2025 的 f001 与 2026 的 f001 是两部不同的片)。

要点
----
* **断点续跑**:目标文件已存在且 >= MIN_BYTES 则跳过(可随时 Ctrl-C,次日接着跑);
* **先写 .tmp 再 rename** —— 中断不会留下半个文件;
* 响应 < MIN_BYTES 视为被拦(418 占位),不落盘并计入 fail;
* 档位由 `poster` URL 里的尺寸段替换而来(域名/路径原样保留,兼容 img1/img2/img9)。

用法
----
    python fetch_posters.py --enriched data/enriched_douban.json \\
        --out-dir apps/web/public/posters [--delay 2] [--limit N]
"""
import argparse
import json
import os
import re
import time
import urllib.request

UA = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Referer": "https://movie.douban.com/",
    "Accept": "image/avif,image/webp,image/jpeg,*/*",
}
# 档位 → 文件名后缀(顺序即下载顺序:先小后大,便于尽早看到效果)
SIZES = (("s_ratio_poster", "s"), ("m", "m"), ("l", "l"))
# 小于此字节数 = 被防盗链拦下的占位响应,不是真图
MIN_BYTES = 1024
# 只替换 URL 里的尺寸段,域名与其余路径原样保留
RE_SIZE_SEG = re.compile(r"/view/photo/[^/]+/")


def size_url(poster_url, size):
    """把海报 URL 的尺寸段换成 `size`(如 `/l/` → `/s_ratio_poster/`)。"""
    return RE_SIZE_SEG.sub(f"/view/photo/{size}/", poster_url)


def download(url, dest):
    """下载单张到 `dest`;返回 (是否成功, 字节数)。"""
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = resp.read()
    if len(data) < MIN_BYTES:
        return False, len(data)
    tmp = dest + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, dest)
    return True, len(data)


def load_rows(enriched_path, limit):
    """读富化产物,只保留**有海报 URL** 的行(未命中的行 `poster` 为空串)。"""
    with open(enriched_path, encoding="utf-8") as f:
        rows = json.load(f)
    rows = [r for r in rows if r.get("poster") and r.get("douban_id")]
    if limit:
        rows = rows[:limit]
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--enriched", default="data/enriched_douban.json",
                    help="enrich_douban.py 的产物")
    ap.add_argument("--out-dir", default="apps/web/public/posters", help="海报落盘目录")
    ap.add_argument("--delay", type=float, default=2.0, help="每张图之间的间隔秒数")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 部(调试用)")
    args = ap.parse_args()

    rows = load_rows(args.enriched, args.limit)
    os.makedirs(args.out_dir, exist_ok=True)
    print(f"待处理 {len(rows)} 部影片 x {len(SIZES)} 档,间隔 {args.delay}s → {args.out_dir}")

    ok = skip = fail = 0
    for idx, row in enumerate(rows, 1):
        sid = str(row["douban_id"])
        for size, suffix in SIZES:
            dest = os.path.join(args.out_dir, f"{sid}-{suffix}.jpg")
            if os.path.exists(dest) and os.path.getsize(dest) >= MIN_BYTES:
                skip += 1
                continue
            url = size_url(row["poster"], size)
            try:
                good, info = download(url, dest)
            except Exception as exc:  # 网络抖动 / 超时 → 记 fail,不中断整轮
                good, info = False, str(exc)
            if good:
                ok += 1
                print(f"[{idx}/{len(rows)}] {sid}-{suffix}  {info // 1024} KB", flush=True)
            else:
                fail += 1
                print(f"[{idx}/{len(rows)}] {sid}-{suffix}  FAIL {info}", flush=True)
            time.sleep(args.delay)

    print(f"\n== 完成 == 新下 {ok} / 跳过 {skip} / 失败 {fail}")
    if fail:
        print("失败的多为防盗链/网络抖动,重跑本脚本会自动补(已存在的会跳过)")


if __name__ == "__main__":
    main()
