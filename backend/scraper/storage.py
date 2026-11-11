import time
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy.orm import Session

from backend.app.config import settings
from backend.app.db.models import MediaItem, MediaSourceUrl, MediaTag, Tag, TagGroup
from backend.app.services.hash_service import find_earlier_phash_match, perceptual_hash, sha256_file
from backend.app.services.tag_service import adjust_usage_count
from backend.scraper.post import PostData, PostTag, normalize_tag_name


@dataclass
class StoredFile:
    path: Path
    content_hash: str
    phash: str | None
    file_size: int


@dataclass
class UpsertResult:
    media: MediaItem | None
    skipped_reason: str | None = None


def get_or_create_tag_group(db: Session, key: str) -> TagGroup:
    """Resolve a group by key; create with sort_order + palette color if missing.

    Does not fall back to unknown for unknown keys — that would lose artist/AI/etc.
    """
    from sqlalchemy import func

    from backend.app.services.tag_group_colors import consume_tag_group_color_slot
    from backend.app.services.tag_service import KNOWN_TAG_GROUP_SORT_ORDER
    from backend.scraper.post import normalize_tag_group_key

    normalized = normalize_tag_group_key(key)
    group = db.query(TagGroup).filter(TagGroup.key == normalized).first()
    if group:
        return group

    # Migrate legacy creator → artist in place (preserve user's sort_order).
    if normalized == "artist":
        legacy = db.query(TagGroup).filter(TagGroup.key == "creator").first()
        if legacy:
            legacy.key = "artist"
            if legacy.label.lower() in {"creator", "artist"}:
                legacy.label = "Artist"
            db.flush()
            return legacy

    sort_order = KNOWN_TAG_GROUP_SORT_ORDER.get(normalized)
    if sort_order is None:
        max_order = (
            db.query(func.max(TagGroup.sort_order))
            .filter(TagGroup.sort_order < 999)
            .scalar()
        )
        sort_order = int(max_order or -1) + 1

    color = consume_tag_group_color_slot()
    label = normalized.replace("_", " ").title()
    group = TagGroup(
        key=normalized,
        label=label,
        default_color=color,
        sort_order=sort_order,
        is_default=False,
    )
    db.add(group)
    db.flush()
    return group


def get_or_create_tag(db: Session, name: str, group_key: str) -> Tag:
    from backend.app.services.tag_service import (
        _strip_unknown_when_grouped,
        ensure_tag_group_link,
        next_tag_sort_order,
        sync_tag_group_links_from_primary,
    )

    normalized = normalize_tag_name(name)
    group = get_or_create_tag_group(db, group_key)

    tag = db.query(Tag).filter(Tag.name == normalized, Tag.is_deleted.is_(False)).first()
    if tag:
        current_key = None
        if tag.group is not None:
            current_key = tag.group.key
        elif tag.group_id is not None:
            existing_group = db.query(TagGroup).filter(TagGroup.id == tag.group_id).first()
            current_key = existing_group.key if existing_group else None

        # Never change an existing non-unknown group (including to another known group).
        # Only upgrade unset/Unknown when the site provides a real group.
        if group.key == "unknown" and current_key and current_key != "unknown":
            sync_tag_group_links_from_primary(db, tag)
            return tag

        if tag.group_id != group.id and (
            current_key is None or (current_key == "unknown" and group.key != "unknown")
        ):
            tag.group_id = group.id
            db.flush()
            ensure_tag_group_link(db, tag.id, group.id)
            _strip_unknown_when_grouped(db, tag)
        else:
            sync_tag_group_links_from_primary(db, tag)
        return tag

    deleted = db.query(Tag).filter(Tag.name == normalized, Tag.is_deleted.is_(True)).first()
    if deleted:
        deleted.is_deleted = False
        deleted_key = deleted.group.key if deleted.group else None
        # Same rules as active tags: keep a known group; only fill unset or upgrade Unknown.
        if group.key == "unknown" and deleted_key and deleted_key != "unknown":
            sync_tag_group_links_from_primary(db, deleted)
            db.flush()
            return deleted
        if deleted.group_id != group.id and (
            deleted_key is None or (deleted_key == "unknown" and group.key != "unknown")
        ):
            deleted.group_id = group.id
        ensure_tag_group_link(db, deleted.id, deleted.group_id or group.id)
        _strip_unknown_when_grouped(db, deleted)
        db.flush()
        return deleted

    tag = Tag(name=normalized, group_id=group.id, sort_order=next_tag_sort_order(db, group.id))
    db.add(tag)
    db.flush()
    ensure_tag_group_link(db, tag.id, group.id)
    return tag


MEDIA_FETCH_ATTEMPTS = 6


def _get_curl_cffi(url: str) -> bytes:
    # BunnyCDN often blocks plain httpx; curl_cffi matches browser TLS.
    from curl_cffi import requests as crequests

    response = crequests.get(url, impersonate="chrome", timeout=120)
    response.raise_for_status()
    return response.content


def _get_httpx(url: str) -> bytes:
    import httpx

    response = httpx.get(url, timeout=120, follow_redirects=True)
    response.raise_for_status()
    return response.content


def _is_http_status_error(exc: Exception) -> bool:
    status = getattr(getattr(exc, "response", None), "status_code", None)
    return isinstance(status, int) and 400 <= status < 500


