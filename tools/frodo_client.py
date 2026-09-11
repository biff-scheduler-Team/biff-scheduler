#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""frodo_client.py — 豆瓣 Frodo(移动端)subject API 的签名客户端(纯标准库)。

为什么需要它
------------
豆瓣网页侧的匿名 JSON 口(`movie.douban.com/j/subject_suggest`)会**静默限流**
(返回 `[]`)并最终撞 CAPTCHA —— 这是本仓库长期只做「链接跳转」的原因。
官方 App 走的 Frodo 口则稳定得多,但要求三个应用签名参数:

    apikey / _ts / _sig

其中 `_sig = Base64(HMAC-SHA1(app_secret, "METHOD&percent_encode(path)&_ts"))`
(签名算法见 API 交接文档 §4.1;`q/start/count` 等业务 query **不参与**签名)。

本模块只做**协议层**:签名 / 设备参数 / HTTP / 错误码解析。
业务字段解析留给调用方(见 `build_douban_map.py` / `enrich_douban.py`)。

⚠ 只能在**离线管线**(本机 Python)里跑,不能进浏览器:
  1. `User-Agent` 是浏览器的**禁止头**,JS 设不了;
  2. `frodo.douban.com` 不返回 CORS 头,跨域必被拦;
  3. `app_secret` 一旦随前端产物下发就等于公开。

用法
----
    from frodo_client import FrodoClient

    client = FrodoClient()
    status, data = client.get_json("/api/v2/search/subjects", {"q": "霸王别姬", "count": 5})
    if status == 200 and isinstance(data, dict):
        ...

    # 只构造签名 URL、不发请求(排查签名问题时用)
    print(client.build_url("GET", "/api/v2/movie/1291546"))
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

API_ORIGIN = "https://frodo.douban.com"
API_PREFIX = "/api/v2"

# 应用凭证(来自 API 交接文档 §3.2 的恢复记录)—— 只参与应用签名,与用户 access token 无关
APIKEY = "0dad551ec0f84ed02907ff5c42e8ec70"
APP_SECRET = "bf7dddc7c9cfe6f7"

# 文档 §3.1 的客户端标识:伪装成 iOS 豆瓣 7.129.0 —— 服务端按它决定返回 schema
USER_AGENT = "api-client/1 com.douban.frodo/7.129.0(071290003) iOS/18.2 iPhone14,5"

# 文档 §3.3 的仓库默认设备参数(匿名探测口径;占位 udid 仅用于公开读接口)
DEFAULT_DEVICE_PARAMS: dict[str, str] = {
    "os_rom": "ios",
    "channel": "AppStore",
    "udid": "f" * 40,
    "device_id": "f" * 40,
    "timezone": "Asia/Shanghai",
}

# 文档 §13.2 的错误码 → 人话(仅用于日志;调用方按 code 决定重试 / 放弃)
ERROR_HINTS: dict[int, str] = {
    997: "缺少签名参数",
    996: "签名错误",
    104: "apikey 无效",
    1062: "apikey 无效",
    103: "用户凭证无效(invalid_access_token)",
    1000: "权限不足(need_permission)",
    1005: "访问被拒绝(forbidden)",
    1041: "接口已弃用(api_discard)",
    1270: "活动报名冲突",
    1309: "IP 级限流(subject_ip_rate_limit,同 IP 高频)",
    1411: "该类型不支持职员表(type_no_credits)",
}


def encode_path(path: str) -> str:
    """签名输入用的 path 编码 —— `/` 变 `%2F`,且不放过 `!'()*`。

    与 `urllib.parse.quote(path, safe="")` 等价;单独抽出来是为了让签名公式可读。
    ⚠ **只有签名输入**编码一次;HTTP query 上的 `_sig` 由 `urlencode` 完成第二层编码
    (Base64 里的 `+` 不编码会被服务端当成空格,实测报 996)。
    """
    return urllib.parse.quote(path, safe="")


def frodo_sign(method: str, path: str, ts: int, secret: str = APP_SECRET) -> str:
    """按文档 §4.1 计算 `_sig`。

    :param method: HTTP 方法(`GET` / `POST`),内部会转大写
    :param path: 实际 API path(含 `/api/v2` 前缀,不含 origin / query / fragment)
    :param ts: 与 query 中 `_ts` **同一个**整数秒时间戳
    :param secret: 应用密钥
    :return: 标准 Base64(不是 URL-safe,也不是十六进制摘要)
    """
    normalized = path if path.startswith("/") else "/" + path
    raw = f"{method.upper()}&{encode_path(normalized)}&{ts}"
    digest = hmac.new(secret.encode("utf-8"), raw.encode("utf-8"), hashlib.sha1).digest()
    return base64.b64encode(digest).decode("ascii")


