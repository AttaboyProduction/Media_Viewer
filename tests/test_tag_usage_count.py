"""Stored tag usage_count stays in step with media links."""

from __future__ import annotations

import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from backend.app.api.tags import build_tag_out, post_recalculate_usage
from backend.app.db.models import Base, MediaItem, Tag, TagGroup
from backend.app.services.media_service import delete_media, update_media_tags
from backend.app.services.tag_service import create_tag


class TagUsageCountTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db: Session = sessionmaker(bind=self.engine, autoflush=False)()
        self.group = TagGroup(key="general", label="General", default_color="#3498db", sort_order=1)
        self.db.add(self.group)
        self.db.flush()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def _media(self, post_id: str) -> MediaItem:
        media = MediaItem(
            source_post_id=post_id,
            source_url=f"https://example.test/{post_id}",
            local_path=f"media/{post_id}.jpg",
            media_type="image",
        )
        self.db.add(media)
        self.db.flush()
        return media

    def test_add_and_remove_adjust_stored_count(self) -> None:
        tag = create_tag(self.db, "blue", [self.group.id])
        media = self._media("1")
        update_media_tags(self.db, media.id, ["blue"], [])
        self.db.refresh(tag)
        self.assertEqual(tag.usage_count, 1)
        self.assertEqual(build_tag_out(self.db, tag).usage_count, 1)

        update_media_tags(self.db, media.id, [], ["blue"])
        self.db.refresh(tag)
        self.assertEqual(tag.usage_count, 0)

    def test_delete_media_decrements_count(self) -> None:
        create_tag(self.db, "blue", [self.group.id])
        media = self._media("2")
        update_media_tags(self.db, media.id, ["blue"], [])
        delete_media(self.db, media.id)
        tag = self.db.query(Tag).filter(Tag.name == "blue").one()
        self.assertEqual(tag.usage_count, 0)

    def test_recalculate_rebuilds_from_links(self) -> None:
        tag = create_tag(self.db, "blue", [self.group.id])
        media = self._media("3")
        update_media_tags(self.db, media.id, ["blue"], [])
        tag.usage_count = 0
        self.db.flush()
        result = post_recalculate_usage(self.db)
        self.db.refresh(tag)
        self.assertEqual(result["updated"], 1)
        self.assertEqual(tag.usage_count, 1)
