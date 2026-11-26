from __future__ import annotations

import argparse
import threading
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from pathlib import Path

from backend.app.config import settings
from backend.app.db.models import MediaItem
from backend.app.db.seed import seed_database
from backend.app.db.session import SessionLocal
from backend.app.schemas import ScrapeRunRequest
from backend.scraper.client import PlaywrightClient
from backend.scraper.gallery import extract_post_id
from backend.scraper.job import ScrapeJob, compile_scrape_job, date_in_range, should_stop_for_date
from backend.scraper.post import normalize_tag_name, scrape_post, scrape_post_from_api
from backend.scraper.storage import (
    classify_stored_against_library,
    download_media,
    save_remote_file,
    upsert_post,
    video_can_improve,
    video_suffix_rank,
)


@dataclass
class SkippedItem:
    url: str
    reason: str
    detail: str = ""
    existing_media_id: int | None = None


@dataclass
class ScrapeStatus:
    running: bool = False
    cancel: bool = False
    total: int = 0
    processed: int = 0
    downloaded: int = 0
    skipped: int = 0
    similar: int = 0
    errors: list[str] = field(default_factory=list)
    last_gallery_url: str | None = None
    message: str = ""
    current_url: str | None = None
    skipped_items: list[SkippedItem] = field(default_factory=list)
    # Failed downloads (separate from intentional Skipped).
    error_items: list[SkippedItem] = field(default_factory=list)
    # Process-lifetime session list — not cleared by _reset_status between jobs.
    recent_media_ids: list[int] = field(default_factory=list)
    # URLs left behind by Stop this process. Kept for the progress line.
    cancelled_urls: list[str] = field(default_factory=list)
    # True after the first scrape job starts in this process.
    ran_this_session: bool = False
    # Extension URLs join the running scrape through this queue.
    job_id: int = 0
    kind: str = ""  # "scrape" | "enqueue" | "import" | "download" | ""
    site_id: str | None = None
    # Panel the live counters / lists belong to (see services/scrape_panels.py).
    source_key: str = ""
    source_label: str = ""
    queue_open: bool = False
    pending_urls: list[str] = field(default_factory=list)
    accepted_urls: set[str] = field(default_factory=set)
    # One-shot: the next _reset_status keeps processed / downloaded / skipped.
    continue_counts: bool = False
    # Extension links waiting for Run scrape. Mirrors the stored queue.
    queue_urls: list[str] = field(default_factory=list)
    # Unfinished URLs this run is retrying. Already-counted ones do not grow total.
    retry_urls: set[str] = field(default_factory=set)
    # URLs already in this job's total. Retries do not grow total.
    counted_urls: set[str] = field(default_factory=set)
    # Intentional skips already settled. A re-queue clears this.
    released_urls: set[str] = field(default_factory=set)
    # URLs already included in processed. A retried skip or error leaves this set.
    processed_urls: set[str] = field(default_factory=set)
    # URLs that finished with a real media download.
    finished_urls: set[str] = field(default_factory=set)
    # Retries and queue URLs still run after the gallery download limit is met.
    leftover_urls: set[str] = field(default_factory=set)
    # Linked local rows whose files vanished under a Sync folders root.
    # ``[{id, path}, ...]`` until the UI acks or deletes them.
    missing_linked: list[dict] = field(default_factory=list)


scrape_status = ScrapeStatus()
# Shared with the scrape API so a new job and an extension append can't overlap.
# RLock: status updates nest (skip → record) and Stop already holds this lock.
scrape_lock = threading.RLock()
# URLs popped into a download worker. Stop and crash recovery treat them as still open.
_inflight_urls: set[str] = set()
_posts_lock = threading.Lock()
# Workers set this False so the browser fallback stays on the thread that owns Playwright.
_browser_ok = threading.local()


def _reset_status(gallery_url: str) -> None:
    scrape_status.running = True
    # Leave cancel alone. The starter clears it, and a Stop click that lands
    # before this runs must still stop the job.
    # total / pending_urls belong to the queue opened by begin_scrape_queue.
    keep = scrape_status.continue_counts
    scrape_status.continue_counts = False
    if not keep:
        scrape_status.processed = 0
        scrape_status.downloaded = 0
        scrape_status.skipped = 0
        scrape_status.similar = 0
        scrape_status.errors = []
        scrape_status.skipped_items = []
        scrape_status.error_items = []
        scrape_status.counted_urls = set()
        scrape_status.released_urls = set()
        scrape_status.processed_urls = set()
        scrape_status.finished_urls = set()
        scrape_status.retry_urls = set()
    scrape_status.last_gallery_url = gallery_url
    scrape_status.message = "Starting..."
    scrape_status.current_url = None
    scrape_status.ran_this_session = True
    # recent_media_ids intentionally retained across scrapes in this process


def begin_scrape_queue(
    job: ScrapeJob,
    site_id: str | None,
    *,
    continue_counts: bool = False,
    retry_urls: set[str] | None = None,
) -> None:
    """Open the running scrape's URL queue. Caller holds ``scrape_lock``.

    ``continue_counts`` keeps the counters from the file that just finished, so
    the next extension file grows 1/1 into 1/2 instead of starting over.
    URLs in ``retry_urls`` that this session already counted do not grow ``total``.
    """
    post_seeds = [url for url in job.seed_urls if extract_post_id(url)]
    retries = set(retry_urls or [])
    scrape_status.retry_urls.update(retries)
    scrape_status.kind = "scrape"
    scrape_status.site_id = site_id
    scrape_status.queue_open = True
    if continue_counts and scrape_status.ran_this_session:
        # After a reload, total is only the leftover queue (processed is 0).
        # Those URLs are added again below, so drop that placeholder first.
        # A run that already downloaded keeps its total and grows from there.
        if (
            scrape_status.processed == 0
            and not scrape_status.finished_urls
            and not scrape_status.counted_urls
        ):
            scrape_status.total = 0
        added = 0
        for url in post_seeds:
            if url in retries:
                _reopen_skipped_or_error(url)
            # accepted_urls remembers this session, including files that failed
            # or were cancelled. Only a URL still waiting in this queue is a duplicate.
            if url in scrape_status.pending_urls:
                continue
            scrape_status.accepted_urls.add(url)
            scrape_status.pending_urls.append(url)
            if url in retries and url in scrape_status.counted_urls:
                continue
            added += 1
            _hold_download_slot(url)
        scrape_status.total = max(scrape_status.total, scrape_status.processed) + added
        scrape_status.continue_counts = True
        _sync_open_urls()
        return
    scrape_status.accepted_urls = set(post_seeds)
    scrape_status.pending_urls = list(post_seeds)
    scrape_status.total = len(post_seeds)
    scrape_status.continue_counts = False
    _sync_open_urls()


def _library_post_ids(db) -> dict[str, object]:
    return {
        row.source_post_id: row.source_posted_at
        for row in db.query(MediaItem.source_post_id, MediaItem.source_posted_at).all()
        if row.source_post_id
    }


