from __future__ import annotations

import logging
import threading

from backend.app.db.models import MediaItem
from backend.app.db.session import SessionLocal
from backend.app.services.hash_service import (
    classify_stored_hash,
    find_earlier_phash_match,
    perceptual_hash,
    sha256_file,
)
from backend.app.services.media_service import absolute_path_for_media

logger = logging.getLogger(__name__)

backfill_status = {
    "running": False,
    "total": 0,
    "done": 0,
}

_backfill_lock = threading.Lock()


def _find_duplicate_target(db, item: MediaItem) -> tuple[MediaItem, str] | None:
    """Earlier match so the first/primary file is never marked similar.

    Byte-identical files are identical; otherwise use pHash kind.
    """
    if item.content_hash:
        exact = (
            db.query(MediaItem)
            .filter(
                MediaItem.content_hash == item.content_hash,
                MediaItem.id < item.id,
            )
            .order_by(MediaItem.id.asc())
            .first()
        )
        if exact:
            return exact, "identical"
    match = find_earlier_phash_match(db, item.phash, exclude_id=item.id)
    if match and match[0].content_hash != item.content_hash:
        return match
    return None


def _fill_kind(item: MediaItem, target: MediaItem) -> str:
    if item.duplicate_kind in {"identical", "similar", "dismissed"}:
        return item.duplicate_kind
    if item.content_hash and item.content_hash == target.content_hash:
        return "identical"
    return classify_stored_hash(item.phash, target.phash) or "similar"


def rematch_duplicate_kinds() -> dict[str, int]:
    """Reclassify every existing duplicate link with the current identical/similar bands.

    SHA-256 matches stay identical. pHash/video hashes are reclassified; pairs that
    fall outside the sensitivity setting are unlinked. Returns counts.
    User-dismissed (keep both) links are left alone.
    """
    db = SessionLocal()
    stats = {
        "identical": 0,
        "similar": 0,
        "unlinked": 0,
        "unchanged_sha": 0,
        "dismissed": 0,
    }
    try:
        items = (
            db.query(MediaItem)
            .filter(MediaItem.duplicate_of_id.isnot(None))
            .order_by(MediaItem.id.asc())
            .all()
        )
        for item in items:
            if item.duplicate_kind == "dismissed":
                stats["dismissed"] += 1
                continue
            target = db.query(MediaItem).filter(MediaItem.id == item.duplicate_of_id).first()
            if target is None or (item.duplicate_of_id is not None and item.duplicate_of_id >= item.id):
                item.duplicate_of_id = None
                item.duplicate_kind = None
                stats["unlinked"] += 1
                continue
            if item.content_hash and item.content_hash == target.content_hash:
                item.duplicate_kind = "identical"
                stats["unchanged_sha"] += 1
                stats["identical"] += 1
                continue
            kind = classify_stored_hash(item.phash, target.phash)
            if kind is None:
                item.duplicate_of_id = None
                item.duplicate_kind = None
                stats["unlinked"] += 1
                continue
            item.duplicate_kind = kind
            stats[kind] += 1
        db.commit()
        logger.info(
            "Rematched duplicate kinds: identical=%s similar=%s unlinked=%s sha=%s",
            stats["identical"],
            stats["similar"],
            stats["unlinked"],
            stats["unchanged_sha"],
        )
        return stats
    finally:
        db.close()


def run_hash_backfill() -> None:
    with _backfill_lock:
        if backfill_status["running"]:
            return
        backfill_status["running"] = True

    db = SessionLocal()
    try:
        items = db.query(MediaItem).order_by(MediaItem.id.asc()).all()
        pending = [item for item in items if not item.content_hash]
        videos = [
            item
            for item in items
            if item.media_type == "video" and item.content_hash and not item.phash
        ]
        backfill_status["total"] = len(pending) + len(videos)
        backfill_status["done"] = 0
        total = backfill_status["total"]
        if total:
            logger.info("Indexing existing files: 0/%s", total)
        else:
            logger.info("Indexing existing files: nothing to do")

        for item in pending:
            path = absolute_path_for_media(item)
            if path.is_file():
                item.content_hash = sha256_file(path)
                item.file_size = path.stat().st_size
                item.phash = perceptual_hash(path, item.media_type)
            backfill_status["done"] += 1
            db.commit()

        for item in videos:
            path = absolute_path_for_media(item)
            if path.is_file():
                item.phash = perceptual_hash(path, item.media_type)
            backfill_status["done"] += 1
            db.commit()

        hashed = db.query(MediaItem).filter(MediaItem.content_hash.isnot(None)).all()
        for item in hashed:
            if item.duplicate_of_id is not None and item.duplicate_of_id >= item.id:
                item.duplicate_of_id = None
                item.duplicate_kind = None
            if item.duplicate_of_id:
                # Keep-all / keep-both dismissals must survive reload/backfill.
                if item.duplicate_kind == "dismissed":
                    continue
                target = db.query(MediaItem).filter(MediaItem.id == item.duplicate_of_id).first()
                if target:
                    item.duplicate_kind = _fill_kind(item, target)
                continue
            target_kind = _find_duplicate_target(db, item)
            if target_kind:
                item.duplicate_of_id = target_kind[0].id
                item.duplicate_kind = target_kind[1]
        db.commit()
        if total:
            logger.info(
                "Indexing existing files: done %s/%s",
                backfill_status["done"],
                total,
            )
    finally:
        db.close()
        backfill_status["running"] = False


def start_hash_backfill() -> None:
    """Background hash/duplicate fill on server start (Launch / Restart). No UI banner."""
    thread = threading.Thread(target=run_hash_backfill, name="hash-backfill", daemon=True)
    thread.start()
