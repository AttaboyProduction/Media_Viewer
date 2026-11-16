from __future__ import annotations

import argparse
import threading
from dataclasses import dataclass, field
from pathlib import Path

from backend.app.config import settings
from backend.app.db.models import MediaItem
from backend.app.db.seed import seed_database
from backend.app.db.session import SessionLocal
from backend.app.schemas import ScrapeRunRequest
from backend.scraper.client import PlaywrightClient
from backend.scraper.gallery import extract_post_id, iter_post_urls
from backend.scraper.job import ScrapeJob, compile_scrape_job, date_in_range, should_stop_for_date
from backend.scraper.post import normalize_tag_name, scrape_post, scrape_post_from_api
from backend.scraper.storage import (
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
    # Process-lifetime session list — not cleared by _reset_status between jobs.
    recent_media_ids: list[int] = field(default_factory=list)
    # URLs left behind by Stop this process. Kept for the progress line.
    cancelled_urls: list[str] = field(default_factory=list)
    # True after the first scrape job starts in this process.
    ran_this_session: bool = False
    # Extension URLs join the running scrape through this queue.
    job_id: int = 0
    kind: str = ""  # "scrape" | "import" | ""
    site_id: str | None = None
    queue_open: bool = False
    pending_urls: list[str] = field(default_factory=list)
    accepted_urls: set[str] = field(default_factory=set)
    # One-shot: the next _reset_status keeps processed / downloaded / skipped.
    continue_counts: bool = False
    # Extension links waiting for Run scrape. Mirrors the stored queue.
    queue_urls: list[str] = field(default_factory=list)
    # Unfinished URLs this run is retrying. Already-counted ones do not grow total.
    retry_urls: set[str] = field(default_factory=set)
    # URLs already included in processed for this process.
    counted_urls: set[str] = field(default_factory=set)
    # Retries and queue URLs still run after the gallery download limit is met.
    leftover_urls: set[str] = field(default_factory=set)


scrape_status = ScrapeStatus()
# Shared with the scrape API so a new job and an extension append can't overlap.
scrape_lock = threading.Lock()


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
        scrape_status.counted_urls = set()
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
        added = 0
        for url in post_seeds:
            # accepted_urls remembers this session, including files that failed
            # or were cancelled. Only a URL still waiting in this queue is a duplicate.
            if url in scrape_status.pending_urls:
                continue
            scrape_status.accepted_urls.add(url)
            scrape_status.pending_urls.append(url)
            if url in retries and url in scrape_status.counted_urls:
                continue
            added += 1
        scrape_status.total = max(scrape_status.total, scrape_status.processed) + added
        scrape_status.continue_counts = True
        _sync_open_urls()
        return
    scrape_status.accepted_urls = set(post_seeds)
    scrape_status.pending_urls = list(post_seeds)
    scrape_status.total = len(post_seeds)
    scrape_status.continue_counts = False
    _sync_open_urls()


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
        scrape_status.total += len(added)
        _sync_open_urls()
        return added


def enqueue_discovered_urls(urls: list[str], *, site_id: str | None) -> list[str]:
    """Persist gallery finds into Queue to scrape before this job drains them."""
    from backend.app.services.scrape_leftovers import add_queue, identity

    with scrape_lock:
        known = {identity(url) for url in scrape_status.accepted_urls}
        known.update(identity(url) for url in scrape_status.pending_urls)
    fresh: list[str] = []
    for url in urls:
        key = identity(url)
        if not key or key in known:
            continue
        known.add(key)
        fresh.append(url)
    stored = add_queue(fresh)
    if not stored:
        return []
    if site_id:
        added = append_scrape_urls(stored, site_id)
        return added if added is not None else []
    with scrape_lock:
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
            added.append(url)
        _sync_open_urls()
        return added


def _pop_pending() -> str | None:
    with scrape_lock:
        if scrape_status.pending_urls:
            url = scrape_status.pending_urls.pop(0)
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
        scrape_status.pending_urls = []
        _sync_open_urls()


def _cancelled() -> bool:
    return scrape_status.cancel


def _record_cancelled(url: str) -> None:
    """Mark one queued URL as cancelled for this job and for the session list."""
    _record_skip(url, "cancelled")
    if url not in scrape_status.cancelled_urls:
        scrape_status.cancelled_urls.append(url)
    if url and url not in scrape_status.counted_urls:
        scrape_status.counted_urls.add(url)
        scrape_status.processed += 1


def _skip_cancelled_remainder() -> None:
    """Count every file still queued as skipped, and close the gap up to ``total``."""
    with scrape_lock:
        left = list(scrape_status.pending_urls)
        scrape_status.pending_urls = []
    for url in left:
        _record_cancelled(url)
    gap = scrape_status.total - scrape_status.processed
    if gap > 0:
        scrape_status.skipped += gap
        scrape_status.processed += gap


def abandon_running_job() -> None:
    """Stop now. Do not wait for the in-flight fetch to return.

    The worker thread may still be blocked on the network. Bumping ``job_id``
    detaches it so a late response cannot write into this job or the next one.
    Files still queued, including the one in flight, count as skipped.
    """
    with scrape_lock:
        scrape_status.cancel = True
        if scrape_status.running:
            scrape_status.job_id += 1
            left = list(scrape_status.pending_urls)
            if scrape_status.current_url and scrape_status.current_url not in left:
                left.insert(0, scrape_status.current_url)
            scrape_status.pending_urls = []
            scrape_status.current_url = None
            for url in left:
                _record_cancelled(url)
            gap = scrape_status.total - scrape_status.processed
            if gap > 0:
                scrape_status.skipped += gap
                scrape_status.processed += gap
            scrape_status.message = "Cancelled"
            scrape_status.current_url = None
            scrape_status.running = False
            scrape_status.queue_open = False
            scrape_status.kind = ""
        if scrape_status.errors or scrape_status.processed < scrape_status.total:
            _settle_errors_into_skipped()
            scrape_status.message = "Cancelled"
            scrape_status.current_url = None


def _sync_open_urls(extra: list[str] | None = None) -> None:
    """Write the files this job has not finished, so a crash can retry them."""
    from backend.app.services.scrape_leftovers import sync_open

    urls = list(scrape_status.pending_urls)
    if scrape_status.current_url:
        urls.append(scrape_status.current_url)
    urls.extend(extra or [])
    scrape_status.queue_urls = sync_open(urls)


def _is_retry(url: str) -> bool:
    """True when this session already counted the URL and this run is retrying it."""
    return bool(url) and url in scrape_status.retry_urls and url in scrape_status.counted_urls


def _attempt(url: str) -> None:
    """Count one new file. A retry already in the total does not move processed."""
    if _is_retry(url) or (url and url in scrape_status.counted_urls):
        return
    if url:
        scrape_status.counted_urls.add(url)
    if scrape_status.processed + 1 > scrape_status.total:
        scrape_status.total = scrape_status.processed + 1
    scrape_status.processed += 1


def _drop_skipped(url: str) -> None:
    if not url:
        return
    before = len(scrape_status.skipped_items)
    scrape_status.skipped_items = [row for row in scrape_status.skipped_items if row.url != url]
    removed = before - len(scrape_status.skipped_items)
    if removed:
        scrape_status.skipped = max(0, scrape_status.skipped - removed)
    scrape_status.cancelled_urls = [item for item in scrape_status.cancelled_urls if item != url]


def _persist_outcome(url: str, *, downloaded: bool, reason: str = "", detail: str = "") -> None:
    from backend.app.services.scrape_leftovers import note_outcome, queue_urls

    if url:
        scrape_status.queue_urls = note_outcome(
            url, downloaded=downloaded, reason=reason, detail=detail
        )
    else:
        scrape_status.queue_urls = queue_urls()


def _complete_download(url: str) -> None:
    if _is_retry(url):
        scrape_status.retry_urls.discard(url)
    else:
        _attempt(url)
    _drop_skipped(url)
    scrape_status.downloaded += 1
    _persist_outcome(url, downloaded=True)


def _complete_skip(url: str, reason: str, detail: str = "") -> None:
    from backend.app.services.scrape_leftovers import RETRY_REASONS

    if _is_retry(url) and reason not in RETRY_REASONS:
        _drop_skipped(url)
        scrape_status.retry_urls.discard(url)
        _persist_outcome(url, downloaded=False, reason=reason, detail=detail)
        return
    if not _is_retry(url):
        _attempt(url)
    _record_skip(url, reason, detail)


def _record_skip(url: str, reason: str, detail: str = "") -> None:
    if url:
        for row in scrape_status.skipped_items:
            if row.url == url:
                row.reason = reason
                row.detail = detail
                _persist_outcome(url, downloaded=False, reason=reason, detail=detail)
                return
    scrape_status.skipped += 1
    scrape_status.skipped_items.append(SkippedItem(url=url, reason=reason, detail=detail))
    _persist_outcome(url, downloaded=False, reason=reason, detail=detail)


def _settle_errors_into_skipped() -> None:
    """Move scrape errors into the skipped list. Caller holds ``scrape_lock``."""
    for item in list(scrape_status.errors):
        url, _, detail = item.partition(": ")
        if not detail:
            url, detail = item, item
        already = any(
            row.url == url and row.reason == "error" and row.detail == (detail or item)
            for row in scrape_status.skipped_items
        )
        if not already:
            scrape_status.skipped += 1
            scrape_status.skipped_items.append(
                SkippedItem(url=url, reason="error", detail=detail or item)
            )
            if scrape_status.total > scrape_status.processed:
                scrape_status.processed += 1
    gap = scrape_status.total - scrape_status.processed
    if gap > 0:
        scrape_status.skipped += gap
        scrape_status.processed += gap
    scrape_status.errors = []


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


def _quota_blocks_pending(job: ScrapeJob) -> bool:
    """Gallery quota does not drop a retry or a Queue to scrape URL still waiting."""
    if not _quota_met(job):
        return False
    nxt = scrape_status.pending_urls[0] if scrape_status.pending_urls else None
    return not (nxt and nxt in scrape_status.leftover_urls)


def _maybe_upgrade_video(db, post_url: str, post_id: str) -> bool:
    """Replace a saved smaller encode when the original file is available.

    Explicit URL downloads only. A gallery pass still skips posts already saved.
    """
    from backend.app.services.media_service import absolute_path_for_media

    row = db.query(MediaItem).filter(MediaItem.source_post_id == post_id).first()
    if row is None or row.media_type != "video" or not video_can_improve(row.local_path or ""):
        return False
    try:
        post = scrape_post_from_api(post_url)
    except Exception:  # noqa: BLE001 — keep the file we already have
        return False
    if post is None or post.media_type != "video":
        return False
    old = absolute_path_for_media(row)
    stored = download_media(post)
    if video_suffix_rank(stored.path.name) >= video_suffix_rank(Path(row.local_path or "").name):
        if stored.path.exists() and stored.path.resolve() != old.resolve():
            stored.path.unlink(missing_ok=True)
        return False
    result = upsert_post(db, post, stored)
    if old.exists() and old.resolve() != stored.path.resolve():
        old.unlink(missing_ok=True)
    db.commit()
    if result.media is not None:
        scrape_status.recent_media_ids.append(result.media.id)
    return result.skipped_reason is None


def _process_post_url(
    client: PlaywrightClient,
    db,
    job: ScrapeJob,
    post_url: str,
    existing_posts: dict[str, object],
) -> str:
    """Process one post URL.

    Returns ``ok``, ``stop_date``, or ``stop_cancel``.
    """
    owner = scrape_status.job_id
    if _cancelled() or scrape_status.job_id != owner:
        return "stop_cancel"

    post_id = extract_post_id(post_url)
    if post_id and post_id in existing_posts:
        if job.ignore_download_limit and _maybe_upgrade_video(db, post_url, post_id):
            _complete_download(post_url)
            return "ok"
        _complete_skip(post_url, "already_have")
        posted_at = existing_posts[post_id]
        if should_stop_for_date(posted_at, job):  # type: ignore[arg-type]
            scrape_status.message = "Reached date range boundary"
            scrape_status.current_url = None
            return "stop_date"
        return "ok"

    scrape_status.message = f"Scraping {post_url}"
    scrape_status.current_url = post_url

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
        if post is None:
            page = client.new_page()
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
            _complete_skip(post_url, result.skipped_reason)
        else:
            _complete_download(post_url)
            if result.media is not None:
                scrape_status.recent_media_ids.append(result.media.id)
                if result.media.duplicate_of_id:
                    scrape_status.similar += 1
                existing_posts[post.post_id] = post.posted_at
        return "ok"
    except Exception as exc:  # noqa: BLE001 — collect per-post errors
        db.rollback()
        if scrape_status.job_id != owner:
            return "stop_cancel"
        detail = str(exc)
        scrape_status.errors.append(f"{post_url}: {detail}")
        _complete_skip(post_url, "error", detail)
        return "ok"
    finally:
        if page is not None:
            try:
                page.close()
            except Exception:
                pass


def _drain_pending(client: PlaywrightClient, db, job: ScrapeJob, existing_posts: dict) -> str:
    """Scrape URLs waiting on the job, including ones added while this runs."""
    while True:
        if _cancelled() or _quota_blocks_pending(job):
            return "stop_cancel" if _cancelled() else "ok"
        url = _pop_pending()
        if url is None:
            return "ok"
        owner = scrape_status.job_id
        outcome = _process_post_url(client, db, job, url, existing_posts)
        if outcome == "stop_cancel":
            # Popped, but not processed. Put it back so the cancel count includes it.
            # A Stop that already detached this job must not push the URL onto the next one.
            with scrape_lock:
                if scrape_status.job_id == owner:
                    scrape_status.pending_urls.insert(0, url)
            return outcome
        if outcome != "ok":
            return outcome


def _finish_queue(my_id: int, client: PlaywrightClient, db, job: ScrapeJob, existing_posts: dict) -> None:
    """Scrape whatever is left, then close the queue so a new job can start."""
    while not _cancelled():
        with scrape_lock:
            if scrape_status.job_id != my_id:
                return
            if scrape_status.pending_urls:
                url = scrape_status.pending_urls.pop(0)
            else:
                if _cancelled():
                    scrape_status.message = "Cancelled"
                elif not scrape_status.message.startswith("Reached"):
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
                return
        outcome = _process_post_url(client, db, job, url, existing_posts)
        if outcome == "stop_cancel":
            with scrape_lock:
                if scrape_status.job_id == my_id:
                    scrape_status.pending_urls.insert(0, url)
            break
    if scrape_status.job_id != my_id or not _cancelled():
        return
    _skip_cancelled_remainder()
    with scrape_lock:
        if scrape_status.job_id == my_id:
            scrape_status.message = "Cancelled"
            scrape_status.current_url = None
            scrape_status.running = False
            scrape_status.queue_open = False
            scrape_status.kind = ""


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
        _sync_open_urls()
        return "appended"
    if scrape_status.running:
        return "busy"
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
            scrape_status.total = max(scrape_status.total, scrape_status.processed)
        else:
            scrape_status.total = max(scrape_status.total, scrape_status.processed) + 1
    else:
        scrape_status.accepted_urls = {url}
        scrape_status.total = 1
        scrape_status.processed = 0
        scrape_status.downloaded = 0
        scrape_status.skipped = 0
        scrape_status.similar = 0
        scrape_status.errors = []
        scrape_status.skipped_items = []
    _sync_open_urls()
    threading.Thread(target=_run_remote_downloads, args=(job_id,), daemon=True).start()
    return "started"


def _run_remote_downloads(job_id: int) -> None:
    """Save queued picture URLs with no tags. Stop counts the rest as skipped."""
    try:
        while not _cancelled() and scrape_status.job_id == job_id:
            url = _pop_pending()
            if url is None:
                break
            if _cancelled():
                with scrape_lock:
                    if scrape_status.job_id == job_id:
                        scrape_status.pending_urls.insert(0, url)
                break
            scrape_status.message = "Downloading file"
            scrape_status.current_url = url
            try:
                result = save_remote_file(url)
            except Exception as exc:  # noqa: BLE001 — one bad file should not drop the rest
                detail = str(exc)
                scrape_status.errors.append(f"{url}: {detail}")
                _complete_skip(url, "error", detail)
                continue
            if result.skipped_reason:
                _complete_skip(url, result.skipped_reason)
            else:
                _complete_download(url)
                if result.media is not None and result.media.id is not None:
                    scrape_status.recent_media_ids.append(result.media.id)
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
        _release_queue(job_id)


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
            gallery_seeds = [url for url in job.seed_urls if not extract_post_id(url)]

            # Gallery scrapes show the download limit as the queue, plus any
            # extension URLs already waiting. URL-filter jobs keep the seed count.
            if job.limit > 0 and not job.ignore_download_limit:
                with scrape_lock:
                    if scrape_status.processed:
                        new_ones = [
                            url
                            for url in scrape_status.pending_urls
                            if url not in scrape_status.counted_urls
                        ]
                        scrape_status.total = max(
                            scrape_status.total, scrape_status.processed
                        ) + len(new_ones)
                    else:
                        scrape_status.total = job.limit + len(scrape_status.pending_urls)

            scrape_status.message = "Collecting posts..."
            outcome = _drain_pending(client, db, job, existing_posts)
            stop = outcome == "stop_date"

            if not stop and outcome != "stop_cancel":
                for gallery_url in gallery_seeds:
                    if _cancelled() or _quota_met(job):
                        break
                    scrape_status.message = f"Collecting posts from {gallery_url}"
                    scrape_status.last_gallery_url = gallery_url
                    scrape_status.current_url = gallery_url
                    page = client.new_page()
                    try:
                        for post_url in iter_post_urls(
                            page,
                            gallery_url,
                            # 0 = keep paging until quota / cancel / exhaustion
                            limit=0,
                            sort=job.sort,
                            should_stop=lambda: _cancelled() or _quota_met(job),
                        ):
                            if _cancelled() or _quota_met(job):
                                break
                            enqueue_discovered_urls([post_url], site_id=scrape_status.site_id)
                            queued = _drain_pending(client, db, job, existing_posts)
                            if queued == "stop_date":
                                stop = True
                                break
                            if queued == "stop_cancel":
                                break
                    finally:
                        page.close()
                    if stop or _cancelled() or _quota_met(job):
                        break

            _finish_queue(my_id, client, db, job, existing_posts)
    except Exception as exc:  # noqa: BLE001
        if scrape_status.job_id == my_id:
            detail = str(exc)
            scrape_status.errors.append(detail)
            scrape_status.message = "Failed"
            scrape_status.current_url = None
            if scrape_status.processed < scrape_status.total:
                scrape_status.processed += 1
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