def _record_enqueue_skip(
    url: str,
    reason: str,
    *,
    existing_media_id: int | None = None,
) -> None:
    """Find URLs: intentional skips go to Skipped, not Queue to scrape."""
    with scrape_lock:
        if url in scrape_status.accepted_urls:
            return
        scrape_status.accepted_urls.add(url)
        for item in scrape_status.skipped_items:
            if item.url == url and item.reason == reason:
                return
        _record_skip_locked(url, reason, "", existing_media_id=existing_media_id)


def _record_enqueue_already_have(url: str, post_id: str, db) -> None:
    row = db.query(MediaItem).filter(MediaItem.source_post_id == post_id).first()
    existing_id = int(row.id) if row is not None else None
    _record_enqueue_skip(url, "already_have", existing_media_id=existing_id)


def _enqueue_probe_duplicate(
    db,
    client: PlaywrightClient,
    job: ScrapeJob,
    post_url: str,
) -> tuple[str, int | None] | None:
    """Download once and classify; return ``(skip_reason, media_id)`` or None to queue."""
    if _cancelled():
        return None
    post_id = extract_post_id(post_url)
    post = None
    if post_id:
        try:
            post = scrape_post_from_api(post_url)
        except Exception:  # noqa: BLE001
            post = None
    if post is None:
        if not _browser_allowed():
            return None
        try:
            from backend.scraper.gelbooru import is_gelbooru_site

            page = client.shared_page() if is_gelbooru_site() else client.new_page()
            try:
                post = scrape_post(page, post_url)
            finally:
                if page is not None and not is_gelbooru_site():
                    page.close()
        except Exception:  # noqa: BLE001
            return None
    if post is None:
        return None

    tag_names = {tag.name for tag in post.tags}
    if _excluded(tag_names, job.exclude_tags):
        return None
    if job.tags and not _post_matches_tags(tag_names, job.tags, job.tag_mode):
        return None
    if job.media_type and post.media_type != job.media_type:
        return None
    if not date_in_range(post.posted_at, job):
        return None

    try:
        stored = download_media(post)
    except Exception:  # noqa: BLE001
        return None
    try:
        outcome = classify_stored_against_library(db, post, stored)
        if outcome is None or not outcome.skipped_reason:
            if stored.path.exists():
                stored.path.unlink(missing_ok=True)
            db.rollback()
            return None
        media_id = int(outcome.media.id) if outcome.media is not None else None
        db.commit()
        return outcome.skipped_reason, media_id
    except Exception:  # noqa: BLE001
        db.rollback()
        if stored.path.exists():
            stored.path.unlink(missing_ok=True)
        return None


def begin_enqueue_queue(job: ScrapeJob, site_id: str | None) -> None:
    """Open a listing-only job: finds go to Queue to scrape or Skipped after file checks."""

    post_seeds = [url for url in job.seed_urls if extract_post_id(url)]
    scrape_status.kind = "enqueue"
    scrape_status.site_id = site_id
    scrape_status.queue_open = True
    scrape_status.accepted_urls = set()
    scrape_status.pending_urls = []
    scrape_status.continue_counts = False
    scrape_status.processed = 0
    scrape_status.downloaded = 0
    scrape_status.skipped = 0
    scrape_status.similar = 0
    scrape_status.errors = []
    scrape_status.skipped_items = []
    scrape_status.error_items = []
    scrape_status.counted_urls = set()
    scrape_status.released_urls = set()
    scrape_status.processed_urls = set()
    scrape_status.finished_urls = set()
    scrape_status.retry_urls = set()
    scrape_status.total = 0
    db = SessionLocal()
    try:
        seed_database(db)
        existing_posts = _library_post_ids(db)
        for url in post_seeds:
            post_id = extract_post_id(url)
            if post_id and post_id in existing_posts:
                _record_enqueue_already_have(url, post_id, db)
    finally:
        db.close()
    _refresh_persisted_queue_urls()


def append_leftover_urls(urls: list[str], retry_urls: set[str]) -> None:
    """Add stored leftovers to the open job. Caller holds ``scrape_lock``.

    Retries already counted in this session do not increase ``total``.
    Queue URLs do. Leftovers are taken before the gallery quota can stop them.
    """
    scrape_status.retry_urls.update(retry_urls)
    front: list[str] = []
    back: list[str] = []
    added = 0
    for url in urls:
        if url in retry_urls:
            _reopen_skipped_or_error(url)
        if not url or url in scrape_status.pending_urls or url in front or url in back:
            continue
        scrape_status.accepted_urls.add(url)
        scrape_status.leftover_urls.add(url)
        if url in retry_urls:
            front.append(url)
        else:
            back.append(url)
        if url in retry_urls and url in scrape_status.counted_urls:
            continue
        added += 1
        _hold_download_slot(url)
    scrape_status.pending_urls = front + scrape_status.pending_urls + back
    scrape_status.total += added
    _sync_open_urls()


def append_scrape_urls(urls: list[str], site_id: str) -> list[str] | None:
    """Add post URLs to the running scrape. ``None`` when this job can't take them.

    Newly added URLs increase ``total``, which is the scrape queue the UI shows.
    """
    with scrape_lock:
        if (
            not scrape_status.running
            or scrape_status.kind != "scrape"
            or not scrape_status.queue_open
            or scrape_status.site_id != site_id
        ):
            return None
        from backend.app.services.scrape_leftovers import identity

        added: list[str] = []
        known = {identity(url) for url in scrape_status.accepted_urls}
        known.update(identity(url) for url in scrape_status.pending_urls)
        for url in urls:
            key = identity(url)
            if not key or key in known:
                continue
            known.add(key)
            scrape_status.accepted_urls.add(url)
            scrape_status.pending_urls.append(url)
            added.append(url)
            _hold_download_slot(url)
        scrape_status.total += len(added)
        _sync_open_urls()
        return added


