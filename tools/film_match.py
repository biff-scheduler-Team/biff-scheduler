#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""film_match.py — 官网片目 ↔ xlsx 目录的**约束配对**底座

背景
----
两边命名不同(官网英文/韩文 vs xlsx 中文/原始),靠片名字符串只能对上约一半。
但按「单元」切分后,两边**余量几乎完全配平**(实测:广角镜 19=19、亚洲电影之窗 15=15、
Icons 14=14、World Cinema 9=9、Vision 8=8、Flash Forward 7=7…)——
数量相等意味着**完美配对存在**,只差把顺序对上。

约束(按可信度加权)
------------------
1. **导演**:官网给罗马字(`OKITA Shuichi`),xlsx 给罗马字(`KIM Byoungsoo`)或**中文译名**
   (`顾游`/`韩俊熙`)。罗马字逐字相等、或中文译名转拼音后与罗马字相等,均视为强证据(权重 3)。
2. **国家**:官网给英文(`Korea`/`France`),xlsx 给中文(`韩国`/`法国`)。权重 2。
3. **片名相似度**:归一化后的 difflib 比率(权重 0~2),用于同分时定序。

分配策略:按分数降序贪心 + 一对一占用。**不硬凑** —— 分数为 0 的候选不分配,
宁可留成「未配对」在自检里报出来,也不猜。

2026-09-11 补充
---------------
- `pair_unit_key()`:配对专用的**粗**归并键(展示用的 `unitKey` 保持细粒度,两者刻意分开)。
  官网 section(`Vision`/`Wide Angle`)与 xlsx 子单元(`Vision–Asia`/`广角镜 - 纪录片竞赛`)
  口径不同,不粗归并的话第一轮「同单元」约束会把它们直接跳过。
- `pinyin_of()`:中文译名导演 → 无声调拼音,用来接「中文译名 ↔ 官网罗马字」那批
  (`顾游`→`guyou` = `GU You`)。**只做全等判定**,不做模糊 —— 同单元同国家候选太多,
  模糊匹配实测会把《The First Taste of Loneliness》配到《后生》(两国都是中国大陆)。
- `assign_balanced()`:同粗单元 + 国家命中 的**配平**一对一(双向唯一才认),用于接回
  片名/导演都无字面证据、但两边余量完全配平的那批。
