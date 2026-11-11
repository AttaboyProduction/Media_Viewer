from collections.abc import Iterable

from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from backend.app.db.models import MediaTag, Tag, TagAlias, TagGroup, TagGroupLink
from backend.app.services.order_islands import (
    densify_all_islands,
    densify_island_after_removal,
    has_duplicate_orders,
    insert_into_island,
    move_across_islands,
    reindex_islands_by_name,
)
from backend.scraper.post import normalize_tag_name


def _tag_group_scope_filter(group_id: int | None):
    if group_id is None:
        return Tag.group_id.is_(None)
    return Tag.group_id == group_id


def _active_tags_in_group(db: Session, group_id: int | None) -> list[Tag]:
    return (
        db.query(Tag)
        .filter(Tag.is_deleted.is_(False), _tag_group_scope_filter(group_id))
        .all()
    )


def adjust_usage_count(db: Session, tag_id: int, delta: int) -> None:
    """Keep the stored media-link count in step with one add or remove."""
    if delta == 0:
        return
    tag = db.get(Tag, tag_id)
    if tag is None:
        return
    tag.usage_count = max(0, int(tag.usage_count or 0) + delta)


def recalculate_usage_counts(db: Session) -> int:
    """Rebuild every tag's usage_count from media_tags. Returns rows updated."""
    counts = dict(
        db.query(MediaTag.tag_id, func.count(MediaTag.id)).group_by(MediaTag.tag_id).all()
    )
    updated = 0
    for tag in db.query(Tag).all():
        next_count = int(counts.get(tag.id, 0))
        if int(tag.usage_count or 0) != next_count:
            tag.usage_count = next_count
            updated += 1
    db.flush()
    return updated


def _tag_tie(tag: Tag) -> tuple:
    return (tag.name.lower(), tag.id)


def _group_tie(group: TagGroup) -> tuple:
    return (group.label.lower(), group.id)


def next_tag_sort_order(db: Session, group_id: int | None) -> int:
    max_order = (
        db.query(func.max(Tag.sort_order))
        .filter(Tag.is_deleted.is_(False), _tag_group_scope_filter(group_id))
        .scalar()
    )
    return int(max_order if max_order is not None else -1) + 1


def tag_insert_order_by_name(db: Session, name: str, group_id: int | None, *, exclude_id: int | None = None) -> int:
    """Index where `name` belongs alphabetically among active tags in the group."""
    query = db.query(Tag).filter(Tag.is_deleted.is_(False), _tag_group_scope_filter(group_id))
    if exclude_id is not None:
        query = query.filter(Tag.id != exclude_id)
    names = [row.name for row in query.with_entities(Tag.name).all()]
    names.append(name)
    names.sort(key=lambda n: n.lower())
    return names.index(name)


def assign_new_tag_sort_order(
    db: Session,
    tag: Tag,
    explicit: int | None = None,
) -> None:
    """Set order for a newly created/revived tag (insert-shift or append)."""
    if explicit is not None:
        insert_tag_sort_order(db, tag, explicit)
        return
    from backend.app.services.app_settings import load_app_settings

    mode = load_app_settings().get("tags_auto_order_mode", "by_name")
    if mode == "by_name":
        insert_tag_sort_order(
            db,
            tag,
            tag_insert_order_by_name(db, tag.name, tag.group_id, exclude_id=tag.id),
        )
        return
    max_others = (
        db.query(func.max(Tag.sort_order))
        .filter(
            Tag.is_deleted.is_(False),
            Tag.id != tag.id,
            _tag_group_scope_filter(tag.group_id),
        )
        .scalar()
    )
    tag.sort_order = int(max_others if max_others is not None else -1) + 1
    db.flush()


def reindex_tags_by_name(db: Session, group_id: int | None = None) -> int:
    """Alphabetize tag sort_order within each existing order island (per group)."""
    from collections import defaultdict

    query = db.query(Tag).filter(Tag.is_deleted.is_(False))
    if group_id is not None:
        query = query.filter(Tag.group_id == group_id)
    active = query.all()
    by_group: dict = defaultdict(list)
    for tag in active:
        by_group[tag.group_id].append(tag)
    updated = 0
    for group_tags in by_group.values():
        updated += reindex_islands_by_name(
            group_tags,
            get_order=lambda t: int(t.sort_order),
            set_order=lambda t, value: setattr(t, "sort_order", int(value)),
            name_key=lambda t: t.name.lower(),
            tie_key=_tag_tie,
        )
    db.flush()
    return updated