def enqueue_discovered_urls(
    urls: list[str],
    *,
    site_id: str | None,
    existing_posts: dict[str, object] | None = None,
    db=None,
    client: PlaywrightClient | None = None,
    job: ScrapeJob | None = None,
) -> list[str]:
    """Persist gallery finds into Queue to scrape before this job drains them."""
    from backend.app.services.scrape_leftovers import add_queue, identity

    with scrape_lock:
        known = {identity(url) for url in scrape_status.accepted_urls}
        known.update(identity(url) for url in scrape_status.pending_urls)
        enqueue_only = scrape_status.running and scrape_status.kind == "enqueue"
    fresh: list[str] = []
    for url in urls:
        key = identity(url)
        if not key or key in known:
            continue
        if enqueue_only and db is not None:
            post_id = extract_post_id(url)
            if existing_posts and post_id and post_id in existing_posts:
                known.add(key)
                _record_enqueue_already_have(url, post_id, db)
                continue
            if client is not None and job is not None:
                scrape_status.message = f"Checking {url}"
                scrape_status.current_url = url
                hit = _enqueue_probe_duplicate(db, client, job, url)
                if hit is not None:
                    known.add(key)
                    reason, media_id = hit
                    _record_enqueue_skip(url, reason, existing_media_id=media_id)
                    continue
        known.add(key)
        fresh.append(url)
    stored = add_queue(fresh, source=scrape_status.source_key or site_id or "")
    if not stored:
        return []
    if site_id and scrape_status.kind == "scrape":
        added = append_scrape_urls(stored, site_id)
        if added is not None:
            return added

    with scrape_lock:
        if not (
            scrape_status.running
            and scrape_status.queue_open
            and (site_id is None or scrape_status.site_id == site_id)
        ):
            return []
        if scrape_status.kind == "enqueue":
            added = []
            known = {identity(url) for url in scrape_status.accepted_urls}
            for url in stored:
                key = identity(url)
                if not key or key in known:
                    continue
                known.add(key)
                scrape_status.accepted_urls.add(url)
                scrape_status.total += 1
                added.append(url)
            _refresh_persisted_queue_urls()
            return added
        if scrape_status.kind != "scrape":
            return []
        added = []
        known = {identity(url) for url in scrape_status.accepted_urls}
        known.update(identity(url) for url in scrape_status.pending_urls)
        for url in stored:
            key = identity(url)
            if not key or key in known:
                continue
            known.add(key)
            scrape_status.accepted_urls.add(url)
            scrape_status.pending_urls.append(url)
            scrape_status.total += 1
            _hold_download_slot(url)
            added.append(url)
        _sync_open_urls()
        return added


def _download_concurrency() -> int:
    """How many media files download at once. Settings → Other → Scrape, clamped to 1–6."""
    from backend.app.services.app_settings import get_scrape_concurrency

    return get_scrape_concurrency()


def _browser_allowed() -> bool:
    return getattr(_browser_ok, "ok", True)


def _note_inflight(url: str, active: bool) -> None:
    if not url:
        return
    with scrape_lock:
        if active:
            _inflight_urls.add(url)
        else:
            _inflight_urls.discard(url)


def _listing_saturated(job: ScrapeJob) -> bool:
    """Gallery paging stops when the successful-download quota is met (Scrape limit).

    Skips do not count; queued-but-not-yet-downloaded files do not stop listing.
    """
    return _quota_met(job)


def _pop_pending() -> str | None:
    with scrape_lock:
        if scrape_status.pending_urls:
            url = scrape_status.pending_urls.pop(0)
            _inflight_urls.add(url)
            _sync_open_urls(extra=[url])
            return url
        return None


def _release_queue(job_id: int) -> None:
    with scrape_lock:
        if scrape_status.job_id != job_id:
            return
        scrape_status.running = False
        scrape_status.queue_open = False
        scrape_status.kind = ""
        # Pending URLs that never settled must leave ``total``, or Done shows
        # processed/total with empty queues (e.g. 10/23 after Stop + restart).
        left = list(scrape_status.pending_urls)
        scrape_status.pending_urls = []
        for url in left:
            if not url or url in scrape_status.processed_urls:
                continue
            scrape_status.total = max(scrape_status.processed, scrape_status.total - 1)
            scrape_status.accepted_urls.discard(url)
        if scrape_status.total < scrape_status.processed:
            scrape_status.total = scrape_status.processed
        _sync_open_urls()


def _cancelled() -> bool:
    return scrape_status.cancel


def _record_cancelled(url: str) -> None:
    """Mark one queued URL as cancelled. It counts toward processed once."""
    _count_settled(url)
    _record_skip(url, "cancelled")
    if url not in scrape_status.cancelled_urls:
        scrape_status.cancelled_urls.append(url)
    if url:
        scrape_status.finished_urls.discard(url)


def _skip_cancelled_remainder() -> None:
    """Move every file still queued onto Cancelled. Each one counts as settled."""
    with scrape_lock:
        left = list(scrape_status.pending_urls)
        scrape_status.pending_urls = []
    for url in left:
        _record_cancelled(url)


def abandon_running_job() -> None:
    """Stop now. Do not wait for the in-flight fetch to return.

    The worker thread may still be blocked on the network. Bumping ``job_id``
    detaches it so a late response cannot write into this job or the next one.
    Files still queued, including the one in flight, go to Cancelled and count
    as settled. Files that were never queued stay out of ``processed``.
    """
    with scrape_lock:
        scrape_status.cancel = True
        if scrape_status.running:
            scrape_status.job_id += 1
            left = list(scrape_status.pending_urls)
            for url in _inflight_urls:
                if url not in left:
                    left.append(url)
            if scrape_status.current_url and scrape_status.current_url not in left:
                left.insert(0, scrape_status.current_url)
            scrape_status.pending_urls = []
            _inflight_urls.clear()
            scrape_status.current_url = None
            for url in left:
                _record_cancelled(url)
            scrape_status.message = "Cancelled"
            scrape_status.current_url = None
            scrape_status.running = False
            scrape_status.queue_open = False
            scrape_status.kind = ""
        if scrape_status.errors or scrape_status.error_items or scrape_status.processed < scrape_status.total:
            _settle_errors_into_error_items()
            scrape_status.message = "Cancelled"
            scrape_status.current_url = None


def _refresh_persisted_queue_urls() -> None:
    from backend.app.services.scrape_leftovers import queue_urls

    scrape_status.queue_urls = queue_urls()


def _sync_open_urls(extra: list[str] | None = None) -> None:
    """Write the files this job has not finished, so a crash can retry them."""
    from backend.app.services.scrape_leftovers import sync_open

    urls = list(scrape_status.pending_urls)
    for url in _inflight_urls:
        if url not in urls:
            urls.append(url)
    if scrape_status.current_url and scrape_status.current_url not in urls:
        urls.append(scrape_status.current_url)
    urls.extend(extra or [])
    scrape_status.queue_urls = sync_open(urls)


def _is_retry(url: str) -> bool:
    """True when this session already counted the URL and this run is retrying it."""
    return bool(url) and url in scrape_status.retry_urls and url in scrape_status.counted_urls


def _hold_download_slot(url: str) -> None:
    """This URL is queued to download, so a later settle can count it again."""
    if url:
        scrape_status.released_urls.discard(url)


def _release_download_slot(url: str) -> None:
    """Mark an intentional skip (already have, filter, identical).

    It stays in ``total``. ``processed`` counts it once via ``_count_settled``.
    """
    if not url or url in scrape_status.finished_urls or url in scrape_status.released_urls:
        return
    scrape_status.released_urls.add(url)
    scrape_status.counted_urls.add(url)


def _count_settled(url: str) -> None:
    """Count one settled file toward processed, once per URL.

    Downloads, skips, errors, and cancels all count. A URL already settled
    (an earlier error, then a download) is not counted again.
    """
    if not url or url in scrape_status.processed_urls:
        return
    scrape_status.processed_urls.add(url)
    scrape_status.counted_urls.add(url)
    if scrape_status.processed + 1 > scrape_status.total:
        scrape_status.total = scrape_status.processed + 1
    scrape_status.processed += 1


