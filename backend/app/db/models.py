from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class TagGroup(Base):
    __tablename__ = "tag_groups"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    key: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    label: Mapped[str] = mapped_column(String(128), nullable=False)
    default_color: Mapped[str] = mapped_column(String(16), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    tags: Mapped[list["Tag"]] = relationship(back_populates="group", passive_deletes=True)
    tag_links: Mapped[list["TagGroupLink"]] = relationship(
        back_populates="group",
        cascade="all, delete-orphan",
    )


class Tag(Base):
    __tablename__ = "tags"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(256), unique=True, nullable=False, index=True)
    group_id: Mapped[int | None] = mapped_column(
        ForeignKey("tag_groups.id", ondelete="SET NULL"),
        nullable=True,
    )
    color_override: Mapped[str | None] = mapped_column(String(16), nullable=True)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    usage_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    group: Mapped[TagGroup | None] = relationship(back_populates="tags")
    group_links: Mapped[list["TagGroupLink"]] = relationship(
        back_populates="tag",
        cascade="all, delete-orphan",
    )
    media_links: Mapped[list["MediaTag"]] = relationship(back_populates="tag")
    aliases_from: Mapped[list["TagAlias"]] = relationship(
        foreign_keys="TagAlias.alias_tag_id",
        back_populates="alias_tag",
    )
    aliases_to: Mapped[list["TagAlias"]] = relationship(
        foreign_keys="TagAlias.canonical_tag_id",
        back_populates="canonical_tag",
    )


class TagGroupLink(Base):
    """Many-to-many: a tag can belong to multiple groups (primary is Tag.group_id)."""

    __tablename__ = "tag_group_links"
    __table_args__ = (UniqueConstraint("tag_id", "group_id", name="uq_tag_group_link"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tag_id: Mapped[int] = mapped_column(ForeignKey("tags.id", ondelete="CASCADE"), nullable=False)
    group_id: Mapped[int] = mapped_column(
        ForeignKey("tag_groups.id", ondelete="CASCADE"),
        nullable=False,
    )

    tag: Mapped[Tag] = relationship(back_populates="group_links")
    group: Mapped[TagGroup] = relationship(back_populates="tag_links")


class TagAlias(Base):
    __tablename__ = "tag_aliases"
    __table_args__ = (UniqueConstraint("alias_tag_id", name="uq_tag_alias_alias"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    alias_tag_id: Mapped[int] = mapped_column(ForeignKey("tags.id"), nullable=False)
    canonical_tag_id: Mapped[int] = mapped_column(ForeignKey("tags.id"), nullable=False)

    alias_tag: Mapped[Tag] = relationship(
        foreign_keys=[alias_tag_id],
        back_populates="aliases_from",
    )
    canonical_tag: Mapped[Tag] = relationship(
        foreign_keys=[canonical_tag_id],
        back_populates="aliases_to",
    )


class MediaItem(Base):
    __tablename__ = "media_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_post_id: Mapped[str] = mapped_column(String(32), unique=True, nullable=False, index=True)
    source_url: Mapped[str] = mapped_column(String(512), nullable=False)
    # managed: relative under project media/; linked: absolute PC path (SQLite stores as TEXT).
    local_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    # managed = copied under media/; linked = original file left in place on disk.
    storage_kind: Mapped[str] = mapped_column(String(16), default="managed", nullable=False)
    media_type: Mapped[str] = mapped_column(String(16), nullable=False)
    is_discarded: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    content_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    phash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    file_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source_posted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    duplicate_of_id: Mapped[int | None] = mapped_column(ForeignKey("media_items.id"), nullable=True)
    duplicate_kind: Mapped[str | None] = mapped_column(String(16), nullable=True)
    scraped_at: Mapped[datetime] = mapped_column(
        DateTime,
        server_default=func.now(),
        nullable=False,
    )

    tag_links: Mapped[list["MediaTag"]] = relationship(back_populates="media")
    ratings: Mapped[list["Rating"]] = relationship(back_populates="media")
    source_url_rows: Mapped[list["MediaSourceUrl"]] = relationship(
        back_populates="media",
        cascade="all, delete-orphan",
    )
    duplicate_of: Mapped["MediaItem | None"] = relationship(
        remote_side="MediaItem.id",
        foreign_keys=[duplicate_of_id],
    )


class MediaSourceUrl(Base):
    __tablename__ = "media_source_urls"
    __table_args__ = (UniqueConstraint("media_id", "url", name="uq_media_source_url"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    media_id: Mapped[int] = mapped_column(ForeignKey("media_items.id"), nullable=False)
    url: Mapped[str] = mapped_column(String(512), nullable=False)

    media: Mapped["MediaItem"] = relationship(back_populates="source_url_rows")


class MediaTag(Base):
    __tablename__ = "media_tags"
    __table_args__ = (UniqueConstraint("media_id", "tag_id", name="uq_media_tag"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    media_id: Mapped[int] = mapped_column(ForeignKey("media_items.id"), nullable=False)
    tag_id: Mapped[int] = mapped_column(ForeignKey("tags.id"), nullable=False)
    is_manual: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    media: Mapped[MediaItem] = relationship(back_populates="tag_links")
    tag: Mapped[Tag] = relationship(back_populates="media_links")


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    is_local_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    ratings: Mapped[list["Rating"]] = relationship(back_populates="user")


class Rating(Base):
    __tablename__ = "ratings"
    __table_args__ = (UniqueConstraint("media_id", "user_id", name="uq_media_user_rating"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    media_id: Mapped[int] = mapped_column(ForeignKey("media_items.id"), nullable=False)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    score: Mapped[float] = mapped_column(Float, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    media: Mapped[MediaItem] = relationship(back_populates="ratings")
    user: Mapped[User] = relationship(back_populates="ratings")
