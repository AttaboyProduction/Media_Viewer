"""Match scrape post URLs to library rows (primary id, source URL, extra URLs)."""

from __future__ import annotations

from sqlalchemy.orm import Session

from backend.app.db.models import MediaItem, MediaSourceUrl
from backend.scraper.gallery import extract_post_id
from backend.scraper.sites import page_identity


def build_library_url_index(db: Session) -> dict[str, int]:
    """``post:{id}``, exact URLs, and ``page_identity`` → ``media_id``."""
    index: dict[str, int] = {}
    for row in db.query(MediaItem.id, MediaItem.source_post_id, MediaItem.source_url).all():
        mid = int(row.id)
        if row.source_post_id:
            index[f"post:{row.source_post_id}"] = mid
        if row.source_url:
            text = row.source_url.strip()
            if text:
                index[text] = mid
                ident = page_identity(text)
                if ident:
                    index[ident] = mid
    for row in db.query(MediaSourceUrl.media_id, MediaSourceUrl.url).all():
        mid = int(row.media_id)
        text = (row.url or "").strip()
        if not text:
            continue
        index[text] = mid
        ident = page_identity(text)
        if ident:
            index[ident] = mid
    return index


def library_media_id_for_scrape_url(db: Session, url: str) -> int | None:
    """Library row when the post URL matches primary id, ``source_url``, or extras."""
    return library_media_id_from_index(build_library_url_index(db), url)


def library_media_id_from_index(index: dict[str, int], url: str) -> int | None:
    text = (url or "").strip()
    if not text:
        return None
    post_id = extract_post_id(text)
    if post_id:
        hit = index.get(f"post:{post_id}")
        if hit is not None:
            return hit
    for key in (text, page_identity(text)):
        if key:
            hit = index.get(key)
            if hit is not None:
                return hit
    return None