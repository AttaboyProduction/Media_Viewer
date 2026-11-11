from collections import defaultdict
from collections.abc import Iterable, Sequence
from pathlib import Path

from sqlalchemy import func, or_, select, union
from sqlalchemy.orm import Session, joinedload

from backend.app.config import settings
from backend.app.db.models import MediaItem, MediaSourceUrl, MediaTag, Rating, Tag, TagAlias, TagGroup, TagGroupLink, User
from backend.app.schemas import MediaSummary, MediaTagOut, RatingOut, TagGroupOut
from backend.app.services.local_media import STORAGE_LINKED, STORAGE_MANAGED
from backend.app.services.tag_service import (
    adjust_usage_count,
    get_or_create_tag_by_name,
    get_tag_color,
    resolve_canonical_tag,
    resolve_canonical_tags,
)
from backend.scraper.post import normalize_tag_name


def media_ids_for_tags(
    db: Session,
    tag_names: Iterable[str],
    mode: str = "and",
    only_media_ids: Sequence[int] | None = None,
):
    """Media ids that have every listed tag (and) or any of them (or).

    Soft-deleted tags never match. Empty input returns None (no filter).
    """
    names = sorted({name.strip() for name in tag_names if name and name.strip()})
    if not names:
        return None
    matching = (
        db.query(MediaTag.media_id)
        .join(Tag)
        .filter(Tag.name.in_(names), Tag.is_deleted.is_(False))
    )
    if only_media_ids is not None:
        matching = matching.filter(MediaTag.media_id.in_(list(only_media_ids)))
    if (mode or "and").strip().lower() != "or":
        matching = matching.group_by(MediaTag.media_id).having(
            func.count(func.distinct(Tag.name)) == len(names)
        )
    return matching


def media_ids_with_excluded_tags(
    db: Session,
    exclude_names: Iterable[str],
    exclude_group_keys: Iterable[str] = (),
):
    """Media ids that carry any excluded tag name/group (including aliases). None = no filter."""
    names = sorted({name.strip() for name in exclude_names if name and name.strip()})
    group_keys = sorted({key.strip() for key in exclude_group_keys if key and key.strip()})
    if not names and not group_keys:
        return None
    hidden_conditions = []
    if names:
        hidden_conditions.append(Tag.name.in_(names))
    if group_keys:
        group_ids = db.query(TagGroup.id).filter(TagGroup.key.in_(group_keys))
        hidden_conditions.append(
            or_(
                Tag.group_id.in_(group_ids),
                Tag.id.in_(
                    db.query(TagGroupLink.tag_id).filter(TagGroupLink.group_id.in_(group_ids))
                ),
            )
        )
    hidden_tag_ids = (
        db.query(Tag.id)
        .filter(Tag.is_deleted.is_(False), or_(*hidden_conditions))
        .subquery()
    )
    hidden_or_alias_ids = union(
        select(hidden_tag_ids.c.id),
        select(TagAlias.alias_tag_id).where(
            TagAlias.canonical_tag_id.in_(select(hidden_tag_ids.c.id))
        ),
    )
    return db.query(MediaTag.media_id).filter(MediaTag.tag_id.in_(hidden_or_alias_ids))


def get_local_user(db: Session) -> User:
    user = db.query(User).filter(User.is_local_default.is_(True)).first()
    if not user:
        user = User(name="local", is_local_default=True)
        db.add(user)
        db.commit()
        db.refresh(user)
    return user


def media_storage_kind(media: MediaItem) -> str:
    kind = getattr(media, "storage_kind", None) or STORAGE_MANAGED
    return STORAGE_LINKED if kind == STORAGE_LINKED else STORAGE_MANAGED


def media_file_url(local_path: str) -> str:
    """Static URL for managed files under the /media mount."""
    return f"/{local_path.replace(chr(92), '/')}"


def media_file_url_for(media: MediaItem) -> str:
    """Viewer URL: linked files go through the API so paths stay outside media/."""
    if media_storage_kind(media) == STORAGE_LINKED:
        return f"/api/media/{media.id}/file"
    return media_file_url(media.local_path)


def absolute_media_path(local_path: str, storage_kind: str = STORAGE_MANAGED) -> Path:
    if storage_kind == STORAGE_LINKED:
        return Path(local_path)
    return settings.media_dir.parent / local_path


def absolute_path_for_media(media: MediaItem) -> Path:
    return absolute_media_path(media.local_path, media_storage_kind(media))


