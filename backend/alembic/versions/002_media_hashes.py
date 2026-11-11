"""Add media hash and duplicate columns

Revision ID: 002_media_hashes
Revises: 001_initial
Create Date: 2026-08-26
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "002_media_hashes"
down_revision: Union[str, None] = "001_initial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("media_items", sa.Column("content_hash", sa.String(length=64), nullable=True))
    op.add_column("media_items", sa.Column("phash", sa.String(length=64), nullable=True))
    op.add_column("media_items", sa.Column("file_size", sa.Integer(), nullable=True))
    op.add_column("media_items", sa.Column("source_posted_at", sa.DateTime(), nullable=True))
    op.add_column("media_items", sa.Column("duplicate_of_id", sa.Integer(), nullable=True))
    op.create_index("ix_media_items_content_hash", "media_items", ["content_hash"])
    op.create_foreign_key(
        "fk_media_items_duplicate_of_id",
        "media_items",
        "media_items",
        ["duplicate_of_id"],
        ["id"],
    )


def downgrade() -> None:
    op.drop_constraint("fk_media_items_duplicate_of_id", "media_items", type_="foreignkey")
    op.drop_index("ix_media_items_content_hash", table_name="media_items")
    op.drop_column("media_items", "duplicate_of_id")
    op.drop_column("media_items", "source_posted_at")
    op.drop_column("media_items", "file_size")
    op.drop_column("media_items", "phash")
    op.drop_column("media_items", "content_hash")