"""

from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher
from typing import Any, Optional

# 官网英文国家名 → xlsx 中文国家名(只收录 2026 这一届出现过的)
COUNTRY_ZH: dict[str, str] = {
    "Korea": "韩国",
    "Japan": "日本",
    "France": "法国",
    "United States": "美国",
    "Germany": "德国",
    "Italy": "意大利",
    "Spain": "西班牙",
    "United Kingdom": "英国",
    "Taiwan": "中国台湾",
    "China": "中国大陆",
    "Hong Kong, China": "中国香港",
    "Belgium": "比利时",
    "India": "印度",
    "Singapore": "新加坡",
    "Norway": "挪威",
    "Iran": "伊朗",
    "Indonesia": "印度尼西亚",
    "Denmark": "丹麦",
    "Netherlands": "荷兰",
    "Saudi Arabia": "沙特阿拉伯",
    "Thailand": "泰国",
    "Austria": "奥地利",
    "Vietnam": "越南",
    "Philippines": "菲律宾",
    "Canada": "加拿大",
    "Poland": "波兰",
    "Nepal": "尼泊尔",
    "Greece": "希腊",
    "Sweden": "瑞典",
    "Mexico": "墨西哥",
    "Chile": "智利",
    "Brazil": "巴西",
    "Romania": "罗马尼亚",
    "Ireland": "爱尔兰",
    "Australia": "澳大利亚",
    "Afghanistan": "阿富汗",
    "Mongolia": "蒙古",
    "Kazakhstan": "哈萨克斯坦",
    "Turkiye": "土耳其",
    "Cambodia": "柬埔寨",
    "Switzerland": "瑞士",
    "Portugal": "葡萄牙",
    "Finland": "芬兰",
    "Iceland": "冰岛",
    "Israel": "以色列",
    "Malaysia": "马来西亚",
    "Myanmar": "缅甸",
    "Sri Lanka": "斯里兰卡",
    "Uzbekistan": "乌兹别克斯坦",
    "Colombia": "哥伦比亚",
    "Argentina": "阿根廷",
    "Peru": "秘鲁",
    "Egypt": "埃及",
    "Morocco": "摩洛哥",
    "Tunisia": "突尼斯",
    "Qatar": "卡塔尔",
    "United Arab Emirates": "阿联酋",
    "Kuwait": "科威特",
    "Jordan": "约旦",
    "Lebanon": "黎巴嫩",
    "Georgia": "格鲁吉亚",
    "Bulgaria": "保加利亚",
    "Croatia": "克罗地亚",
    "Serbia": "塞尔维亚",
    "Hungary": "匈牙利",
    "Czech Republic": "捷克",
    "Slovakia": "斯洛伐克",
    "Ukraine": "乌克兰",
    "Russia": "俄罗斯",
    "Lithuania": "立陶宛",
    "Latvia": "拉脱维亚",
    "Estonia": "爱沙尼亚",
}


def norm_title(raw: str) -> str:
    """片名归一(NFKC + 弯引号 / 破折号统一 + 只留字母数字与 CJK / 谚文)。"""
    s = unicodedata.normalize("NFKC", raw or "").lower()
    for a, b in (("′", "'"), ("’", "'"), ("‘", "'"), ("–", "-"), ("—", "-")):
        s = s.replace(a, b)
    return re.sub(r"[^0-9a-z\u4e00-\u9fff\uac00-\ud7af]+", "", s)


# 配对专用粗归并规则:命中即归并到同一键。顺序敏感(先匹配先归)。
# ⚠ 与展示/筛选用 `src/library.ts::unitKey` **刻意不同口径** —— 那里要保持细粒度,
# 否则下拉选项与卡片副标题的中英对照会重新对不上(见 2026-09-11 的收窄记录)。
PAIR_UNIT_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"Vision", "Vision"),
    (r"广角镜|Wide Angle", "广角镜"),
    (r"Korean Cinema Today", "Korean Cinema Today"),
    (r"On Screen", "On Screen"),
    (r"特别企划|日本动画特别企划|CARTE BLANCHE|亚洲电影人奖|Special Program in Focus", "特别企划"),
    (r"亚洲电影之窗|A Window on Asian Cinema", "亚洲电影之窗"),
)


def pair_unit_key(raw: str) -> str:
    """配对专用的**粗**归并键(官网 section 与 xlsx 子单元口径对齐)。

    官网只给 section 名(`Vision` / `Wide Angle` / `Special Program in Focus`),
    xlsx 目录却细到子单元(`Vision–Asia` / `Vision–Korea` / `广角镜 - 纪录片竞赛` /
    `日本动画特别企划`)。不粗归并时第一轮「同单元」约束会把 12 部片直接跳过。
    """
    t = (raw or "").strip()
    for pat, key in PAIR_UNIT_PATTERNS:
        if re.search(pat, t):
            return key
    return t or "未标注单元"


def pinyin_of(raw: str) -> str:
    """导演名 → 比较用的拉丁串。

    - 已含拉丁字母(`KIM Ji-hyun` / `GU You`):走 `letters()` 只留 a-z;
    - 纯汉字(`顾游` / `韩俊熙`):转无声调拼音(`guyou` / `hanjunxi`);
    - 其他(谚文 / 假名 / 混排):返回空串 —— 没有可比信息,交由片名与国家判定。

    `pypinyin` 是可选依赖:缺失时汉字分支返回空串(退化为原行为),不抛错。
    """
    s = raw or ""
    if re.search(r"[\u4e00-\u9fff]", s):
        han = re.sub(r"[^\u4e00-\u9fff]", "", s)
        try:
            from pypinyin import lazy_pinyin  # noqa: PLC0415  (可选依赖,延迟导入)
        except ImportError:
            return ""
        return "".join(lazy_pinyin(han))
    return letters(s)


def letters(raw: str) -> str:
    """只留字母(用于导演名跨写法比较:`OKITA Shuichi` / `OKITA Shuichi`)。"""
    return re.sub(r"[^a-z]", "", unicodedata.normalize("NFKD", raw or "").lower())


def country_set(raw: str) -> set[str]:
    """官网国家串(`India/Canada/Estonia/France`)→ 中文集合。"""
    return {COUNTRY_ZH.get(x.strip(), x.strip()) for x in (raw or "").split("/") if x.strip()}


def score(web: dict[str, Any], cat: dict[str, Any]) -> float:
    """候选配对的可信度(**0 = 证据不足,不参与分配**)。

    ⚠ **只靠国家相同不算证据**。实测:同一单元里「日本」片有几十部,贪心按国家配
    会把《You, Like a Star》配到《杀人之门》——两边都是日本、都在亚洲电影之窗,
    但根本不是同一部。这类错配比「配不上」危害大得多(静默挂错中文名 / 海报)。
    故门槛设为:**导演命中 或 片名相似度 ≥ 0.85**,二者必有其一。0.85 而不是 0.5 ——
    实测 0.5 会把《Let Us Through, Dear Ancestors》配到《夏日红岩》(短串上比率天然偏高),
    宁可配不上(显示英文名)也不要配错(静默挂错中文名与海报)。

    「导演命中」含两种写法:官网罗马字逐字相等,或 xlsx 中文译名转拼音后相等
    (`顾游`→`guyou` == `GU You`)。**只做全等**,不做模糊 —— 模糊版实测会把
    《The First Taste of Loneliness》(顾游)配到《后生》(陈吉文),两国同为中国大陆。
    """
    dir_web = letters(web.get("director"))
    dir_hit = bool(dir_web) and dir_web == letters(cat.get("director"))
    dir_py = bool(dir_web) and dir_web == pinyin_of(cat.get("director"))
    ctry_hit = bool(country_set(web.get("country")) & {cat.get("country") or ""})
    a = norm_title(web.get("title_en")) or norm_title(web.get("title_kr"))
    ratio = 0.0
    for cand in (cat.get("title_orig"), cat.get("title_zh")):
        b = norm_title(cand)
        if a and b:
            ratio = max(ratio, SequenceMatcher(None, a, b).ratio())
    if not (dir_hit or dir_py) and ratio < 0.85:
        return 0.0
    return (3.0 if (dir_hit or dir_py) else 0.0) + (2.0 if ctry_hit else 0.0) + ratio


def assign(
    web_items: list[dict[str, Any]],
    cat_items: list[dict[str, Any]],
    unit_of,
    *,
    same_unit: bool = True,
    min_score: float = 0.0,
) -> tuple[list[tuple[dict[str, Any], dict[str, Any], float]], list[dict[str, Any]]]:
    """一对一贪心分配。返回 (配对成功, 未配对的 web 条目)。

    `same_unit=True` 时只在同一归并单元内配对(首选);`False` = 不限单元,但要抬 `min_score`。
    **为什么要第二轮**:xlsx 的「日本动画特别企划 / 亚洲电影人奖 / CARTE BLANCHE」在官网
    统统归在 `Special Program in Focus` 一个 section 下 —— 同单元口径对不上,但**片确实是同一部**
    (天使之卵↔Angel's Egg、大都会↔Metropolis…)。第二轮靠「导演 + 国家」把它们接回来。
    """
    pairs: list[tuple[dict[str, Any], dict[str, Any], float]] = []
    used_cat: set[int] = set()
    used_web: set[int] = set()
    scored: list[tuple[float, int, int]] = []
    for i, w in enumerate(web_items):
        for j, c in enumerate(cat_items):
            if same_unit and unit_of(w.get("unit")) != unit_of(c.get("unit")):
                continue
            s = score(w, c)
            if s > min_score:
                scored.append((s, i, j))
    scored.sort(reverse=True)
    for s, i, j in scored:
        if i in used_web or j in used_cat:
            continue
        used_web.add(i)
        used_cat.add(j)
        pairs.append((web_items[i], cat_items[j], s))
    return pairs, [w for i, w in enumerate(web_items) if i not in used_web]


def _country_hit(web: dict[str, Any], cat: dict[str, Any]) -> bool:
    """官网国家串与 xlsx 中文国家名是否相交。"""
    return bool(country_set(web.get("country")) & {cat.get("country") or ""})


def assign_balanced(
    web_items: list[dict[str, Any]],
    cat_items: list[dict[str, Any]],
    unit_of,
) -> tuple[list[tuple[dict[str, Any], dict[str, Any], float]], list[dict[str, Any]]]:
    """「同粗单元 + 国家命中 + 余量配平」的保守一对一(双向唯一才认)。

    与 `assign()` 的分工:**`assign()` 要求字面证据**(导演罗马字/拼音、片名相似度),
    本函数专门接「片名是英文译名、导演是中文译名」这种**无字面证据**、只剩国家可用的那批
    (`Nagi Notes`↔《奈义日记》、`Red Rocks`↔《夏日红岩》)。

    之所以敢用「国家」这种弱证据,靠的是两道硬约束叠加:

    1. **余量配平**:本粗单元内官网待配片数 == xlsx 未认领数。不配平说明有片不在本单元
       (或目录多出合集成员),一律跳过。实测主竞赛 8 vs 9、亚洲电影之窗 11 vs 12 都因此
       被跳过 —— 正是原型里《The First Taste of Loneliness》被配到《后生》的那两处。
    2. **双向唯一**:候选关系收敛到「该 web 片只有一个国家命中的候选,且该候选也只有一个
       web 片指向它」。同国家多片互抢时两边都不认(`Bitter Christmas` 与 `The Beloved`
       同为西班牙,各自 2 个候选 → 全部留空)。

    分数固定记 2.0(国家证据),仅用于统计展示;`match_score` 低于字面证据配对,便于复核。
    """
    pairs: list[tuple[dict[str, Any], dict[str, Any], float]] = []
    taken_w_all: set[int] = set()
    groups: dict[str, list[int]] = {}
    for i, w in enumerate(web_items):
        groups.setdefault(unit_of(w.get("unit")), []).append(i)
    for key, w_idx in groups.items():
        c_idx = [j for j, c in enumerate(cat_items) if unit_of(c.get("unit")) == key]
        if not w_idx or len(w_idx) != len(c_idx):
            continue
        taken_w: set[int] = set()
        taken_c: set[int] = set()
        changed = True
        while changed:
            changed = False
            for i in w_idx:
                if i in taken_w:
                    continue
                avail = [j for j in c_idx if j not in taken_c and _country_hit(web_items[i], cat_items[j])]
                if len(avail) == 1:
                    pairs.append((web_items[i], cat_items[avail[0]], 2.0))
                    taken_w.add(i)
                    taken_c.add(avail[0])
                    changed = True
            for j in c_idx:
                if j in taken_c:
                    continue
                backers = [i for i in w_idx if i not in taken_w and _country_hit(web_items[i], cat_items[j])]
                if len(backers) == 1:
                    pairs.append((web_items[backers[0]], cat_items[j], 2.0))
                    taken_w.add(backers[0])
                    taken_c.add(j)
                    changed = True
        taken_w_all |= taken_w
    return pairs, [w for i, w in enumerate(web_items) if i not in taken_w_all]
