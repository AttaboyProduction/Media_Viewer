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

# Tried, but not downloaded. Everything in ``PERSIST_UNFINISHED_REASONS`` is
# written to scrape_leftovers.json so Skipped survives Reload / restart.
RETRY_REASONS = {"error", "cancelled", "unavailable", "interrupted"}
PERSIST_UNFINISHED_REASONS = RETRY_REASONS | {
    "library_updated",
    "already_have",
    "identical",
    "duplicate_hash",
    "excluded_tag",
    "tag_mismatch",
    "media_type",
    "date_range",
}

_lock = threading.Lock()
# One process owns this file. Keep the last copy so a scrape does not re-read it
# on every queued URL.
_cache: dict | None = None
_cache_path: str | None = None
_cache_stamp: tuple | None = None


def leftovers_path():
    return settings.data_dir / "scrape_leftovers.json"


def identity(url: str) -> str:
    """Stable page key: post id when known, else host+path (scheme/www/query ignored)."""
    from backend.scraper.gallery import extract_post_id

    parsed = urlparse((url or "").strip())
    host = (parsed.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    if not host:
        return ""
    post_id = extract_post_id(url)
    if post_id:
        return f"{host}/post/{post_id}"
    path = (parsed.path or "/").rstrip("/") or "/"
    return f"{host}{path.lower()}"


def _empty() -> dict:
    return {"unfinished": [], "queue": [], "open": [], "page_urls": {}, "sources": {}}


def _copy(data: dict) -> dict:
    return {
        "unfinished": [dict(item) for item in data["unfinished"]],
        "queue": list(data["queue"]),
        "open": list(data["open"]),
        "page_urls": dict(data.get("page_urls") or {}),
        "sources": dict(data.get("sources") or {}),
    }


SOURCE_UNSUPPORTED = "unsupported"

# Rows that matched the library without a new download (for clear/retry grouping).
LIBRARY_MATCH_REASONS = frozenset(
    {"library_updated", "already_have", "identical", "duplicate_hash"}
)


def skip_reason_matches(item_reason: str, filter_reason: str | None) -> bool:
    """True when an unfinished/skip row belongs to the requested filter group."""
    if not filter_reason:
        return True
    reason = (item_reason or "").strip()
    if filter_reason == "library_updated":
        return reason == "library_updated"
    if filter_reason in LIBRARY_MATCH_REASONS:
        return reason == filter_reason
    return reason == filter_reason


def derive_source(url: str) -> str:
    """Site id when an installed adapter recognizes the URL, else ``unsupported``."""
    try:
        from backend.scraper.sites import extension_scrape_target

        hit = extension_scrape_target(url)
    except Exception:  # noqa: BLE001
        hit = None
    return hit[0] if hit else SOURCE_UNSUPPORTED


def _source_of(data: dict, url: str, stored: str = "") -> str:
    """Panel a URL belongs to: stored on enqueue / skip, else guessed from the URL."""
    return stored or data["sources"].get(identity(url), "") or derive_source(url)


def _stamp(path) -> tuple | None:
    if not path.is_file():
        return None
    stat = path.stat()
    return (stat.st_mtime_ns, stat.st_size)


def _load() -> dict:
    global _cache, _cache_path, _cache_stamp
    path = leftovers_path()
    key = str(path)
    stamp = _stamp(path)
    if _cache is not None and _cache_path == key and _cache_stamp == stamp:
        return _copy(_cache)
    if stamp is None:
        data = _empty()
    else:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raw = None
        data = _parse(raw)
    _cache = data
    _cache_path = key
    _cache_stamp = stamp
    return _copy(data)


def _parse(data: object) -> dict:
    if not isinstance(data, dict):
        return _empty()
    unfinished = []
    for item in data.get("unfinished") or []:
        if not isinstance(item, dict):
            continue
        url = item.get("url")
        if not isinstance(url, str) or not url.strip():
            continue
        row = {
            "url": url.strip(),
            "reason": str(item.get("reason") or "error"),
            "detail": str(item.get("detail") or ""),
            "source": str(item.get("source") or ""),
        }
        raw_id = item.get("existing_media_id")
        if isinstance(raw_id, int) and raw_id > 0:
            row["existing_media_id"] = raw_id
        elif isinstance(raw_id, str) and raw_id.isdigit() and int(raw_id) > 0:
            row["existing_media_id"] = int(raw_id)
        unfinished.append(row)
    queue = [url.strip() for url in data.get("queue") or [] if isinstance(url, str) and url.strip()]
    open_urls = [url.strip() for url in data.get("open") or [] if isinstance(url, str) and url.strip()]
    page_urls: dict[str, str] = {}
    raw_pages = data.get("page_urls") or {}
    if isinstance(raw_pages, dict):
        for key, value in raw_pages.items():
            if isinstance(key, str) and isinstance(value, str) and key.strip() and value.strip():
                page_urls[key.strip()] = value.strip()
    sources: dict[str, str] = {}
    raw_sources = data.get("sources") or {}
    if isinstance(raw_sources, dict):
        for key, value in raw_sources.items():
            if isinstance(key, str) and isinstance(value, str) and key.strip() and value.strip():
                sources[key.strip()] = value.strip()
    return {
        "unfinished": unfinished,
        "queue": queue,
        "open": open_urls,
        "page_urls": page_urls,
        "sources": sources,
    }


def _save(data: dict) -> None:
    global _cache, _cache_path, _cache_stamp
    path = leftovers_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, indent=2)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(path)
    _cache = _copy(data)
    _cache_path = str(path)
    _cache_stamp = _stamp(path)


