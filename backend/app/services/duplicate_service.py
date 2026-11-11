"""Identical / similar media groups: list, unlink, discard, merge."""

from __future__ import annotations

from sqlalchemy.orm import Session, joinedload

from backend.app.db.models import MediaItem, MediaTag, Rating
from backend.app.schemas import DuplicateGroupOut
from backend.app.services.hash_service import classify_stored_hash
from backend.app.services.tag_service import adjust_usage_count
from backend.app.services.media_service import (
    build_media_summaries,
    get_local_user,
    list_media_source_urls,
    update_media_urls,
)


def _ensure_kind(item: MediaItem, primary: MediaItem) -> str:
    if item.duplicate_kind in {"identical", "similar"}:
        return item.duplicate_kind
    if item.content_hash and item.content_hash == primary.content_hash:
        return "identical"
    return classify_stored_hash(item.phash, primary.phash) or "similar"


def _children(db: Session, primary_id: int) -> list[MediaItem]:
    return (
        db.query(MediaItem)
        .filter(
            MediaItem.duplicate_of_id == primary_id,
            MediaItem.is_discarded.is_(False),
        )
        .order_by(MediaItem.id.asc())
        .all()
    )


def _group_out(db: Session, primary: MediaItem, members: list[MediaItem]) -> DuplicateGroupOut:
    return DuplicateGroupOut(
        primary_id=primary.id,
        items=build_media_summaries(db, [primary, *members]),
    )


def _identical_member_ids(db: Session, primary: MediaItem) -> set[int]:
    ids = {primary.id}
    for child in _children(db, primary.id):
        if _ensure_kind(child, primary) == "identical":
            ids.add(child.id)
    return ids


def list_duplicate_groups(db: Session) -> tuple[list[DuplicateGroupOut], list[DuplicateGroupOut]]:
    children = (
        db.query(MediaItem)
        .filter(
            MediaItem.duplicate_of_id.isnot(None),
            MediaItem.is_discarded.is_(False),
        )
        .order_by(MediaItem.id.asc())
        .all()
    )
    if not children:
        return [], []
    primary_ids = {item.duplicate_of_id for item in children if item.duplicate_of_id}
    primaries = {
        item.id: item
        for item in db.query(MediaItem).filter(MediaItem.id.in_(primary_ids)).all()
    }
    identical_members: dict[int, list[MediaItem]] = {}
    similar_members: dict[int, list[MediaItem]] = {}
    for child in children:
        primary = primaries.get(child.duplicate_of_id)
        if primary is None:
            continue
        kind = _ensure_kind(child, primary)
        child.duplicate_kind = kind
        bucket = identical_members if kind == "identical" else similar_members
        bucket.setdefault(primary.id, []).append(child)

    identical = [
        _group_out(db, primaries[pid], members)
        for pid, members in identical_members.items()
    ]
    similar = [
        _group_out(db, primaries[pid], members)
        for pid, members in similar_members.items()
    ]
    identical.sort(key=lambda group: -group.primary_id)
    similar.sort(key=lambda group: -group.primary_id)
    return identical, similar


def group_for_media(db: Session, media_id: int) -> DuplicateGroupOut | None:
    media = db.query(MediaItem).filter(MediaItem.id == media_id).first()
    if not media:
        return None
    primary_id = media.duplicate_of_id or media.id
    primary = (
        media
        if primary_id == media.id
        else db.query(MediaItem).filter(MediaItem.id == primary_id).first()
    )
    if primary is None:
        return None
    members = _children(db, primary.id)
    for child in members:
        child.duplicate_kind = _ensure_kind(child, primary)
    visible = [item for item in members if not item.is_discarded]
    items = ([] if primary.is_discarded else [primary]) + visible
    if len(items) < 2:
        return None
    return DuplicateGroupOut(primary_id=primary.id, items=build_media_summaries(db, items))


