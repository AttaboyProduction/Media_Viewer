"""Identical vs similar classification, grouping, and merge.

Run:
  python -m unittest tests.test_duplicates tests.test_media_list -v
"""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from backend.app.api.media import list_duplicates
from backend.app.db.models import Base, MediaItem, MediaSourceUrl, MediaTag, Rating, Tag, User
from backend.app.services.duplicate_service import (
    keep_group_members,
    mark_related,
    mark_related_many,
    mark_related_to,
    merge_identical,
    resolve_duplicate,
)
from backend.app.services.hash_service import classify_distance, classify_video_hash, find_earlier_phash_match

BASE_TIME = datetime(2026, 1, 1, 12, 0, 0)


class ClassifyTests(unittest.TestCase):
    def test_identical_band_is_zero_through_two(self):
        self.assertEqual(classify_distance(0, 8), "identical")
        self.assertEqual(classify_distance(2, 8), "identical")
        self.assertEqual(classify_distance(3, 8), "similar")
        self.assertEqual(classify_distance(8, 8), "similar")
        self.assertIsNone(classify_distance(9, 8))

    def test_sensitivity_caps_identical_band(self):
        self.assertEqual(classify_distance(1, 1), "identical")
        self.assertIsNone(classify_distance(2, 1))

    def test_video_hash_is_identical_only(self):
        same = "v:" + ",".join(["0000000000000000"] * 4)
        close = "v:" + ",".join(["0000000000000000"] * 3 + ["0000000000000001"])
        apart = "v:" + ",".join(["0000000000000000"] * 3 + ["0000000000000007"])
        self.assertEqual(classify_video_hash(same, close, 8), "identical")
        self.assertIsNone(classify_video_hash(same, apart, 8))
        self.assertIsNone(classify_video_hash(same, "0000000000000000", 8))


