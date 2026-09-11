#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""douban_match.py — 「本地影片 → 豆瓣 subject」的检索与确认(共享给两个产物脚本)。

调用方
------
* `tools/build_douban_map.py` —— 产出前端消费的 `public/douban.json`;
* `tools/enrich_douban.py`   —— 产出海报管线用的 `data/enriched_douban.json`。

两者输入不同(前者吃 `films.json` 的官网片目,后者吃 xlsx / 目录清单),但**判定口径必须同源** ——
否则「豆瓣映射说这部是 A、海报却是 B」这种漂移没人能发现。故检索 / 确认 / 置信度都收敛在这里。

判定口径(宁可缺,不可错)
--------------------------
1. 先检索候选(见下「检索通道」),**只取 movie**;
2. 挑一个候选拉 `movie/{id}` 详情 —— 详情同时给 `title` / `original_title` / `aka[]`,
   三者与本地片名任一归一后相等即算**片名命中**(`aka` 是英文名,正是官网排期给的那一列);
3. `high` = 片名命中 **且** 年份不矛盾;`medium` = 片名命中但年份不符(多半是同名翻拍 / 续集);
   `miss` = 片名没命中(只靠导演命中的也算 `medium`,不单独放行)。
   ⚠ 只靠「年份 + 国家」这类弱证据**永不**判命中 —— 实测同单元同国家同名年份的错配极多。

检索通道(为什么不用 `search/subjects`)
--------------------------------------
`/api/v2/search/subjects` 是交接文档里验证过的接口,但**实测跑约 100 次后开始返回
`HTTP 403 code=103 need_login`**(风控),而交接文档 §16.3 明确记录「豆瓣用户登录与刷新流程
**未恢复**」—— 所以拿不到 token,这条路在长跑里不可用。

改用两个**匿名稳定**的替代口(同一台机器、同一时段实测均 200):

| 通道 | 路径 | 返回 |
|---|---|---|
| 主 | `/api/v2/search/suggestion` | `cards[]`,subject 卡片带 `target{id,title,year,rating}` |
| 备 | `/api/v2/search/mix_suggest_subjects` | `items[]`,字段平铺,年份藏在 `card_subtitle` 开头 |