def next_tag_group_sort_order(db: Session) -> int:
    max_order = (
        db.query(func.max(TagGroup.sort_order))
        .filter(TagGroup.sort_order < 999)
        .scalar()
    )
    return int(max_order if max_order is not None else -1) + 1


def tag_group_insert_order_by_name(db: Session, label: str, *, exclude_id: int | None = None) -> int:
    query = db.query(TagGroup)
    if exclude_id is not None:
        query = query.filter(TagGroup.id != exclude_id)
    # Keep unknown at the end: only order among non-unknown for by_name insert.
    rows = [
        (g.label, g.key, g.id)
        for g in query.all()
        if g.key != "unknown"
    ]
    rows.append((label, "", -1))
    rows.sort(key=lambda r: r[0].lower())
    for index, (_label, _key, gid) in enumerate(rows):
        if gid == -1:
            return index
    return len(rows)


def assign_new_tag_group_sort_order(
    db: Session,
    group: TagGroup,
    explicit: int | None = None,
) -> None:
    if explicit is not None:
        insert_tag_group_sort_order(db, group, explicit)
        return
    from backend.app.services.app_settings import load_app_settings

    mode = load_app_settings().get("tags_auto_order_mode", "by_name")
    if group.key == "unknown":
        group.sort_order = 999
        db.flush()
        return
    if mode == "by_name":
        insert_tag_group_sort_order(
            db,
            group,
            tag_group_insert_order_by_name(db, group.label, exclude_id=group.id),
        )
        return
    group.sort_order = next_tag_group_sort_order(db)
    db.flush()


def reindex_tag_groups_by_name(db: Session) -> int:
    """Alphabetize group sort_order within each existing order island (preserve gaps).

    Within an island, unknown is sorted last; a singleton unknown island at 999 is left in place.
    """
    groups = db.query(TagGroup).all()
    updated = reindex_islands_by_name(
        groups,
        get_order=lambda g: int(g.sort_order),
        set_order=lambda g, value: setattr(g, "sort_order", int(value)),
        name_key=lambda g: g.label.lower(),
        tie_key=_group_tie,
        name_sort_key=lambda g: (0 if g.key != "unknown" else 1, g.label.lower(), g.id),
    )
    db.flush()
    return updated


def insert_tag_sort_order(db: Session, tag: Tag, order: int) -> None:
    """Place a new/revived tag at order; shift only within that order island."""
    target = int(order)
    peers = _active_tags_in_group(db, tag.group_id)
    if tag not in peers:
        peers.append(tag)
    insert_into_island(
        peers,
        tag,
        target,
        get_order=lambda t: int(t.sort_order),
        set_order=lambda t, value: setattr(t, "sort_order", int(value)),
        get_id=lambda t: t.id,
        tie_key=_tag_tie,
    )
    db.flush()


def move_tag_sort_order(db: Session, tag: Tag, order: int) -> None:
    """Move an existing tag to target order (may cross or merge islands)."""
    peers = _active_tags_in_group(db, tag.group_id)
    move_across_islands(
        peers,
        tag,
        int(order),
        get_order=lambda t: int(t.sort_order),
        set_order=lambda t, value: setattr(t, "sort_order", int(value)),
        get_id=lambda t: t.id,
        tie_key=_tag_tie,
    )
    db.flush()


def set_tag_sort_order(db: Session, tag: Tag, order: int) -> None:
    """PATCH helper: move existing tag order within its group."""
    move_tag_sort_order(db, tag, order)


