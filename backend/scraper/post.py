import html
import re
import time
from dataclasses import dataclass
from datetime import datetime

from bs4 import BeautifulSoup
from dateutil import parser as date_parser
from playwright.sync_api import Page

from backend.app.config import settings

_TRANSIENT_NAV_MARKERS = (
    "ssl",
    "wrong_version",
    "network error",
    "err_connection",
    "err_ssl",
    "timeout",
    "net::",
    "econnreset",
    "connection reset",
    "connection closed",
)


@dataclass
class PostTag:
    name: str
    group_key: str


@dataclass
class PostData:
    post_id: str
    post_url: str
    tags: list[PostTag]
    media_type: str
    media_url: str
    extension: str
    posted_at: datetime | None = None


def normalize_tag_name(name: str) -> str:
    # Sites sometimes emit entities like &#039;; store the real character.
    return html.unescape(name).strip().lower().replace(" ", "_")


def normalize_tag_group_key(key: str | None) -> str:
    """Normalize site/HTML group keys to TagGroup.key values."""
    if not key:
        return "unknown"
    normalized = key.strip().lower().replace(" ", "_").removeprefix("chip--tag-")
    aliases = {
        "creator": "artist",
        "artist": "artist",
        "character": "character",
        "copyright": "copyright",
        "meta": "meta",
        "general": "general",
        "system": "system",
        "ai": "ai",
        "ai_generated": "ai",
        "unknown": "unknown",
    }
    return aliases.get(normalized, normalized or "unknown")


def parse_tags_from_html(html: str) -> list[PostTag]:
    from backend.app.services.app_settings import get_untyped_tag_group_key

    soup = BeautifulSoup(html, "html.parser")
    chip_divs = soup.find_all(
        "div",
        class_=lambda x: x and "chip" in x and "chip--small" in x,
    )
    ignore_classes = {"chip", "chip--small"}
    tags: list[PostTag] = []
    untyped_key = get_untyped_tag_group_key()

    for div in chip_divs:
        link = div.find("a")
        if not link:
            continue
        tag_name = normalize_tag_name(link.text)
        all_classes = set(div.get("class", []))
        type_classes = all_classes - ignore_classes
        if not type_classes:
            group_key = untyped_key
        else:
            tag_type = list(type_classes)[0]
            group_key = normalize_tag_group_key(
                tag_type.removeprefix("chip--tag-").replace(" ", "_")
            )
            if group_key == "unknown":
                group_key = untyped_key
        tags.append(PostTag(name=tag_name, group_key=group_key))

    return tags


def expand_tags(page: Page) -> None:
    """Best-effort expand of collapsed tag chips. Never raises — HTML scrape can use visible chips."""
    expand_selector = "button.chip-part:has-text('Show more')"
    try:
        button = page.locator(expand_selector).first
        if button.count() == 0 or not button.is_visible(timeout=1500):
            return
        initial_count = page.locator(".chip").count()
        # no_wait_after: Show more must not block on a hung/in-flight navigation.
        button.click(timeout=5000, no_wait_after=True)
        try:
            page.wait_for_function(
                f"document.querySelectorAll('.chip').length > {initial_count}",
                timeout=3000,
            )
        except Exception:
            pass
    except Exception:
        pass


def _is_transient_nav_error(exc: BaseException) -> bool:
    message = f"{type(exc).__name__}: {exc}".lower()
    return any(marker in message for marker in _TRANSIENT_NAV_MARKERS)


def goto_post(page: Page, post_url: str, *, attempts: int = 3) -> None:
    """Navigate to a post page, retrying flaky TLS/network failures (VPN / Cloudflare)."""
    last_error: BaseException | None = None
    for attempt in range(attempts):
        try:
            page.goto(post_url, wait_until="domcontentloaded", timeout=45_000)
            return
        except Exception as exc:  # noqa: BLE001 — classify then retry or raise
            last_error = exc
            if not _is_transient_nav_error(exc) or attempt >= attempts - 1:
                raise
            time.sleep(min(1.2 * (attempt + 1), 4.0))
    if last_error:
        raise last_error


def media_type_from_api_post_type(api_type: int | None) -> str | None:
    """Map gallery API post ``type`` field to local media_type (0=image, 1=video)."""
    if api_type == 1:
        return "video"
    if api_type == 0:
        return "image"
    return None


def detect_media(
    soup: BeautifulSoup,
    post_id: str,
    *,
    api_type: int | None = None,
) -> tuple[str, str, str]:
    folder_id = int(post_id) // 1000

    api_kind = media_type_from_api_post_type(api_type)
    if api_kind == "video" or (api_kind is None and soup.find("video") is not None):
        extension = ".mov.mp4"
        media_type = "video"
    else:
        img = soup.find("img")
        src = (img.get("src") or "") if img else ""
        alt = (img.get("alt") or "").lower() if img else ""
        if ".gif" in src.lower() or "gif" in alt:
            extension = ".pic.jpg"
            media_type = "gif"
        else:
            extension = ".pic.jpg"
            media_type = "image"

    # Media files are served from the selected site CDN host, not always the origin.
    from backend.scraper.sites import get_selected_site

    site = get_selected_site()
    if not site:
        raise ValueError("No site selected; cannot build media CDN URL.")
    cdn = str(site.get("media_cdn_host") or "").rstrip("/")
    if not cdn:
        raise ValueError(f"Site {site.get('id')!r} has no media_cdn_host.")
    media_url = f"{cdn}/posts/{folder_id}/{post_id}/{post_id}{extension}"
    return media_type, media_url, extension