def _reopen_skipped_or_error(url: str) -> None:
    """A new run is retrying this skip or error. Take it back out of processed."""
    if not url or url not in scrape_status.processed_urls or url in scrape_status.finished_urls:
        return
    row = next((item for item in scrape_status.skipped_items if item.url == url), None)
    err_row = next((item for item in scrape_status.error_items if item.url == url), None)
    prefix = f"{url}:"
    in_errors = err_row is not None or any(
        item == url or item.startswith(prefix) for item in scrape_status.errors
    )
    if row is not None and row.reason == "cancelled" and not in_errors:
        return
    if row is None and not in_errors:
        return
    scrape_status.processed_urls.discard(url)
    scrape_status.processed = max(0, scrape_status.processed - 1)


def _attempt(url: str) -> None:
    """Record a real download. processed includes it once, even after an error."""
    if url and url in scrape_status.finished_urls:
        return
    if url:
        scrape_status.finished_urls.add(url)
        scrape_status.counted_urls.add(url)
        scrape_status.released_urls.discard(url)
    _count_settled(url)


def _drop_skipped(url: str) -> None:
    if not url:
        return
    before = len(scrape_status.skipped_items)
    scrape_status.skipped_items = [row for row in scrape_status.skipped_items if row.url != url]
    removed = before - len(scrape_status.skipped_items)
    if removed:
        scrape_status.skipped = max(0, scrape_status.skipped - removed)
    scrape_status.cancelled_urls = [item for item in scrape_status.cancelled_urls if item != url]


def _drop_errors(url: str) -> None:
    """Drop this file from the Errors queue and the error string list."""
    if not url:
        return
    prefix = f"{url}:"
    scrape_status.errors = [
        item for item in scrape_status.errors if item != url and not item.startswith(prefix)
    ]
    scrape_status.error_items = [row for row in scrape_status.error_items if row.url != url]


def _persist_outcome(
    url: str,
    *,
    downloaded: bool,
    reason: str = "",
    detail: str = "",
    existing_media_id: int | None = None,
) -> None:
    from backend.app.services.scrape_leftovers import note_outcome, queue_urls

    if url:
        scrape_status.queue_urls = note_outcome(
            url,
            downloaded=downloaded,
            reason=reason,
            detail=detail,
            source=scrape_status.source_key,
            existing_media_id=existing_media_id,
        )
    else:
        scrape_status.queue_urls = queue_urls()


def _complete_download(url: str) -> None:
    with scrape_lock:
        _complete_download_locked(url)


def _complete_download_locked(url: str) -> None:
    if _is_retry(url):
        scrape_status.retry_urls.discard(url)
    _attempt(url)
    _drop_skipped(url)
    _drop_errors(url)
    scrape_status.downloaded += 1
    _persist_outcome(url, downloaded=True)


def _complete_skip(
    url: str,
    reason: str,
    detail: str = "",
    *,
    existing_media_id: int | None = None,
) -> None:
    with scrape_lock:
        _complete_skip_locked(url, reason, detail, existing_media_id=existing_media_id)


def _complete_skip_locked(
    url: str,
    reason: str,
    detail: str = "",
    *,
    existing_media_id: int | None = None,
) -> None:
    from backend.app.services.scrape_leftovers import RETRY_REASONS

    if reason == "error":
        _complete_error_locked(url, detail)
        return
    if _is_retry(url) and reason not in RETRY_REASONS:
        _drop_skipped(url)
        _drop_errors(url)
        scrape_status.retry_urls.discard(url)
        # The old error is gone. This outcome stays in total and counts once.
        _count_settled(url)
        _release_download_slot(url)
        _persist_outcome(
            url,
            downloaded=False,
            reason=reason,
            detail=detail,
            existing_media_id=existing_media_id,
        )
        return
    if reason not in RETRY_REASONS:
        # Already-have, filters, identical stay in total.
        _release_download_slot(url)
    elif url:
        scrape_status.counted_urls.add(url)
    _count_settled(url)
    _record_skip(url, reason, detail, existing_media_id=existing_media_id)


def _record_skip(
    url: str,
    reason: str,
    detail: str = "",
    *,
    existing_media_id: int | None = None,
) -> None:
    with scrape_lock:
        _record_skip_locked(url, reason, detail, existing_media_id=existing_media_id)


def _record_skip_locked(
    url: str,
    reason: str,
    detail: str = "",
    *,
    existing_media_id: int | None = None,
) -> None:
    if reason == "error":
        _record_error_locked(url, detail)
        return
    if url:
        for row in scrape_status.skipped_items:
            if row.url == url:
                row.reason = reason
                row.detail = detail
                if existing_media_id is not None:
                    row.existing_media_id = existing_media_id
                _persist_outcome(
                    url,
                    downloaded=False,
                    reason=reason,
                    detail=detail,
                    existing_media_id=existing_media_id,
                )
                return
    scrape_status.skipped += 1
    scrape_status.skipped_items.append(
        SkippedItem(
            url=url,
            reason=reason,
            detail=detail,
            existing_media_id=existing_media_id,
        )
    )
    _persist_outcome(
        url,
        downloaded=False,
        reason=reason,
        detail=detail,
        existing_media_id=existing_media_id,
    )


ERROR_DOWNLOAD_ATTEMPTS = 3


def _download_error_attempts() -> int:
    """How many times to try a failing file in this job before the Errors queue.

    With Never auto-run scrape on: fail once and park in Errors.
    Off (default): retry up to three times in the same job.
    """
    try:
        from backend.app.services.app_settings import load_app_settings

        if bool(load_app_settings().get("never_auto_run_scrape", False)):
            return 1
    except Exception:  # noqa: BLE001 — settings must not block a scrape
        pass
    return ERROR_DOWNLOAD_ATTEMPTS


def _complete_error(url: str, detail: str = "") -> None:
    with scrape_lock:
        _complete_error_locked(url, detail)


def _complete_error_locked(url: str, detail: str = "") -> None:
    """Settle a failed download into the Errors queue (not Skipped)."""
    if url:
        scrape_status.counted_urls.add(url)
    _count_settled(url)
    _record_error_locked(url, detail)


def _record_error_locked(url: str, detail: str = "") -> None:
    line = f"{url}: {detail}" if url else (detail or "error")
    if url:
        for row in scrape_status.error_items:
            if row.url == url:
                row.reason = "error"
                row.detail = detail
                # Keep one string line per URL.
                prefix = f"{url}:"
                scrape_status.errors = [
                    item
                    for item in scrape_status.errors
                    if item != url and not item.startswith(prefix)
                ]
                scrape_status.errors.append(line)
                _persist_outcome(url, downloaded=False, reason="error", detail=detail)
                return
        # Leave intentional Skipped rows alone; errors are a separate list.
        scrape_status.skipped_items = [row for row in scrape_status.skipped_items if row.url != url]
    scrape_status.error_items.append(SkippedItem(url=url, reason="error", detail=detail))
    if line not in scrape_status.errors:
        scrape_status.errors.append(line)
    _persist_outcome(url, downloaded=False, reason="error", detail=detail)


