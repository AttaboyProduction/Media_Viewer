"""Auto-tests for the viewer media list through the API entry point.

Backend: ``backend.app.api.media.list_media`` / ``list_duplicates`` on real SQLAlchemy
models in an in-memory DB — the same functions FastAPI calls, so filter, sort, paging
and summary-building behaviour is locked, including the batched (non N+1) page build.

Run:
  python -m unittest tests.test_media_list -v
  scripts\\run_order_tests.bat
"""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from backend.app.api.media import list_duplicates, list_media, post_bulk_action, post_bulk_tags
from backend.app.schemas import MediaBulkActionRequest, MediaBulkTagsRequest
from backend.app.db.models import (
    Base,
    MediaItem,
    MediaSourceUrl,
    MediaTag,
    Rating,
    Tag,
    TagAlias,
    TagGroup,
    User,
)

BASE_TIME = datetime(2026, 1, 1, 12, 0, 0)


class MediaListTestCase(unittest.TestCase):
    """In-memory SQLite; no network and no data/app.db."""

    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db: Session = sessionmaker(bind=self.engine, autoflush=False)()
        self.query_count = 0

        @event.listens_for(self.engine, "before_cursor_execute")
        def _count(conn, cursor, statement, parameters, context, executemany):  # noqa: ANN001
            self.query_count += 1

        self._count_listener = _count
        self.user = User(name="local", is_local_default=True)
        self.db.add(self.user)
        self.db.flush()

    def tearDown(self) -> None:
        event.remove(self.engine, "before_cursor_execute", self._count_listener)
        self.db.close()
        self.engine.dispose()

    # Fixtures ----------------------------------------------------------
    def _add_group(self, key: str) -> TagGroup:
        group = TagGroup(key=key, label=key, default_color="#888888", sort_order=0)
        self.db.add(group)
        self.db.flush()
        return group

    def _add_tag(self, name: str, group: TagGroup | None = None) -> Tag:
        tag = Tag(name=name, group_id=group.id if group else None, sort_order=0)
        self.db.add(tag)
        self.db.flush()
        return tag

    def _add_media(
        self,
        post_id: str,
        *,
        tags: list[Tag] | None = None,
        media_type: str = "image",
        is_discarded: bool = False,
        minutes: int = 0,
        duplicate_of: MediaItem | None = None,
        extra_urls: list[str] | None = None,
    ) -> MediaItem:
        media = MediaItem(
            source_post_id=post_id,
            source_url=f"https://example.test/post/{post_id}",
            local_path=f"media/image/{post_id}.jpg",
            media_type=media_type,
            is_discarded=is_discarded,
            scraped_at=BASE_TIME + timedelta(minutes=minutes),
            duplicate_of_id=duplicate_of.id if duplicate_of else None,
        )
        self.db.add(media)
        self.db.flush()
        for tag in tags or []:
            self.db.add(MediaTag(media_id=media.id, tag_id=tag.id, is_manual=False))
        for url in extra_urls or []:
            self.db.add(MediaSourceUrl(media_id=media.id, url=url))
        self.db.flush()
        return media

    def _rate(self, media: MediaItem, score: float, user: User | None = None) -> None:
        self.db.add(
            Rating(media_id=media.id, user_id=(user or self.user).id, score=score)
        )
        self.db.flush()

    # Helpers -----------------------------------------------------------
    def _list(self, **kwargs):
        params = {
            "page": 1,
            "page_size": 24,
            "tags": None,
            "exclude_tags": None,
            "exclude_tag_groups": None,
            "media_type": None,
            "min_rating": None,
            "include_discarded": False,
            "exclude_id": None,
            "sort": "date_desc",
            "db": self.db,
        }
        params.update(kwargs)
        return list_media(**params)

    def _post_ids(self, **kwargs) -> list[str]:
        return [item.source_post_id for item in self._list(**kwargs).items]


