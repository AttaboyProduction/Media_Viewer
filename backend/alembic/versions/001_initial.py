"""Initial schema

Revision ID: 001_initial
Revises:
Create Date: 2026-08-26
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "tag_groups",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("label", sa.String(length=128), nullable=False),
        sa.Column("default_color", sa.String(length=16), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("key"),
    )
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("is_local_default", sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )
    op.create_table(
        "tags",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("group_id", sa.Integer(), nullable=True),
        sa.Column("color_override", sa.String(length=16), nullable=True),
        sa.Column("is_deleted", sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(["group_id"], ["tag_groups.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )
    op.create_index(op.f("ix_tags_name"), "tags", ["name"], unique=False)
    op.create_table(
        "media_items",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("source_post_id", sa.String(length=32), nullable=False),
        sa.Column("source_url", sa.String(length=512), nullable=False),
        sa.Column("local_path", sa.String(length=512), nullable=False),
        sa.Column("media_type", sa.String(length=16), nullable=False),
        sa.Column("is_discarded", sa.Boolean(), nullable=False),
        sa.Column("scraped_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("source_post_id"),
    )
    op.create_index(op.f("ix_media_items_source_post_id"), "media_items", ["source_post_id"], unique=False)
    op.create_table(
        "tag_aliases",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("alias_tag_id", sa.Integer(), nullable=False),
        sa.Column("canonical_tag_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["alias_tag_id"], ["tags.id"]),
        sa.ForeignKeyConstraint(["canonical_tag_id"], ["tags.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("alias_tag_id", name="uq_tag_alias_alias"),
    )
    op.create_table(
        "media_tags",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("media_id", sa.Integer(), nullable=False),
        sa.Column("tag_id", sa.Integer(), nullable=False),
        sa.Column("is_manual", sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(["media_id"], ["media_items.id"]),
        sa.ForeignKeyConstraint(["tag_id"], ["tags.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("media_id", "tag_id", name="uq_media_tag"),
    )
    op.create_table(
        "ratings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("media_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("score", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)"), nullable=False),
        sa.ForeignKeyConstraint(["media_id"], ["media_items.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("media_id", "user_id", name="uq_media_user_rating"),
    )


def downgrade() -> None:
    op.drop_table("ratings")
    op.drop_table("media_tags")
    op.drop_table("tag_aliases")
    op.drop_index(op.f("ix_media_items_source_post_id"), table_name="media_items")
    op.drop_table("media_items")
    op.drop_index(op.f("ix_tags_name"), table_name="tags")
    op.drop_table("tags")
    op.drop_table("users")
    op.drop_table("tag_groups")