def _try_parse_datetime(value: str) -> datetime | None:
    text = value.strip()
    if not text:
        return None
    try:
        parsed = date_parser.parse(text, fuzzy=True)
        if parsed.tzinfo is not None:
            parsed = parsed.replace(tzinfo=None)
        return parsed
    except (ValueError, OverflowError, TypeError):
        return None


def extract_posted_at(html: str) -> datetime | None:
    soup = BeautifulSoup(html, "html.parser")
    time_el = soup.find("time")
    if time_el:
        raw = time_el.get("datetime") or time_el.get_text(" ", strip=True)
        parsed = _try_parse_datetime(str(raw))
        if parsed:
            return parsed

    patterns = [
        r'"createdAt"\s*:\s*"([^"]+)"',
        r'"created_at"\s*:\s*"([^"]+)"',
        r'"postedAt"\s*:\s*"([^"]+)"',
        r'"posted_at"\s*:\s*"([^"]+)"',
        r'"published_at"\s*:\s*"([^"]+)"',
        r'"date"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"',
    ]
    for pattern in patterns:
        match = re.search(pattern, html)
        if match:
            parsed = _try_parse_datetime(match.group(1))
            if parsed:
                return parsed
    return None


def _api_type_from_payload(payload: dict) -> int | None:
    raw_type = payload.get("type")
    if raw_type is None:
        return None
    try:
        return int(raw_type)
    except (TypeError, ValueError):
        return None


def _posted_at_from_payload(payload: dict) -> datetime | None:
    for key in ("createdAt", "created_at", "postedAt", "posted_at", "published_at", "date"):
        raw = payload.get(key)
        if isinstance(raw, str):
            parsed = _try_parse_datetime(raw)
            if parsed:
                return parsed
    return None


def scrape_post_from_api(post_url: str) -> PostData | None:
    """Build post data from the site JSON API + CDN URL (no browser).

    Preferred for direct ``/post/{id}`` seeds: avoids flaky page TLS and Show more clicks.
    """
    match = re.search(r"/post/(\d+)", post_url)
    if not match:
        return None
    post_id = match.group(1)

    from backend.app.services.app_settings import get_untyped_tag_group_key
    from backend.scraper.site_api import fetch_post_payload, tags_from_post_payload

    payload = fetch_post_payload(post_url)
    api_post_type = _api_type_from_payload(payload)
    tags = tags_from_post_payload(payload, untyped_key=get_untyped_tag_group_key())
    media_type, media_url, extension = detect_media(
        BeautifulSoup("", "html.parser"),
        post_id,
        api_type=api_post_type,
    )
    return PostData(
        post_id=post_id,
        post_url=post_url,
        tags=tags,
        media_type=media_type,
        media_url=media_url,
        extension=extension,
        posted_at=_posted_at_from_payload(payload),
    )


def scrape_tags_from_url(post_url: str) -> list[PostTag]:
    """Last-resort tag fetch via Playwright HTML chip scrape (no media download)."""
    from backend.scraper.client import PlaywrightClient

    with PlaywrightClient() as client:
        page = client.new_page()
        goto_post(page, post_url)
        if "Checking your browser" in page.content():
            raise RuntimeError("Blocked by Cloudflare")
        expand_tags(page)
        return parse_tags_from_html(page.content())


def scrape_post(page: Page, post_url: str) -> PostData | None:
    """Scrape one post via browser HTML; tags prefer JSON API, HTML chips as fallback."""
    goto_post(page, post_url)

    if "Checking your browser" in page.content():
        raise RuntimeError("Blocked by Cloudflare")

    match = re.search(r"/post/(\d+)", post_url)
    if not match:
        return None
    post_id = match.group(1)

    html = page.content()
    soup = BeautifulSoup(html, "html.parser")
    posted_at = extract_posted_at(html)

    # Prefer site JSON API for post type (image vs video) and tags.
    api_post_type: int | None = None
    tags: list[PostTag] = []
    try:
        from backend.scraper.site_api import fetch_post_payload, tags_from_post_payload
        from backend.app.services.app_settings import get_untyped_tag_group_key

        payload = fetch_post_payload(post_url)
        api_post_type = _api_type_from_payload(payload)
        tags = tags_from_post_payload(payload, untyped_key=get_untyped_tag_group_key())
        if not posted_at:
            posted_at = _posted_at_from_payload(payload)
    except Exception:
        tags = []

    media_type, media_url, extension = detect_media(soup, post_id, api_type=api_post_type)

    if not tags:
        # Visible chips first; Show more is best-effort and must not fail the download.
        tags = parse_tags_from_html(page.content())
        expand_tags(page)
        expanded = parse_tags_from_html(page.content())
        if len(expanded) > len(tags):
            tags = expanded

    return PostData(
        post_id=post_id,
        post_url=post_url,
        tags=tags,
        media_type=media_type,
        media_url=media_url,
        extension=extension,
        posted_at=posted_at,
    )