class FilterTests(MediaListTestCase):
    def test_discarded_items_are_hidden_unless_requested(self):
        self._add_media("keep")
        self._add_media("gone", is_discarded=True)

        self.assertEqual(self._post_ids(), ["keep"])
        result = self._list(include_discarded=True)
        self.assertEqual(result.total, 2)
        self.assertEqual({item.source_post_id for item in result.items}, {"keep", "gone"})

    def test_media_type_and_min_rating_filters(self):
        image = self._add_media("img", media_type="image")
        video = self._add_media("vid", media_type="video")
        self._rate(image, 2)
        self._rate(video, 5)

        self.assertEqual(self._post_ids(media_type="video"), ["vid"])
        self.assertEqual(self._post_ids(min_rating=4), ["vid"])
        self.assertEqual(sorted(self._post_ids(min_rating=1)), ["img", "vid"])

    def test_tag_filter_requires_every_tag(self):
        red = self._add_tag("red")
        blue = self._add_tag("blue")
        self._add_media("both", tags=[red, blue])
        self._add_media("red_only", tags=[red])
        self._add_media("blue_only", tags=[blue])
        self._add_media("untagged")

        self.assertEqual(sorted(self._post_ids(tags="red")), ["both", "red_only"])
        self.assertEqual(self._post_ids(tags="red,blue"), ["both"])
        # Repeated names must not tighten the AND count.
        self.assertEqual(sorted(self._post_ids(tags="red,red")), ["both", "red_only"])
        self.assertEqual(self._post_ids(tags="red, missing"), [])
        # OR keeps any file that has at least one of the names. Unknown mode stays AND.
        self.assertEqual(
            sorted(self._post_ids(tags="red,blue", tag_mode="or")),
            ["blue_only", "both", "red_only"],
        )
        self.assertEqual(self._post_ids(tags="red,blue", tag_mode="xor"), ["both"])

    def test_soft_deleted_tags_do_not_match_filters(self):
        gone = self._add_tag("gone")
        gone.is_deleted = True
        self.db.flush()
        self._add_media("item", tags=[gone])

        self.assertEqual(self._post_ids(tags="gone"), [])
        self.assertEqual(self._post_ids(tags="gone", tag_mode="or"), [])
        # A soft-deleted tag also cannot hide media.
        self.assertEqual(self._post_ids(exclude_tags="gone"), ["item"])