def insert_tag_group_sort_order(db: Session, group: TagGroup, order: int) -> None:
    """Place a new group at order; shift only within that order island."""
    target = int(order)
    peers = db.query(TagGroup).all()
    insert_into_island(
        peers,
        group,
        target,
        get_order=lambda g: int(g.sort_order),
        set_order=lambda g, value: setattr(g, "sort_order", int(value)),
        get_id=lambda g: g.id,
        tie_key=_group_tie,
    )
    db.flush()


def move_tag_group_sort_order(db: Session, group: TagGroup, order: int) -> None:
    """Move an existing group to target order (may cross or merge islands)."""
    peers = db.query(TagGroup).all()
    move_across_islands(
        peers,
        group,
        int(order),
        get_order=lambda g: int(g.sort_order),
        set_order=lambda g, value: setattr(g, "sort_order", int(value)),
        get_id=lambda g: g.id,
        tie_key=_group_tie,
    )
    db.flush()


def set_tag_group_sort_order(db: Session, group: TagGroup, order: int) -> None:
    """PATCH helper: move existing group order."""
    move_tag_group_sort_order(db, group, order)


def repair_duplicate_sort_orders(db: Session) -> None:
    """Densify order islands when duplicate sort_order values exist (tags and groups)."""
    from collections import defaultdict

    groups = db.query(TagGroup).all()
    if has_duplicate_orders(groups, get_order=lambda g: int(g.sort_order)):
        densify_all_islands(
            groups,
            get_order=lambda g: int(g.sort_order),
            set_order=lambda g, value: setattr(g, "sort_order", int(value)),
            tie_key=_group_tie,
        )

    active = db.query(Tag).filter(Tag.is_deleted.is_(False)).all()
    by_group: dict = defaultdict(list)
    for tag in active:
        by_group[tag.group_id].append(tag)
    for group_tags in by_group.values():
        if has_duplicate_orders(group_tags, get_order=lambda t: int(t.sort_order)):
            densify_all_islands(
                group_tags,
                get_order=lambda t: int(t.sort_order),
                set_order=lambda t, value: setattr(t, "sort_order", int(value)),
                tie_key=_tag_tie,
            )
    db.flush()


def resolve_canonical_tag(db: Session, tag: Tag) -> Tag:
    visited: set[int] = set()
    current = tag
    while True:
        if current.id in visited:
            break
        visited.add(current.id)
        alias = (
            db.query(TagAlias)
            .filter(TagAlias.alias_tag_id == current.id)
            .first()
        )
        if not alias:
            return current
        canonical = db.query(Tag).filter(Tag.id == alias.canonical_tag_id).first()
        if not canonical or canonical.is_deleted:
            return current
        current = canonical


def resolve_canonical_tags(db: Session, tags: Iterable[Tag]) -> dict[int, Tag]:
    """Batched `resolve_canonical_tag`: tag id → canonical tag, one alias query for all tags."""
    known: dict[int, Tag] = {tag.id: tag for tag in tags}
    if not known:
        return {}

    alias_map: dict[int, int] = dict(
        db.query(TagAlias.alias_tag_id, TagAlias.canonical_tag_id).all()
    )
    if not alias_map:
        return known

    missing: set[int] = set()
    for tag_id in known:
        current = tag_id
        seen = {current}
        while current in alias_map:
            current = alias_map[current]
            if current in seen:
                break
            seen.add(current)
            if current not in known:
                missing.add(current)
    if missing:
        for tag in db.query(Tag).options(joinedload(Tag.group)).filter(Tag.id.in_(missing)).all():
            known[tag.id] = tag

    resolved: dict[int, Tag] = {}
    for tag_id, tag in list(known.items()):
        current = tag
        seen = {current.id}
        while current.id in alias_map:
            canonical = known.get(alias_map[current.id])
            if not canonical or canonical.is_deleted or canonical.id in seen:
                break
            seen.add(canonical.id)
            current = canonical
        resolved[tag_id] = current
    return resolved


def get_tag_color(tag: Tag) -> str:
    if tag.color_override:
        return tag.color_override
    if tag.group:
        return tag.group.default_color
    return "#bdc3c7"


def linked_group_ids(db: Session, tag_id: int) -> set[int]:
    return {
        row[0]
        for row in db.query(TagGroupLink.group_id).filter(TagGroupLink.tag_id == tag_id).all()
    }