def _settle_errors_into_error_items() -> None:
    """Ensure every ``errors`` string has a matching Errors-queue row. Caller holds lock."""
    for item in list(scrape_status.errors):
        url, _, detail = item.partition(": ")
        if not detail:
            url, detail = item, item
        already = any(row.url == url for row in scrape_status.error_items)
        if not already:
            scrape_status.error_items.append(
                SkippedItem(url=url, reason="error", detail=detail or item)
            )
            # Do not bump skipped — errors are not Skipped.
    # Drop any leftover error rows that were wrongly parked under Skipped.
    moved = [row for row in scrape_status.skipped_items if row.reason == "error"]
    if moved:
        scrape_status.skipped_items = [
            row for row in scrape_status.skipped_items if row.reason != "error"
        ]
        scrape_status.skipped = max(0, int(scrape_status.skipped) - len(moved))
        for row in moved:
            if not any(existing.url == row.url for existing in scrape_status.error_items):
                scrape_status.error_items.append(row)


def _post_matches_tags(post_tag_names: set[str], required: list[str], mode: str = "and") -> bool:
    if not required:
        return True
    if mode == "or":
        return any(tag in post_tag_names for tag in required)
    return all(tag in post_tag_names for tag in required)


def _excluded(post_tag_names: set[str], extra_exclude: list[str]) -> bool:
    blocked = {normalize_tag_name(tag) for tag in extra_exclude}
    return bool(blocked) and any(tag in post_tag_names for tag in blocked)


def _quota_met(job: ScrapeJob) -> bool:
    """Download quota applies to tag/default gallery scrapes, not URL-filter runs."""
    if job.ignore_download_limit:
        return False
    return job.limit > 0 and scrape_status.downloaded >= job.limit


def _maybe_upgrade_existing(db, post_url: str, post_id: str | None) -> bool:
    """Re-fetch a post already in the library and keep the download when it is heavier."""
    if not post_id:
        return False
    row = db.query(MediaItem).filter(MediaItem.source_post_id == post_id).first()
    if row is None:
        return False
    if row.media_type == "video" and not video_can_improve(row.local_path or ""):
        return False
    try:
        post = scrape_post_from_api(post_url)
    except Exception:  # noqa: BLE001 — keep the file we already have
        return False
    if post is None:
        return False
    try:
        stored = download_media(post)
    except Exception:  # noqa: BLE001
        return False
    from backend.scraper.storage import new_download_beats_library, replace_library_file_if_larger

    if not new_download_beats_library(row, stored, new_media_type=post.media_type):
        from backend.app.services.media_service import absolute_path_for_media

        kept_path = absolute_path_for_media(row)
        if stored.path.exists() and stored.path.resolve() != kept_path.resolve():
            stored.path.unlink(missing_ok=True)
        return False
    if not replace_library_file_if_larger(db, row, post, stored):
        return False
    db.commit()
    scrape_status.recent_media_ids.append(row.id)
    return True


def _process_post_url(
    client: PlaywrightClient,
    db,
    job: ScrapeJob,
    post_url: str,
    existing_posts: dict[str, object],
) -> str:
    """Process one post URL.

    Returns ``ok``, ``stop_date``, ``stop_cancel``, or ``needs_browser``.

    ``needs_browser`` means the JSON API missed and this thread must not open
    Playwright. The caller retries on the thread that owns the browser.
    """
    owner = scrape_status.job_id
    if _cancelled() or scrape_status.job_id != owner:
        return "stop_cancel"

    post_id = extract_post_id(post_url)
    with _posts_lock:
        already = bool(post_id and post_id in existing_posts)
        posted_at = existing_posts.get(post_id) if already else None
    if already:
        existing = (
            db.query(MediaItem).filter(MediaItem.source_post_id == post_id).first()
            if post_id
            else None
        )
        existing_id = int(existing.id) if existing is not None else None
        if _maybe_upgrade_existing(db, post_url, post_id):
            _complete_download(post_url)
            return "ok"
        _complete_skip(post_url, "already_have", existing_media_id=existing_id)
        if should_stop_for_date(posted_at, job):  # type: ignore[arg-type]
            scrape_status.message = "Reached date range boundary"
            scrape_status.current_url = None
            return "stop_date"
        return "ok"

    scrape_status.message = f"Scraping {post_url}"
    scrape_status.current_url = post_url

    attempts = _download_error_attempts()
    last_detail = ""
    for attempt in range(1, attempts + 1):
        page = None
        try:
            # Direct post URLs: JSON API + CDN first (no browser). Browser is HTML fallback.
            post = None
            api_error: Exception | None = None
            if post_id:
                try:
                    post = scrape_post_from_api(post_url)
                except Exception as exc:  # noqa: BLE001 — fall back to page scrape
                    api_error = exc
            if post is None and not _browser_allowed():
                return "needs_browser"
            if post is None:
                from backend.scraper.gelbooru import is_gelbooru_site

                page = client.shared_page() if is_gelbooru_site() else client.new_page()
                try:
                    post = scrape_post(page, post_url)
                except Exception:
                    if api_error is not None:
                        raise RuntimeError(
                            f"API failed ({api_error}); browser scrape also failed"
                        ) from api_error
                    raise
            if scrape_status.job_id != owner:
                return "stop_cancel"
            if post is None:
                _complete_skip(post_url, "unavailable")
                return "ok"

            tag_names = {tag.name for tag in post.tags}
            if _excluded(tag_names, job.exclude_tags):
                _complete_skip(post_url, "excluded_tag")
                return "ok"
            if job.tags and not _post_matches_tags(tag_names, job.tags, job.tag_mode):
                _complete_skip(post_url, "tag_mismatch")
                return "ok"
            if job.media_type and post.media_type != job.media_type:
                _complete_skip(post_url, "media_type")
                return "ok"
            if not date_in_range(post.posted_at, job):
                _complete_skip(post_url, "date_range")
                if should_stop_for_date(post.posted_at, job):
                    scrape_status.message = "Reached date range boundary"
                    scrape_status.current_url = None
                    return "stop_date"
                return "ok"

            stored = download_media(post)
            if scrape_status.job_id != owner:
                return "stop_cancel"
            result = upsert_post(db, post, stored)
            db.commit()
            if result.skipped_reason in {"duplicate_hash", "identical"}:
                media_id = int(result.media.id) if result.media is not None else None
                _complete_skip(
                    post_url,
                    result.skipped_reason,
                    existing_media_id=media_id,
                )
            else:
                _complete_download(post_url)
                if result.media is not None:
                    scrape_status.recent_media_ids.append(result.media.id)
                    if result.media.duplicate_of_id:
                        scrape_status.similar += 1
                    with _posts_lock:
                        existing_posts[post.post_id] = post.posted_at
            return "ok"
        except Exception as exc:  # noqa: BLE001 — collect per-post errors
            from backend.scraper.gelbooru import NeedsBrowser, ScrapeCancelled

            if isinstance(exc, ScrapeCancelled):
                db.rollback()
                return "stop_cancel"
            if isinstance(exc, NeedsBrowser):
                db.rollback()
                return "needs_browser"
            db.rollback()
            if scrape_status.job_id != owner:
                return "stop_cancel"
            last_detail = str(exc)
            if attempt < attempts and not _cancelled():
                scrape_status.message = f"Retrying ({attempt + 1}/{attempts}) {post_url}"
                scrape_status.current_url = post_url
                continue
            _complete_error(post_url, last_detail)
            return "ok"
        finally:
            if page is not None:
                try:
                    page.close()
                except Exception:
                    pass
    _complete_error(post_url, last_detail or "download failed")
    return "ok"


