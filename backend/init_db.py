"""Initialize database and seed default data."""

from sqlalchemy import inspect, text

from backend.app.db.models import Base, Tag, TagGroup, TagGroupLink
from backend.app.db.seed import seed_database
from backend.app.db.session import SessionLocal, engine

_MEDIA_ITEM_COLUMNS = {
    "content_hash": "ALTER TABLE media_items ADD COLUMN content_hash VARCHAR(64)",
    "phash": "ALTER TABLE media_items ADD COLUMN phash VARCHAR(64)",
    "file_size": "ALTER TABLE media_items ADD COLUMN file_size INTEGER",
    "source_posted_at": "ALTER TABLE media_items ADD COLUMN source_posted_at DATETIME",
    "duplicate_of_id": "ALTER TABLE media_items ADD COLUMN duplicate_of_id INTEGER",
    "duplicate_kind": "ALTER TABLE media_items ADD COLUMN duplicate_kind VARCHAR(16)",
    "storage_kind": (
        "ALTER TABLE media_items ADD COLUMN storage_kind VARCHAR(16) NOT NULL DEFAULT 'managed'"
    ),
}

_TAG_GROUP_COLUMNS = {
    "sort_order": "ALTER TABLE tag_groups ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
    "is_default": "ALTER TABLE tag_groups ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT 0",
}

_TAG_COLUMNS = {
    "sort_order": "ALTER TABLE tags ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
    "usage_count": "ALTER TABLE tags ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0",
}


def _ensure_media_item_columns() -> None:
    inspector = inspect(engine)
    if "media_items" not in inspector.get_table_names():
        return
    existing = {column["name"] for column in inspector.get_columns("media_items")}
    with engine.begin() as conn:
        for name, statement in _MEDIA_ITEM_COLUMNS.items():
            if name not in existing:
                conn.execute(text(statement))
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_media_items_content_hash "
                "ON media_items (content_hash)"
            )
        )
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_media_items_duplicate_of_id "
                "ON media_items (duplicate_of_id)"
            )
        )


def _ensure_tag_group_columns() -> None:
    inspector = inspect(engine)
    if "tag_groups" not in inspector.get_table_names():
        return
    existing = {column["name"] for column in inspector.get_columns("tag_groups")}
    with engine.begin() as conn:
        for name, statement in _TAG_GROUP_COLUMNS.items():
            if name not in existing:
                conn.execute(text(statement))


def _ensure_tag_columns() -> None:
    inspector = inspect(engine)
    if "tags" not in inspector.get_table_names():
        return
    existing = {column["name"] for column in inspector.get_columns("tags")}
    with engine.begin() as conn:
        for name, statement in _TAG_COLUMNS.items():
            if name not in existing:
                conn.execute(text(statement))


def _backfill_tag_sort_orders(db) -> None:
    """Preserve order islands; densify within them. Fresh all-zero installs get 0..n-1 by name."""
    from collections import defaultdict

    from backend.app.db.models import Tag
    from backend.app.services.order_islands import densify_all_islands
    from backend.app.services.tag_service import _tag_tie, repair_duplicate_sort_orders

    active = db.query(Tag).filter(Tag.is_deleted.is_(False)).all()
    by_group: dict = defaultdict(list)
    for tag in active:
        by_group[tag.group_id].append(tag)

    all_zero = bool(active) and all(tag.sort_order == 0 for tag in active)
    if all_zero:
        for group_tags in by_group.values():
            group_tags.sort(key=lambda t: t.name.lower())
            for index, tag in enumerate(group_tags):
                tag.sort_order = index
    else:
        for group_tags in by_group.values():
            densify_all_islands(
                group_tags,
                get_order=lambda t: int(t.sort_order),
                set_order=lambda t, value: setattr(t, "sort_order", int(value)),
                tie_key=_tag_tie,
            )

    repair_duplicate_sort_orders(db)
    db.commit()


def _backfill_unknown_sort_order(db) -> None:
    """System unknown group sorts last (999); migrate legacy 7."""
    unknown = db.query(TagGroup).filter(TagGroup.key == "unknown").first()
    if unknown and unknown.sort_order in (0, 7):
        unknown.sort_order = 999
        db.commit()


