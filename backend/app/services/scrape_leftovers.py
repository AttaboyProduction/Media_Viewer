"""URLs that still need a download, stored under data/.

``queue`` is what the extension added and Run scrape has not finished.
``unfinished`` was skipped because of an error, Stop, or the app closing.
``open`` is the job's in-flight list so a crash can move it into unfinished.
"""

from __future__ import annotations

import json
import threading
from urllib.parse import urlparse

from backend.app.config import settings

# Tried, but not downloaded. Intentional skips (already in the library, tag
# filters, identical files) are not kept.
RETRY_REASONS = {"error", "cancelled", "unavailable", "interrupted"}

_lock = threading.Lock()


def leftovers_path():
    return settings.data_dir / "scrape_leftovers.json"


def identity(url: str) -> str:
    """Host and path only, so scheme, www, and query do not duplicate a page."""
    parsed = urlparse((url or "").strip())
    host = (parsed.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    path = (parsed.path or "/").rstrip("/") or "/"
    if not host:
        return ""
    return f"{host}{path.lower()}"


def _empty() -> dict:
    return {"unfinished": [], "queue": [], "open": []}


def _load() -> dict:
    path = leftovers_path()
    if not path.is_file():
        return _empty()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _empty()
    if not isinstance(data, dict):
        return _empty()
    unfinished = []
    for item in data.get("unfinished") or []:
        if not isinstance(item, dict):
            continue
        url = item.get("url")
        if not isinstance(url, str) or not url.strip():
            continue
        unfinished.append(
            {
                "url": url.strip(),
                "reason": str(item.get("reason") or "error"),
                "detail": str(item.get("detail") or ""),
            }
        )
    queue = [url.strip() for url in data.get("queue") or [] if isinstance(url, str) and url.strip()]
    open_urls = [url.strip() for url in data.get("open") or [] if isinstance(url, str) and url.strip()]
    return {"unfinished": unfinished, "queue": queue, "open": open_urls}


def _save(data: dict) -> None:
    path = leftovers_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, indent=2)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(path)


def _without(urls: list[str], url: str) -> list[str]:
    key = identity(url)
    if not key:
        return [item for item in urls if item != url]
    return [item for item in urls if identity(item) != key]


def unfinished_items() -> list[dict]:
    with _lock:
        return list(_load()["unfinished"])


def queue_urls() -> list[str]:
    with _lock:
        return list(_load()["queue"])


def add_queue(urls: list[str]) -> list[str]:
    """Append extension URLs. A URL added again leaves the unfinished list."""
    added: list[str] = []
    with _lock:
        data = _load()
        seen = {identity(url) for url in data["queue"]}
        for url in urls:
            key = identity(url)
            if not key or key in seen:
                continue
            seen.add(key)
            data["queue"].append(url)
            data["unfinished"] = [
                item for item in data["unfinished"] if identity(item["url"]) != key
            ]
            added.append(url)
        _save(data)
    return added


def remember_unfinished(url: str, reason: str, detail: str = "") -> None:
    key = identity(url)
    if not key:
        return
    with _lock:
        data = _load()
        data["queue"] = _without(data["queue"], url)
        data["open"] = _without(data["open"], url)
        kept = [item for item in data["unfinished"] if identity(item["url"]) != key]
        kept.append({"url": url, "reason": reason or "error", "detail": detail or ""})
        data["unfinished"] = kept
        _save(data)


def forget(url: str) -> None:
    """The page is done: downloaded, or skipped on purpose."""
    if not identity(url):
        return
    with _lock:
        data = _load()
        data["queue"] = _without(data["queue"], url)
        data["open"] = _without(data["open"], url)
        data["unfinished"] = [
            item for item in data["unfinished"] if identity(item["url"]) != identity(url)
        ]
        _save(data)


def note_outcome(url: str, *, downloaded: bool, reason: str = "", detail: str = "") -> None:
    if not url:
        return
    if downloaded or reason not in RETRY_REASONS:
        forget(url)
    else:
        remember_unfinished(url, reason, detail)


def sync_open(urls: list[str]) -> None:
    """Remember the files a running job has not finished yet."""
    cleaned: list[str] = []
    seen: set[str] = set()
    for url in urls:
        key = identity(url)
        if not key or key in seen:
            continue
        seen.add(key)
        cleaned.append(url)
    with _lock:
        data = _load()
        data["open"] = cleaned
        _save(data)


def adopt_open_as_unfinished() -> None:
    """A previous process died with files still open. Keep them for a retry."""
    with _lock:
        data = _load()
        if not data["open"]:
            return
        seen = {identity(item["url"]) for item in data["unfinished"]}
        for url in data["open"]:
            key = identity(url)
            if not key or key in seen:
                continue
            seen.add(key)
            data["queue"] = _without(data["queue"], url)
            data["unfinished"].append(
                {
                    "url": url,
                    "reason": "interrupted",
                    "detail": "App closed before this file finished",
                }
            )
        data["open"] = []
        _save(data)


def persist_interrupted() -> None:
    """Keep whatever a stopping process had not finished."""
    from backend.scraper.pipeline import scrape_lock, scrape_status

    with scrape_lock:
        urls: list[str] = []
        if scrape_status.current_url:
            urls.append(scrape_status.current_url)
        urls.extend(scrape_status.pending_urls)
        scrape_status.pending_urls = []
        scrape_status.current_url = None
    for url in urls:
        remember_unfinished(url, "interrupted", "App closed before this file finished")
    sync_open([])


def restore_into_status() -> None:
    """Show stored leftovers on the Scrape page after a restart."""
    from backend.scraper.pipeline import SkippedItem, scrape_status

    adopt_open_as_unfinished()
    items = unfinished_items()
    scrape_status.skipped_items = [
        SkippedItem(url=item["url"], reason=item["reason"], detail=item["detail"])
        for item in items
    ]
    scrape_status.skipped = len(items)
    scrape_status.cancelled_urls = [
        item["url"] for item in items if item["reason"] == "cancelled"
    ]
    scrape_status.queue_urls = queue_urls()
    if items or scrape_status.queue_urls:
        scrape_status.ran_this_session = True
