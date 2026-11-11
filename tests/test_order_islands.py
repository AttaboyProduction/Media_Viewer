"""Auto-tests for island-aware sort_order through the entry points the app uses.

Backend: ``tag_service`` (``set_tag_*_sort_order``, ``insert_tag_*_sort_order``,
``soft_delete_tag``, ``repair_duplicate_sort_orders``, ``reindex_*_by_name``) on real
SQLAlchemy models in an in-memory DB — no parallel reorder implementation.
Frontend mirror: ``frontend/src/utils/rowReorder.selftest.ts``.

Run:
  python -m unittest tests.test_order_islands -v
  scripts\\run_order_tests.bat
"""

from __future__ import annotations

import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from backend.app.db.models import Base, Tag, TagGroup
from backend.app.services.order_islands import order_islands, shift_to_clear
from backend.app.services.tag_service import (
    insert_tag_group_sort_order,
    insert_tag_sort_order,
    merge_tag_groups,
    reindex_tag_groups_by_name,
    reindex_tags_by_name,
    repair_duplicate_sort_orders,
    set_tag_group_sort_order,
    set_tag_sort_order,
    soft_delete_tag,
)


def _groups(db: Session) -> list[TagGroup]:
    return db.query(TagGroup).order_by(TagGroup.sort_order, TagGroup.id).all()


def _tags(db: Session, group_id: int | None) -> list[Tag]:
    scope = Tag.group_id.is_(None) if group_id is None else Tag.group_id == group_id
    return (
        db.query(Tag)
        .filter(Tag.is_deleted.is_(False), scope)
        .order_by(Tag.sort_order, Tag.id)
        .all()
    )


def _islands(rows: list[TagGroup] | list[Tag]) -> list[tuple[int, int]]:
    return order_islands(int(row.sort_order) for row in rows)


class DbTestCase(unittest.TestCase):
    """In-memory SQLite; exercises real models + tag_service (no network, no data/app.db)."""

    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine, autoflush=False)()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def _add_group(self, key: str, sort_order: int, *, label: str | None = None) -> TagGroup:
        group = TagGroup(
            key=key,
            label=label if label is not None else key,
            default_color="#888888",
            sort_order=sort_order,
            is_default=False,
        )
        self.db.add(group)
        self.db.flush()
        return group

    def _add_tag(
        self,
        name: str,
        group_id: int | None,
        sort_order: int,
        *,
        is_deleted: bool = False,
    ) -> Tag:
        tag = Tag(name=name, group_id=group_id, sort_order=sort_order, is_deleted=is_deleted)
        self.db.add(tag)
        self.db.flush()
        return tag

    # Assertion helpers -------------------------------------------------
    def assertGroups(self, keys: list[str], orders: list[int]) -> None:
        rows = _groups(self.db)
        self.assertEqual([g.key for g in rows], keys)
        self.assertEqual([int(g.sort_order) for g in rows], orders)

    def assertTags(self, group_id: int | None, names: list[str], orders: list[int]) -> None:
        rows = _tags(self.db, group_id)
        self.assertEqual([t.name for t in rows], names)
        self.assertEqual([int(t.sort_order) for t in rows], orders)

    def assertGroupIslands(self, islands: list[tuple[int, int]]) -> None:
        self.assertEqual(_islands(_groups(self.db)), islands)

    def assertNoDuplicateOrders(self, rows: list[TagGroup] | list[Tag]) -> None:
        orders = [int(row.sort_order) for row in rows]
        self.assertEqual(len(set(orders)), len(orders), f"duplicate sort_order in {orders}")


class OrderIslandDerivationTests(unittest.TestCase):
    """Pure helper behind every island decision (empty / single / gaps / duplicates)."""

    def test_empty_single_gaps_duplicates(self):
        self.assertEqual(order_islands([]), [])
        self.assertEqual(order_islands([5]), [(5, 5)])
        self.assertEqual(order_islands([1, 2, 3, 10, 11, 999]), [(1, 3), (10, 11), (999, 999)])
        self.assertEqual(order_islands([2, 2, 3, 3]), [(2, 3)])