def _backfill_tag_group_links(db) -> None:
    """Ensure every tag.group_id has a matching tag_group_links row."""
    tags = db.query(Tag).filter(Tag.group_id.isnot(None)).all()
    if not tags:
        return
    existing = {
        (tag_id, group_id)
        for tag_id, group_id in db.query(TagGroupLink.tag_id, TagGroupLink.group_id).all()
    }
    added = False
    for tag in tags:
        key = (tag.id, tag.group_id)
        if key in existing:
            continue
        db.add(TagGroupLink(tag_id=tag.id, group_id=tag.group_id))
        existing.add(key)
        added = True
    if added:
        db.commit()


def _backfill_strip_unknown_when_grouped(db) -> None:
    """Drop unknown memberships when a tag also belongs to a real group."""
    from backend.app.services.tag_service import _strip_unknown_when_grouped

    unknown = db.query(TagGroup).filter(TagGroup.key == "unknown").first()
    if not unknown:
        return
    tag_ids = [
        row[0]
        for row in db.query(TagGroupLink.tag_id)
        .filter(TagGroupLink.group_id == unknown.id)
        .all()
    ]
    if not tag_ids:
        return
    for tag in db.query(Tag).filter(Tag.id.in_(tag_ids)).all():
        _strip_unknown_when_grouped(db, tag)
    db.commit()


def _backfill_known_tag_group_orders(db) -> None:
    """No-op: never rewrite existing tag_groups.sort_order (user order is authoritative).

    Known defaults are applied only when creating missing groups (seed / get_or_create).
    Kept as a named hook so init_db call sites stay stable.
    """
    return


def _ensure_ratings_score_float() -> None:
    """Migrate ratings.score INTEGER → REAL so half-star values are not truncated."""
    inspector = inspect(engine)
    if "ratings" not in inspector.get_table_names():
        return
    cols = {column["name"]: column for column in inspector.get_columns("ratings")}
    score = cols.get("score")
    if not score:
        return
    col_type = str(score.get("type", "")).upper()
    if "FLOAT" in col_type or "REAL" in col_type or "NUMERIC" in col_type or "DECIMAL" in col_type:
        return
    with engine.begin() as conn:
        conn.execute(text("PRAGMA foreign_keys=OFF"))
        conn.execute(
            text(
                """
                CREATE TABLE ratings__score_real (
                    id INTEGER NOT NULL PRIMARY KEY,
                    media_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    score REAL NOT NULL,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    CONSTRAINT uq_media_user_rating UNIQUE (media_id, user_id),
                    FOREIGN KEY(media_id) REFERENCES media_items (id),
                    FOREIGN KEY(user_id) REFERENCES users (id)
                )
                """
            )
        )
        conn.execute(
            text(
                """
                INSERT INTO ratings__score_real (id, media_id, user_id, score, updated_at)
                SELECT id, media_id, user_id, score, updated_at FROM ratings
                """
            )
        )
        conn.execute(text("DROP TABLE ratings"))
        conn.execute(text("ALTER TABLE ratings__score_real RENAME TO ratings"))
        conn.execute(text("PRAGMA foreign_keys=ON"))


def _backfill_tag_usage_counts(db) -> None:
    from backend.app.services.tag_service import recalculate_usage_counts

    recalculate_usage_counts(db)
    db.commit()


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    _ensure_media_item_columns()
    _ensure_tag_group_columns()
    _ensure_tag_columns()
    _ensure_ratings_score_float()
    db = SessionLocal()
    try:
        seed_database(db)
        _backfill_tag_usage_counts(db)
        _backfill_unknown_sort_order(db)
        _backfill_known_tag_group_orders(db)
        _backfill_tag_group_links(db)
        _backfill_strip_unknown_when_grouped(db)
        _backfill_tag_sort_orders(db)
    finally:
        db.close()


if __name__ == "__main__":
    init_db()
    print("Database initialized and seeded.")