def error_hint(code: Any) -> str:
    """把响应里的 `code` 翻成一句人话(未知码返回空串)。"""
    try:
        return ERROR_HINTS.get(int(code), "")
    except (TypeError, ValueError):
        return ""


class FrodoClient:
    """豆瓣 Frodo 请求客户端(匿名读 / 可选用户 token)。

    :param timeout: 单请求超时秒数
    :param access_token: 用户 access token;给了就带 `Authorization: Bearer`(写操作 / 用户态读需要)
    :param device_params: 覆盖 `DEFAULT_DEVICE_PARAMS` 中的任意键
    :param user_agent: 覆盖默认 UA(一般不用改)
    """

    def __init__(
        self,
        timeout: float = 20.0,
        access_token: Optional[str] = None,
        device_params: Optional[dict[str, str]] = None,
        user_agent: str = USER_AGENT,
    ) -> None:
        self.timeout = timeout
        self.access_token = access_token
        self.user_agent = user_agent
        self.device_params = {**DEFAULT_DEVICE_PARAMS, **(device_params or {})}

    @property
    def host(self) -> str:
        """API origin(与文档 §3.1 一致,便于打印 / 拼 URL)。"""
        return API_ORIGIN

    def build_params(
        self,
        method: str,
        path: str,
        params: Optional[dict[str, Any]] = None,
    ) -> dict[str, str]:
        """合并「设备参数 + 业务 query」并写入 `apikey/_ts/_sig`。

        值为 `None` 的业务参数会被跳过;其余值一律 `str()`(与原始 client 同口径 ——
        所以列表 / 布尔值必须由调用方自己序列化成服务端认识的字符串)。
        """
        merged: dict[str, str] = dict(self.device_params)
        for key, value in (params or {}).items():
            if value is None:
                continue
            merged[key] = str(value)
        ts = int(time.time())
        merged["apikey"] = APIKEY
        merged["_ts"] = str(ts)
        merged["_sig"] = frodo_sign(method, path, ts)
        return merged

    def build_url(self, method: str, path: str, params: Optional[dict[str, Any]] = None) -> str:
        """构造**带签名**的完整 URL(`_sig` 交给 `urlencode` 做第二层编码)。"""
        return API_ORIGIN + path + "?" + urllib.parse.urlencode(self.build_params(method, path, params))

    def request(
        self,
        method: str,
        path: str,
        params: Optional[dict[str, Any]] = None,
        body: Optional[dict[str, Any]] = None,
    ) -> tuple[int, dict[str, str], bytes]:
        """发一个请求,返回 `(status, headers, raw_bytes)`。

        * `status == 0` 表示**传输层**失败(DNS / TLS / 超时),`raw` 是异常文本;
          HTTP 4xx/5xx **不抛异常**,原样返回真实状态与 body(与原始 client 一致)。
        * `body` 走 `application/x-www-form-urlencoded`;`None` = 无表单体。
        """
        url = self.build_url(method, path, params)
        data = urllib.parse.urlencode(body).encode("utf-8") if body is not None else None
        headers = {"Accept": "application/json", "User-Agent": self.user_agent}
        if body is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        if self.access_token:
            headers["Authorization"] = f"Bearer {self.access_token}"

        req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return resp.status, dict(resp.headers.items()), resp.read()
        except urllib.error.HTTPError as exc:
            # 4xx/5xx 也带 JSON 错误对象,按正常响应返回,交给调用方判 code
            return exc.code, dict(exc.headers.items()) if exc.headers else {}, exc.read()
        except Exception as exc:  # noqa: BLE001  (网络异常统一降级为 status=0,与原始 client 同口径)
            return 0, {}, str(exc).encode("utf-8", "replace")

    def get_json(
        self,
        path: str,
        params: Optional[dict[str, Any]] = None,
    ) -> tuple[int, Any]:
        """GET 并解析 JSON,返回 `(status, data)`;解析失败时 `data` 是**原始文本**。"""
        status, _, raw = self.request("GET", path, params=params)
        text = raw.decode("utf-8", "replace")
        try:
            return status, json.loads(text)
        except ValueError:
            return status, text