class ReportedRegressionTests(DbTestCase):
    """Bugs reported against the Tags / Tag groups order UI."""

    def test_drop_before_late_island_joins_at_start_minus_one(self):
        # Move 10 before 9998/9999 (UI target = 9998) → 9997, one island, island not shifted.
        moved = self._add_group("a", 10)
        self._add_group("b", 9998)
        self._add_group("c", 9999)
        set_tag_group_sort_order(self.db, moved, 9998)
        self.assertGroups(["a", "b", "c"], [9997, 9998, 9999])
        self.assertGroupIslands([(9997, 9999)])

    def test_within_island_move_after_last_stays_dense(self):
        # 1..4, move 3 after 4 (UI target = 5) → still one island, no +1 overshoot.
        self._add_group("g1", 1)
        self._add_group("g2", 2)
        moved = self._add_group("g3", 3)
        self._add_group("g4", 4)
        set_tag_group_sort_order(self.db, moved, 5)
        self.assertGroups(["g1", "g2", "g4", "g3"], [1, 2, 3, 4])
        self.assertGroupIslands([(1, 4)])

    def test_manual_gap_fill_joins_next_island(self):
        # Typing 997 into the 1-slot gap left of 998/999 must join, not clamp back.
        moved = self._add_group("near", 996)
        self._add_group("x", 998)
        self._add_group("y", 999)
        set_tag_group_sort_order(self.db, moved, 997)
        self.assertGroups(["near", "x", "y"], [997, 998, 999])
        self.assertGroupIslands([(997, 999)])

    def test_insert_into_joined_island_has_no_duplicate_or_bump(self):
        # Then moving 10 after 997 → dense 997..1000 (previously produced 997/997/1008/1009).
        self._add_group("near", 997)
        self._add_group("x", 998)
        self._add_group("y", 999)
        moved = self._add_group("early", 10)
        set_tag_group_sort_order(self.db, moved, 998)
        self.assertGroups(["near", "early", "x", "y"], [997, 998, 999, 1000])
        self.assertGroupIslands([(997, 1000)])


class GroupOrderTests(DbTestCase):
    def test_insert_new_group_at_order(self):
        self._add_group("a", 1)
        self._add_group("b", 2)
        new = self._add_group("mid", 0)
        insert_tag_group_sort_order(self.db, new, 2)
        self.assertGroups(["a", "mid", "b"], [1, 2, 3])

    def test_insert_overflow_pushes_following_island(self):
        # Growing (1,2) into 1..3 collides with (4,5) → later island bumped +10.
        self._add_group("a", 1)
        self._add_group("b", 2)
        self._add_group("c", 4)
        self._add_group("d", 5)
        new = self._add_group("n", 0)
        insert_tag_group_sort_order(self.db, new, 2)
        self.assertGroups(["a", "n", "b", "c", "d"], [1, 2, 3, 14, 15])
        self.assertGroupIslands([(1, 3), (14, 15)])

    def test_after_last_far_from_next_island_stays_within_island(self):
        moved = self._add_group("g1", 1)
        self._add_group("g2", 2)
        self._add_group("g3", 3)
        self._add_group("late", 100)
        set_tag_group_sort_order(self.db, moved, 4)
        self.assertGroups(["g2", "g3", "g1", "late"], [1, 2, 3, 100])
        self.assertGroupIslands([(1, 3), (100, 100)])

    def test_drop_before_shifts_when_adjacent_slot_taken(self):
        self._add_group("prev", 9)
        self._add_group("t0", 10)
        self._add_group("t1", 11)
        moved = self._add_group("moved", 1)
        set_tag_group_sort_order(self.db, moved, 10)
        self.assertGroups(["prev", "moved", "t0", "t1"], [9, 10, 11, 12])

    def test_move_to_same_order_is_a_noop(self):
        self._add_group("a", 1)
        stay = self._add_group("b", 2)
        self._add_group("c", 3)
        set_tag_group_sort_order(self.db, stay, 2)
        self.assertGroups(["a", "b", "c"], [1, 2, 3])