def list_groups_for_tag(db: Session, tag: Tag) -> list[TagGroup]:
    """All groups for a tag (links), ordered by group sort_order then label."""
    groups = (
        db.query(TagGroup)
        .join(TagGroupLink, TagGroupLink.group_id == TagGroup.id)
        .filter(TagGroupLink.tag_id == tag.id)
        .order_by(TagGroup.sort_order, TagGroup.label, TagGroup.id)
        .all()
    )
    if groups:
        return groups
    # Legacy / mid-migration: fall back to primary only.
    if tag.group:
        return [tag.group]
    return []


def ensure_tag_group_link(db: Session, tag_id: int, group_id: int) -> None:
    exists = (
        db.query(TagGroupLink.id)
        .filter(TagGroupLink.tag_id == tag_id, TagGroupLink.group_id == group_id)
        .first()
    )
    if exists:
        return
    db.add(TagGroupLink(tag_id=tag_id, group_id=group_id))
    db.flush()


def sync_tag_group_links_from_primary(db: Session, tag: Tag) -> None:
    """Ensure the primary group_id has a membership row (backfill / scrape helpers)."""
    if tag.group_id is None:
        return
    ensure_tag_group_link(db, tag.id, tag.group_id)


def _strip_unknown_when_grouped(db: Session, tag: Tag) -> None:
    """Drop the unknown membership when the tag also belongs to a real group."""
    unknown = db.query(TagGroup).filter(TagGroup.key == "unknown").first()
    if not unknown:
        return
    linked = linked_group_ids(db, tag.id)
    if unknown.id not in linked:
        return
    if not any(gid != unknown.id for gid in linked):
        return
    db.query(TagGroupLink).filter(
        TagGroupLink.tag_id == tag.id,
        TagGroupLink.group_id == unknown.id,
    ).delete(synchronize_session="fetch")
    if tag.group_id == unknown.id:
        remaining = list_groups_for_tag(db, tag)
        tag.group_id = remaining[0].id if remaining else None
    db.flush()


def _pick_primary_group_id(db: Session, tag: Tag, preferred: int | None = None) -> int | None:
    linked = list_groups_for_tag(db, tag)
    if preferred is not None and any(g.id == preferred for g in linked):
        return preferred
    if tag.group_id is not None and any(g.id == tag.group_id for g in linked):
        return tag.group_id
    if linked:
        return linked[0].id
    fallback = get_default_tag_group(db)
    return fallback.id if fallback else None


def set_tag_primary_group(db: Session, tag: Tag, group_id: int) -> Tag:
    """Set primary group and ensure membership; keep other links."""
    group = db.query(TagGroup).filter(TagGroup.id == group_id).first()
    if not group:
        raise ValueError(f"Tag group not found: {group_id}")
    ensure_tag_group_link(db, tag.id, group_id)
    tag.group_id = group_id
    _strip_unknown_when_grouped(db, tag)
    db.flush()
    return tag


def add_tag_groups(db: Session, tag: Tag, group_ids: list[int]) -> Tag:
    """Add memberships without replacing existing ones (+ button)."""
    if not group_ids:
        return tag
    for group_id in group_ids:
        group = db.query(TagGroup).filter(TagGroup.id == group_id).first()
        if not group:
            raise ValueError(f"Tag group not found: {group_id}")
        if group.key == "unknown" and linked_group_ids(db, tag.id):
            # Don't add unknown on top of real groups.
            continue
        ensure_tag_group_link(db, tag.id, group_id)
        # First membership (or upgrading from no primary) becomes primary.
        if tag.group_id is None:
            tag.group_id = group_id
    _strip_unknown_when_grouped(db, tag)
    db.flush()
    return tag


