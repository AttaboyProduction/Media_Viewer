"""Multi-group tag memberships (tag_group_links) through tag_service + patch_tag."""

from __future__ import annotations

import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from backend.app.api.tags import build_tag_out, patch_tag
from backend.app.db.models import Base, MediaItem, Tag, TagGroup, TagGroupLink
from backend.app.schemas import TagGroupReplaceRequest, TagPatchRequest
from backend.app.services.media_service import update_media_tags
from backend.app.services.tag_service import (
    add_tag_groups,
    create_tag,
    get_or_create_tag_by_name,
    list_groups_for_tag,
    remove_tag_groups,
    replace_tag_group,
)


class MultiGroupTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db: Session = sessionmaker(bind=self.engine, autoflush=False)()
        self.general = self._group("general", 1)
        self.ai = self._group("ai", 2)
        self.meta = self._group("meta", 3)
        self.unknown = self._group("unknown", 999)
        self.unknown.is_default = True
        self.db.flush()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def _group(self, key: str, order: int) -> TagGroup:
        group = TagGroup(
            key=key,
            label=key,
            default_color="#888888",
            sort_order=order,
            is_default=False,
        )
        self.db.add(group)
        self.db.flush()
        return group

    def _keys(self, tag: Tag) -> list[str]:
        return [g.key for g in list_groups_for_tag(self.db, tag)]

    def test_create_tag_writes_links_for_all_group_ids(self):
        tag = create_tag(self.db, "multi", [self.general.id, self.ai.id])
        self.db.commit()
        self.assertEqual(tag.group_id, self.general.id)
        self.assertEqual(self._keys(tag), ["general", "ai"])

    def test_add_keeps_primary_and_appends(self):
        tag = create_tag(self.db, "solo", [self.general.id])
        add_tag_groups(self.db, tag, [self.ai.id])
        self.db.commit()
        self.assertEqual(tag.group_id, self.general.id)
        self.assertEqual(self._keys(tag), ["general", "ai"])

    def test_add_via_patch_does_not_replace(self):
        tag = create_tag(self.db, "patch_add", [self.general.id])
        self.db.commit()
        out = patch_tag(
            tag.id,
            TagPatchRequest(add_group_ids=[self.meta.id]),
            self.db,
        )
        self.assertEqual(out.group.key if out.group else None, "general")
        self.assertEqual([g.key for g in out.groups], ["general", "meta"])

    def test_replace_swaps_one_membership(self):
        tag = create_tag(self.db, "swap", [self.general.id, self.ai.id])
        replace_tag_group(self.db, tag, self.ai.id, self.meta.id)
        self.db.commit()
        self.assertEqual(tag.group_id, self.general.id)
        self.assertEqual(self._keys(tag), ["general", "meta"])

    def test_replace_primary_updates_primary(self):
        tag = create_tag(self.db, "primary_swap", [self.general.id, self.ai.id])
        out = patch_tag(
            tag.id,
            TagPatchRequest(
                replace_group=TagGroupReplaceRequest(from_id=self.general.id, to_id=self.meta.id)
            ),
            self.db,
        )
        self.assertEqual(out.group.key if out.group else None, "meta")
        self.assertEqual(sorted(g.key for g in out.groups), ["ai", "meta"])

    def test_remove_secondary_keeps_primary(self):
        tag = create_tag(self.db, "drop", [self.general.id, self.ai.id])
        remove_tag_groups(self.db, tag, [self.ai.id])
        self.db.commit()
        self.assertEqual(tag.group_id, self.general.id)
        self.assertEqual(self._keys(tag), ["general"])

    def test_adding_real_group_strips_unknown(self):
        tag = create_tag(self.db, "upgraded", [self.unknown.id])
        add_tag_groups(self.db, tag, [self.ai.id])
        self.db.commit()
        self.assertNotIn("unknown", self._keys(tag))
        self.assertEqual(self._keys(tag), ["ai"])
        self.assertEqual(tag.group_id, self.ai.id)

    def test_build_tag_out_lists_all_groups(self):
        tag = create_tag(self.db, "shown", [self.general.id, self.ai.id, self.meta.id])
        self.db.commit()
        out = build_tag_out(self.db, tag)
        self.assertEqual([g.key for g in out.groups], ["general", "ai", "meta"])
        link_count = (
            self.db.query(TagGroupLink).filter(TagGroupLink.tag_id == tag.id).count()
        )
        self.assertEqual(link_count, 3)

    def test_get_or_create_applies_group_ids_only_on_create(self):
        created = get_or_create_tag_by_name(
            self.db, "from_search", [self.ai.id, self.meta.id]
        )
        self.db.commit()
        self.assertEqual(created.group_id, self.ai.id)
        self.assertEqual(self._keys(created), ["ai", "meta"])

        again = get_or_create_tag_by_name(self.db, "from_search", [self.general.id])
        self.assertEqual(again.id, created.id)
        self.assertEqual(self._keys(again), ["ai", "meta"])

    def test_update_media_tags_passes_group_ids_for_new_tag(self):
        media = MediaItem(
            source_post_id="mg1",
            source_url="https://example.test/mg1",
            local_path="media/mg1.jpg",
            media_type="image",
        )
        self.db.add(media)
        self.db.flush()
        update_media_tags(self.db, media.id, ["picked"], [], [self.meta.id])
        self.db.commit()
        tag = self.db.query(Tag).filter(Tag.name == "picked").one()
        self.assertEqual(tag.group_id, self.meta.id)
        self.assertEqual(self._keys(tag), ["meta"])


if __name__ == "__main__":
    unittest.main()