def fetch_media_bytes(url: str, *, sleep=time.sleep) -> bytes:
    """Download media, retrying transient TLS/connection failures (VPNs drop handshakes)."""
    last_exc: Exception | None = None
    for attempt in range(MEDIA_FETCH_ATTEMPTS):
        try:
            return _get_curl_cffi(url)
        except Exception as exc:  # noqa: BLE001
            if _is_http_status_error(exc):
                raise
            last_exc = exc
            if attempt < MEDIA_FETCH_ATTEMPTS - 1:
                sleep(min(1.0 + attempt, 3.0))
    try:
        return _get_httpx(url)
    except Exception:  # noqa: BLE001
        assert last_exc is not None
        raise last_exc


def download_media(post: PostData) -> StoredFile:
    media_dir = settings.media_dir / post.media_type
    media_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{post.post_id}{post.extension}"
    dest = media_dir / filename

    if not dest.exists():
        content = fetch_media_bytes(post.media_url)
        tmp = dest.with_name(dest.name + ".part")
        tmp.write_bytes(content)
        tmp.replace(dest)

    content_hash = sha256_file(dest)
    return StoredFile(
        path=dest,
        content_hash=content_hash,
        phash=perceptual_hash(dest, post.media_type),
        file_size=dest.stat().st_size,
    )


def _relative_path(path: Path) -> str:
    return path.relative_to(settings.media_dir.parent).as_posix()


def apply_scraped_tags(db: Session, media: MediaItem, tags: list[PostTag]) -> None:
    """Upsert scraped tags; keep manual links; drop non-manual tags absent from scrape."""
    existing_links = {
        link.tag_id: link
        for link in db.query(MediaTag).filter(MediaTag.media_id == media.id).all()
    }
    scraped_tag_ids: set[int] = set()

    for post_tag in tags:
        tag = get_or_create_tag(db, post_tag.name, post_tag.group_key)
        scraped_tag_ids.add(tag.id)
        if tag.id in existing_links:
            continue
        db.add(MediaTag(media_id=media.id, tag_id=tag.id, is_manual=False))
        adjust_usage_count(db, tag.id, 1)

    for tag_id, link in existing_links.items():
        if not link.is_manual and tag_id not in scraped_tag_ids:
            adjust_usage_count(db, tag_id, -1)
            db.delete(link)


def _merge_scraped_tags(db: Session, media: MediaItem, post: PostData) -> None:
    apply_scraped_tags(db, media, post.tags)


def _add_source_url(db: Session, media: MediaItem, url: str | None) -> None:
    text = (url or "").strip()
    if not text or text == media.source_url:
        return
    exists = (
        db.query(MediaSourceUrl.id)
        .filter(MediaSourceUrl.media_id == media.id, MediaSourceUrl.url == text)
        .first()
    )
    if exists:
        return
    db.add(MediaSourceUrl(media_id=media.id, url=text))


def _skip_identical_download(db: Session, post: PostData, stored: StoredFile) -> UpsertResult | None:
    from backend.app.services.app_settings import load_app_settings

    if not load_app_settings().get("scrape_skip_identical"):
        return None
    match = find_earlier_phash_match(db, stored.phash)
    if not match or match[1] != "identical":
        return None
    kept = match[0]
    _merge_scraped_tags(db, kept, post)
    _add_source_url(db, kept, post.post_url)
    from backend.app.services.media_service import absolute_path_for_media

    kept_path = absolute_path_for_media(kept)
    if stored.path.exists() and stored.path.resolve() != kept_path.resolve():
        stored.path.unlink(missing_ok=True)
    db.flush()
    return UpsertResult(media=kept, skipped_reason="identical")


def _apply_visual_match(db: Session, media: MediaItem, phash: str | None) -> None:
    match = find_earlier_phash_match(db, phash, exclude_id=media.id)
    if match and match[0].content_hash != media.content_hash:
        media.duplicate_of_id = match[0].id
        media.duplicate_kind = match[1]
    elif not match:
        media.duplicate_of_id = None
        media.duplicate_kind = None


def upsert_post(db: Session, post: PostData, stored: StoredFile) -> UpsertResult:
    relative_path = _relative_path(stored.path)

    exact = (
        db.query(MediaItem)
        .filter(MediaItem.content_hash == stored.content_hash)
        .first()
    )
    by_post = db.query(MediaItem).filter(MediaItem.source_post_id == post.post_id).first()

    if exact and (not by_post or exact.id != by_post.id):
        from backend.app.services.media_service import absolute_path_for_media

        _merge_scraped_tags(db, exact, post)
        _add_source_url(db, exact, post.post_url)
        if stored.path.exists() and stored.path.resolve() != absolute_path_for_media(exact).resolve():
            stored.path.unlink(missing_ok=True)
        db.flush()
        return UpsertResult(media=exact, skipped_reason="duplicate_hash")

    if by_post is None:
        skipped = _skip_identical_download(db, post, stored)
        if skipped is not None:
            return skipped

    media = by_post
    if not media:
        media = MediaItem(
            source_post_id=post.post_id,
            source_url=post.post_url,
            local_path=relative_path,
            storage_kind="managed",
            media_type=post.media_type,
        )
        db.add(media)
        db.flush()
    else:
        media.source_url = post.post_url
        media.local_path = relative_path
        media.storage_kind = "managed"
        media.media_type = post.media_type

    media.content_hash = stored.content_hash
    media.phash = stored.phash
    media.file_size = stored.file_size
    media.source_posted_at = post.posted_at

    _apply_visual_match(db, media, stored.phash)

    _merge_scraped_tags(db, media, post)
    db.flush()
    return UpsertResult(media=media)
