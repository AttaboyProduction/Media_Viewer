"""Internal site JSON API helpers (/api/v2/ style).

GET /api/v2/post/{id} returns full post detail including tags with numeric type flags.

## Tag-fetch transport preference

Try in this order — fastest / most reliable first for Cloudflare/CDN hosts:

1. **curl_cffi** — Chrome TLS impersonation. Best default (~1s). Plain OpenSSL often
   fails with INVALID_SESSION_ID / connection reset against Cloudflare.
2. **httpx** — Hardened TLS (no session tickets, no keepalive). Sometimes works; keep
   as a light fallback without extra native deps beyond httpx.
3. **curl** — System curl.exe (Windows Schannel). Avoids Python OpenSSL.
4. **playwright_api** — Chromium network stack JSON GET. Slower cold start.
5. **html** — Playwright page scrape (`scrape_tags_from_url`). Last resort; still yields
   group keys from CSS, but heavier than the JSON API.

Callers should start at #1 and iterate; HTML fallback lives in `refresh_media_tags`.
"""

from __future__ import annotations

import json
import re
import shutil
import ssl
import subprocess
import time
from collections.abc import Callable
from urllib.parse import urlparse

import httpx
from curl_cffi import requests as curl_requests
from sqlalchemy.orm import Session

from backend.app.db.models import TagGroup
from backend.scraper.gallery import extract_post_id
from backend.scraper.post import PostTag, normalize_tag_group_key, normalize_tag_name

# Tag `type` bit flags from GET /api/v2/post/{id} → group key / seed metadata.
API_TAG_TYPES: list[dict] = [
    {"type": 1, "key": "general", "label": "General", "color": "#95a5a6", "sort_order": 6},
    {"type": 2, "key": "copyright", "label": "Copyright", "color": "#f39c12", "sort_order": 2},
    {"type": 4, "key": "character", "label": "Character", "color": "#3498db", "sort_order": 1},
    {"type": 8, "key": "artist", "label": "Artist", "color": "#e74c3c", "sort_order": 0},
    {"type": 16, "key": "system", "label": "System", "color": "#7f8c8d", "sort_order": 4},
    {"type": 32, "key": "meta", "label": "Meta", "color": "#9b59b6", "sort_order": 3},
]

TAG_TYPE_TO_GROUP: dict[int, str] = {item["type"]: item["key"] for item in API_TAG_TYPES}

# Ordered JSON transports for this site (see module docstring). HTML is separate.
TAG_FETCH_JSON_TRANSPORTS: tuple[str, ...] = (
    "curl_cffi",
    "httpx",
    "curl",
    "playwright_api",
)

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

_IMPERSONATE_CANDIDATES = ("chrome131", "chrome124", "chrome120", "chrome")

_TRANSIENT_MARKERS = (
    "SSL",
    "INVALID_SESSION_ID",
    "ERR_SSL",
    "EPROTO",
    "Connection reset",
    "ConnectionAborted",
    "ConnectError",
    "ConnectTimeout",
    "ReadTimeout",
    "Timeout",
    "EOF",
    "timed out",
    "handshake",
    "Recv failure",
)


def _is_transient(exc: BaseException) -> bool:
    message = f"{type(exc).__name__}: {exc}"
    return any(marker in message for marker in _TRANSIENT_MARKERS)


def _ssl_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    if hasattr(ssl, "OP_NO_TICKET"):
        ctx.options |= ssl.OP_NO_TICKET
    return ctx


def api_origin_from_url(url: str) -> str:
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        raise ValueError(f"Invalid post URL: {url}")
    return f"{parsed.scheme}://{parsed.netloc}".rstrip("/")


def post_api_url(post_page_url: str, post_id: str | None = None) -> str:
    pid = post_id or extract_post_id(post_page_url)
    if not pid:
        raise ValueError(f"Could not extract post id from URL: {post_page_url}")
    return f"{api_origin_from_url(post_page_url)}/api/v2/post/{pid}"


def group_key_from_tag_type(tag_type: int | None, *, untyped_key: str = "unknown") -> str:
    if tag_type is None:
        return untyped_key
    if tag_type in TAG_TYPE_TO_GROUP:
        return TAG_TYPE_TO_GROUP[tag_type]
    for flag in (32, 16, 8, 4, 2, 1):
        if tag_type & flag and flag in TAG_TYPE_TO_GROUP:
            return TAG_TYPE_TO_GROUP[flag]
    return untyped_key