def unlink_duplicate(db: Session, media_id: int) -> MediaItem:
    media = db.query(MediaItem).filter(MediaItem.id == media_id).first()
    if not media or not media.duplicate_of_id:
        raise ValueError("Duplicate item not found")
    media.duplicate_of_id = None
    media.duplicate_kind = None
    db.flush()
    db.refresh(media)
    return media


def _retarget_children(db: Session, old_id: int, new_id: int) -> None:
    db.query(MediaItem).filter(
        MediaItem.duplicate_of_id == old_id,
        MediaItem.id != new_id,
        MediaItem.is_discarded.is_(False),
    ).update({"duplicate_of_id": new_id}, synchronize_session=False)
    keep = db.query(MediaItem).filter(MediaItem.id == new_id).first()
    if keep is not None:
        keep.duplicate_of_id = None
        keep.duplicate_kind = None


def discard_duplicate_member(db: Session, media_id: int) -> MediaItem:
    media = db.query(MediaItem).filter(MediaItem.id == media_id).first()
    if not media:
        raise ValueError("Media not found")
    children = _children(db, media.id)
    media.is_discarded = True
    if children:
        _retarget_children(db, media.id, children[0].id)
    db.flush()
    db.refresh(media)
    return media


def resolve_duplicate(db: Session, media_id: int, action: str) -> MediaItem:
    media = db.query(MediaItem).filter(MediaItem.id == media_id).first()
    if not media:
        raise ValueError("Duplicate item not found")
    if action == "keep_both":
        return unlink_duplicate(db, media_id)
    if action in {"discard", "discard_new"}:
        return discard_duplicate_member(db, media_id)
    if action == "discard_old":
        if not media.duplicate_of_id:
            raise ValueError("Duplicate item not found")
        return discard_duplicate_member(db, media.duplicate_of_id)
    raise ValueError(f"Unknown duplicate action: {action}")


def _copy_tags(db: Session, source: MediaItem, keep: MediaItem) -> None:
    keep_links = {
        link.tag_id: link
        for link in db.query(MediaTag).filter(MediaTag.media_id == keep.id).all()
    }
    for link in db.query(MediaTag).filter(MediaTag.media_id == source.id).all():
        existing = keep_links.get(link.tag_id)
        if existing is None:
            added = MediaTag(media_id=keep.id, tag_id=link.tag_id, is_manual=link.is_manual)
            db.add(added)
            adjust_usage_count(db, link.tag_id, 1)
            keep_links[link.tag_id] = added
        elif link.is_manual:
            existing.is_manual = True


def merge_identical(
    db: Session, keep_id: int, merge_ids: list[int], rating_from_id: int | None
) -> MediaItem:
    keep = db.query(MediaItem).filter(MediaItem.id == keep_id).first()
    if keep is None or keep.is_discarded:
        raise ValueError("Keep media not found")
    primary_id = keep.duplicate_of_id or keep.id
    primary = (
        keep
        if primary_id == keep.id
        else db.query(MediaItem).filter(MediaItem.id == primary_id).first()
    )
    if primary is None:
        raise ValueError("Keep media is not in an identical group")
    allowed = _identical_member_ids(db, primary)
    if keep_id not in allowed:
        raise ValueError("Keep media is not identical to the group")
    sources = [
        item
        for item in db.query(MediaItem).filter(MediaItem.id.in_(merge_ids)).all()
        if item.id != keep_id
    ]
    if not sources:
        raise ValueError("Nothing to merge")
    for source in sources:
        if source.id not in allowed:
            raise ValueError(f"Media {source.id} is not identical to the group")

    for source in sources:
        _copy_tags(db, source, keep)
        update_media_urls(db, keep.id, list_media_source_urls(source), [])
        source.is_discarded = True

    if rating_from_id:
        user = get_local_user(db)
        source_rating = (
            db.query(Rating)
            .filter(Rating.media_id == rating_from_id, Rating.user_id == user.id)
            .first()
        )
        if source_rating is None:
            raise ValueError("Selected rating was not found")
        dest = (
            db.query(Rating)
            .filter(Rating.media_id == keep.id, Rating.user_id == user.id)
            .first()
        )
        if dest is None:
            db.add(Rating(media_id=keep.id, user_id=user.id, score=source_rating.score))
        else:
            dest.score = source_rating.score

    if keep.id != primary.id:
        _retarget_children(db, primary.id, keep.id)

    db.flush()
    db.refresh(keep)
    return keep