class TagOrderTests(DbTestCase):
    def test_move_and_insert_stay_inside_the_tag_group(self):
        group = self._add_group("chars", 0)
        other = self._add_group("other", 1)
        self._add_tag("neighbour", other.id, 9998)
        moved = self._add_tag("early", group.id, 10)
        self._add_tag("late_a", group.id, 9998)
        self._add_tag("late_b", group.id, 9999)
        set_tag_sort_order(self.db, moved, 9998)
        self.assertTags(group.id, ["early", "late_a", "late_b"], [9997, 9998, 9999])
        self.assertTags(other.id, ["neighbour"], [9998])

    def test_insert_shifts_only_own_group_island(self):
        group = self._add_group("g", 0)
        other = self._add_group("h", 1)
        self._add_tag("a", group.id, 1)
        self._add_tag("b", group.id, 2)
        self._add_tag("c", group.id, 3)
        self._add_tag("z", other.id, 1)
        new = self._add_tag("new", group.id, 0)
        insert_tag_sort_order(self.db, new, 2)
        self.assertTags(group.id, ["a", "new", "b", "c"], [1, 2, 3, 4])
        self.assertTags(other.id, ["z"], [1])

    def test_untyped_tags_are_their_own_scope(self):
        group = self._add_group("g", 0)
        self._add_tag("grouped", group.id, 1)
        moved = self._add_tag("free_a", None, 10)
        self._add_tag("free_b", None, 20)
        self._add_tag("free_c", None, 21)
        set_tag_sort_order(self.db, moved, 20)
        self.assertTags(None, ["free_a", "free_b", "free_c"], [19, 20, 21])
        self.assertTags(group.id, ["grouped"], [1])

    def test_soft_deleted_tags_do_not_occupy_order_slots(self):
        group = self._add_group("g", 0)
        self._add_tag("ghost", group.id, 2, is_deleted=True)
        moved = self._add_tag("a", group.id, 10)
        self._add_tag("b", group.id, 20)
        self._add_tag("c", group.id, 21)
        set_tag_sort_order(self.db, moved, 20)
        # The deleted row at 2 is invisible to ordering; live tags join at 19.
        self.assertTags(group.id, ["a", "b", "c"], [19, 20, 21])

    def test_soft_delete_densifies_its_island_only(self):
        group = self._add_group("g", 0)
        self._add_tag("a", group.id, 1)
        gone = self._add_tag("b", group.id, 2)
        self._add_tag("c", group.id, 3)
        self._add_tag("far", group.id, 50)
        soft_delete_tag(self.db, gone.id)
        self.assertTags(group.id, ["a", "c", "far"], [1, 2, 50])