def _without(urls: list[str], url: str) -> list[str]:
    key = identity(url)
    if not key:
        return [item for item in urls if item != url]
    return [item for item in urls if identity(item) != key]


def _resolved_unfinished(data: dict, source: str | None = None) -> list[dict]:
    """Unfinished rows with ``source`` filled in; ``source`` keeps one panel only."""
    out: list[dict] = []
    for item in data["unfinished"]:
        row = dict(item)
        row["source"] = _source_of(data, row["url"], row.get("source", ""))
        if source is None or row["source"] == source:
            out.append(row)
    return out


def _queue_for(data: dict, source: str | None = None) -> list[str]:
    if source is None:
        return list(data["queue"])
    return [url for url in data["queue"] if _source_of(data, url) == source]


def snapshot(source: str | None = None) -> tuple[list[dict], list[str]]:
    """Unfinished rows and the queue, from one read. ``source`` keeps one panel."""
    with _lock:
        data = _load()
        return _resolved_unfinished(data, source), _queue_for(data, source)


def unfinished_items(source: str | None = None) -> list[dict]:
    with _lock:
        return _resolved_unfinished(_load(), source)


def queue_urls(source: str | None = None) -> list[str]:
    with _lock:
        return _queue_for(_load(), source)


def queue_by_source() -> dict[str, list[str]]:
    """Queue to scrape split by panel. Sources with nothing queued are left out."""
    with _lock:
        data = _load()
        out: dict[str, list[str]] = {}
        for url in data["queue"]:
            out.setdefault(_source_of(data, url), []).append(url)
        return out


def add_queue(
    urls: list[str],
    page_urls: dict[str, str] | None = None,
    source: str = "",
) -> list[str]:
    """Append extension URLs to one source queue.

    A URL may only live in one place: if it is already in Queue to scrape (same or
    another source), unfinished/Skipped, or open, it is moved here (to the end of
    this source's queue). ``source`` is the panel (site id, ``unsupported``).
    """
    added: list[str] = []
    pages = page_urls or {}
    with _lock:
        data = _load()
        for url in urls:
            key = identity(url)
            if not key:
                continue
            # Drop from every leftovers list first — then append once under ``source``.
            data["queue"] = [item for item in data["queue"] if identity(item) != key]
            data["open"] = _without(data["open"], url)
            kept_source = data["sources"].get(key, "")
            for item in data["unfinished"]:
                if identity(item["url"]) == key and not kept_source:
                    kept_source = item.get("source", "")
            data["unfinished"] = [
                item for item in data["unfinished"] if identity(item["url"]) != key
            ]
            data["queue"].append(url)
            if source or kept_source:
                data["sources"][key] = source or kept_source
            page = (pages.get(url) or "").strip()
            if page:
                data["page_urls"][key] = page
            added.append(url)
        _save(data)
    if added:
        _drop_from_live_status(added)
    return added


def _drop_from_live_status(urls: list[str]) -> None:
    """Pull re-queued URLs out of in-memory pending / Skipped / Cancelled lists."""
    try:
        from backend.app.services import scrape_panels
        from backend.scraper.pipeline import scrape_lock, scrape_status
    except Exception:  # noqa: BLE001 — leftovers must work without a live job
        return
    with scrape_lock:
        for url in urls:
            scrape_panels.drop_url(scrape_status, url)


def page_url_for(file_url: str) -> str | None:
    key = identity(file_url)
    if not key:
        return None
    with _lock:
        value = _load()["page_urls"].get(key)
        return value if isinstance(value, str) and value.strip() else None