def _root(db: Session, item: MediaItem) -> MediaItem:
    seen: set[int] = set()
    while item.duplicate_of_id and item.duplicate_of_id not in seen:
        seen.add(item.id)
        parent = db.query(MediaItem).filter(MediaItem.id == item.duplicate_of_id).first()
        if parent is None:
            break
        item = parent
    return item


def mark_related(db: Session, media_id: int, other_id: int, kind: str) -> MediaItem:
    """Hand-link two files by local database id. The earlier id stays the primary."""
    if kind not in {"identical", "similar"}:
        raise ValueError("Kind must be identical or similar")
    media = db.query(MediaItem).filter(MediaItem.id == media_id).first()
    if media is None:
        raise ValueError("Media not found")
    other_item = db.query(MediaItem).filter(MediaItem.id == other_id).first()
    if other_item is None:
        raise ValueError("Other file not found")
    if other_item.id == media.id:
        raise ValueError("Pick a different file")
    left, right = _root(db, media), _root(db, other_item)
    if left.id == right.id:
        child = media if media.duplicate_of_id else other_item
        if child.duplicate_of_id:
            child.duplicate_kind = kind
            db.flush()
            db.refresh(child)
            return child
        raise ValueError("Those files are already the same group")
    primary, child = (left, right) if left.id < right.id else (right, left)
    _retarget_children(db, child.id, primary.id)
    child.duplicate_of_id = primary.id
    child.duplicate_kind = kind
    db.flush()
    db.refresh(media)
    return media


def mark_related_many(db: Session, media_ids: list[int], kind: str) -> None:
    """Link every selected file into one group. The earliest id stays the primary."""
    unique = list(dict.fromkeys(media_ids))
    if len(unique) < 2:
        raise ValueError("Select at least two files")
    items = db.query(MediaItem).filter(MediaItem.id.in_(unique)).all()
    if len(items) != len(unique):
        raise ValueError("Media not found")
    anchor = min(items, key=lambda item: item.id)
    for item in items:
        if item.id == anchor.id:
            continue
        try:
            mark_related(db, item.id, anchor.id, kind)
        except ValueError as exc:
            if str(exc) != "Those files are already the same group":
                raise


def mark_related_to(db: Session, anchor_id: int, other_ids: list[int], kind: str) -> None:
    """Link each selected file to this one. The earlier id in each pair stays the primary."""
    unique = [item_id for item_id in dict.fromkeys(other_ids) if item_id != anchor_id]
    if not unique:
        raise ValueError("Pick a different file")
    for other_id in unique:
        try:
            mark_related(db, anchor_id, other_id, kind)
        except ValueError as exc:
            if str(exc) != "Those files are already the same group":
                raise


def keep_group_members(db: Session, keep_ids: list[int], scope_ids: list[int] | None = None) -> None:
    """Keep the selected files as unrelated. Discard the other files in the same review card."""
    unique = list(dict.fromkeys(keep_ids))
    if not unique:
        raise ValueError("Select at least one file to keep")
    group = group_for_media(db, unique[0])
    if group is None:
        raise ValueError("Not in a duplicate group")
    member_ids = {item.id for item in group.items}
    scope = member_ids if not scope_ids else set(scope_ids)
    if not scope <= member_ids:
        raise ValueError("Selection is not in this group")
    keep = set(unique)
    if not keep <= scope:
        raise ValueError("Selection is not in this group")
    for media_id in [item.id for item in group.items if item.id in scope and item.id not in keep]:
        discard_duplicate_member(db, media_id)
    for item in db.query(MediaItem).filter(MediaItem.id.in_(keep)).all():
        item.duplicate_of_id = None
        item.duplicate_kind = None
    db.flush()

