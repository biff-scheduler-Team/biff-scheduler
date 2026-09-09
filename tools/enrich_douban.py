#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
豆瓣富化器:按影片表逐条检索豆瓣条目(subject id / 海报 / 中文名 / 年份)
—— BIFF 排片工具 数据管线 M1 的一部分。

要点:
* 数据源:BIFF 影片信息 xlsx(只读,不改写原文件)
* 检索通道:movie.douban.com/j/subject_suggest(匿名 JSON,唯一仍开放的轻量口)
* 限流:豆瓣对匿名高频请求会静默返回空数组 → 必须控速 + 连续空响应退避
* 断点续跑:结果 JSON 每处理完一部即落盘,重启时已含 douban_id 的行自动跳过
* 置信度:标题精确 + 年份一致 => high;仅标题匹配年份不符 => medium(人工复核清单)

用法:
  python enrich_douban.py --xlsx <path> --out enriched.json [--limit N] [--delay 4.5]
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

UA = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Referer": "https://movie.douban.com/",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Accept": "application/json",
}
SUGGEST_URL = "https://movie.douban.com/j/subject_suggest?q={q}"
BIG_POSTER = re.compile(r"/s_ratio_poster/")  # 换成 /l/ 拿大图


def norm(s) -> str:
    if s is None:
        return ""
    if not isinstance(s, str):
        s = str(s)
    return re.sub(r"\s+", " ", s.strip())


def query_suggest(q: str):
    url = SUGGEST_URL.format(q=urllib.parse.quote(q))
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=12) as r:
        return json.loads(r.read().decode("utf-8"))


def big_poster(img: str) -> str:
    if not img:
        return ""
    return BIG_POSTER.sub("/l/", img)


def build_queries(c: str, d: str):
    qs = []
    for s in (d, c):
        s = norm(s)
        if s and s not in qs:
            qs.append(s)
    joined = [norm(x) for x in (f"{d} {c}", f"{c} {d}") if norm(x)]
    for s in joined:
        if s and s not in qs:
            qs.append(s)
    return qs


def score_item(it, c: str, d: str, expect_year):
    title = norm(it.get("title", ""))
    sub = norm(it.get("sub_title", ""))
    year = it.get("year", "")
    score = 0.0
    if title == c or title == d or sub == c or sub == d:
        score += 3.0
    elif c and (c in title or title in c) or d and (d in sub or sub in d):
        score += 1.5
    if expect_year and year == str(expect_year):
        score += 1.0
    if it.get("type") == "movie":
        score += 0.5
    return score, year


def match_film(c, d, expect_year, delay, max_sleep):
    qs = build_queries(c, d)
    if not qs:
        return None, "无检索词"
  # 只跑一轮(慢速 60s+ 间隔下基本不会限流;miss 行无 douban_id,重跑会自动补)
    for q in qs:
        try:
            data = query_suggest(q)
        except Exception:
            time.sleep(delay)
            continue
        time.sleep(delay)
        if not data:
            continue  # 空响应:慢速模式下降级为"本轮跳过该词",下一部/下次运行再试
        for it in data:
            if it.get("type") != "movie":
                continue
            s, yr = score_item(it, c, d, expect_year)
            if s > best_score:
                best_score = s
                best = (it, yr)
        if best and best_score >= 4.0:  # 标题精确 + 类型电影 + 年份一致,不必再试
            break
    if not best or best_score < 3.5:
        return None, f"低分({best_score:.1f})或未匹配"
    it, yr = best
    conf = "high" if (best_score >= 4.0 and yr == str(expect_year)) else "medium"
    return {
        "douban_id": it.get("id", ""),
        "douban_url": f"https://movie.douban.com/subject/{it.get('id','')}/",
        "douban_title": it.get("title", ""),
        "douban_orig": it.get("sub_title", ""),
        "douban_year": yr,
        "poster": big_poster(it.get("img", "")),
        "confidence": conf,
        "score": round(best_score, 1),
    }, None


def load_rows(xlsx_path):
    from openpyxl import load_workbook
    wb = load_workbook(xlsx_path, read_only=True, data_only=True)
    ws = wb["Sheet1"]
    rows = []
    for i, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        if row[0] is None and all(v is None for v in row):
            continue
        rows.append({
            "row": i,
            "unit": norm(row[0]), "note": norm(row[1]),
            "title_zh": norm(row[2]), "title_orig": norm(row[3]),
            "year": norm(row[4]) or "", "rating": norm(row[5]),
            "voters": norm(row[6]), "country": norm(row[7]),
            "director": norm(row[8]),
        })
    wb.close()
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--xlsx", required=True)
    ap.add_argument("--out", default="enriched.json")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 部(调试用)")
    ap.add_argument("--delay", type=float, default=4.5)
    ap.add_argument("--max-sleep", type=float, default=15.0)
    args = ap.parse_args()

    rows = load_rows(args.xlsx)
    if args.limit:
        rows = rows[: args.limit]
    print(f"共 {len(rows)} 部影片,基础间隔 {args.delay}s")

    done = {}
    if os.path.exists(args.out):
        try:
            with open(args.out, encoding="utf-8") as f:
                for it in json.load(f):
                    if it.get("douban_id"):
                        done[it["row"]] = it
        except Exception:
            pass
    print(f"已有 {len(done)} 部完成,跳过")

    stats = {"high": 0, "medium": 0, "miss": 0}
    for idx, film in enumerate(rows, 1):
        if film["row"] in done:
            continue
        hit, err = match_film(film["title_zh"], film["title_orig"],
                              int(film["year"]) if film["year"].isdigit() else None,
                              args.delay, args.max_sleep)
        if hit:
            done[film["row"]] = {**film, **hit}
            stats[hit["confidence"]] += 1
            tag = f"✔{hit['douban_id']} {hit['douban_title']} ({hit['douban_year']}) conf={hit['confidence']}"
        else:
            done[film["row"]] = {**film, "douban_id": "", "confidence": "miss",
                                 "poster": "", "match_note": err}
            stats["miss"] += 1
            tag = f"✘ {err}"
        print(f"[{idx}/{len(rows)}] 行{film['row']} {film['title_zh'][:18]} -> {tag}", flush=True)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(list(done.values()), f, ensure_ascii=False, indent=1)
        time.sleep(args.delay * 0.5)  # 行间小停顿

    print("\n== 完成 ==", stats)
    miss = [x for x in done.values() if not x.get("douban_id")]
    if miss:
        print(f"未匹配 {len(miss)} 部,见 --out 中 confidence=miss 的行")


if __name__ == "__main__":
    main()