class IslandGrowthTests(DbTestCase):
    """A densified island must push its neighbour instead of overlapping it."""

    def test_shift_to_clear_keeps_one_empty_slot(self):
        self.assertEqual(shift_to_clear(2, 5), 0)  # 2 .. gap .. 5 already fine
        self.assertEqual(shift_to_clear(3, 5), 0)  # end exactly two below next start
        self.assertEqual(shift_to_clear(4, 5), 10)  # would touch → bump a whole step
        self.assertEqual(shift_to_clear(20, 5), 20)  # large overrun rounds up to 20

    def test_repair_does_not_collide_duplicates_into_next_island(self):
        # Three groups share order 5 and the next island starts at 7: densifying the
        # first island needs 5..7, which used to overwrite the neighbour at 7.
        self._add_group("a", 5)
        self._add_group("b", 5)
        self._add_group("c", 5)
        self._add_group("n1", 7)
        self._add_group("n2", 8)
        repair_duplicate_sort_orders(self.db)
        rows = _groups(self.db)
        self.assertNoDuplicateOrders(rows)
        self.assertEqual([int(g.sort_order) for g in rows], [5, 6, 7, 17, 18])
        self.assertGroupIslands([(5, 7), (17, 18)])

    def test_reindex_does_not_collide_duplicates_into_next_island(self):
        self._add_group("c", 5, label="c")
        self._add_group("a", 5, label="a")
        self._add_group("b", 5, label="b")
        self._add_group("y", 7, label="y")
        self._add_group("z", 8, label="z")
        reindex_tag_groups_by_name(self.db)
        rows = _groups(self.db)
        self.assertNoDuplicateOrders(rows)
        self.assertEqual([g.key for g in rows], ["a", "b", "c", "y", "z"])
        self.assertGroupIslands([(5, 7), (17, 18)])

    def test_group_merge_keeps_tag_orders_unique(self):
        # Merged tags collide at the same orders; each island must stay separate.
        target = self._add_group("target", 1)
        source = self._add_group("source", 2)
        self._add_tag("t_a", target.id, 1)
        self._add_tag("t_b", target.id, 3)
        self._add_tag("t_c", target.id, 4)
        self._add_tag("s_a", source.id, 1)
        self._add_tag("s_b", source.id, 3)
        merge_tag_groups(self.db, [source.id], target.id)
        rows = _tags(self.db, target.id)
        self.assertNoDuplicateOrders(rows)
        self.assertEqual(len(rows), 5)


class RepairAndReindexTests(DbTestCase):
    def test_repair_densifies_duplicate_group_orders(self):
        self._add_group("c", 5)
        self._add_group("a", 5)
        self._add_group("b", 5)
        self._add_group("z", 20)
        repair_duplicate_sort_orders(self.db)
        self.assertGroupIslands([(5, 7), (20, 20)])

    def test_repair_densifies_duplicate_tag_orders_per_group(self):
        group = self._add_group("g", 0)
        other = self._add_group("h", 1)
        self._add_tag("a", group.id, 4)
        self._add_tag("b", group.id, 4)
        self._add_tag("dup_other", other.id, 7)
        self._add_tag("dup_other_2", other.id, 7)
        repair_duplicate_sort_orders(self.db)
        self.assertTags(group.id, ["a", "b"], [4, 5])
        self.assertTags(other.id, ["dup_other", "dup_other_2"], [7, 8])

    def test_reindex_groups_by_name_keeps_island_starts(self):
        self._add_group("c", 10, label="c")
        self._add_group("a", 11, label="a")
        self._add_group("b", 12, label="b")
        self._add_group("z", 100, label="z")
        self.assertGreater(reindex_tag_groups_by_name(self.db), 0)
        self.assertGroups(["a", "b", "c", "z"], [10, 11, 12, 100])

    def test_reindex_sorts_unknown_last_within_island_and_leaves_999(self):
        self._add_group("unknown", 1, label="aaa unknown")
        self._add_group("b", 2, label="bbb")
        reindex_tag_groups_by_name(self.db)
        self.assertGroups(["b", "unknown"], [1, 2])

    def test_reindex_leaves_singleton_unknown_island_at_999(self):
        self._add_group("b", 1, label="bbb")
        self._add_group("c", 2, label="ccc")
        self._add_group("unknown", 999, label="aaa unknown")
        reindex_tag_groups_by_name(self.db)
        self.assertGroups(["b", "c", "unknown"], [1, 2, 999])

    def test_reindex_tags_by_name_within_each_island(self):
        group = self._add_group("g", 0)
        self._add_tag("c", group.id, 10)
        self._add_tag("a", group.id, 11)
        self._add_tag("b", group.id, 12)
        self._add_tag("y", group.id, 100)
        self._add_tag("x", group.id, 101)
        reindex_tags_by_name(self.db)
        self.assertTags(group.id, ["a", "b", "c", "x", "y"], [10, 11, 12, 100, 101])


if __name__ == "__main__":
    unittest.main()
