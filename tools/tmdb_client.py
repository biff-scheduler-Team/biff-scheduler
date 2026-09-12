#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""tmdb_client.py — TMDB v3 HTTP 客户端(纯标准库)。

鉴权与 piecelet-api-relay 的 `/tmdb` 中继相同:`Authorization: Bearer <v4 token>`。
Token **只从环境变量读**,不写文件、不进仓库:

    TMDB_KEY
    RELAY_TMDB_KEY   # 与 Piecelet GitHub secret 同名,二选一

用法
----
    from tmdb_client import TmdbClient
    client = TmdbClient()          # 缺 token 会立刻报错
    data = client.get("/3/search/movie", {"query": "Look Back", "year": "2026"})
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

API_ORIGIN = "https://api.themoviedb.org"
IMAGE_ORIGIN = "https://image.tmdb.org/t/p"
# 与本站 s / m / l 三档大致对应(列表缩略 / 卡片 / 弹层大图)
POSTER_SIZES = (("w185", "s"), ("w500", "m"), ("original", "l"))


def read_token() -> str:
    """环境变量里的 v4 token;两个名字都认,都不在就空串。"""
    return (os.environ.get("TMDB_KEY") or os.environ.get("RELAY_TMDB_KEY") or "").strip()


class TmdbClient:
    def __init__(self, timeout: float = 20.0, token: Optional[str] = None) -> None:
        self.timeout = timeout
        self.token = (token or read_token()).strip()
        if not self.token:
            raise RuntimeError(
                "缺少 TMDB_KEY(或 RELAY_TMDB_KEY)。"
                "在 shell 里 export,或放到未跟踪的 .env,不要写进仓库。"
            )

    def get(self, path: str, params: Optional[dict[str, Any]] = None) -> tuple[int, Any]:
        query = urllib.parse.urlencode(
            {k: str(v) for k, v in (params or {}).items() if v is not None}
        )
        url = API_ORIGIN + path + (("?" + query) if query else "")
        req = urllib.request.Request(
            url,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {self.token}",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
                status = resp.status
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            status = exc.code
        except Exception as exc:  # noqa: BLE001
            return 0, str(exc)
        text = raw.decode("utf-8", "replace")
        try:
            return status, json.loads(text)
        except ValueError:
            return status, text


def poster_url(poster_path: str, size: str = "w500") -> str:
    """TMDB 图床。`poster_path` 以 `/` 开头,如 `/abc.jpg`。图床本身不需要 token。"""
    path = poster_path if poster_path.startswith("/") else "/" + poster_path
    return f"{IMAGE_ORIGIN}/{size}{path}"