def ensure_api_tag_type_groups(db: Session) -> list[TagGroup]:
    """Create/update TagGroup rows for every known API tag type."""
    ensured: list[TagGroup] = []
    for item in API_TAG_TYPES:
        group = db.query(TagGroup).filter(TagGroup.key == item["key"]).first()
        if group:
            if group.label != item["label"]:
                if group.label.lower() in {group.key, item["key"], "creator"} or not group.label:
                    group.label = item["label"]
            ensured.append(group)
            continue
        group = TagGroup(
            key=item["key"],
            label=item["label"],
            default_color=item["color"],
            sort_order=item["sort_order"],
            is_default=False,
        )
        db.add(group)
        db.flush()
        ensured.append(group)
    return ensured


def tags_from_post_payload(payload: dict, *, untyped_key: str = "unknown") -> list[PostTag]:
    raw_tags = payload.get("tags") or []
    if not isinstance(raw_tags, list):
        raise ValueError("Post API response missing tags array")

    result: list[PostTag] = []
    seen: set[str] = set()
    for item in raw_tags:
        if not isinstance(item, dict):
            continue
        value = item.get("value")
        if not value or not isinstance(value, str):
            continue
        name = normalize_tag_name(value)
        if not name or name in seen:
            continue
        seen.add(name)
        tag_type = item.get("type")
        try:
            type_int = int(tag_type) if tag_type is not None else None
        except (TypeError, ValueError):
            type_int = None
        group_key = normalize_tag_group_key(
            group_key_from_tag_type(type_int, untyped_key=untyped_key)
        )
        result.append(PostTag(name=name, group_key=group_key))
    return result


def _request_headers(post_page_url: str, api_url: str) -> dict[str, str]:
    return {
        "User-Agent": _USER_AGENT,
        "Accept": "application/json",
        "Referer": post_page_url if re.search(r"/post/\d+", post_page_url) else api_url,
        "Origin": api_origin_from_url(post_page_url),
        "Cache-Control": "no-cache",
        "Connection": "close",
    }


def fetch_post_json_curl_cffi(
    post_page_url: str, *, retries: int = 3, timeout: float = 25.0
) -> dict:
    """Preferred for Cloudflare/CDN hosts: Chrome TLS fingerprint via curl_cffi."""
    url = post_api_url(post_page_url)
    headers = _request_headers(post_page_url, url)
    last_error: BaseException | None = None

    for attempt in range(retries):
        impersonate = _IMPERSONATE_CANDIDATES[min(attempt, len(_IMPERSONATE_CANDIDATES) - 1)]
        try:
            response = curl_requests.get(
                url,
                headers=headers,
                impersonate=impersonate,
                timeout=timeout,
                allow_redirects=True,
            )
            if response.status_code == 404:
                raise ValueError(f"Post not found via API: {url}")
            if response.status_code >= 400:
                raise RuntimeError(f"HTTP {response.status_code} for {url}")
            data = response.json()
            if not isinstance(data, dict):
                raise ValueError(f"Unexpected API response for {url}")
            return data
        except ValueError:
            raise
        except Exception as exc:
            last_error = exc
            if attempt >= retries - 1:
                raise
            time.sleep(min(0.8 * (attempt + 1), 3.0))

    if last_error:
        raise last_error
    raise RuntimeError(f"Failed to fetch post API (curl_cffi): {url}")


def fetch_post_json_httpx(post_page_url: str, *, retries: int = 2, timeout: float = 20.0) -> dict:
    """httpx with fresh SSL context (often fails on this CDN; kept as fallback)."""
    url = post_api_url(post_page_url)
    headers = _request_headers(post_page_url, url)
    limits = httpx.Limits(max_keepalive_connections=0, max_connections=5)
    last_error: BaseException | None = None

    for attempt in range(retries):
        try:
            with httpx.Client(
                timeout=timeout,
                follow_redirects=True,
                http2=False,
                verify=_ssl_context(),
                limits=limits,
            ) as client:
                response = client.get(url, headers=headers)
                if response.status_code == 404:
                    raise ValueError(f"Post not found via API: {url}")
                response.raise_for_status()
                data = response.json()
                if not isinstance(data, dict):
                    raise ValueError(f"Unexpected API response for {url}")
                return data
        except ValueError:
            raise
        except Exception as exc:
            last_error = exc
            if attempt >= retries - 1 or not _is_transient(exc):
                raise
            time.sleep(min(1.0 * (attempt + 1), 4.0))

    if last_error:
        raise last_error
    raise RuntimeError(f"Failed to fetch post API (httpx): {url}")


