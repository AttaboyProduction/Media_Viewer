"""Gelbooru-style sites (rule34.xxx): DAPI listing, original file_url, checkbox page.

The xyz downloader stays the default when a site has no ``profile``. This module
runs only for ``profile: gelbooru``.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
from datetime import datetime, timezone
from urllib.parse import parse_qs, quote, urlencode, urljoin, urlparse, urlunparse

from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

# Gelbooru tag type ids. Missing types stay general.
GELBOORU_TAG_GROUPS = {
    0: "general",
    1: "artist",
    3: "copyright",
    4: "character",
    5: "meta",
}

# Metatag appended for Oldest. Newest is the API and list default.
SORT_OLDEST = "sort:id:asc"

_MAX_PAGES = 500
_PAGE_SIZE = 100
_SOFT_CAP = 10_000

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

_FILE_EXT = (".jpeg", ".jpg", ".png", ".webp", ".gif", ".webm", ".mp4", ".mkv", ".mov")

# Set for the duration of a gelbooru job so a file response that is the checkbox
# page can be retried on the browser thread.
_job_client = None


class NeedsBrowser(Exception):
    """File body is the checkbox page and this thread must not open the browser."""


class ScrapeCancelled(Exception):
    """Stop was pressed while waiting on the checkbox page."""


def bind_client(client) -> None:
    global _job_client
    _job_client = client


def is_gelbooru_site(site: dict | None = None) -> bool:
    if site is None:
        from backend.scraper.sites import get_selected_site

        site = get_selected_site() or {}
    return str(site.get("profile") or "") == "gelbooru"


def list_page_url(site: dict, tags: list[str], exclude: list[str]) -> str:
    """Gallery list URL. Several tags are one space-separated ``tags`` value."""
    base = str(site.get("base_url") or "").rstrip("/")
    names = [tag for tag in tags if tag]
    names.extend(f"-{name}" for name in exclude if name)
    url = f"{base}/index.php?page=post&s=list"
    if names:
        url += "&tags=" + quote(" ".join(names))
    return url


def with_oldest_sort(url: str) -> str:
    """Add the oldest-first metatag when it is not already in the list URL."""
    if SORT_OLDEST in url:
        return url
    parsed = urlparse(url)
    query = parse_qs(parsed.query, keep_blank_values=True)
    current = (query.get("tags") or [""])[0]
    query["tags"] = [(current + " " + SORT_OLDEST).strip()]
    if "page" not in query:
        query["page"] = ["post"]
    if "s" not in query:
        query["s"] = ["list"]
    encoded = urlencode({key: values[0] if values else "" for key, values in query.items()})
    return urlunparse(parsed._replace(query=encoded))


def api_url(site: dict, **params: object) -> str:
    base = str(site.get("api_base") or "https://api.rule34.xxx/index.php?page=dapi").strip()
    query: dict[str, str] = {"json": "1"}
    for key, value in params.items():
        if value is None:
            continue
        query[key] = str(value)
    user_id = str(site.get("api_user_id") or "").strip()
    api_key = str(site.get("api_key") or "").strip()
    if user_id and api_key:
        query["user_id"] = user_id
        query["api_key"] = api_key
    joiner = "&" if "?" in base else "?"
    return base + joiner + urlencode(query)


def parse_post_list(data: object) -> list[dict] | None:
    """Post objects, or None when the body is not a post list (auth HTML, error text)."""
    if isinstance(data, str):
        return None
    if isinstance(data, list):
        posts = [item for item in data if isinstance(item, dict)]
        return posts
    if isinstance(data, dict):
        if data.get("file_url") or data.get("id"):
            return [data]
        for key in ("post", "posts"):
            inner = data.get(key)
            if isinstance(inner, list):
                return [item for item in inner if isinstance(item, dict)]
            if isinstance(inner, dict) and (inner.get("file_url") or inner.get("id")):
                return [inner]
    return None


def media_from_file_url(file_url: str) -> tuple[str, str]:
    """``(media_type, extension)`` from the original file URL. GIF stays gif."""
    path = urlparse(file_url).path.lower()
    for ext in _FILE_EXT:
        if path.endswith(ext):
            if ext == ".gif":
                return "gif", ext
            if ext in {".webm", ".mp4", ".mkv", ".mov"}:
                return "video", ext
            return "image", ext
    return "image", ".jpg"


def _posted_at(item: dict) -> datetime | None:
    raw = item.get("change")
    if isinstance(raw, (int, float)) or (isinstance(raw, str) and raw.isdigit()):
        try:
            return datetime.fromtimestamp(int(raw), timezone.utc).replace(tzinfo=None)
        except (OverflowError, OSError, ValueError):
            pass
    for key in ("created_at", "createdAt", "date"):
        text = item.get(key)
        if isinstance(text, str) and text.strip():
            from backend.scraper.post import _try_parse_datetime

            parsed = _try_parse_datetime(text)
            if parsed:
                return parsed
    return None


def _tag_names(value: object) -> list[str]:
    from backend.scraper.post import normalize_tag_name

    if isinstance(value, str):
        parts = value.split()
    elif isinstance(value, list):
        parts = [str(item) for item in value]
    else:
        return []
    names: list[str] = []
    seen: set[str] = set()
    for part in parts:
        name = normalize_tag_name(part)
        if name and name not in seen:
            seen.add(name)
            names.append(name)
    return names


def tag_pairs(names: list[str], types: dict[str, str]) -> list[tuple[str, str]]:
    """``(name, group_key)``. Unknown names are general."""
    return [(name, types.get(name) or "general") for name in names]


def fetch_json(url: str, *, referer: str) -> object:
    """JSON from the DAPI. A non-JSON body is returned as text so the caller can fall back."""
    errors: list[str] = []
    for label, fn in (
        ("curl_cffi", _get_curl_cffi),
        ("httpx", _get_httpx),
        ("curl", _get_curl),
        ("playwright_api", _get_playwright),
    ):
        try:
            return _decode(fn(url, referer))
        except Exception as exc:  # noqa: BLE001 — next transport
            errors.append(f"{label}: {exc}")
    raise RuntimeError("; ".join(errors) if errors else f"Failed to fetch {url}")


def _decode(raw: str) -> object:
    text = raw.strip()
    if not text:
        return ""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def _headers(url: str, referer: str) -> dict[str, str]:
    return {
        "User-Agent": _USER_AGENT,
        "Accept": "application/json,text/plain,*/*",
        "Referer": referer or url,
    }


def _get_curl_cffi(url: str, referer: str) -> str:
    from curl_cffi import requests as curl_requests

    response = curl_requests.get(
        url,
        headers=_headers(url, referer),
        impersonate="chrome",
        timeout=25,
        allow_redirects=True,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"HTTP {response.status_code}")
    return response.text


def _get_httpx(url: str, referer: str) -> str:
    import httpx

    with httpx.Client(timeout=20, follow_redirects=True, http2=False) as client:
        response = client.get(url, headers=_headers(url, referer))
        response.raise_for_status()
        return response.text


def _get_curl(url: str, referer: str) -> str:
    curl = shutil.which("curl") or shutil.which("curl.exe")
    if not curl:
        raise RuntimeError("curl executable not found")
    headers = _headers(url, referer)
    completed = subprocess.run(
        [
            curl,
            "-sS",
            "--fail-with-body",
            "--http1.1",
            "--max-time",
            "30",
            "-A",
            headers["User-Agent"],
            "-H",
            f"Referer: {headers['Referer']}",
            url,
        ],
        capture_output=True,
        text=True,
        timeout=35,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or completed.stdout or "curl failed").strip())
    return completed.stdout


def _get_playwright(url: str, referer: str) -> str:
    from backend.scraper.client import PlaywrightClient

    headers = _headers(url, referer)
    with PlaywrightClient(ignore_https_errors=True) as client:
        response = client._engine._api_context().request.get(url, headers=headers, timeout=60_000)  # type: ignore[union-attr]
        if not response.ok:
            raise RuntimeError(f"HTTP {response.status}")
        return response.text()


def _post_page(site: dict, post_id: str) -> str:
    extension = site.get("extension") or {}
    template = str(extension.get("post_url_template") or "")
    if "{id}" in template:
        return template.replace("{id}", post_id)
    base = str(site.get("base_url") or "").rstrip("/")
    return f"{base}/index.php?page=post&s=view&id={post_id}"


def _tag_query(tags: list[str], exclude: list[str], sort: str) -> str:
    parts = [tag for tag in tags if tag and not tag.startswith("-")]
    parts.extend(f"-{name}" for name in exclude if name)
    if sort == "date_asc":
        parts.append(SORT_OLDEST)
    return " ".join(parts)


def _tags_in_url(url: str) -> tuple[list[str], list[str]]:
    raw = (parse_qs(urlparse(url).query).get("tags") or [""])[0]
    include: list[str] = []
    exclude: list[str] = []
    for part in raw.split():
        if part == SORT_OLDEST or part.startswith("sort:"):
            continue
        if part.startswith("-") and len(part) > 1:
            exclude.append(part[1:])
        elif part:
            include.append(part)
    return include, exclude


def load_tag_groups(site: dict, names: list[str], *, referer: str) -> dict[str, str]:
    """Name → group key. Empty when the tag API does not answer."""
    found: dict[str, str] = {}
    try:
        for start in range(0, len(names), 40):
            chunk = names[start : start + 40]
            url = api_url(site, s="tag", q="index", names=" ".join(chunk), limit=100)
            data = fetch_json(url, referer=referer)
            rows: list = []
            if isinstance(data, list):
                rows = data
            elif isinstance(data, dict):
                inner = data.get("tag") or data.get("tags") or []
                if isinstance(inner, dict):
                    rows = [inner]
                elif isinstance(inner, list):
                    rows = inner
            for row in rows:
                if not isinstance(row, dict):
                    continue
                name = str(row.get("name") or "").strip().lower().replace(" ", "_")
                try:
                    type_id = int(row.get("type"))
                except (TypeError, ValueError):
                    continue
                group = GELBOORU_TAG_GROUPS.get(type_id)
                if name and group:
                    found[name] = group
    except Exception as exc:  # noqa: BLE001 — names still save as general
        logger.info("Gelbooru tag types unavailable: %s", exc)
        return {}
    return found


def api_post_record(site: dict, post_url: str, post_id: str) -> dict | None:
    """One post from the DAPI, or None when the body is not that post."""
    referer = post_url or _post_page(site, post_id)
    data = fetch_json(api_url(site, s="post", q="index", id=post_id, limit=1), referer=referer)
    posts = parse_post_list(data)
    if not posts:
        return None
    item = posts[0]
    file_url = item.get("file_url")
    if not isinstance(file_url, str) or not file_url.strip():
        return None
    file_url = file_url.strip()
    names = _tag_names(item.get("tags"))
    groups = load_tag_groups(site, names, referer=referer) if names else {}
    media_type, extension = media_from_file_url(file_url)
    return {
        "post_id": str(item.get("id") or post_id),
        "post_url": referer,
        "tags": tag_pairs(names, groups),
        "media_type": media_type,
        "media_url": file_url,
        "extension": extension,
        "posted_at": _posted_at(item),
    }


class _ApiPass:
    """Distinguish 'API returned a list' from 'API body was not a list'."""

    def __init__(self) -> None:
        self.saw_list = False

    def run(self, site, gallery_url, sort, should_stop):
        include, exclude = _tags_in_url(gallery_url)
        referer = gallery_url
        yielded = 0
        for page_index in range(_MAX_PAGES):
            if should_stop and should_stop():
                return
            url = api_url(
                site,
                s="post",
                q="index",
                limit=_PAGE_SIZE,
                pid=page_index,
                tags=_tag_query(include, exclude, sort),
            )
            try:
                data = fetch_json(url, referer=referer)
            except Exception as exc:  # noqa: BLE001
                logger.info("Gelbooru list API missed: %s", exc)
                if page_index == 0:
                    return
                return
            posts = parse_post_list(data)
            if posts is None:
                return
            self.saw_list = True
            if not posts:
                return
            for item in posts:
                pid = str(item.get("id") or "")
                if not pid.isdigit():
                    continue
                yielded += 1
                yield _post_page(site, pid)
                if yielded >= _SOFT_CAP or (should_stop and should_stop()):
                    return
            if len(posts) < _PAGE_SIZE:
                return


def iter_posts(client, site: dict, gallery_url: str, *, sort: str, should_stop):
    """DAPI pages first. HTML list when the first response is not a post list."""
    passed = _ApiPass()
    yield from passed.run(site, gallery_url, sort, should_stop)
    if passed.saw_list:
        return
    yield from iter_html_posts(client, site, gallery_url, sort=sort, should_stop=should_stop)


def is_gelbooru_content(html: str) -> bool:
    """List thumbs, the post image, or the tag sidebar — not the checkbox page."""
    lowered = html.lower()
    if 'id="image"' in lowered or "id='image'" in lowered:
        return True
    if "tag-sidebar" in lowered:
        return True
    if 'class="thumb"' in lowered or "class='thumb'" in lowered:
        return True
    return False


def is_checkbox_page(html: str) -> bool:
    """Short human-check page. A real list or post is never the checkbox."""
    if not html or is_gelbooru_content(html):
        return False
    soup = BeautifulSoup(html, "html.parser")
    box = soup.find("input", attrs={"type": lambda value: isinstance(value, str) and value.lower() == "checkbox"})
    if box is None:
        return False
    text = soup.get_text(" ", strip=True).lower()
    if any(word in text for word in ("captcha", "robot", "human", "verify")):
        return True
    return len(text) < 600 and len(soup.find_all("a")) < 5


def is_html_challenge(content: bytes) -> bool:
    """A download body that is an HTML page instead of the file."""
    head = content[:800].lstrip().lower()
    if not head.startswith(b"<"):
        return False
    sample = content[:6000].lower()
    if b"<html" not in sample and b"<!doctype" not in sample:
        return False
    return b"checkbox" in sample or b"captcha" in sample or b"robot" in sample or b"verify" in sample


def _click_checkbox(page) -> bool:
    try:
        locator = page.locator("input[type='checkbox']")
        if locator.count() > 0:
            locator.first.click(timeout=5000)
            return True
    except Exception:
        pass
    try:
        frames = list(page.frames)
    except Exception:
        frames = []
    for frame in frames:
        try:
            locator = frame.locator("input[type='checkbox']")
            if locator.count() > 0:
                locator.first.click(timeout=5000)
                return True
        except Exception:
            continue
    return False


def _cancelled() -> bool:
    from backend.scraper.pipeline import scrape_status

    return bool(scrape_status.cancel)


def wait_for_user_checkbox(page, target_url: str) -> None:
    """Show a visible browser until the checkbox page is gone, then copy its cookies back."""
    from playwright.sync_api import sync_playwright

    from backend.scraper.pipeline import scrape_status

    scrape_status.message = "Tick the checkbox in the browser window"
    scrape_status.current_url = target_url
    try:
        cookies = page.context.cookies()
    except Exception:
        cookies = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=False)
        try:
            context = browser.new_context()
            if cookies:
                context.add_cookies(cookies)
            visible = context.new_page()
            visible.goto(target_url, wait_until="domcontentloaded", timeout=45_000)
            while True:
                if _cancelled():
                    raise ScrapeCancelled()
                try:
                    html = visible.content()
                except Exception:
                    html = ""
                if html and not is_checkbox_page(html):
                    break
                visible.wait_for_timeout(500)
            fresh = context.cookies()
        finally:
            browser.close()
    if fresh:
        page.context.add_cookies(fresh)


def settle_checkbox(page, target_url: str) -> None:
    """Click the checkbox up to twice. If it stays, wait for the user in a visible window."""
    for _ in range(2):
        try:
            html = page.content()
        except Exception:
            return
        if not is_checkbox_page(html):
            return
        if not _click_checkbox(page):
            break
        try:
            page.wait_for_load_state("domcontentloaded", timeout=8_000)
        except Exception:
            try:
                page.wait_for_timeout(1500)
            except Exception:
                return
    try:
        html = page.content()
    except Exception:
        return
    if is_checkbox_page(html):
        wait_for_user_checkbox(page, target_url)
        from backend.scraper.post import goto_post

        goto_post(page, target_url, attempts=3)


def _abs(page_url: str, href: str) -> str:
    href = href.strip()
    if href.startswith("//"):
        return "https:" + href
    return urljoin(page_url, href)


def _kind_from_href(href: str) -> tuple[str, str] | None:
    path = urlparse(href).path.lower()
    if not any(path.endswith(ext) for ext in _FILE_EXT):
        return None
    return media_from_file_url(href)


def post_from_html(html: str, post_url: str, post_id: str) -> dict | None:
    """Original file and sidebar tags from a Gelbooru post page."""
    if is_checkbox_page(html):
        return None
    soup = BeautifulSoup(html, "html.parser")
    media_url = ""
    media_type = "image"
    extension = ".jpg"
    source = soup.select_one("video source[src]")
    if source and source.get("src"):
        media_url = _abs(post_url, str(source.get("src")))
        media_type, extension = media_from_file_url(media_url)
    if not media_url:
        for anchor in soup.find_all("a"):
            label = anchor.get_text(" ", strip=True).lower()
            href = str(anchor.get("href") or "")
            if "original image" in label and href:
                media_url = _abs(post_url, href)
                media_type, extension = media_from_file_url(media_url)
                break
    if not media_url:
        image = soup.select_one("#image")
        if image is not None:
            parent = image.find_parent("a")
            href = str(parent.get("href") or "") if parent is not None else ""
            src = str(image.get("src") or "")
            chosen = ""
            if href and _kind_from_href(_abs(post_url, href)):
                chosen = _abs(post_url, href)
            elif src:
                chosen = _abs(post_url, src)
            if chosen:
                media_url = chosen
                media_type, extension = media_from_file_url(media_url)
    if not media_url:
        return None
    from backend.scraper.post import normalize_tag_group_key, normalize_tag_name

    tags: list[tuple[str, str]] = []
    seen: set[str] = set()
    for item in soup.select("#tag-sidebar li, li[class*='tag-type-']"):
        classes = " ".join(item.get("class") or [])
        group = "general"
        for key, name in (
            ("tag-type-artist", "artist"),
            ("tag-type-character", "character"),
            ("tag-type-copyright", "copyright"),
            ("tag-type-metadata", "meta"),
            ("tag-type-meta", "meta"),
            ("tag-type-general", "general"),
        ):
            if key in classes:
                group = name
                break
        link = item.find("a")
        if link is None:
            continue
        # Skip the trailing ? search link; the tag name is the first anchor.
        name = normalize_tag_name(link.get_text(" ", strip=True))
        if not name or name in seen or name in {"?", "+"}:
            continue
        seen.add(name)
        tags.append((name, normalize_tag_group_key(group)))
    posted_at = None
    match = re.search(r"Posted:\s*(\d{4}-\d{2}-\d{2}[^<\n]{0,24})", html)
    if match:
        from backend.scraper.post import _try_parse_datetime

        posted_at = _try_parse_datetime(match.group(1))
    return {
        "post_id": post_id,
        "post_url": post_url,
        "tags": tags,
        "media_type": media_type,
        "media_url": media_url,
        "extension": extension,
        "posted_at": posted_at,
    }


def collect_post_urls(page, site: dict) -> list[str]:
    try:
        hrefs = page.eval_on_selector_all(
            "a[href*='id=']",
            "elements => elements.map(el => el.href)",
        )
    except Exception:
        hrefs = []
    seen: set[str] = set()
    result: list[str] = []
    for href in hrefs:
        text = str(href or "")
        if "s=view" not in text and "page=post" not in text:
            continue
        match = re.search(r"[?&]id=(\d+)", text)
        if not match:
            continue
        post_url = _post_page(site, match.group(1))
        if post_url in seen:
            continue
        seen.add(post_url)
        result.append(post_url)
    return result


def _click_next(page, site: dict, known: set[str]) -> bool:
    for selector in ("a[alt='next']", "a[alt='Next']", "a:has-text('Next')"):
        locator = page.locator(selector)
        try:
            if locator.count() == 0:
                continue
            locator.first.click(timeout=3000)
            page.wait_for_timeout(800)
            settle_checkbox(page, page.url or "")
            return any(url not in known for url in collect_post_urls(page, site))
        except Exception:
            continue
    return False


def iter_html_posts(client, site: dict, gallery_url: str, *, sort: str, should_stop):
    from backend.scraper.post import goto_post

    target = with_oldest_sort(gallery_url) if sort == "date_asc" else gallery_url
    page = client.shared_page()
    try:
        goto_post(page, target, attempts=6)
        settle_checkbox(page, target)
        known: set[str] = set()
        yielded = 0
        for _ in range(_MAX_PAGES):
            if should_stop and should_stop():
                return
            settle_checkbox(page, page.url or target)
            for post_url in collect_post_urls(page, site):
                if post_url in known:
                    continue
                known.add(post_url)
                yielded += 1
                yield post_url
                if yielded >= _SOFT_CAP or (should_stop and should_stop()):
                    return
            if not _click_next(page, site, set(known)):
                return
    finally:
        try:
            page.close()
        except Exception:
            pass


def fetch_bytes_after_checkbox(url: str) -> bytes:
    """Open the file URL in the shared context, clear the checkbox, then read the bytes."""
    client = _job_client
    if client is None:
        raise RuntimeError("Checkbox page and no scrape browser")
    page = client.shared_page()
    try:
        from backend.scraper.post import goto_post

        goto_post(page, url, attempts=3)
        settle_checkbox(page, url)
        response = page.context.request.get(url, timeout=60_000)
        body = response.body()
        if is_html_challenge(body):
            raise RuntimeError("Still on the checkbox page")
        return body
    finally:
        try:
            page.close()
        except Exception:
            pass


def record_to_post(record: dict):
    from backend.scraper.post import PostData, PostTag

    return PostData(
        post_id=str(record["post_id"]),
        post_url=str(record["post_url"]),
        tags=[PostTag(name=name, group_key=group) for name, group in record["tags"]],
        media_type=str(record["media_type"]),
        media_url=str(record["media_url"]),
        extension=str(record["extension"]),
        posted_at=record.get("posted_at"),
    )