def remove_tag_groups(db: Session, tag: Tag, group_ids: list[int]) -> Tag:
    """Remove memberships; reassign primary if it was removed."""
    if not group_ids:
        return tag
    removed_primary = tag.group_id in group_ids
    db.query(TagGroupLink).filter(
        TagGroupLink.tag_id == tag.id,
        TagGroupLink.group_id.in_(group_ids),
    ).delete(synchronize_session="fetch")
    db.flush()
    if removed_primary or tag.group_id is None:
        tag.group_id = _pick_primary_group_id(db, tag, preferred=None)
        if tag.group_id is not None:
            ensure_tag_group_link(db, tag.id, tag.group_id)
        else:
            fallback = get_default_tag_group(db)
            if fallback:
                ensure_tag_group_link(db, tag.id, fallback.id)
                tag.group_id = fallback.id
    db.flush()
    return tag


def replace_tag_group(db: Session, tag: Tag, from_group_id: int, to_group_id: int) -> Tag:
    """Swap one membership for another (chip click → replace)."""
    if from_group_id == to_group_id:
        return tag
    to_group = db.query(TagGroup).filter(TagGroup.id == to_group_id).first()
    if not to_group:
        raise ValueError(f"Tag group not found: {to_group_id}")
    was_primary = tag.group_id == from_group_id
    ensure_tag_group_link(db, tag.id, to_group_id)
    db.query(TagGroupLink).filter(
        TagGroupLink.tag_id == tag.id,
        TagGroupLink.group_id == from_group_id,
    ).delete(synchronize_session="fetch")
    if was_primary:
        tag.group_id = to_group_id
    _strip_unknown_when_grouped(db, tag)
    db.flush()
    return tag


def set_tag_group_ids(db: Session, tag: Tag, group_ids: list[int]) -> Tag:
    """Replace all memberships with the given list (create_tag). First id is primary."""
    wanted = []
    seen: set[int] = set()
    for group_id in group_ids:
        if group_id in seen:
            continue
        group = db.query(TagGroup).filter(TagGroup.id == group_id).first()
        if not group:
            raise ValueError(f"Tag group not found: {group_id}")
        seen.add(group_id)
        wanted.append(group_id)
    if not wanted:
        default = get_default_tag_group(db)
        if default:
            wanted = [default.id]
    db.query(TagGroupLink).filter(TagGroupLink.tag_id == tag.id).delete(
        synchronize_session="fetch"
    )
    db.flush()
    for group_id in wanted:
        ensure_tag_group_link(db, tag.id, group_id)
    tag.group_id = wanted[0] if wanted else None
    _strip_unknown_when_grouped(db, tag)
    db.flush()
    return tag


def get_or_create_tag_by_name(
    db: Session,
    name: str,
    group_ids: list[int] | None = None,
) -> Tag:
    """Find or create a tag by name. group_ids apply only when creating/reviving."""
    normalized = normalize_tag_name(name)
    tag = db.query(Tag).filter(Tag.name == normalized, Tag.is_deleted.is_(False)).first()
    if tag:
        return resolve_canonical_tag(db, tag)

    wanted = list(group_ids or [])
    deleted = db.query(Tag).filter(Tag.name == normalized, Tag.is_deleted.is_(True)).first()
    default_group = get_default_tag_group(db)
    if deleted:
        deleted.is_deleted = False
        if wanted:
            set_tag_group_ids(db, deleted, wanted)
        elif deleted.group_id is None and default_group:
            deleted.group_id = default_group.id
            sync_tag_group_links_from_primary(db, deleted)
        else:
            sync_tag_group_links_from_primary(db, deleted)
        db.flush()
        return resolve_canonical_tag(db, deleted)

    if wanted:
        primary_id = wanted[0]
        # Validate groups before insert (set_tag_group_ids raises on unknown ids).
        tag = Tag(
            name=normalized,
            group_id=primary_id,
            sort_order=next_tag_sort_order(db, primary_id),
        )
        db.add(tag)
        db.flush()
        set_tag_group_ids(db, tag, wanted)
        return tag

    tag = Tag(
        name=normalized,
        group_id=default_group.id if default_group else None,
        sort_order=next_tag_sort_order(db, default_group.id if default_group else None),
    )
    db.add(tag)
    db.flush()
    sync_tag_group_links_from_primary(db, tag)
    return tag