def fetch_post_json_curl(post_page_url: str, *, retries: int = 2, timeout: float = 30.0) -> dict:
    """System curl (Schannel on Windows) — bypasses Python OpenSSL."""
    curl = shutil.which("curl") or shutil.which("curl.exe")
    if not curl:
        raise RuntimeError("curl executable not found")

    url = post_api_url(post_page_url)
    headers = _request_headers(post_page_url, url)
    last_error: BaseException | None = None

    for attempt in range(retries):
        try:
            cmd = [
                curl,
                "-sS",
                "--fail-with-body",
                "--http1.1",
                "--tlsv1.2",
                "--connect-timeout",
                "15",
                "--max-time",
                str(int(timeout)),
                "-A",
                headers["User-Agent"],
                "-H",
                f"Accept: {headers['Accept']}",
                "-H",
                f"Referer: {headers['Referer']}",
                "-H",
                f"Origin: {headers['Origin']}",
                "-H",
                "Connection: close",
                url,
            ]
            completed = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout + 5,
                check=False,
            )
            if completed.returncode != 0:
                err = (completed.stderr or completed.stdout or "").strip() or f"curl exit {completed.returncode}"
                raise RuntimeError(err)
            data = json.loads(completed.stdout)
            if not isinstance(data, dict):
                raise ValueError(f"Unexpected API response for {url}")
            return data
        except ValueError:
            raise
        except Exception as exc:
            last_error = exc
            if attempt >= retries - 1:
                raise
            time.sleep(min(1.0 * (attempt + 1), 4.0))

    if last_error:
        raise last_error
    raise RuntimeError(f"Failed to fetch post API (curl): {url}")


def fetch_post_json_playwright(post_page_url: str, *, retries: int = 2) -> dict:
    """Chromium request context — slower; useful when other TLS stacks fail."""
    from backend.scraper.client import PlaywrightClient

    url = post_api_url(post_page_url)
    headers = _request_headers(post_page_url, url)
    last_error: BaseException | None = None

    with PlaywrightClient(ignore_https_errors=True) as client:
        for attempt in range(retries):
            try:
                if attempt:
                    client.reset_context()
                data = client.request_json(url, headers=headers, timeout_ms=60_000)
                if not isinstance(data, dict):
                    raise ValueError(f"Unexpected API response for {url}")
                return data
            except ValueError:
                raise
            except Exception as exc:
                last_error = exc
                if attempt >= retries - 1 or not _is_transient(exc):
                    raise
                time.sleep(min(1.0 * (attempt + 1), 4.0))

    if last_error:
        raise last_error
    raise RuntimeError(f"Failed to fetch post API (playwright): {url}")


# Back-compat alias: primary transport.
fetch_post_json = fetch_post_json_curl_cffi

_JSON_FETCHERS: dict[str, Callable[..., dict]] = {
    "curl_cffi": fetch_post_json_curl_cffi,
    "httpx": fetch_post_json_httpx,
    "curl": fetch_post_json_curl,
    "playwright_api": fetch_post_json_playwright,
}


def _json_transport_order() -> tuple[str, ...]:
    """Preferred JSON transports for the selected (or default) site."""
    from backend.scraper.sites import get_selected_site

    site = get_selected_site() or {}
    order = site.get("tag_fetch_order") or list(TAG_FETCH_JSON_TRANSPORTS)
    return tuple(name for name in order if name in _JSON_FETCHERS)


def fetch_post_payload(post_page_url: str) -> dict:
    """Fetch full post JSON, trying preferred transports in order until one succeeds."""
    errors: list[str] = []
    for name in _json_transport_order():
        fetcher = _JSON_FETCHERS[name]
        try:
            return fetcher(post_page_url)
        except ValueError:
            raise
        except Exception as exc:
            errors.append(f"{name}: {exc}")
            continue
    raise RuntimeError("; ".join(errors) if errors else f"Failed to fetch post API for {post_page_url}")


def fetch_tags_for_post_url(post_page_url: str, *, untyped_key: str | None = None) -> list[PostTag]:
    """Fetch tags via JSON API, trying preferred transports in order until one succeeds."""
    from backend.app.services.app_settings import get_untyped_tag_group_key

    fallback = untyped_key if untyped_key is not None else get_untyped_tag_group_key()
    return tags_from_post_payload(fetch_post_payload(post_page_url), untyped_key=fallback)
