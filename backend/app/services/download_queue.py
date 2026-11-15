"""Persistent download queue for extension links.

Each source (the local extension today, other users later) keeps its own list
in the order links were added. The app merges those lists, drops URLs that are
the same page aside from scheme and query, then downloads what is left.
"""

from __future__ import annotations

import json
import threading
from urllib.parse import urlparse

from backend.app.config import settings

_lock = threading.Lock()
# Identities tried this process that did not finish. A new launch retries them.
_attempted: set[str] = set()


def queue_path():
    return settings.data_dir / "download_queue.json"


def queue_identity(url: str) -> str:
    """Host and path only: scheme, www, query, and fragment do not count."""
    parsed = urlparse((url or "").strip())
    host = (parsed.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    path = (parsed.path or "/").rstrip("/") or "/"
    if not host:
        return ""
    return f"{host}{path.lower()}"


def _empty() -> dict:
    return {"sources": {}, "source_order": []}


def _load() -> dict:
    path = queue_path()
    if not path.is_file():
        return _empty()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _empty()
    sources = data.get("sources") if isinstance(data, dict) else None
    order = data.get("source_order") if isinstance(data, dict) else None
    if not isinstance(sources, dict):
        sources = {}
    if not isinstance(order, list):
        order = list(sources)
    clean_sources = {
        str(name): [url for url in urls if isinstance(url, str)]
        for name, urls in sources.items()
        if isinstance(urls, list)
    }
    clean_order = [name for name in order if name in clean_sources]
    for name in clean_sources:
        if name not in clean_order:
            clean_order.append(name)
    return {"sources": clean_sources, "source_order": clean_order}


def _save(data: dict) -> None:
    path = queue_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def merged_urls() -> list[str]:
    """Every queued URL, first added first, with identical pages removed."""
    with _lock:
        return _merged(_load())


def _merged(data: dict) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for name in data["source_order"]:
        for url in data["sources"].get(name, []):
            key = queue_identity(url)
            if not key or key in seen:
                continue
            seen.add(key)
            out.append(url)
    return out


def add_urls(source: str, urls: list[str]) -> list[str]:
    """Append new URLs to one source. Returns the merged queue."""
    name = (source or "extension").strip() or "extension"
    with _lock:
        data = _load()
        bucket = data["sources"].setdefault(name, [])
        if name not in data["source_order"]:
            data["source_order"].append(name)
        seen = {queue_identity(url) for url in bucket}
        for url in urls:
            key = queue_identity(url)
            if not key or key in seen:
                continue
            seen.add(key)
            bucket.append(url)
            _attempted.discard(key)
        _save(data)
        merged = _merged(data)
    if not merged:
        _set_queue_active(False)
    return merged


def remove_url(url: str) -> None:
    """Drop one finished page from every source."""
    key = queue_identity(url)
    if not key:
        return
    empty = False
    with _lock:
        _attempted.discard(key)
        data = _load()
        for name, urls in list(data["sources"].items()):
            data["sources"][name] = [item for item in urls if queue_identity(item) != key]
            if not data["sources"][name]:
                del data["sources"][name]
                data["source_order"] = [item for item in data["source_order"] if item != name]
        _save(data)
        empty = not _merged(data)
    if empty:
        _set_queue_active(False)


def _set_queue_active(active: bool) -> None:
    from backend.scraper.pipeline import scrape_status

    scrape_status.queue_active = active


def note_attempted(url: str) -> None:
    key = queue_identity(url)
    if key:
        _attempted.add(key)


def pending_urls() -> list[str]:
    """Merged URLs that this process has not already tried and failed."""
    return [url for url in merged_urls() if queue_identity(url) not in _attempted]


def start_download_queue() -> bool:
    """Start the next same-site batch when the Scrape page is on and nothing is running."""
    from backend.app.services.app_settings import scrape_page_enabled
    from backend.scraper.pipeline import scrape_status

    if not scrape_page_enabled() or scrape_status.running:
        return False
    batch = _next_batch()
    if batch is None:
        scrape_status.queue_active = bool(merged_urls())
        return False
    site_id, urls = batch
    scrape_status.queue_active = True
    if not site_id:
        from backend.scraper.pipeline import begin_remote_download

        started = False
        for url in urls:
            mode = begin_remote_download(url)
            if mode == "duplicate":
                note_attempted(url)
                remove_url(url)
                continue
            started = mode in {"started", "appended"}
        if not started:
            return start_download_queue()
        return True
    from backend.app.api.scrape import start_scrape_run
    from backend.app.schemas import ScrapeFilterIn, ScrapeRunRequest
    from backend.scraper.sites import select_source_for_site

    start_scrape_run(
        ScrapeRunRequest(
            filters=[ScrapeFilterIn(type="url", value="\n".join(urls))],
            limit=0,
        ),
        before_start=lambda: select_source_for_site(site_id),
        continue_counts=True,
    )
    return True


def continue_download_queue() -> None:
    """After a queue batch finishes, start the next site. A Stop leaves the rest for later."""
    from backend.scraper.pipeline import scrape_status

    if scrape_status.cancel:
        scrape_status.queue_active = bool(merged_urls())
        return
    started = start_download_queue()
    if not started:
        scrape_status.queue_active = bool(merged_urls())


def _next_batch() -> tuple[str, list[str]] | None:
    from backend.scraper.sites import extension_scrape_target

    site_id: str | None = None
    batch: list[str] = []
    raw: list[str] = []
    for url in pending_urls():
        hit = extension_scrape_target(url)
        if hit is None:
            if site_id is not None:
                break
            if url not in raw:
                raw.append(url)
            continue
        if raw:
            break
        found_site, scrape_url = hit
        if site_id is None:
            site_id = found_site
        if found_site != site_id:
            break
        if scrape_url not in batch:
            batch.append(scrape_url)
    if raw and site_id is None:
        return "", raw
    if site_id is None or not batch:
        return None
    return site_id, batch
