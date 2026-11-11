"""Order-island helpers: contiguous sort_order ranges that shift/densify independently.

Islands are derived on demand from sort_order gaps (and duplicate orders share an island).
No durable island id is stored.
"""

from __future__ import annotations

from typing import Callable, Iterable, TypeVar

ISLAND_GAP_BUMP = 10

T = TypeVar("T")


def order_islands(orders: Iterable[int]) -> list[tuple[int, int]]:
    """Inclusive (start, end) islands of contiguous integers (duplicates collapse to one value)."""
    uniq = sorted({int(o) for o in orders})
    if not uniq:
        return []
    islands: list[tuple[int, int]] = []
    start = prev = uniq[0]
    for value in uniq[1:]:
        if value == prev + 1:
            prev = value
            continue
        islands.append((start, prev))
        start = prev = value
    islands.append((start, prev))
    return islands


def island_containing(islands: list[tuple[int, int]], value: int) -> tuple[int, int] | None:
    for start, end in islands:
        if start <= value <= end:
            return start, end
    return None


def _next_island(
    islands: list[tuple[int, int]], island: tuple[int, int]
) -> tuple[int, int] | None:
    for index, current in enumerate(islands):
        if current == island and index + 1 < len(islands):
            return islands[index + 1]
    return None


def island_members(
    items: list[T],
    island: tuple[int, int],
    *,
    get_order: Callable[[T], int],
) -> list[T]:
    start, end = island
    return [item for item in items if start <= get_order(item) <= end]


def push_islands_from(
    items: list[T],
    from_order: int,
    *,
    get_order: Callable[[T], int],
    set_order: Callable[[T, int], None],
    bump: int = ISLAND_GAP_BUMP,
) -> None:
    """Add bump to every item with sort_order >= from_order (higher numbers first)."""
    ordered = sorted(items, key=lambda item: get_order(item), reverse=True)
    for item in ordered:
        value = get_order(item)
        if value >= from_order:
            set_order(item, value + bump)