def _dedupe_urls(primary: str | None, extras: Iterable[str]) -> list[str]:
    urls: list[str] = []
    seen: set[str] = set()
    for url in [primary, *extras]:
        text = (url or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        urls.append(text)
    return urls


def list_media_source_urls(media: MediaItem) -> list[str]:
    """Primary + extra source URLs (deduped, primary first)."""
    return _dedupe_urls(media.source_url, (row.url for row in media.source_url_rows))


def build_media_tag_out(db: Session, link: MediaTag) -> MediaTagOut:
    tag = resolve_canonical_tag(db, link.tag)
    groups = [
        group
        for _, group in (
            db.query(TagGroupLink.tag_id, TagGroup)
            .join(TagGroup, TagGroup.id == TagGroupLink.group_id)
            .filter(TagGroupLink.tag_id == tag.id)
            .order_by(TagGroup.sort_order, TagGroup.label, TagGroup.id)
            .all()
        )
    ]
    if not groups and tag.group:
        groups = [tag.group]
    return _media_tag_out(link, tag, groups)


def _media_tag_out(
    link: MediaTag,
    tag: Tag,
    groups: list[TagGroup] | None = None,
) -> MediaTagOut:
    group_list = groups if groups is not None else ([tag.group] if tag.group else [])
    group_outs = [TagGroupOut.model_validate(group) for group in group_list if group]
    group_out = next((g for g in group_outs if g.id == tag.group_id), None)
    if group_out is None and group_outs:
        group_out = group_outs[0]
    return MediaTagOut(
        id=tag.id,
        name=tag.name,
        group=group_out,
        groups=group_outs,
        display_names=[tag.name],
        color=get_tag_color(tag),
        is_manual=link.is_manual,
        sort_order=tag.sort_order,
    )


def build_rating_out(db: Session, media_id: int) -> RatingOut:
    return _rating_outs(db, [media_id])[media_id]


def _rating_outs(db: Session, media_ids: Sequence[int]) -> dict[int, RatingOut]:
    if not media_ids:
        return {}
    user = get_local_user(db)
    mine = dict(
        db.query(Rating.media_id, Rating.score)
        .filter(Rating.media_id.in_(media_ids), Rating.user_id == user.id)
        .all()
    )
    aggregates = {
        media_id: (avg, count)
        for media_id, avg, count in db.query(
            Rating.media_id, func.avg(Rating.score), func.count(Rating.id)
        )
        .filter(Rating.media_id.in_(media_ids))
        .group_by(Rating.media_id)
        .all()
    }
    result: dict[int, RatingOut] = {}
    for media_id in media_ids:
        avg, count = aggregates.get(media_id, (None, 0))
        result[media_id] = RatingOut(
            my_rating=mine.get(media_id),
            avg_rating=float(avg) if avg is not None else None,
            rating_count=int(count or 0),
        )
    return result


def build_media_summaries(db: Session, items: Sequence[MediaItem]) -> list[MediaSummary]:
    """Summaries for a page of media with batched tag / alias / rating / source-url queries."""
    if not items:
        return []

    media_ids = [item.id for item in items]

    links_by_media: dict[int, list[MediaTag]] = defaultdict(list)
    links = (
        db.query(MediaTag)
        .options(joinedload(MediaTag.tag).joinedload(Tag.group))
        .filter(MediaTag.media_id.in_(media_ids))
        .all()
    )
    for link in links:
        links_by_media[link.media_id].append(link)
    canonical = resolve_canonical_tags(db, (link.tag for link in links))

    groups_by_tag: dict[int, list[TagGroup]] = defaultdict(list)
    canonical_ids = {tag.id for tag in canonical.values()}
    if canonical_ids:
        for tag_id, group in (
            db.query(TagGroupLink.tag_id, TagGroup)
            .join(TagGroup, TagGroup.id == TagGroupLink.group_id)
            .filter(TagGroupLink.tag_id.in_(canonical_ids))
            .order_by(TagGroup.sort_order, TagGroup.label, TagGroup.id)
            .all()
        ):
            groups_by_tag[tag_id].append(group)

    extra_urls: dict[int, list[str]] = defaultdict(list)
    for media_id, url in (
        db.query(MediaSourceUrl.media_id, MediaSourceUrl.url)
        .filter(MediaSourceUrl.media_id.in_(media_ids))
        .all()
    ):
        extra_urls[media_id].append(url)

    ratings = _rating_outs(db, media_ids)

    summaries: list[MediaSummary] = []
    for media in items:
        file_url = media_file_url_for(media)
        tag_outs: list[MediaTagOut] = []
        for link in links_by_media.get(media.id, []):
            canon = canonical.get(link.tag_id, link.tag)
            tag_outs.append(
                _media_tag_out(
                    link,
                    canon,
                    groups_by_tag.get(canon.id, [canon.group] if canon.group else []),
                )
            )
        summaries.append(
            MediaSummary(
                id=media.id,
                source_post_id=media.source_post_id,
                source_url=media.source_url,
                source_urls=_dedupe_urls(media.source_url, extra_urls.get(media.id, [])),
                media_type=media.media_type,
                storage_kind=media_storage_kind(media),
                is_discarded=media.is_discarded,
                scraped_at=media.scraped_at,
                media_url=file_url,
                thumbnail_url=file_url,
                tags=tag_outs,
                rating=ratings[media.id],
                duplicate_of_id=media.duplicate_of_id,
                duplicate_kind=media.duplicate_kind,
                file_size=media.file_size,
                source_posted_at=media.source_posted_at,
            )
        )
    return summaries


def build_media_summary(db: Session, media: MediaItem) -> MediaSummary:
    return build_media_summaries(db, [media])[0]


def update_media_tags(
    db: Session,
    media_id: int,
    add: list[str],
    remove: list[str],
    group_ids: list[int] | None = None,
) -> MediaItem:
    media = db.query(MediaItem).filter(MediaItem.id == media_id).first()
    if not media:
        raise ValueError("Media not found")

    existing = {link.tag_id: link for link in media.tag_links}
    create_group_ids = list(group_ids or [])

    for name in remove:
        normalized = normalize_tag_name(name)
        tag = db.query(Tag).filter(Tag.name == normalized).first()
        if tag and tag.id in existing:
            adjust_usage_count(db, tag.id, -1)
            db.delete(existing[tag.id])

    for name in add:
        tag = get_or_create_tag_by_name(
            db, name, create_group_ids if create_group_ids else None
        )
        if tag.id not in existing:
            db.add(MediaTag(media_id=media.id, tag_id=tag.id, is_manual=True))
            adjust_usage_count(db, tag.id, 1)

    db.flush()
    db.refresh(media)
    return media


def update_media_urls(db: Session, media_id: int, add: list[str], remove: list[str]) -> MediaItem:
    media = (
        db.query(MediaItem)
        .options(joinedload(MediaItem.source_url_rows))
        .filter(MediaItem.id == media_id)
        .first()
    )
    if not media:
        raise ValueError("Media not found")

    current = list_media_source_urls(media)
    remove_set = {(u or "").strip() for u in remove if (u or "").strip()}
    add_list = [(u or "").strip() for u in add if (u or "").strip()]

    remaining = [u for u in current if u not in remove_set]
    for url in add_list:
        if url not in remaining:
            remaining.append(url)

    if not remaining:
        raise ValueError("At least one source URL is required")

    media.source_url = remaining[0]
    extras = remaining[1:]
    existing_extras = {row.url: row for row in list(media.source_url_rows)}
    for url, row in list(existing_extras.items()):
        if url not in extras:
            db.delete(row)
    for url in extras:
        if url not in existing_extras and url != media.source_url:
            db.add(MediaSourceUrl(media_id=media.id, url=url))

    db.flush()
    db.refresh(media)
    return media


def _fetch_tags_for_refresh_url(url: str) -> list:
    from backend.scraper.post import PostTag, scrape_tags_from_url
    from backend.scraper.site_api import fetch_tags_for_post_url

    tags: list[PostTag] = []
    json_error: Exception | None = None
    try:
        tags = fetch_tags_for_post_url(url)
    except Exception as exc:
        json_error = exc
        tags = []

    if tags:
        return tags

    try:
        return scrape_tags_from_url(url)
    except Exception as html_exc:
        if json_error is not None:
            raise RuntimeError(f"{url}: {json_error}; html: {html_exc}") from html_exc
        raise RuntimeError(f"{url}: {html_exc}") from html_exc


def refresh_media_tags(db: Session, media_id: int) -> MediaItem:
    """Fetch tags from linked post URLs (JSON API then HTML); no file re-download."""
    from backend.scraper.post import PostTag
    from backend.scraper.storage import apply_scraped_tags

    media = (
        db.query(MediaItem)
        .options(joinedload(MediaItem.source_url_rows))
        .filter(MediaItem.id == media_id)
        .first()
    )
    if not media:
        raise ValueError("Media not found")

    urls = list_media_source_urls(media)
    if not urls:
        raise ValueError("Media has no source URLs")

    by_name: dict[str, PostTag] = {}
    errors: list[str] = []
    for url in urls:
        try:
            tags = _fetch_tags_for_refresh_url(url)
        except Exception as exc:
            errors.append(str(exc))
            continue
        for tag in tags:
            prev = by_name.get(tag.name)
            if prev is None or (
                prev.group_key == "unknown" and tag.group_key != "unknown"
            ):
                by_name[tag.name] = tag

    if not by_name:
        raise RuntimeError("; ".join(errors) if errors else "No tags found from source URLs")

    apply_scraped_tags(db, media, list(by_name.values()))
    db.flush()
    db.refresh(media)
    return media


def rescrape_media(db: Session, media_id: int) -> MediaItem:
    """Re-download file and metadata from the primary source URL."""
    from backend.scraper.client import PlaywrightClient
    from backend.scraper.post import scrape_post
    from backend.scraper.storage import (
        _add_source_url,
        _apply_visual_match,
        _relative_path,
        apply_scraped_tags,
        download_media,
    )

    media = db.query(MediaItem).filter(MediaItem.id == media_id).first()
    if not media:
        raise ValueError("Media not found")
    if not media.source_url:
        raise ValueError("Media has no source URL")

    with PlaywrightClient() as client:
        page = client.new_page()
        post = scrape_post(page, media.source_url)
    if not post:
        raise RuntimeError("Could not scrape post from source URL")

    stored = download_media(post)
    old_path = absolute_path_for_media(media)
    new_rel = _relative_path(stored.path)

    # Another row already owns this exact file hash — keep that file, still refresh this row's tags/meta.
    other = (
        db.query(MediaItem)
        .filter(MediaItem.content_hash == stored.content_hash, MediaItem.id != media.id)
        .first()
    )
    if other:
        apply_scraped_tags(db, media, post.tags)
        _add_source_url(db, other, post.post_url)
        media.source_posted_at = post.posted_at or media.source_posted_at
        if stored.path.exists() and stored.path.resolve() != absolute_path_for_media(other).resolve():
            stored.path.unlink(missing_ok=True)
        db.flush()
        db.refresh(media)
        return media

    media.local_path = new_rel
    media.storage_kind = STORAGE_MANAGED
    media.media_type = post.media_type
    media.content_hash = stored.content_hash
    media.phash = stored.phash
    media.file_size = stored.file_size
    media.source_posted_at = post.posted_at
    media.source_url = post.post_url
    if post.post_id and post.post_id != media.source_post_id:
        conflict = (
            db.query(MediaItem)
            .filter(MediaItem.source_post_id == post.post_id, MediaItem.id != media.id)
            .first()
        )
        if not conflict:
            media.source_post_id = post.post_id

    _apply_visual_match(db, media, stored.phash)

    apply_scraped_tags(db, media, post.tags)

    if (
        old_path.exists()
        and old_path.resolve() != stored.path.resolve()
        and old_path.is_file()
    ):
        old_path.unlink(missing_ok=True)

    db.flush()
    db.refresh(media)
    return media


def _delete_media_rows(db: Session, media: MediaItem) -> Path | None:
    """Delete DB rows for one media item.

    Returns a managed file path the caller should unlink after commit, or None for
    linked (on-disk) media — library delete never removes the PC file.
    """
    kind = media_storage_kind(media)
    path = absolute_path_for_media(media)
    for link in list(media.tag_links):
        adjust_usage_count(db, link.tag_id, -1)
        db.delete(link)
    for rating in list(media.ratings):
        db.delete(rating)
    for row in list(media.source_url_rows):
        db.delete(row)

    db.query(MediaItem).filter(MediaItem.duplicate_of_id == media.id).update(
        {"duplicate_of_id": None, "duplicate_kind": None},
        synchronize_session=False,
    )
    db.delete(media)
    return path if kind == STORAGE_MANAGED else None


def unlink_media_files(paths: Iterable[Path]) -> None:
    for path in paths:
        if path.is_file():
            path.unlink(missing_ok=True)


def delete_media(db: Session, media_id: int) -> None:
    """Permanently delete library row; unlinks managed files only (not linked PC files)."""
    media = (
        db.query(MediaItem)
        .options(joinedload(MediaItem.source_url_rows))
        .filter(MediaItem.id == media_id)
        .first()
    )
    if not media:
        raise ValueError("Media not found")

    path = _delete_media_rows(db, media)
    db.flush()
    if path is not None:
        unlink_media_files([path])


def delete_linked_media_file(db: Session, media_id: int) -> None:
    """Delete a linked PC file from disk and remove its library row."""
    media = (
        db.query(MediaItem)
        .options(joinedload(MediaItem.source_url_rows))
        .filter(MediaItem.id == media_id)
        .first()
    )
    if not media:
        raise ValueError("Media not found")
    if media_storage_kind(media) != STORAGE_LINKED:
        raise ValueError("Media is not a linked local file")

    path = absolute_path_for_media(media)
    _delete_media_rows(db, media)
    db.flush()
    unlink_media_files([path])


def bulk_media_action(
    db: Session, media_ids: Sequence[int], action: str
) -> tuple[list[int], list[int], list[Path]]:
    """Discard or delete many media rows in one transaction.

    Returns ``(processed_ids, missing_ids, file_paths)``; managed files must be
    unlinked by the caller only after the commit succeeds. Linked paths are omitted.
    """
    unique_ids = list(dict.fromkeys(media_ids))
    items = (
        db.query(MediaItem)
        .options(joinedload(MediaItem.source_url_rows))
        .filter(MediaItem.id.in_(unique_ids))
        .all()
    )
    by_id = {item.id: item for item in items}
    processed = [media_id for media_id in unique_ids if media_id in by_id]
    missing = [media_id for media_id in unique_ids if media_id not in by_id]

    paths: list[Path] = []
    if action == "discard":
        for media_id in processed:
            by_id[media_id].is_discarded = True
    elif action == "delete":
        for media_id in processed:
            path = _delete_media_rows(db, by_id[media_id])
            if path is not None:
                paths.append(path)
    else:
        raise ValueError(f"Unknown bulk action: {action}")
    db.flush()
    return processed, missing, paths


def bulk_add_media_tags(
    db: Session, media_ids: Sequence[int], add_names: Sequence[str]
) -> tuple[list[int], list[int], list[str]]:
    """Add the same tag names to many media rows in one transaction.

    Missing tag names are created. Returns ``(processed_ids, missing_ids, added_names)``.
    """
    unique_ids = list(dict.fromkeys(media_ids))
    names: list[str] = []
    seen_names: set[str] = set()
    for raw in add_names:
        normalized = normalize_tag_name(raw)
        if not normalized or normalized in seen_names:
            continue
        seen_names.add(normalized)
        names.append(normalized)
    if not names:
        raise ValueError("At least one tag name is required")

    items = (
        db.query(MediaItem)
        .options(joinedload(MediaItem.tag_links))
        .filter(MediaItem.id.in_(unique_ids))
        .all()
    )
    by_id = {item.id: item for item in items}
    processed = [media_id for media_id in unique_ids if media_id in by_id]
    missing = [media_id for media_id in unique_ids if media_id not in by_id]

    tags = [get_or_create_tag_by_name(db, name) for name in names]
    for media_id in processed:
        media = by_id[media_id]
        existing = {link.tag_id for link in media.tag_links}
        for tag in tags:
            if tag.id in existing:
                continue
            db.add(MediaTag(media_id=media.id, tag_id=tag.id, is_manual=True))
            adjust_usage_count(db, tag.id, 1)
            existing.add(tag.id)

    db.flush()
    return processed, missing, [tag.name for tag in tags]


def set_rating(db: Session, media_id: int, score: float) -> RatingOut:
    media = db.query(MediaItem).filter(MediaItem.id == media_id).first()
    if not media:
        raise ValueError("Media not found")

    stepped = round(float(score) * 2) / 2
    if stepped < 0.5 or stepped > 5:
        raise ValueError("Rating must be between 0.5 and 5")

    user = get_local_user(db)
    rating = db.query(Rating).filter(Rating.media_id == media_id, Rating.user_id == user.id).first()
    if rating:
        rating.score = stepped
    else:
        db.add(Rating(media_id=media_id, user_id=user.id, score=stepped))
    db.flush()
    return build_rating_out(db, media_id)