def create_tag(
    db: Session,
    name: str,
    group_ids: list[int] | None = None,
    sort_order: int | None = None,
) -> Tag:
    """Create or revive a tag; group_ids sets memberships (first id is primary)."""
    normalized = normalize_tag_name(name)
    if not normalized:
        raise ValueError("Tag name is required")

    ids = list(group_ids or [])
    if not ids:
        default = get_default_tag_group(db)
        if default:
            ids = [default.id]

    primary_id = ids[0] if ids else None

    existing = db.query(Tag).filter(Tag.name == normalized, Tag.is_deleted.is_(False)).first()
    if existing:
        raise ValueError(f"Tag already exists: {normalized}")

    deleted = db.query(Tag).filter(Tag.name == normalized, Tag.is_deleted.is_(True)).first()
    if deleted:
        deleted.is_deleted = False
        set_tag_group_ids(db, deleted, ids)
        assign_new_tag_sort_order(db, deleted, sort_order)
        return deleted

    tag = Tag(name=normalized, group_id=primary_id, sort_order=0)
    db.add(tag)
    db.flush()
    set_tag_group_ids(db, tag, ids)
    assign_new_tag_sort_order(db, tag, sort_order)
    return tag


def merge_tags(db: Session, source_ids: list[int], target_id: int | None, new_name: str | None) -> Tag:
    if not source_ids:
        raise ValueError("No source tags provided")

    sources = db.query(Tag).filter(Tag.id.in_(source_ids), Tag.is_deleted.is_(False)).all()
    if len(sources) != len(source_ids):
        raise ValueError("One or more source tags not found")

    if target_id:
        target = db.query(Tag).filter(Tag.id == target_id, Tag.is_deleted.is_(False)).first()
        if not target:
            raise ValueError("Target tag not found")
    elif new_name:
        target = get_or_create_tag_by_name(db, new_name)
    else:
        raise ValueError("Provide target_id or new_name")

    target = resolve_canonical_tag(db, target)

    for source in sources:
        if source.id == target.id:
            continue
        canonical_source = resolve_canonical_tag(db, source)
        if canonical_source.id == target.id:
            continue

        for link in list(canonical_source.media_links):
            existing = next(
                (l for l in target.media_links if l.media_id == link.media_id),
                None,
            )
            if existing:
                adjust_usage_count(db, canonical_source.id, -1)
                db.delete(link)
            else:
                adjust_usage_count(db, canonical_source.id, -1)
                adjust_usage_count(db, target.id, 1)
                link.tag_id = target.id

        existing_alias = (
            db.query(TagAlias).filter(TagAlias.alias_tag_id == canonical_source.id).first()
        )
        if existing_alias:
            existing_alias.canonical_tag_id = target.id
        else:
            db.add(TagAlias(alias_tag_id=canonical_source.id, canonical_tag_id=target.id))

        canonical_source.is_deleted = True

    db.flush()
    return target


def rename_tag(db: Session, tag_id: int, new_name: str) -> Tag:
    tag = db.query(Tag).filter(Tag.id == tag_id, Tag.is_deleted.is_(False)).first()
    if not tag:
        raise ValueError("Tag not found")

    normalized = normalize_tag_name(new_name)
    conflict = (
        db.query(Tag)
        .filter(Tag.name == normalized, Tag.id != tag_id, Tag.is_deleted.is_(False))
        .first()
    )
    if conflict:
        raise ValueError(f"Tag name already exists: {normalized}")

    tag.name = normalized
    db.flush()
    return tag


def set_tag_alias(db: Session, alias_id: int, canonical_id: int) -> None:
    if alias_id == canonical_id:
        raise ValueError("Alias and canonical tag must differ")

    alias_tag = db.query(Tag).filter(Tag.id == alias_id, Tag.is_deleted.is_(False)).first()
    canonical = db.query(Tag).filter(Tag.id == canonical_id, Tag.is_deleted.is_(False)).first()
    if not alias_tag or not canonical:
        raise ValueError("Tag not found")

    canonical = resolve_canonical_tag(db, canonical)
    if alias_tag.id == canonical.id:
        raise ValueError("Cannot alias tag to itself")

    existing = db.query(TagAlias).filter(TagAlias.alias_tag_id == alias_id).first()
    if existing:
        existing.canonical_tag_id = canonical.id
    else:
        db.add(TagAlias(alias_tag_id=alias_id, canonical_tag_id=canonical.id))
    db.flush()