class DuplicateHarness(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db: Session = sessionmaker(bind=self.engine, autoflush=False)()
        self.user = User(name="local", is_local_default=True)
        self.db.add(self.user)
        self.db.flush()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def _add(
        self,
        post_id: str,
        *,
        duplicate_of: MediaItem | None = None,
        kind: str | None = None,
        discarded: bool = False,
        size: int = 100,
        extra_url: str | None = None,
    ) -> MediaItem:
        media = MediaItem(
            source_post_id=post_id,
            source_url=f"https://example.test/post/{post_id}",
            local_path=f"media/image/{post_id}.jpg",
            media_type="image",
            is_discarded=discarded,
            file_size=size,
            scraped_at=BASE_TIME + timedelta(minutes=int(post_id, 36) % 50),
            duplicate_of_id=duplicate_of.id if duplicate_of else None,
            duplicate_kind=kind,
        )
        self.db.add(media)
        self.db.flush()
        if extra_url:
            self.db.add(MediaSourceUrl(media_id=media.id, url=extra_url))
            self.db.flush()
        return media


class GroupListTests(DuplicateHarness):
    def test_groups_split_by_kind_and_omit_discarded(self):
        primary = self._add("a")
        self._add("b", duplicate_of=primary, kind="identical")
        self._add("c", duplicate_of=primary, kind="similar")
        self._add("d", duplicate_of=primary, kind="identical", discarded=True)
        review = list_duplicates(db=self.db)
        self.assertEqual(len(review.identical), 1)
        self.assertEqual([i.source_post_id for i in review.identical[0].items], ["a", "b"])
        self.assertEqual(len(review.similar), 1)
        self.assertEqual([i.source_post_id for i in review.similar[0].items], ["a", "c"])


class MergeTests(DuplicateHarness):
    def test_merge_unions_tags_urls_and_chosen_rating(self):
        keep = self._add("keep", size=200)
        other = self._add(
            "other", duplicate_of=keep, kind="identical", size=50, extra_url="https://other.test/x"
        )
        tag = Tag(name="red", sort_order=0)
        self.db.add(tag)
        self.db.flush()
        self.db.add(MediaTag(media_id=other.id, tag_id=tag.id, is_manual=True))
        self.db.add(Rating(media_id=other.id, user_id=self.user.id, score=4.5))
        self.db.commit()

        merged = merge_identical(self.db, keep.id, [other.id], other.id)
        self.db.commit()
        self.db.refresh(keep)
        self.db.refresh(other)

        self.assertTrue(other.is_discarded)
        self.assertFalse(keep.is_discarded)
        tag_ids = [
            row.tag_id for row in self.db.query(MediaTag).filter(MediaTag.media_id == keep.id).all()
        ]
        tag_names = [
            self.db.query(Tag).filter(Tag.id == tag_id).one().name for tag_id in tag_ids
        ]
        self.assertEqual(tag_names, ["red"])
        urls = {keep.source_url, *(row.url for row in keep.source_url_rows)}
        self.assertIn("https://other.test/x", urls)
        rating = (
            self.db.query(Rating)
            .filter(Rating.media_id == keep.id, Rating.user_id == self.user.id)
            .one()
        )
        self.assertEqual(rating.score, 4.5)
        self.assertEqual(merged.id, keep.id)

    def test_merge_rejects_similar_members(self):
        keep = self._add("keep")
        similar = self._add("sim", duplicate_of=keep, kind="similar")
        with self.assertRaises(ValueError):
            merge_identical(self.db, keep.id, [similar.id], None)

    def test_unlink_and_discard(self):
        primary = self._add("p")
        child = self._add("c", duplicate_of=primary, kind="identical")
        resolve_duplicate(self.db, child.id, "keep_both")
        self.db.refresh(child)
        self.assertIsNone(child.duplicate_of_id)
        other = self._add("o", duplicate_of=primary, kind="similar")
        resolve_duplicate(self.db, other.id, "discard")
        self.db.refresh(other)
        self.assertTrue(other.is_discarded)


class HandMarkTests(DuplicateHarness):
    def test_mark_links_later_file_to_earlier(self):
        first = self._add("111")
        second = self._add("222")
        mark_related(self.db, second.id, first.id, "identical")
        self.db.refresh(first)
        self.db.refresh(second)
        self.assertIsNone(first.duplicate_of_id)
        self.assertEqual(second.duplicate_of_id, first.id)
        self.assertEqual(second.duplicate_kind, "identical")

    def test_mark_rejects_a_source_post_number(self):
        item = self._add("111")
        with self.assertRaises(ValueError):
            mark_related(self.db, item.id, 111, "identical")

    def test_mark_by_database_id_and_updates_kind(self):
        first = self._add("111")
        second = self._add("222", duplicate_of=first, kind="similar")
        mark_related(self.db, first.id, second.id, "identical")
        self.db.refresh(second)
        self.assertEqual(second.duplicate_kind, "identical")

    def test_video_frame_hash_matches_earlier_file(self):
        video_hash = "v:" + ",".join(["0000000000000000"] * 4)
        earlier = self._add("vid1")
        earlier.media_type = "video"
        earlier.phash = video_hash
        later = self._add("vid2")
        later.media_type = "video"
        later.phash = video_hash
        self.db.flush()
        match = find_earlier_phash_match(self.db, video_hash, exclude_id=later.id, threshold=8)
        self.assertIsNotNone(match)
        assert match is not None
        self.assertEqual(match[0].id, earlier.id)
        self.assertEqual(match[1], "identical")


class KeepMembersTests(DuplicateHarness):
    def test_keep_selected_discards_the_rest_of_the_card(self):
        primary = self._add("p")
        keep = self._add("k", duplicate_of=primary, kind="identical")
        drop = self._add("d", duplicate_of=primary, kind="identical")
        similar = self._add("s", duplicate_of=primary, kind="similar")
        keep_group_members(self.db, [primary.id, keep.id], [primary.id, keep.id, drop.id])
        self.db.refresh(primary)
        self.db.refresh(keep)
        self.db.refresh(drop)
        self.db.refresh(similar)
        self.assertIsNone(primary.duplicate_of_id)
        self.assertIsNone(keep.duplicate_of_id)
        self.assertTrue(drop.is_discarded)
        self.assertEqual(similar.duplicate_of_id, primary.id)
        self.assertFalse(similar.is_discarded)

    def test_bulk_mark_links_every_selected_file(self):
        first = self._add("1")
        second = self._add("2")
        third = self._add("3")
        mark_related_many(self.db, [third.id, first.id, second.id], "similar")
        self.db.refresh(first)
        self.db.refresh(second)
        self.db.refresh(third)
        self.assertIsNone(first.duplicate_of_id)
        self.assertEqual(second.duplicate_of_id, first.id)
        self.assertEqual(second.duplicate_kind, "similar")
        self.assertEqual(third.duplicate_of_id, first.id)
        self.assertEqual(third.duplicate_kind, "similar")

    def test_mark_to_anchor_links_each_selected_file(self):
        earlier = self._add("early")
        anchor = self._add("anchor")
        later = self._add("later")
        mark_related_to(self.db, anchor.id, [later.id, earlier.id, anchor.id], "similar")
        self.db.refresh(earlier)
        self.db.refresh(anchor)
        self.db.refresh(later)
        self.assertIsNone(earlier.duplicate_of_id)
        self.assertEqual(anchor.duplicate_of_id, earlier.id)
        self.assertEqual(anchor.duplicate_kind, "similar")
        self.assertEqual(later.duplicate_of_id, earlier.id)
        self.assertEqual(later.duplicate_kind, "similar")


if __name__ == "__main__":
    unittest.main()
