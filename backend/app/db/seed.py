from sqlalchemy.orm import Session

from backend.app.db.models import TagGroup, User

# key, label, color, sort_order, is_default
# Fresh installs omit Artist/Character — those appear when a scrape/API creates them.
# Unknown stays at end (999).
DEFAULT_TAG_GROUPS = [
    ("copyright", "Copyright", "#f39c12", 0, False),
    ("meta", "Meta", "#9b59b6", 1, False),
    ("system", "System", "#7f8c8d", 2, False),
    ("ai", "AI", "#8e44ad", 3, False),
    ("general", "General", "#95a5a6", 4, False),
    ("unknown", "Unknown", "#bdc3c7", 999, True),
]


def seed_database(db: Session) -> None:
    for key, label, color, sort_order, is_default in DEFAULT_TAG_GROUPS:
        existing = db.query(TagGroup).filter(TagGroup.key == key).first()
        if not existing:
            # Legacy seed used "creator" for artist.
            if key == "artist":
                legacy = db.query(TagGroup).filter(TagGroup.key == "creator").first()
                if legacy:
                    legacy.key = "artist"
                    if legacy.label.lower() in {"creator", "artist"}:
                        legacy.label = label
                    if getattr(legacy, "sort_order", None) is None or legacy.sort_order == 0:
                        legacy.sort_order = sort_order
                    continue
            db.add(
                TagGroup(
                    key=key,
                    label=label,
                    default_color=color,
                    sort_order=sort_order,
                    is_default=is_default,
                )
            )

    # Exactly one default group.
    defaults = db.query(TagGroup).filter(TagGroup.is_default.is_(True)).all()
    if not defaults:
        unknown = db.query(TagGroup).filter(TagGroup.key == "unknown").first()
        if unknown:
            unknown.is_default = True
    elif len(defaults) > 1:
        keep = next((g for g in defaults if g.key == "unknown"), defaults[0])
        for g in defaults:
            g.is_default = g.id == keep.id

    local_user = db.query(User).filter(User.is_local_default.is_(True)).first()
    if not local_user:
        db.add(User(name="local", is_local_default=True))

    db.commit()