def soft_delete_tag(db: Session, tag_id: int) -> None:
    tag = db.query(Tag).filter(Tag.id == tag_id, Tag.is_deleted.is_(False)).first()
    if not tag:
        raise ValueError("Tag not found")

    group_id = tag.group_id
    removed_order = int(tag.sort_order)

    for link in list(tag.media_links):
        adjust_usage_count(db, tag.id, -1)
        db.delete(link)

    db.query(TagAlias).filter(
        (TagAlias.alias_tag_id == tag_id) | (TagAlias.canonical_tag_id == tag_id)
    ).delete(synchronize_session=False)

    tag.is_deleted = True
    db.flush()

    peers = _active_tags_in_group(db, group_id)
    densify_island_after_removal(
        peers,
        removed_order,
        get_order=lambda t: int(t.sort_order),
        set_order=lambda t, value: setattr(t, "sort_order", int(value)),
        get_id=lambda t: t.id,
        tie_key=_tag_tie,
    )
    db.flush()


def get_default_tag_group(db: Session) -> TagGroup | None:
    group = db.query(TagGroup).filter(TagGroup.is_default.is_(True)).first()
    if group:
        return group
    return db.query(TagGroup).filter(TagGroup.key == "unknown").first()


# Known scrape/API group keys → stable sort_order (unknown last).
KNOWN_TAG_GROUP_SORT_ORDER: dict[str, int] = {
    "artist": 0,
    "creator": 0,
    "character": 1,
    "copyright": 2,
    "meta": 3,
    "system": 4,
    "ai": 5,
    "general": 6,
    "unknown": 999,
}


def create_tag_group(
    db: Session,
    *,
    key: str,
    label: str,
    default_color: str | None = None,
    sort_order: int | None = None,
    is_default: bool = False,
) -> TagGroup:
    from backend.app.services.tag_group_colors import consume_tag_group_color_slot
    from backend.scraper.post import normalize_tag_group_key

    normalized_key = normalize_tag_group_key(key.strip()) if key.strip() else ""
    if not key.strip():
        raise ValueError("Tag group key is required")
    # Prefer the raw slug when normalize collapses unknown aliases incorrectly.
    if normalized_key == "unknown" and key.strip().lower() not in {"unknown"}:
        normalized_key = key.strip().lower().replace(" ", "_")

    existing = db.query(TagGroup).filter(TagGroup.key == normalized_key).first()
    if existing:
        raise ValueError(f"Tag group already exists: {normalized_key}")

    color = default_color or consume_tag_group_color_slot()

    if is_default:
        db.query(TagGroup).filter(TagGroup.is_default.is_(True)).update({"is_default": False})

    group = TagGroup(
        key=normalized_key,
        label=label.strip() or normalized_key,
        default_color=color,
        sort_order=0,
        is_default=is_default,
    )
    db.add(group)
    db.flush()
    if sort_order is not None:
        insert_tag_group_sort_order(db, group, int(sort_order))
    elif normalized_key in KNOWN_TAG_GROUP_SORT_ORDER:
        group.sort_order = KNOWN_TAG_GROUP_SORT_ORDER[normalized_key]
        db.flush()
    else:
        assign_new_tag_group_sort_order(db, group, None)
    return group