class HiddenTagTests(MediaListTestCase):
    def test_exclude_tags_by_name(self):
        secret = self._add_tag("secret")
        self._add_media("hidden", tags=[secret])
        self._add_media("shown")

        self.assertEqual(self._post_ids(exclude_tags="secret"), ["shown"])

    def test_exclude_tag_groups_expands_server_side(self):
        ai_group = self._add_group("ai")
        other = self._add_group("general")
        generated = self._add_tag("ai_generated", ai_group)
        also_ai = self._add_tag("stable_diffusion", ai_group)
        safe = self._add_tag("landscape", other)
        self._add_media("ai_one", tags=[generated])
        self._add_media("ai_two", tags=[also_ai])
        self._add_media("clean", tags=[safe])
        self._add_media("untyped")

        result = self._list(exclude_tag_groups="ai")
        self.assertEqual(sorted(item.source_post_id for item in result.items), ["clean", "untyped"])
        self.assertEqual(result.total, 2)
        # Unknown group keys hide nothing.
        self.assertEqual(len(self._list(exclude_tag_groups="nope").items), 4)

    def test_names_and_groups_are_combined(self):
        ai_group = self._add_group("ai")
        generated = self._add_tag("ai_generated", ai_group)
        by_name = self._add_tag("roblox")
        self._add_media("by_group", tags=[generated])
        self._add_media("by_name", tags=[by_name])
        self._add_media("kept")

        self.assertEqual(
            self._post_ids(exclude_tags="roblox", exclude_tag_groups="ai"), ["kept"]
        )

    def test_alias_of_a_hidden_tag_also_hides_media(self):
        ai_group = self._add_group("ai")
        canonical = self._add_tag("ai_generated", ai_group)
        alias = self._add_tag("aigen")
        self.db.add(TagAlias(alias_tag_id=alias.id, canonical_tag_id=canonical.id))
        self.db.flush()
        # Only the alias row is linked to the media.
        self._add_media("via_alias", tags=[alias])
        self._add_media("kept")

        self.assertEqual(self._post_ids(exclude_tag_groups="ai"), ["kept"])
        self.assertEqual(self._post_ids(exclude_tags="ai_generated"), ["kept"])

    def test_secondary_group_membership_hides_media(self):
        from backend.app.db.models import TagGroupLink
        from backend.app.services.tag_service import ensure_tag_group_link

        ai_group = self._add_group("ai")
        general = self._add_group("general")
        tag = self._add_tag("portrait", general)
        ensure_tag_group_link(self.db, tag.id, general.id)
        ensure_tag_group_link(self.db, tag.id, ai_group.id)
        self.db.flush()
        self._add_media("also_ai", tags=[tag])
        self._add_media("clean")

        self.assertEqual(self._post_ids(exclude_tag_groups="ai"), ["clean"])
        # Primary remains general; both memberships are stored.
        self.assertEqual(tag.group_id, general.id)
        self.assertEqual(
            self.db.query(TagGroupLink)
            .filter(TagGroupLink.tag_id == tag.id)
            .count(),
            2,
        )

    def test_hidden_filters_apply_to_totals_and_paging(self):
        secret = self._add_tag("secret")
        for index in range(5):
            self._add_media(f"hidden{index}", tags=[secret], minutes=index)
        for index in range(3):
            self._add_media(f"shown{index}", minutes=10 + index)

        result = self._list(exclude_tags="secret", page_size=2)
        self.assertEqual(result.total, 3)
        self.assertEqual([item.source_post_id for item in result.items], ["shown2", "shown1"])

    def test_exclude_id_leaves_a_full_page_of_other_files(self):
        skipped = self._add_media("skip", minutes=3)
        self._add_media("m2", minutes=2)
        self._add_media("m1", minutes=1)
        self._add_media("m0", minutes=0)

        result = self._list(exclude_id=skipped.id, page_size=2)
        self.assertEqual(result.total, 3)
        self.assertEqual([item.source_post_id for item in result.items], ["m2", "m1"])
        self.assertEqual(result.page_size, 2)


class SortAndPageTests(MediaListTestCase):
    def test_date_sorts(self):
        for index in range(3):
            self._add_media(f"m{index}", minutes=index)

        self.assertEqual(self._post_ids(sort="date_desc"), ["m2", "m1", "m0"])
        self.assertEqual(self._post_ids(sort="date_asc"), ["m0", "m1", "m2"])
        # Unknown sort values fall back to newest-first.
        self.assertEqual(self._post_ids(sort="bogus"), ["m2", "m1", "m0"])

    def test_rating_sorts_use_average_and_treat_unrated_as_zero(self):
        low = self._add_media("low", minutes=0)
        high = self._add_media("high", minutes=1)
        mixed = self._add_media("mixed", minutes=2)
        self._add_media("unrated", minutes=3)
        second_user = User(name="other", is_local_default=False)
        self.db.add(second_user)
        self.db.flush()
        self._rate(low, 1)
        self._rate(high, 5)
        self._rate(mixed, 2)
        self._rate(mixed, 4, user=second_user)  # avg 3

        self.assertEqual(self._post_ids(sort="rating_desc"), ["high", "mixed", "low", "unrated"])
        self.assertEqual(self._post_ids(sort="rating_asc"), ["unrated", "low", "mixed", "high"])

    def test_random_sort_pages_the_whole_filtered_set(self):
        for index in range(7):
            self._add_media(f"m{index}", minutes=index)
        self._add_media("discarded", is_discarded=True, minutes=99)

        first = self._list(sort="random", page_size=4)
        second = self._list(sort="random", page=2, page_size=4)
        self.assertEqual(first.total, 7)
        self.assertEqual(len(first.items), 4)
        self.assertEqual(len(second.items), 3)
        self.assertNotIn("discarded", {item.source_post_id for item in first.items})

    def test_pagination_boundaries(self):
        for index in range(5):
            self._add_media(f"m{index}", minutes=index)

        first = self._list(page=1, page_size=2)
        second = self._list(page=2, page_size=2)
        third = self._list(page=3, page_size=2)
        beyond = self._list(page=4, page_size=2)

        self.assertEqual([item.source_post_id for item in first.items], ["m4", "m3"])
        self.assertEqual([item.source_post_id for item in second.items], ["m2", "m1"])
        self.assertEqual([item.source_post_id for item in third.items], ["m0"])
        self.assertEqual(beyond.items, [])
        for result in (first, second, third, beyond):
            self.assertEqual(result.total, 5)
            self.assertEqual(result.page_size, 2)

    def test_empty_database(self):
        result = self._list()
        self.assertEqual(result.total, 0)
        self.assertEqual(result.items, [])