def _drain_pending(client: PlaywrightClient, db, job: ScrapeJob, existing_posts: dict) -> str:
    """Download every URL already queued. Kept for callers that do not share lanes."""
    del db
    lanes = _DownloadLanes(client, job, existing_posts)
    try:
        return lanes.drain()
    finally:
        lanes.close()


class _DownloadLanes:
    """Download queued posts ``scrape_concurrency`` at a time.

    The browser fallback runs on the calling thread. File downloads and the
    JSON API run on the pool, each with its own database session.
    """

    def __init__(self, client, job: ScrapeJob, existing_posts: dict) -> None:
        self.client = client
        self.job = job
        self.existing_posts = existing_posts
        self.n = _download_concurrency()
        self.listing_stop = False
        self._job_id = scrape_status.job_id
        self._executor = (
            ThreadPoolExecutor(max_workers=self.n, thread_name_prefix="media-download")
            if self.n > 1
            else None
        )
        self._futures: dict = {}

    def close(self) -> None:
        if self._executor is not None:
            self._executor.shutdown(wait=True, cancel_futures=False)
            self._executor = None

    def fill(self) -> None:
        """Start downloads until the pool is full or the queue is empty."""
        self._reap(block=False)
        while len(self._futures) < self.n and not _cancelled():
            url = _pop_pending()
            if url is None:
                break
            if self._executor is None:
                self._handle(url, self._call(url, browser=True))
            else:
                self._futures[self._executor.submit(self._worker, url)] = url

    def drain(self) -> str:
        """Download until the queue and the pool are both empty."""
        while True:
            self.fill()
            if not self._futures:
                if _cancelled():
                    return "stop_cancel"
                return "stop_date" if self.listing_stop else "ok"
            self._reap(block=True)

    def _worker(self, url: str) -> str:
        _browser_ok.ok = False
        db = SessionLocal()
        try:
            return _process_post_url(self.client, db, self.job, url, self.existing_posts)
        finally:
            db.close()

    def _call(self, url: str, *, browser: bool) -> str:
        _browser_ok.ok = browser
        db = SessionLocal()
        try:
            return _process_post_url(self.client, db, self.job, url, self.existing_posts)
        finally:
            db.close()

    def _reap(self, block: bool) -> None:
        if not self._futures:
            return
        if block:
            done, _ = wait(set(self._futures), return_when=FIRST_COMPLETED)
        else:
            done = [fut for fut in list(self._futures) if fut.done()]
        for fut in done:
            url = self._futures.pop(fut)
            try:
                outcome = fut.result()
            except Exception as exc:  # noqa: BLE001 — one worker must not drop the rest
                _complete_error(url, str(exc))
                outcome = "ok"
            self._handle(url, outcome)

    def _handle(self, url: str, outcome: str) -> None:
        try:
            if outcome == "needs_browser":
                outcome = self._call(url, browser=True)
            if outcome == "stop_cancel":
                # Popped, but not finished. Put it back so Stop can count it.
                # A Stop that already detached this job must not push onto the next one.
                with scrape_lock:
                    if scrape_status.job_id == self._job_id and url not in scrape_status.pending_urls:
                        scrape_status.pending_urls.insert(0, url)
            elif outcome == "stop_date":
                self.listing_stop = True
        finally:
            _note_inflight(url, False)


def _finish_queue(
    my_id: int,
    client: PlaywrightClient,
    db,
    job: ScrapeJob,
    existing_posts: dict,
    lanes: _DownloadLanes | None = None,
) -> None:
    """Download whatever is left, then close the queue so a new job can start."""
    del db
    own = lanes is None
    if lanes is None:
        lanes = _DownloadLanes(client, job, existing_posts)
    try:
        if scrape_status.job_id != my_id:
            return
        if not _cancelled():
            lanes.drain()
        if scrape_status.job_id != my_id:
            return
        if _cancelled():
            _skip_cancelled_remainder()
            with scrape_lock:
                if scrape_status.job_id == my_id:
                    scrape_status.message = "Cancelled"
                    scrape_status.current_url = None
                    scrape_status.running = False
                    scrape_status.queue_open = False
                    scrape_status.kind = ""
            return
        with scrape_lock:
            if scrape_status.job_id != my_id:
                return
            if not scrape_status.message.startswith("Reached"):
                if (
                    job.limit > 0
                    and not job.ignore_download_limit
                    and scrape_status.downloaded < job.limit
                ):
                    scrape_status.message = "Done — no more posts"
                else:
                    scrape_status.message = "Done"
            scrape_status.current_url = None
            scrape_status.running = False
            scrape_status.queue_open = False
            scrape_status.kind = ""
    finally:
        if own:
            lanes.close()


def _mark_retry_already_in_total(urls: list[str]) -> None:
    """Reload parks every leftover in ``total`` with ``processed`` at 0.

    Those URLs are not in ``counted_urls`` yet. Mark the ones this retry is
    about to add so the queue length is not counted a second time. A session
    that already counted them is left alone so they can leave ``processed``
    and be counted again when they settle.
    """
    if scrape_status.processed != 0 or scrape_status.finished_urls:
        return
    for url in urls:
        if url and url not in scrape_status.counted_urls:
            scrape_status.counted_urls.add(url)


def begin_remote_retry(urls: list[str]) -> None:
    """Download exactly these raw files again. Caller holds ``scrape_lock``.

    Does not take Queue to scrape or Cancelled. Counters stay; each retried
    file that was already settled leaves ``processed`` until it settles again.
    """
    from backend.app.services.scrape_panels import SOURCE_UNSUPPORTED, activate

    ordered = list(dict.fromkeys(url for url in urls if url))
    activate(scrape_status, SOURCE_UNSUPPORTED)
    _mark_retry_already_in_total(ordered)
    scrape_status.job_id += 1
    job_id = scrape_status.job_id
    scrape_status.running = True
    scrape_status.cancel = False
    scrape_status.kind = "download"
    scrape_status.site_id = None
    scrape_status.queue_open = True
    scrape_status.pending_urls = list(ordered)
    scrape_status.message = "Queued"
    scrape_status.current_url = ordered[0] if ordered else None
    scrape_status.ran_this_session = True
    added = 0
    for url in ordered:
        scrape_status.accepted_urls.add(url)
        if url in scrape_status.counted_urls:
            scrape_status.retry_urls.add(url)
            _reopen_skipped_or_error(url)
            continue
        added += 1
        _hold_download_slot(url)
    scrape_status.total = max(scrape_status.total, scrape_status.processed) + added
    scrape_status.continue_counts = True
    _sync_open_urls()
    threading.Thread(target=_run_remote_downloads, args=(job_id,), daemon=True).start()