def merge_tag_groups(db: Session, source_ids: list[int], target_id: int) -> TagGroup:
    """Move tags from source groups into target, then delete the source groups.

    Tags keep relative ``sort_order``; same-order ties break by name. Each order
    island is densified independently. Source groups are removed with a core
    DELETE so ORM relationship sync cannot null out moved tags' ``group_id``.
    """
    if not source_ids:
        raise ValueError("No source tag groups provided")
    if target_id in source_ids:
        raise ValueError("Target group cannot also be a source")

    target = db.query(TagGroup).filter(TagGroup.id == target_id).first()
    if not target:
        raise ValueError("Target tag group not found")

    sources = db.query(TagGroup).filter(TagGroup.id.in_(source_ids)).all()
    if len(sources) != len(set(source_ids)):
        raise ValueError("One or more source tag groups not found")

    for source in sources:
        if source.key == "unknown":
            raise ValueError("Cannot merge away the unknown tag group")

    source_ids_list = [s.id for s in sources]
    became_default = any(s.is_default for s in sources)

    # Bulk reassign first and flush so FKs no longer point at sources.
    db.query(Tag).filter(Tag.group_id.in_(source_ids_list)).update(
        {Tag.group_id: target.id},
        synchronize_session="fetch",
    )
    db.flush()

    # Membership rows: retarget to target or drop when the tag already has target.
    source_links = (
        db.query(TagGroupLink).filter(TagGroupLink.group_id.in_(source_ids_list)).all()
    )
    for link in source_links:
        already = (
            db.query(TagGroupLink.id)
            .filter(
                TagGroupLink.tag_id == link.tag_id,
                TagGroupLink.group_id == target.id,
            )
            .first()
        )
        if already:
            db.delete(link)
        else:
            link.group_id = target.id
    db.flush()

    # Merged tags can share orders; densify each island and push any it would overrun.
    densify_all_islands(
        _active_tags_in_group(db, target.id),
        get_order=lambda t: int(t.sort_order),
        set_order=lambda t, value: setattr(t, "sort_order", int(value)),
        tie_key=_tag_tie,
    )
    db.flush()

    # Core delete bypasses relationship nullification of child group_id.
    db.query(TagGroup).filter(TagGroup.id.in_(source_ids_list)).delete(
        synchronize_session="fetch"
    )

    if became_default:
        db.query(TagGroup).filter(TagGroup.is_default.is_(True), TagGroup.id != target.id).update(
            {"is_default": False}
        )
        target.is_default = True

    # Densify the group-order island that held each removed source.
    peers = db.query(TagGroup).all()
    for source_order in sorted({int(s.sort_order) for s in sources}, reverse=True):
        densify_island_after_removal(
            peers,
            source_order,
            get_order=lambda g: int(g.sort_order),
            set_order=lambda g, value: setattr(g, "sort_order", int(value)),
            get_id=lambda g: g.id,
            tie_key=_group_tie,
        )

    db.flush()
    db.refresh(target)
    return target


def delete_tag_group(db: Session, group_id: int) -> None:
    group = db.query(TagGroup).filter(TagGroup.id == group_id).first()
    if not group:
        raise ValueError("Tag group not found")
    if group.key == "unknown":
        raise ValueError("Cannot delete the unknown tag group")

    removed_order = int(group.sort_order)

    fallback = get_default_tag_group(db)
    if fallback and fallback.id == group.id:
        fallback = db.query(TagGroup).filter(TagGroup.key == "unknown").first()

    moved = db.query(Tag).filter(Tag.group_id == group_id).all()
    if fallback:
        next_order = next_tag_sort_order(db, fallback.id)
        for tag in moved:
            tag.group_id = fallback.id
            tag.sort_order = next_order
            next_order += 1
            ensure_tag_group_link(db, tag.id, fallback.id)
    else:
        for tag in moved:
            tag.group_id = None
            tag.sort_order = next_tag_sort_order(db, None)

    # Drop secondary memberships pointing at the deleted group.
    db.query(TagGroupLink).filter(TagGroupLink.group_id == group_id).delete(
        synchronize_session="fetch"
    )

    was_default = group.is_default
    db.flush()
    db.query(TagGroup).filter(TagGroup.id == group_id).delete(synchronize_session="fetch")
    db.flush()

    if was_default:
        unknown = db.query(TagGroup).filter(TagGroup.key == "unknown").first()
        if unknown:
            unknown.is_default = True

    peers = db.query(TagGroup).all()
    densify_island_after_removal(
        peers,
        removed_order,
        get_order=lambda g: int(g.sort_order),
        set_order=lambda g, value: setattr(g, "sort_order", int(value)),
        get_id=lambda g: g.id,
        tie_key=_group_tie,
    )
    db.flush()