class SummaryTests(MediaListTestCase):
    def test_summary_fields(self):
        group = self._add_group("general")
        tag = self._add_tag("landscape", group)
        media = self._add_media(
            "item",
            tags=[tag],
            extra_urls=["https://example.test/mirror", "https://example.test/post/item"],
        )
        self._rate(media, 4.5)

        summary = self._list().items[0]
        self.assertEqual(summary.media_url, "/media/image/item.jpg")
        self.assertEqual(summary.thumbnail_url, summary.media_url)
        self.assertEqual([t.name for t in summary.tags], ["landscape"])
        self.assertEqual(summary.tags[0].group.key, "general")
        self.assertEqual(summary.tags[0].color, "#888888")
        # Primary URL first, no duplicates.
        self.assertEqual(
            summary.source_urls,
            ["https://example.test/post/item", "https://example.test/mirror"],
        )
        self.assertEqual(summary.rating.my_rating, 4.5)
        self.assertEqual(summary.rating.avg_rating, 4.5)
        self.assertEqual(summary.rating.rating_count, 1)

    def test_aliased_tags_are_reported_as_canonical(self):
        canonical = self._add_tag("cat")
        alias = self._add_tag("kitty")
        self.db.add(TagAlias(alias_tag_id=alias.id, canonical_tag_id=canonical.id))
        self.db.flush()
        self._add_media("item", tags=[alias])

        self.assertEqual([t.name for t in self._list().items[0].tags], ["cat"])

    def test_deleted_canonical_keeps_the_alias_name(self):
        canonical = self._add_tag("cat")
        canonical.is_deleted = True
        alias = self._add_tag("kitty")
        self.db.add(TagAlias(alias_tag_id=alias.id, canonical_tag_id=canonical.id))
        self.db.flush()
        self._add_media("item", tags=[alias])

        self.assertEqual([t.name for t in self._list().items[0].tags], ["kitty"])

    def test_ratings_of_other_users_do_not_become_my_rating(self):
        other = User(name="other", is_local_default=False)
        self.db.add(other)
        self.db.flush()
        media = self._add_media("item")
        self._rate(media, 3, user=other)

        rating = self._list().items[0].rating
        self.assertIsNone(rating.my_rating)
        self.assertEqual(rating.avg_rating, 3)
        self.assertEqual(rating.rating_count, 1)

    def test_duplicate_pairs_are_returned_with_both_summaries(self):
        original = self._add_media("original", minutes=0)
        self._add_media("copy", minutes=1, duplicate_of=original)
        self._add_media("dangling", minutes=2, duplicate_of=None)

        review = list_duplicates(db=self.db)
        self.assertEqual(len(review.similar), 1)
        self.assertEqual(
            [item.source_post_id for item in review.similar[0].items],
            ["original", "copy"],
        )
        self.assertEqual(review.identical, [])