def remember_unfinished(
    url: str,
    reason: str,
    detail: str = "",
    source: str = "",
    *,
    existing_media_id: int | None = None,
) -> list[str]:
    """Keep a tried-but-not-downloaded URL. ``source`` is the fallback panel; the one
    stored when the URL was queued or first skipped wins."""
    key = identity(url)
    if not key:
        return queue_urls()
    with _lock:
        data = _load()
        stored = data["sources"].get(key, "")
        for item in data["unfinished"]:
            if identity(item["url"]) == key and not stored:
                stored = item.get("source", "")
        data["queue"] = _without(data["queue"], url)
        data["open"] = _without(data["open"], url)
        kept = [item for item in data["unfinished"] if identity(item["url"]) != key]
        row = {
            "url": url,
            "reason": reason or "error",
            "detail": detail or "",
            "source": stored or source,
        }
        if existing_media_id is not None and existing_media_id > 0:
            row["existing_media_id"] = int(existing_media_id)
        kept.append(row)
        data["unfinished"] = kept
        _save(data)
        return list(data["queue"])


def forget(url: str, *, keep_open: bool = False) -> list[str]:
    """The page is done: downloaded, or skipped on purpose.

    ``keep_open`` drops the queue row but leaves the in-flight list alone, so a
    second spelling of a file already downloading does not erase crash recovery.
    """
    key = identity(url)
    if not key:
        return queue_urls()
    with _lock:
        data = _load()
        data["queue"] = _without(data["queue"], url)
        if not keep_open:
            data["open"] = _without(data["open"], url)
        data["unfinished"] = [
            item for item in data["unfinished"] if identity(item["url"]) != key
        ]
        data["page_urls"].pop(key, None)
        data["sources"].pop(key, None)
        _save(data)
        return list(data["queue"])


def note_outcome(
    url: str,
    *,
    downloaded: bool,
    reason: str = "",
    detail: str = "",
    source: str = "",
    existing_media_id: int | None = None,
) -> list[str]:
    if downloaded or reason not in PERSIST_UNFINISHED_REASONS:
        return forget(url)
    return remember_unfinished(
        url,
        reason,
        detail,
        source,
        existing_media_id=existing_media_id,
    )


def sync_open(urls: list[str]) -> list[str]:
    """Remember the files a running job has not finished yet. Returns the queue."""
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
        return list(data["queue"])


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


def clear_queues(
    source: str | None = None,
    *,
    which: str | None = None,
    skip_reason: str | None = None,
) -> None:
    """Forget stored leftovers.

    ``which`` is ``queue``, ``skipped`` (unfinished except cancelled and error),
    ``errors`` (reason=error only), or ``cancelled``. Omitted clears all four.
    With ``which=skipped``, ``skip_reason`` clears only that reason group.
    ``source`` limits that to one panel. A full clear also drops the in-flight
    (open) list; a partial clear leaves it.
    """
    with _lock:
        if source is None and which is None:
            _save(_empty())
            return
        data = _load()
        gone_keys: set[str] = set()
        if which in (None, "queue"):
            for url in _queue_for(data, source):
                key = identity(url)
                if key:
                    gone_keys.add(key)
            data["queue"] = [url for url in data["queue"] if identity(url) not in gone_keys]
        reason_filter = (skip_reason or "").strip() or None
        if which in (None, "skipped", "cancelled", "errors"):
            kept: list[dict] = []
            for item in data["unfinished"]:
                src = _source_of(data, item["url"], item.get("source", ""))
                if source is not None and src != source:
                    kept.append(item)
                    continue
                reason = item.get("reason") or "error"
                drop = which is None or (
                    (which == "cancelled" and reason == "cancelled")
                    or (which == "errors" and reason == "error")
                    or (
                        which == "skipped"
                        and reason not in {"cancelled", "error"}
                        and (
                            reason_filter is None
                            or skip_reason_matches(reason, reason_filter)
                        )
                    )
                )
                if drop:
                    key = identity(item["url"])
                    if key:
                        gone_keys.add(key)
                else:
                    kept.append(item)
            data["unfinished"] = kept
        still = {identity(url) for url in data["queue"]}
        still.update(identity(item["url"]) for item in data["unfinished"])
        for key in gone_keys:
            if key in still:
                continue
            data["page_urls"].pop(key, None)
            data["sources"].pop(key, None)
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
    source = scrape_status.source_key
    for url in urls:
        remember_unfinished(
            url, "interrupted", "App closed before this file finished", source
        )
    sync_open([])


def restore_into_status() -> None:
    """Show stored leftovers on the Scrape page after a restart, one panel per source.

    Clears prior-session progress and Downloaded previously. Incomplete Queue /
    Skipped / Cancelled URLs set each panel's ``total`` with ``processed`` at 0
    so nothing looks finished until it completes again in this process.
    """
    from backend.app.services import scrape_panels
    from backend.scraper.pipeline import scrape_status

    adopt_open_as_unfinished()
    items = unfinished_items()
    scrape_panels.restore(scrape_status, items)
    queues = queue_by_source()
    scrape_status.queue_urls = queue_urls()
    scrape_panels.note_queued_totals(scrape_status, queues)
    if items or scrape_status.queue_urls:
        scrape_status.ran_this_session = True
