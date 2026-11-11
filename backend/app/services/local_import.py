"""Link local PC media into the library (no copy, no tags)."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.orm import Session

from backend.app.db.models import MediaItem
from backend.app.db.session import SessionLocal
from backend.app.services.hash_service import find_earlier_phash_match, perceptual_hash, sha256_file
from backend.app.services.local_media import (
    STORAGE_LINKED,
    file_uri_for_path,
    iter_media_files,
    linked_source_post_id,
    media_type_for_path,
    normalize_absolute_path,
)
from backend.scraper.pipeline import SkippedItem, scrape_status


def _apply_visual_match(db: Session, media: MediaItem, phash: str | None) -> None:
    match = find_earlier_phash_match(db, phash, exclude_id=media.id)
    if match and match[0].content_hash != media.content_hash:
        media.duplicate_of_id = match[0].id
        media.duplicate_kind = match[1]
    elif not match:
        media.duplicate_of_id = None
        media.duplicate_kind = None


def link_one_file(db: Session, path: Path) -> tuple[MediaItem | None, str | None]:
    """Insert or skip one file. Returns (media, skip_reason)."""
    resolved = normalize_absolute_path(path)
    if not resolved.is_file():
        return None, "missing"
    media_type = media_type_for_path(resolved)
    if not media_type:
        return None, "unsupported"

    stored_path = str(resolved)
    post_id = linked_source_post_id(resolved)

    by_post = db.query(MediaItem).filter(MediaItem.source_post_id == post_id).first()
    if by_post is not None:
        return by_post, "already_have"

    by_path = (
        db.query(MediaItem)
        .filter(MediaItem.storage_kind == STORAGE_LINKED, MediaItem.local_path == stored_path)
        .first()
    )
    if by_path is not None:
        return by_path, "already_have"

    content_hash = sha256_file(resolved)
    exact = db.query(MediaItem).filter(MediaItem.content_hash == content_hash).first()
    if exact is not None:
        return exact, "duplicate_hash"

    phash = perceptual_hash(resolved, media_type)
    media = MediaItem(
        source_post_id=post_id,
        source_url=file_uri_for_path(resolved),
        local_path=stored_path,
        storage_kind=STORAGE_LINKED,
        media_type=media_type,
        content_hash=content_hash,
        phash=phash,
        file_size=resolved.stat().st_size,
        scraped_at=datetime.now(timezone.utc).replace(tzinfo=None),
    )
    db.add(media)
    db.flush()
    _apply_visual_match(db, media, phash)
    db.flush()
    return media, None


def run_local_import(paths: list[str], *, recursive: bool) -> None:
    """Background job: scan paths, hash, insert linked rows; updates scrape_status."""
    scrape_status.running = True
    scrape_status.cancel = False
    scrape_status.total = 0
    scrape_status.processed = 0
    scrape_status.downloaded = 0
    scrape_status.skipped = 0
    scrape_status.similar = 0
    scrape_status.errors = []
    scrape_status.last_gallery_url = None
    scrape_status.message = "Scanning local files..."
    scrape_status.current_url = None
    scrape_status.skipped_items = []
    scrape_status.ran_this_session = True

    try:
        files = iter_media_files(paths, recursive=recursive)
        scrape_status.total = len(files)
        if not files:
            scrape_status.message = "No supported media files found"
            return

        db = SessionLocal()
        try:
            cancelled = False
            for path in files:
                if scrape_status.cancel:
                    cancelled = True
                    break
                scrape_status.message = f"Importing {path.name}"
                scrape_status.current_url = str(path)
                try:
                    media, skip = link_one_file(db, path)
                    scrape_status.processed += 1
                    if skip:
                        scrape_status.skipped += 1
                        scrape_status.skipped_items.append(
                            SkippedItem(url=str(path), reason=skip)
                        )
                    else:
                        assert media is not None
                        scrape_status.downloaded += 1
                        scrape_status.recent_media_ids.append(media.id)
                        if media.duplicate_kind == "similar":
                            scrape_status.similar += 1
                    db.commit()
                except Exception as exc:  # noqa: BLE001
                    db.rollback()
                    scrape_status.processed += 1
                    scrape_status.errors.append(f"{path}: {exc}")
            scrape_status.message = "Cancelled" if cancelled else "Done"
        finally:
            db.close()
    except Exception as exc:  # noqa: BLE001
        scrape_status.errors.append(str(exc))
        scrape_status.message = f"Failed: {exc}"
    finally:
        scrape_status.running = False
        scrape_status.current_url = None