class QueryCountTests(MediaListTestCase):
    """Page building must stay batched — per-item summaries cost ~1500 queries per page."""

    def _queries_for_page(self, media_count: int, tags_per_media: int) -> int:
        group = self._add_group("general")
        tags = [self._add_tag(f"tag{index}", group) for index in range(tags_per_media)]
        for index in range(media_count):
            media = self._add_media(f"m{index}", tags=tags, minutes=index)
            self._rate(media, 3)
        self.db.commit()

        self.query_count = 0
        result = self._list(page_size=media_count)
        self.assertEqual(len(result.items), media_count)
        return self.query_count

    def test_query_count_does_not_grow_with_page_size(self):
        small = self._queries_for_page(1, 5)
        self.tearDown()
        self.setUp()
        large = self._queries_for_page(20, 25)

        self.assertEqual(small, large, "page build must not issue per-item queries")
        self.assertLessEqual(large, 12, f"unexpected query count for a page: {large}")


class BulkActionTests(MediaListTestCase):
    """``POST /media/bulk`` — one transaction for Scrape-page bulk discard/delete."""

    def _bulk(self, ids: list[int], action: str):
        return post_bulk_action(MediaBulkActionRequest(ids=ids, action=action), db=self.db)

    def test_discard_marks_existing_and_reports_missing(self):
        a = self._add_media("a")
        b = self._add_media("b", minutes=1)
        self.db.commit()

        result = self._bulk([a.id, b.id, 9999, a.id], "discard")

        self.assertEqual(result.processed, [a.id, b.id])
        self.assertEqual(result.missing, [9999])
        self.assertEqual(self._list().total, 0)
        self.assertEqual(self._list(include_discarded=True).total, 2)

    def test_delete_removes_rows_links_and_clears_duplicate_refs(self):
        tag = self._add_tag("kitty")
        original = self._add_media("original", tags=[tag])
        copy = self._add_media("copy", minutes=1, duplicate_of=original)
        keep = self._add_media("keep", minutes=2)
        self._rate(original, 4)
        self.db.commit()

        result = self._bulk([original.id], "delete")

        self.assertEqual(result.processed, [original.id])
        self.assertEqual(
            sorted(item.source_post_id for item in self._list().items), ["copy", "keep"]
        )
        self.assertEqual(self.db.query(MediaTag).count(), 0)
        self.assertEqual(self.db.query(Rating).count(), 0)
        self.db.refresh(copy)
        self.assertIsNone(copy.duplicate_of_id)
        self.assertIsNotNone(self.db.get(MediaItem, keep.id))

    def test_empty_or_oversized_requests_are_rejected(self):
        with self.assertRaises(ValueError):
            MediaBulkActionRequest(ids=[], action="delete")
        with self.assertRaises(ValueError):
            MediaBulkActionRequest(ids=list(range(501)), action="discard")


class BulkTagsTests(MediaListTestCase):
    """``POST /media/bulk-tags`` — add the same tags to many selected files."""

    def test_adds_tags_to_each_selected_media(self):
        existing = self._add_tag("shared")
        a = self._add_media("a", tags=[existing])
        b = self._add_media("b", minutes=1)
        self.db.commit()

        result = post_bulk_tags(
            MediaBulkTagsRequest(ids=[a.id, b.id, 9999], add=["shared", "new_tag", "shared"]),
            db=self.db,
        )

        self.assertEqual(result.processed, [a.id, b.id])
        self.assertEqual(result.missing, [9999])
        self.assertEqual(sorted(result.added_tag_names), ["new_tag", "shared"])

        names_a = {
            self.db.get(Tag, link.tag_id).name
            for link in self.db.query(MediaTag).filter(MediaTag.media_id == a.id)
        }
        names_b = {
            self.db.get(Tag, link.tag_id).name
            for link in self.db.query(MediaTag).filter(MediaTag.media_id == b.id)
        }
        self.assertEqual(names_a, {"shared", "new_tag"})
        self.assertEqual(names_b, {"shared", "new_tag"})
        # Existing link on a was not duplicated.
        self.assertEqual(
            self.db.query(MediaTag).filter(MediaTag.media_id == a.id, MediaTag.tag_id == existing.id).count(),
            1,
        )

    def test_rejects_empty_tag_list(self):
        with self.assertRaises(ValueError):
            MediaBulkTagsRequest(ids=[1], add=[])


if __name__ == "__main__":
    unittest.main()