def begin_remote_download(url: str) -> str:
    """Queue one file URL the gallery scrapers don't know.

    Returns ``started``, ``appended``, ``duplicate`` (already in this download),
    or ``busy`` when a scrape or import is running. Added files increase ``total``
    and do not reset processed, downloaded, or skipped.
    """
    with scrape_lock:
        return _claim_remote_download(url)


def _file_already_accepted(url: str) -> bool:
    from backend.app.services.scrape_leftovers import identity

    key = identity(url)
    if not key:
        return url in scrape_status.accepted_urls
    return any(identity(item) == key for item in scrape_status.accepted_urls)


def _claim_remote_download(url: str) -> str:
    """Same as ``begin_remote_download``. Caller already holds ``scrape_lock``."""
    if scrape_status.running and scrape_status.kind == "download" and scrape_status.queue_open:
        if _file_already_accepted(url):
            return "duplicate"
        scrape_status.accepted_urls.add(url)
        scrape_status.pending_urls.append(url)
        scrape_status.total += 1
        _hold_download_slot(url)
        _sync_open_urls()
        return "appended"
    if scrape_status.running:
        return "busy"
    from backend.app.services.scrape_panels import SOURCE_UNSUPPORTED, activate

    activate(scrape_status, SOURCE_UNSUPPORTED)
    keep = scrape_status.ran_this_session
    already_counted = url in scrape_status.counted_urls
    scrape_status.job_id += 1
    job_id = scrape_status.job_id
    scrape_status.running = True
    scrape_status.cancel = False
    scrape_status.kind = "download"
    scrape_status.site_id = None
    scrape_status.queue_open = True
    scrape_status.pending_urls = [url]
    scrape_status.message = "Queued"
    scrape_status.current_url = url
    scrape_status.ran_this_session = True
    if keep:
        scrape_status.accepted_urls.add(url)
        if already_counted:
            # This session already counted the file. Retrying it must not grow total.
            scrape_status.retry_urls.add(url)
            _reopen_skipped_or_error(url)
            scrape_status.total = max(scrape_status.total, scrape_status.processed)
        else:
            scrape_status.total = max(scrape_status.total, scrape_status.processed) + 1
            _hold_download_slot(url)
    else:
        scrape_status.accepted_urls = {url}
        scrape_status.total = 1
        scrape_status.processed = 0
        scrape_status.downloaded = 0
        scrape_status.skipped = 0
        scrape_status.similar = 0
        scrape_status.errors = []
        scrape_status.skipped_items = []
        scrape_status.error_items = []
        scrape_status.counted_urls = set()
        scrape_status.released_urls = set()
        scrape_status.processed_urls = set()
        scrape_status.finished_urls = set()
        scrape_status.retry_urls = set()
    _sync_open_urls()
    threading.Thread(target=_run_remote_downloads, args=(job_id,), daemon=True).start()
    return "started"


def _finish_remote_download(url: str, result) -> None:
    """Record a finished raw download without touching the closed DB session."""
    media_id = getattr(result, "media_id", None)
    if isinstance(media_id, int) and media_id not in scrape_status.recent_media_ids:
        scrape_status.recent_media_ids.append(media_id)
    if result.skipped_reason:
        _complete_skip(url, result.skipped_reason)
    else:
        _complete_download(url)


def _run_remote_downloads(job_id: int) -> None:
    """Save queued picture URLs with no tags, several at once. Stop counts the rest as skipped."""
    n = _download_concurrency()
    executor = (
        ThreadPoolExecutor(max_workers=n, thread_name_prefix="file-download") if n > 1 else None
    )
    futures: dict = {}

    def one(url: str) -> str:
        if _cancelled() or scrape_status.job_id != job_id:
            return "stop"
        attempts = _download_error_attempts()
        last_detail = ""
        for attempt in range(1, attempts + 1):
            if _cancelled() or scrape_status.job_id != job_id:
                return "stop"
            scrape_status.message = (
                "Downloading file"
                if attempt == 1
                else f"Retrying file ({attempt}/{attempts})"
            )
            scrape_status.current_url = url
            try:
                from backend.app.services.scrape_leftovers import page_url_for

                result = save_remote_file(url, page_url_for(url))
            except Exception as exc:  # noqa: BLE001 — one bad file should not drop the rest
                last_detail = str(exc)
                if attempt < attempts and not _cancelled():
                    continue
                _complete_error(url, last_detail)
                return "ok"
            if scrape_status.job_id != job_id:
                return "stop"
            _finish_remote_download(url, result)
            return "ok"
        _complete_error(url, last_detail or "download failed")
        return "ok"

    try:
        while scrape_status.job_id == job_id:
            while len(futures) < n and not _cancelled() and scrape_status.job_id == job_id:
                url = _pop_pending()
                if url is None:
                    break
                if executor is None:
                    if one(url) == "stop":
                        with scrape_lock:
                            if scrape_status.job_id == job_id and url not in scrape_status.pending_urls:
                                scrape_status.pending_urls.insert(0, url)
                    _note_inflight(url, False)
                else:
                    futures[executor.submit(one, url)] = url
            if not futures:
                break
            done, _ = wait(set(futures), return_when=FIRST_COMPLETED)
            for fut in done:
                url = futures.pop(fut)
                try:
                    outcome = fut.result()
                except Exception as exc:  # noqa: BLE001
                    _complete_error(url, str(exc))
                    outcome = "ok"
                if outcome == "stop":
                    with scrape_lock:
                        if scrape_status.job_id == job_id and url not in scrape_status.pending_urls:
                            scrape_status.pending_urls.insert(0, url)
                _note_inflight(url, False)
        if scrape_status.job_id == job_id and _cancelled():
            _skip_cancelled_remainder()
            with scrape_lock:
                if scrape_status.job_id == job_id:
                    scrape_status.message = "Cancelled"
                    scrape_status.current_url = None
        elif scrape_status.job_id == job_id:
            scrape_status.message = "Done"
            scrape_status.current_url = None
    finally:
        if executor is not None:
            executor.shutdown(wait=True, cancel_futures=False)
        _release_queue(job_id)