两个通道都拿不到 HTTP 200 时抛 `DoubanUnavailableError`,让调用方**停止本轮、保留进度**,
而不是把风控误记成「这部片豆瓣没有」。
"""

from __future__ import annotations

import re
import sys
import time
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

import film_match  # noqa: E402  (同目录工具,需先补 sys.path)
from frodo_client import FrodoClient, error_hint  # noqa: E402

# 匿名检索通道(主 → 备);`search/subjects` 需登录,刻意不用
SUGGEST_PATH = "/api/v2/search/suggestion"
MIX_SUGGEST_PATH = "/api/v2/search/mix_suggest_subjects"
MOVIE_PATH = "/api/v2/movie/{id}"
DOUBAN_SUBJECT_URL = "https://movie.douban.com/subject/{id}/"

# 置信度排序(阈值比较用);`miss` 永不落盘
CONFIDENCE_RANK: dict[str, int] = {"high": 2, "medium": 1, "miss": 0}

# 详情 `pic.large` 的档位段(如 `m_ratio_poster` / `l`)→ 统一改写成经典 `/view/photo/l/`
RE_PHOTO_SIZE_SEG = re.compile(r"/view/photo/[^/]+/")
# `mix_suggest_subjects` 把年份放在 `card_subtitle` 开头(`2026 / 日本 / 剧情 / …`)
RE_CARD_YEAR = re.compile(r"^\s*(\d{4})\b")

# 风控 / 需登录错误码 —— 命中即**停止本轮**,绝不能记成「这部片豆瓣没有」
#   103  need_login           检索口跑约 100 次后触发(实测)
#   1309 subject_ip_rate_limit 详情口同 IP 高频触发,文案「您所在的网络存在异常,请登录后重试」
#   1005 forbidden            同族拒绝
RATE_LIMIT_CODES: frozenset[int] = frozenset({103, 1005, 1309})


class DoubanUnavailableError(RuntimeError):
    """豆瓣**按 IP 风控**(或要求登录),本机已拿不到数据。

    调用方应据此**停止本轮并保留已落盘的进度**,而不是把失败记成 `miss` ——
    否则风控期间跑一轮就会把整张映射表写成「全部未命中」,比不跑更糟。
    恢复后重跑即可续(见 `build_douban_map.py --delay`)。
    """


def rate_limited(status: int, data: Any) -> bool:
    """响应是否表示「本机 IP 被风控 / 需要登录」。"""
    if status == 200 or not isinstance(data, dict):
        return False
    try:
        return int(data.get("code")) in RATE_LIMIT_CODES
    except (TypeError, ValueError):
        return False


def norm(raw: Any) -> str:
    """片名归一 —— 复用 `film_match.norm_title`(NFKC + 只留字母数字与 CJK / 谚文)。"""
    if raw is None:
        return ""
    return film_match.norm_title(raw if isinstance(raw, str) else str(raw))


def name_forms(*values: Any) -> set[str]:
    """一组片名 → 归一化集合(丢弃空串)。"""
    return {norm(v) for v in values if norm(v)}


def dedup_queries(*values: Any) -> list[str]:
    """检索词:去空、去重、保序(顺序即尝试顺序,由调用方按命中率排)。"""
    out: list[str] = []
    for value in values:
        text = str(value or "").strip()
        if text and text not in out:
            out.append(text)
    return out


def _targets_from_suggestion(data: dict[str, Any]) -> list[dict[str, Any]]:
    """`search/suggestion` → movie target 列表(卡片式:条目信息在 `card.target`)。"""
    cards = data.get("cards") or []
    targets: list[dict[str, Any]] = []
    for card in cards:
        if not isinstance(card, dict) or card.get("target_type") != "movie":
            continue
        target = card.get("target")
        if isinstance(target, dict) and target.get("id"):
            targets.append(target)
    return targets


def _targets_from_mix_suggest(data: dict[str, Any]) -> list[dict[str, Any]]:
    """`search/mix_suggest_subjects` → movie 列表(字段平铺,年份藏在 `card_subtitle` 开头)。

    归一成与 `search/suggestion` 的 `target` 同形状,后续 `pick_target` 不必分叉。
    """
    items = data.get("items") or []
    targets: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict) or item.get("type") != "movie" or not item.get("id"):
            continue
        matched = RE_CARD_YEAR.match(str(item.get("card_subtitle") or ""))
        targets.append({
            "id": item.get("id"),
            "title": item.get("title"),
            "year": matched.group(1) if matched else "",
            "rating": item.get("rating"),
            "cover_url": item.get("cover_url"),
        })
    return targets


def search_movie_targets(client: FrodoClient, query: str, count: int = 3) -> list[dict[str, Any]]:
    """检索 movie 候选(主通道 `search/suggestion`,备通道 `mix_suggest_subjects`)。

    两个通道**都**没返回 HTTP 200 时抛 `DoubanUnavailableError`;返回 200 但确实没有
    movie 候选 = 该词真的搜不到(正常返回空表)。
    """
    reachable = 0
    last_error = ""
    for path, parser in (
        (SUGGEST_PATH, _targets_from_suggestion),
        (MIX_SUGGEST_PATH, _targets_from_mix_suggest),
    ):
        status, data = client.get_json(path, {"q": query, "start": 0, "count": count})
        if rate_limited(status, data):
            raise DoubanUnavailableError(
                f"{path} 被风控 → HTTP {status} code={data.get('code')} msg={data.get('msg')}"
            )
        if status == 200 and isinstance(data, dict):
            reachable += 1
            targets = parser(data)
            if targets:
                return targets
        else:
            hint = error_hint(data.get("code")) if isinstance(data, dict) else ""
            last_error = f"{path} → HTTP {status}{(' ' + hint) if hint else ''}"
    if reachable == 0:
        raise DoubanUnavailableError(f"检索通道全部不可用({last_error})")
    return []


def pick_target(
    targets: list[dict[str, Any]],
    forms: set[str],
    year: Any,
) -> Optional[dict[str, Any]]:
    """从候选里挑一个去拉详情:片名精确命中优先,其次年份一致,再其次保持服务端相关度序。"""
    best: Optional[dict[str, Any]] = None
    best_score = float("-inf")
    for index, target in enumerate(targets):
        score = 0.0
        if norm(target.get("title")) in forms:
            score += 3.0
        if year and str(target.get("year") or "") == str(year):
            score += 1.0
        score -= index * 0.01
        if score > best_score:
            best_score, best = score, target
    return best


def fetch_movie_detail(client: FrodoClient, subject_id: str) -> Optional[dict[str, Any]]:
    """拉条目详情(中文名 / 评分 / 海报 / `aka` / 导演 / 年份)。

    * 命中风控 → 抛 `DoubanUnavailableError`(同 IP 高频,详情口也会被限);
    * 条目不存在 / 其它 4xx → 返回 `None`(换下一个候选)。
    """
    status, data = client.get_json(MOVIE_PATH.format(id=subject_id))
    if rate_limited(status, data):
        raise DoubanUnavailableError(
            f"{MOVIE_PATH.format(id=subject_id)} 被风控 → HTTP {status} "
            f"code={data.get('code')} msg={data.get('msg')}"
        )
    if status == 200 and isinstance(data, dict) and data.get("id"):
        return data
    return None


def detail_forms(detail: dict[str, Any]) -> set[str]:
    """详情侧的全部片名写法:`title` + `original_title` + `aka[]`。"""
    aka = detail.get("aka") or []
    return name_forms(detail.get("title"), detail.get("original_title"), *aka)


def detail_directors(detail: dict[str, Any]) -> set[str]:
    """详情侧导演名集合(归一化;豆瓣给的是中文译名,与 xlsx 目录同口径)。"""
    return {norm(d.get("name")) for d in (detail.get("directors") or []) if isinstance(d, dict)}


def confidence_of(
    detail: dict[str, Any],
    forms: set[str],
    year: Any,
    directors: Optional[set[str]] = None,
) -> str:
    """详情与本片的吻合度:`high` / `medium` / `miss`。

    * 片名未命中且导演未命中 → `miss`(不落盘);
    * 片名命中 + 年份不矛盾 → `high`(本地缺年份时按「不矛盾」处理 —— 无从证伪);
    * 片名命中但年份不符,或只靠导演命中 → `medium`。
    """
    title_hit = bool(detail_forms(detail) & forms)
    year_hit = (not year) or str(detail.get("year") or "") == str(year)
    dir_hit = bool(detail_directors(detail) & (directors or set()))
    if not title_hit:
        return "medium" if dir_hit else "miss"
    return "high" if year_hit else "medium"


def poster_url_of(detail: dict[str, Any]) -> str:
    """详情海报 → `tools/fetch_posters.py` 认的**经典档位 URL**。

    详情给的是 `/view/photo/m_ratio_poster/public/pXXX.webp`(webp + 新档位段),
    而 `fetch_posters.py` 按 `/view/photo/<档位>/` 做替换(`s_ratio_poster` / `m` / `l`)。
    这里统一改写成 `/view/photo/l/public/pXXX.jpg` —— 三个档位实测都 200(见交接文档 §10.3:
    图片 URL 要**原样保留**主机的道理这里只对主机成立,档位段本就是可替换的尺寸参数)。
    """
    pic = detail.get("pic") or {}
    url = pic.get("large") or pic.get("normal") or detail.get("cover_url") or ""
    if not url:
        return ""
    url = RE_PHOTO_SIZE_SEG.sub("/view/photo/l/", url)
    return re.sub(r"\.webp$", ".jpg", url)


def resolve_subject(
    client: FrodoClient,
    queries: list[str],
    forms: set[str],
    year: Any = None,
    directors: Optional[set[str]] = None,
    delay: float = 1.2,
    count: int = 3,
) -> tuple[Optional[dict[str, Any]], str]:
    """逐个检索词试,命中即拉详情确认。返回 `(详情 or None, 置信度)`。

    每个豆瓣请求之间都 `sleep(delay)` —— 交接文档 §13.5 明确说**没有**恢复出服务端配额,
    所以节奏由调用方定;宁可慢,也不要因为高频被静默降级。
    """
    for query in queries:
        targets = search_movie_targets(client, query, count=count)
        time.sleep(delay)
        if not targets:
            continue
        target = pick_target(targets, forms, year)
        if target is None:
            continue
        detail = fetch_movie_detail(client, str(target["id"]))
        time.sleep(delay)
        if detail is None:
            continue
        confidence = confidence_of(detail, forms, year, directors)
        if confidence == "miss":
            continue
        return detail, confidence
    return None, "miss"