def shift_to_clear(needed_end: int, next_start: int) -> int:
    """Amount to move ``next_start`` up so an island ending at needed_end keeps a 1-slot gap.

    Rounded up to a whole ``ISLAND_GAP_BUMP`` so pushed islands keep breathing room.
    """
    deficit = needed_end - (next_start - 2)
    if deficit <= 0:
        return 0
    return -(-deficit // ISLAND_GAP_BUMP) * ISLAND_GAP_BUMP


def _assign_planned_islands(
    plan: list[tuple[int, list[T]]],
    *,
    set_order: Callable[[T, int], None],
) -> None:
    """Write dense orders for pre-sorted islands, pushing later ones that would be overrun.

    ``plan`` is ascending ``(start, members)`` with members already in final order. An island
    holding duplicate orders grows when densified, so later starts shift instead of colliding.
    """
    starts = [start for start, _ in plan]
    for index in range(len(plan)):
        start = starts[index]
        members = plan[index][1]
        if index + 1 < len(plan):
            shift = shift_to_clear(start + len(members) - 1, starts[index + 1])
            if shift:
                for later in range(index + 1, len(plan)):
                    starts[later] += shift
        for offset, member in enumerate(members):
            set_order(member, start + offset)


def densify_island(
    items: list[T],
    island: tuple[int, int],
    *,
    get_order: Callable[[T], int],
    set_order: Callable[[T, int], None],
    tie_key: Callable[[T], tuple],
) -> tuple[int, int]:
    """Reassign orders inside an island to start .. start+n-1. Returns new (start, end)."""
    start, end = island
    members = island_members(items, island, get_order=get_order)
    members.sort(key=lambda item: (get_order(item), *tie_key(item)))
    for offset, item in enumerate(members):
        set_order(item, start + offset)
    if not members:
        return start, start - 1
    return start, start + len(members) - 1


def densify_all_islands(
    items: list[T],
    *,
    get_order: Callable[[T], int],
    set_order: Callable[[T, int], None],
    tie_key: Callable[[T], tuple],
) -> None:
    """Densify each contiguous island in place (fixes holes and duplicate orders)."""
    if not items:
        return
    # Plan (and sort) before mutating so growth cannot absorb the next island mid-pass.
    plan: list[tuple[int, list[T]]] = []
    for island in order_islands(get_order(item) for item in items):
        members = island_members(items, island, get_order=get_order)
        members.sort(key=lambda item: (get_order(item), *tie_key(item)))
        plan.append((island[0], members))
    _assign_planned_islands(plan, set_order=set_order)


def has_duplicate_orders(items: list[T], *, get_order: Callable[[T], int]) -> bool:
    seen: set[int] = set()
    for item in items:
        value = get_order(item)
        if value in seen:
            return True
        seen.add(value)
    return False


def reindex_islands_by_name(
    items: list[T],
    *,
    get_order: Callable[[T], int],
    set_order: Callable[[T, int], None],
    name_key: Callable[[T], str],
    tie_key: Callable[[T], tuple],
    name_sort_key: Callable[[T], tuple] | None = None,
) -> int:
    """Alphabetize within each existing island; preserve island starts/gaps. Returns change count."""
    if not items:
        return 0
    plan: list[tuple[int, list[T]]] = []
    for island in order_islands(get_order(item) for item in items):
        members = island_members(items, island, get_order=get_order)
        if name_sort_key is not None:
            members.sort(key=name_sort_key)
        else:
            members.sort(key=lambda item: (name_key(item), *tie_key(item)))
        plan.append((island[0], members))

    before = [(item, get_order(item)) for item in items]
    _assign_planned_islands(plan, set_order=set_order)
    return sum(1 for item, old_order in before if get_order(item) != old_order)


def move_within_island(
    items: list[T],
    item: T,
    target: int,
    *,
    get_order: Callable[[T], int],
    set_order: Callable[[T, int], None],
    get_id: Callable[[T], int],
    tie_key: Callable[[T], tuple],
) -> None:
    """Swap-shift an item inside its island (keeps the island dense; no split)."""
    islands = order_islands(get_order(peer) for peer in items)
    old = int(get_order(item))
    island = island_containing(islands, old)
    if island is None:
        set_order(item, int(target))
        return
    start, end = island
    dest = int(target)
    # "After last" from DnD uses end+1 — treat as move to last slot.
    if dest == end + 1:
        dest = end
    dest = max(start, min(dest, end))
    if dest == old:
        return
    for other in items:
        if get_id(other) == get_id(item):
            continue
        value = int(get_order(other))
        if not (start <= value <= end):
            continue
        if dest < old and dest <= value < old:
            set_order(other, value + 1)
        elif dest > old and old < value <= dest:
            set_order(other, value - 1)
    set_order(item, dest)
    densify_island(
        items,
        island,
        get_order=get_order,
        set_order=set_order,
        tie_key=tie_key,
    )


def insert_into_island(
    items: list[T],
    new_item: T,
    target: int,
    *,
    get_order: Callable[[T], int],
    set_order: Callable[[T, int], None],
    get_id: Callable[[T], int],
    tie_key: Callable[[T], tuple],
) -> None:
    """Insert new_item at target, shifting only within the affected island.

    Inserting *before* an island with ``start - 1`` free places there without
    shifting (joins into one contiguous island).
    """
    others = [item for item in items if get_id(item) != get_id(new_item)]
    islands = order_islands(get_order(item) for item in others)
    target = int(target)

    # Drop-before first row (target == start), or explicit start-1: join at start-1.
    # start-1 is free by definition — an occupied slot there would be part of the island.
    for start, _end in islands:
        if target in (start, start - 1):
            set_order(new_item, start - 1)
            return

    island = island_containing(islands, target)
    if island is None:
        for start, end in islands:
            # Join when landing on end+1 (after last) — extend that island.
            if target == end + 1:
                island = (start, end)
                break

    if island is None:
        set_order(new_item, target)
        return

    start, end = island
    following = _next_island(islands, island)
    for item in others:
        order = get_order(item)
        if start <= order <= end and order >= target:
            set_order(item, order + 1)
    set_order(new_item, target)
    new_island = densify_island(
        others + [new_item],
        (start, end + 1),
        get_order=get_order,
        set_order=set_order,
        tie_key=tie_key,
    )
    if following is not None:
        shift = shift_to_clear(new_island[1], following[0])
        if shift:
            push_islands_from(
                others + [new_item],
                following[0],
                get_order=get_order,
                set_order=set_order,
                bump=shift,
            )


def densify_island_after_removal(
    items: list[T],
    removed_order: int,
    *,
    get_order: Callable[[T], int],
    set_order: Callable[[T, int], None],
    get_id: Callable[[T], int],
    tie_key: Callable[[T], tuple],
    preserve_when_removing_start: bool = False,
) -> None:
    """After deleting/soft-deleting an item, densify only the island it belonged to.

    If ``preserve_when_removing_start`` and the removed order was the island's first
    slot, leave a hole so later numbers (e.g. unknown at 999) are not pulled down.
    """
    islands = order_islands([get_order(item) for item in items] + [removed_order])
    island = island_containing(islands, removed_order)
    if island is None:
        return
    if preserve_when_removing_start and removed_order == island[0]:
        return
    # Removal only shrinks an island, so no later island can be overrun.
    densify_island(
        items,
        island,
        get_order=get_order,
        set_order=set_order,
        tie_key=tie_key,
    )


def move_across_islands(
    items: list[T],
    item: T,
    target: int,
    *,
    get_order: Callable[[T], int],
    set_order: Callable[[T, int], None],
    get_id: Callable[[T], int],
    tie_key: Callable[[T], tuple],
) -> None:
    """Move an existing item to target: within-island swap, or lift+insert across islands."""
    old = int(get_order(item))
    target = int(target)
    if old == target:
        densify_all_islands(items, get_order=get_order, set_order=set_order, tie_key=tie_key)
        return

    islands = order_islands(get_order(peer) for peer in items)
    old_island = island_containing(islands, old)
    if old_island is not None:
        start, end = old_island
        if start <= target <= end:
            move_within_island(
                items,
                item,
                target,
                get_order=get_order,
                set_order=set_order,
                get_id=get_id,
                tie_key=tie_key,
            )
            return
        # DnD "after last" (end+1): stay within-island only when not filling a 1-slot
        # gap toward the next island (end+2). Filling that gap should join via insert.
        if target == end + 1:
            following = _next_island(islands, old_island)
            if following is None or following[0] > end + 2:
                move_within_island(
                    items,
                    item,
                    target,
                    get_order=get_order,
                    set_order=set_order,
                    get_id=get_id,
                    tie_key=tie_key,
                )
                return

    others = [peer for peer in items if get_id(peer) != get_id(item)]
    densify_island_after_removal(
        others,
        old,
        get_order=get_order,
        set_order=set_order,
        get_id=get_id,
        tie_key=tie_key,
        preserve_when_removing_start=True,
    )
    insert_into_island(
        others + [item],
        item,
        target,
        get_order=get_order,
        set_order=set_order,
        get_id=get_id,
        tie_key=tie_key,
    )