def _finish_enqueue_job(job_id: int) -> None:
    with scrape_lock:
        if scrape_status.job_id != job_id:
            return
        found = scrape_status.total
        if scrape_status.cancel:
            if scrape_status.message != "Failed":
                scrape_status.message = "Cancelled"
        elif scrape_status.message == "Failed":
            pass
        elif found:
            scrape_status.message = f"Queued {found} URL{'s' if found != 1 else ''}"
        else:
            scrape_status.message = "No new posts to queue"
        scrape_status.current_url = None
        scrape_status.running = False
        scrape_status.queue_open = False
        scrape_status.kind = ""
        scrape_status.total = 0
        scrape_status.processed = 0
        _refresh_persisted_queue_urls()


def run_enqueue_job(job: ScrapeJob) -> ScrapeStatus:
    """Walk gallery listings and fill Queue to scrape without downloading."""
    my_id = scrape_status.job_id
    _reset_status(job.gallery_url)
    db = SessionLocal()
    try:
        seed_database(db)
        existing_posts = _library_post_ids(db)
        with PlaywrightClient() as client:
            from backend.scraper.gelbooru import bind_client, is_gelbooru_site

            gelbooru_job = is_gelbooru_site()
            if gelbooru_job:
                bind_client(client)
            _browser_ok.ok = True
            post_seeds = [url for url in job.seed_urls if extract_post_id(url)]
            for url in post_seeds:
                if _cancelled():
                    break
                enqueue_discovered_urls(
                    [url],
                    site_id=scrape_status.site_id,
                    existing_posts=existing_posts,
                    db=db,
                    client=client,
                    job=job,
                )
            gallery_seeds = [url for url in job.seed_urls if not extract_post_id(url)]
            scrape_status.message = "Finding posts..."
            for gallery_url in gallery_seeds:
                if _cancelled():
                    break
                scrape_status.message = f"Finding posts from {gallery_url}"
                scrape_status.last_gallery_url = gallery_url
                scrape_status.current_url = gallery_url
                from backend.scraper.listing import run_gallery_discovery

                def _on_discovered(post_url: str) -> None:
                    enqueue_discovered_urls(
                        [post_url],
                        site_id=scrape_status.site_id,
                        existing_posts=existing_posts,
                        db=db,
                        client=client,
                        job=job,
                    )

                run_gallery_discovery(
                    client,
                    gallery_url,
                    sort=job.sort,
                    should_stop=_cancelled,
                    should_abort=_cancelled,
                    site_id=scrape_status.site_id,
                    on_discovered=_on_discovered,
                    after_discovered=None,
                )
    except Exception as exc:  # noqa: BLE001
        if scrape_status.job_id == my_id:
            detail = str(exc)
            scrape_status.errors.append(detail)
            scrape_status.message = "Failed"
            scrape_status.current_url = None
        raise
    finally:
        _finish_enqueue_job(my_id)
        db.close()
    return scrape_status


def run_job(job: ScrapeJob) -> ScrapeStatus:
    if not scrape_status.queue_open:
        with scrape_lock:
            if not scrape_status.queue_open:
                scrape_status.job_id += 1
                scrape_status.running = True
                begin_scrape_queue(job, None)
    my_id = scrape_status.job_id
    _reset_status(job.gallery_url)
    db = SessionLocal()
    try:
        seed_database(db)
        existing_posts = {
            row.source_post_id: row.source_posted_at
            for row in db.query(MediaItem.source_post_id, MediaItem.source_posted_at).all()
        }

        with PlaywrightClient() as client:
            from backend.scraper.gelbooru import bind_client, is_gelbooru_site

            gelbooru_job = is_gelbooru_site()
            if gelbooru_job:
                bind_client(client)
            gallery_seeds = [url for url in job.seed_urls if not extract_post_id(url)]

            # total is files in this run (queued, downloaded, skipped, cancelled,
            # errors). processed counts each of those once it settles. The
            # Settings limit still stops the listing and counts downloads only.
            scrape_status.message = "Collecting posts..."
            lanes = _DownloadLanes(client, job, existing_posts)
            try:
                outcome = lanes.drain()
                stop = outcome == "stop_date"

                if not stop and outcome != "stop_cancel":
                    for gallery_url in gallery_seeds:
                        if _cancelled() or _quota_met(job) or lanes.listing_stop:
                            break
                        scrape_status.message = f"Collecting posts from {gallery_url}"
                        scrape_status.last_gallery_url = gallery_url
                        scrape_status.current_url = gallery_url
                        from backend.scraper.listing import run_gallery_discovery

                        def _listing_should_stop() -> bool:
                            return (
                                _cancelled()
                                or _quota_met(job)
                                or _listing_saturated(job)
                            )

                        def _listing_should_abort() -> bool:
                            return (
                                _listing_should_stop()
                                or lanes.listing_stop
                            )

                        run_gallery_discovery(
                            client,
                            gallery_url,
                            sort=job.sort,
                            should_stop=_listing_should_stop,
                            should_abort=_listing_should_abort,
                            site_id=scrape_status.site_id,
                            on_discovered=lambda post_url: enqueue_discovered_urls(
                                [post_url], site_id=scrape_status.site_id
                            ),
                            after_discovered=lanes.fill,
                        )
                        if lanes.listing_stop or _cancelled():
                            stop = lanes.listing_stop
                        if stop or _cancelled() or _quota_met(job):
                            break

                _finish_queue(my_id, client, db, job, existing_posts, lanes)
            finally:
                lanes.close()
                if gelbooru_job:
                    bind_client(None)
                    client.close_shared()
    except Exception as exc:  # noqa: BLE001
        if scrape_status.job_id == my_id:
            detail = str(exc)
            scrape_status.errors.append(detail)
            scrape_status.message = "Failed"
            scrape_status.current_url = None
            # Job-level failure: list it, but do not count it as a download.
            _record_skip("", "error", detail)
        raise
    finally:
        _release_queue(my_id)
        db.close()
    return scrape_status


def run_pipeline(gallery_url: str, limit: int, sort: str = "date_desc") -> ScrapeStatus:
    payload = ScrapeRunRequest(
        filters=[{"type": "url", "value": gallery_url}],
        limit=limit,
        sort=sort,
    )
    return run_job(compile_scrape_job(payload))


def main() -> None:
    parser = argparse.ArgumentParser(description="Scrape gallery posts into local database")
    parser.add_argument("--url", default=settings.default_gallery_url, help="Gallery or search URL")
    parser.add_argument(
        "--limit",
        type=int,
        default=10,
        help="Max successful downloads (0 = all; skips do not count)",
    )
    parser.add_argument(
        "--sort",
        choices=["date_desc", "date_asc"],
        default="date_desc",
        help="Listing date sort",
    )
    args = parser.parse_args()

    status = run_pipeline(args.url, args.limit, args.sort)
    print(
        f"Done. Processed={status.processed}, Downloaded={status.downloaded}, "
        f"Skipped={status.skipped}, Similar={status.similar}, Errors={len(status.errors)}"
    )
    for error in status.errors:
        print(f"  ERROR: {error}")


if __name__ == "__main__":
    main()
