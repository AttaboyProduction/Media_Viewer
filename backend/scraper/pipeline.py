from __future__ import annotations

import argparse
from dataclasses import dataclass, field

from backend.app.config import settings
from backend.app.db.models import MediaItem
from backend.app.db.seed import seed_database
from backend.app.db.session import SessionLocal
from backend.app.schemas import ScrapeRunRequest
from backend.scraper.client import PlaywrightClient
from backend.scraper.gallery import extract_post_id, iter_post_urls
from backend.scraper.job import ScrapeJob, compile_scrape_job, date_in_range, should_stop_for_date
from backend.scraper.post import normalize_tag_name, scrape_post, scrape_post_from_api
from backend.scraper.storage import download_media, upsert_post


@dataclass
class SkippedItem:
    url: str
    reason: str


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
    # True after the first scrape job starts in this process.
    ran_this_session: bool = False


scrape_status = ScrapeStatus()


def _reset_status(gallery_url: str) -> None:
    scrape_status.running = True
    scrape_status.cancel = False
    scrape_status.total = 0
    scrape_status.processed = 0
    scrape_status.downloaded = 0
    scrape_status.skipped = 0
    scrape_status.similar = 0
    scrape_status.errors = []
    scrape_status.last_gallery_url = gallery_url
    scrape_status.message = "Starting..."
    scrape_status.current_url = None
    scrape_status.skipped_items = []
    scrape_status.ran_this_session = True
    # recent_media_ids intentionally retained across scrapes in this process


def _cancelled() -> bool:
    return scrape_status.cancel


def _record_skip(url: str, reason: str) -> None:
    scrape_status.skipped += 1
    scrape_status.skipped_items.append(SkippedItem(url=url, reason=reason))


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
    if _cancelled():
        return "stop_cancel"

    post_id = extract_post_id(post_url)
    if post_id and post_id in existing_posts:
        scrape_status.processed += 1
        _record_skip(post_url, "already_have")
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
        scrape_status.processed += 1
        if post is None:
            _record_skip(post_url, "unavailable")
            return "ok"

        tag_names = {tag.name for tag in post.tags}
        if _excluded(tag_names, job.exclude_tags):
            _record_skip(post_url, "excluded_tag")
            return "ok"
        if job.tags and not _post_matches_tags(tag_names, job.tags, job.tag_mode):
            _record_skip(post_url, "tag_mismatch")
            return "ok"
        if job.media_type and post.media_type != job.media_type:
            _record_skip(post_url, "media_type")
            return "ok"
        if not date_in_range(post.posted_at, job):
            _record_skip(post_url, "date_range")
            if should_stop_for_date(post.posted_at, job):
                scrape_status.message = "Reached date range boundary"
                scrape_status.current_url = None
                return "stop_date"
            return "ok"

        stored = download_media(post)
        result = upsert_post(db, post, stored)
        db.commit()
        if result.skipped_reason in {"duplicate_hash", "identical"}:
            _record_skip(post_url, result.skipped_reason)
        else:
            scrape_status.downloaded += 1
            if result.media is not None:
                scrape_status.recent_media_ids.append(result.media.id)
                if result.media.duplicate_of_id:
                    scrape_status.similar += 1
                existing_posts[post.post_id] = post.posted_at
        return "ok"
    except Exception as exc:  # noqa: BLE001 — collect per-post errors
        db.rollback()
        scrape_status.errors.append(f"{post_url}: {exc}")
        return "ok"
    finally:
        if page is not None:
            try:
                page.close()
            except Exception:
                pass


def run_job(job: ScrapeJob) -> ScrapeStatus:
    _reset_status(job.gallery_url)
    db = SessionLocal()
    try:
        seed_database(db)
        existing_posts = {
            row.source_post_id: row.source_posted_at
            for row in db.query(MediaItem.source_post_id, MediaItem.source_posted_at).all()
        }

        with PlaywrightClient() as client:
            post_seeds = [url for url in job.seed_urls if extract_post_id(url)]
            gallery_seeds = [url for url in job.seed_urls if not extract_post_id(url)]

            # Target downloads for progress when limiting gallery scrapes.
            if job.limit > 0 and not job.ignore_download_limit:
                scrape_status.total = job.limit
            else:
                scrape_status.total = len(post_seeds)

            scrape_status.message = "Collecting posts..."

            stop = False
            for post_url in post_seeds:
                if _cancelled() or _quota_met(job):
                    break
                outcome = _process_post_url(client, db, job, post_url, existing_posts)
                if outcome == "stop_date":
                    stop = True
                    break
                if outcome == "stop_cancel":
                    break

            if not stop and not _cancelled():
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
                            if job.ignore_download_limit or job.limit <= 0:
                                scrape_status.total = max(
                                    scrape_status.total, scrape_status.processed + 1
                                )
                            outcome = _process_post_url(
                                client, db, job, post_url, existing_posts
                            )
                            if outcome == "stop_date":
                                stop = True
                                break
                            if outcome == "stop_cancel":
                                break
                    finally:
                        page.close()
                    if stop or _cancelled() or _quota_met(job):
                        break

            if _cancelled():
                scrape_status.message = "Cancelled"
            elif not scrape_status.message.startswith("Reached"):
                if (
                    job.limit > 0
                    and not job.ignore_download_limit
                    and scrape_status.downloaded < job.limit
                ):
                    # Listing exhausted (or only skips left) before the download quota.
                    scrape_status.message = "Done — no more posts"
                else:
                    scrape_status.message = "Done"
            scrape_status.current_url = None
    except Exception as exc:  # noqa: BLE001
        scrape_status.errors.append(str(exc))
        scrape_status.message = "Failed"
        scrape_status.current_url = None
        raise
    finally:
        scrape_status.running = False
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
