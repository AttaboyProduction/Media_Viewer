"""Scrape session history split into one panel per source.

There is still a single live job (``pipeline.scrape_status``). Its counters and
Skipped / Cancelled lists belong to ``scrape_status.source_key``. When a job for
another source starts, the previous source's numbers are parked here and the new
source's own numbers (or zeros) are loaded, so each panel keeps its own history
without a second runner. Callers hold ``pipeline.scrape_lock``.

Sources: ``local``, an installed site id (label = site name), or
``unsupported`` for raw file URLs the adapters do not know.
"""

from __future__ import annotations

SOURCE_LOCAL = "local"
SOURCE_UNSUPPORTED = "unsupported"
LOCAL_LABEL = "Local"
UNSUPPORTED_LABEL = "Unsupported"

_COUNTERS = ("total", "processed", "downloaded", "skipped", "similar")
_LISTS = ("errors", "skipped_items", "error_items", "cancelled_urls")
_SETS = (
    "counted_urls",
    "finished_urls",
    "released_urls",
    "processed_urls",
    "retry_urls",
    "accepted_urls",
)
_VALUES = ("last_gallery_url", "message", "current_url")

# Numbers of sources that are not the live one.
_archive: dict[str, dict] = {}
_labels: dict[str, str] = {}


def _fresh() -> dict:
    snap: dict = {name: 0 for name in _COUNTERS}
    snap.update({name: [] for name in _LISTS})
    snap.update({name: set() for name in _SETS})
    snap.update({"last_gallery_url": None, "message": "", "current_url": None})
    return snap


def _take(status) -> dict:
    snap: dict = {}
    for name in _COUNTERS:
        snap[name] = getattr(status, name)
    for name in _LISTS:
        snap[name] = list(getattr(status, name))
    for name in _SETS:
        snap[name] = set(getattr(status, name))
    for name in _VALUES:
        snap[name] = getattr(status, name)
    return snap


def _put(status, snap: dict) -> None:
    for name in _COUNTERS:
        setattr(status, name, snap[name])
    for name in _LISTS:
        setattr(status, name, list(snap[name]))
    for name in _SETS:
        setattr(status, name, set(snap[name]))
    for name in _VALUES:
        setattr(status, name, snap[name])


def reset(status) -> None:
    """Forget every parked source and the live source key. Counters are untouched."""
    _archive.clear()
    _labels.clear()
    status.source_key = ""
    status.source_label = ""


def label_for(key: str) -> str:
    if key == SOURCE_LOCAL:
        return LOCAL_LABEL
    if key == SOURCE_UNSUPPORTED:
        return UNSUPPORTED_LABEL
    try:
        from backend.scraper.sites import list_known_sites

        for site in list_known_sites():
            if site.get("id") == key and site.get("name"):
                return str(site["name"])
    except Exception:  # noqa: BLE001 — a label must never break status
        pass
    return _labels.get(key) or key


def activate(status, key: str, label: str = "") -> None:
    """Make ``key`` the source the live counters belong to. The job must not be running."""
    key = (key or "").strip()
    if not key:
        return
    name = label or label_for(key)
    _labels[key] = name
    current = status.source_key
    if current == key:
        status.source_label = name
        return
    parked = _archive.pop(key, None)
    if current:
        _archive[current] = _take(status)
        _put(status, parked if parked is not None else _fresh())
    elif parked is not None:
        # First job of the process: keep whatever the live status already shows
        # unless this source has parked numbers (restored after a restart).
        _put(status, parked)
    status.source_key = key
    status.source_label = name


def _without_skipped(items, *, drop_cancelled: bool, drop_other: bool):
    kept = []
    for row in items:
        cancelled = getattr(row, "reason", "") == "cancelled"
        if cancelled and drop_cancelled:
            continue
        if not cancelled and drop_other:
            continue
        kept.append(row)
    return kept, len(items) - len(kept)


def clear_panel(status, key: str | None = None, *, which: str | None = None) -> None:
    """Empty one list, or every list, for one source (``key`` omitted = every source).

    ``which`` is ``queue``, ``skipped`` (non-cancelled intentional skips), ``errors``,
    or ``cancelled``. Omitted clears all four. Downloaded counts stay.
    """
    drop_cancelled = which in (None, "cancelled")
    drop_other = which in (None, "skipped")
    drop_errors = which in (None, "errors")
    drop_queue = which in (None, "queue")

    def _apply_lists(skipped_items, cancelled_urls, skipped, errors, error_items):
        next_items, removed = _without_skipped(
            skipped_items, drop_cancelled=drop_cancelled, drop_other=drop_other
        )
        # Never leave reason=error under Skipped after a clear.
        if drop_other:
            next_items = [row for row in next_items if getattr(row, "reason", "") != "error"]
            removed = len(skipped_items) - len(next_items)
        next_cancelled = [] if drop_cancelled else list(cancelled_urls)
        next_errors = [] if drop_errors else list(errors)
        next_error_items = [] if drop_errors else list(error_items)
        return (
            next_items,
            next_cancelled,
            max(0, int(skipped) - removed),
            next_errors,
            next_error_items,
        )

    if key is None or key == status.source_key:
        (
            status.skipped_items,
            status.cancelled_urls,
            status.skipped,
            status.errors,
            status.error_items,
        ) = _apply_lists(
            status.skipped_items,
            status.cancelled_urls,
            status.skipped,
            status.errors,
            getattr(status, "error_items", []) or [],
        )
        if drop_queue:
            status.queue_urls = []
            status.pending_urls = []
        if which is None:
            status.retry_urls = set()
            status.leftover_urls = set()
    targets = list(_archive) if key is None else ([key] if key in _archive else [])
    for name in targets:
        snap = _archive[name]
        (
            snap["skipped_items"],
            snap["cancelled_urls"],
            snap["skipped"],
            snap["errors"],
            snap["error_items"],
        ) = _apply_lists(
            snap["skipped_items"],
            snap["cancelled_urls"],
            snap["skipped"],
            snap.get("errors") or [],
            snap.get("error_items") or [],
        )
        if which is None:
            snap["retry_urls"] = set()


def retry_targets(status, key: str, *, which: str | None = None) -> list[str]:
    """URLs to retry for one panel.

    ``which`` is ``skipped`` (non-cancelled skips only), ``errors`` (Errors queue),
    or omitted for both. Cancelled and Queue to scrape stay out.
    """
    key = (key or "").strip()
    if not key:
        return []
    want_skipped = which in (None, "skipped")
    want_errors = which in (None, "errors")
    if key == status.source_key:
        items = status.skipped_items if want_skipped else []
        error_items = getattr(status, "error_items", []) or [] if want_errors else []
        errors = status.errors if want_errors else []
    else:
        snap = _archive.get(key)
        if snap is None:
            return []
        items = snap.get("skipped_items") or [] if want_skipped else []
        error_items = snap.get("error_items") or [] if want_errors else []
        errors = snap.get("errors") or [] if want_errors else []
    out: list[str] = []
    seen: set[str] = set()

    def add(url: str) -> None:
        url = (url or "").strip()
        if not url or url in seen:
            return
        seen.add(url)
        out.append(url)

    for row in items:
        reason = getattr(row, "reason", "")
        if reason in {"cancelled", "error"}:
            continue
        add(getattr(row, "url", ""))
    for row in error_items:
        add(getattr(row, "url", ""))
    for item in errors:
        text = str(item or "").strip()
        if not text:
            continue
        url, sep, _detail = text.partition(": ")
        add(url if sep and url.strip() else text)
    return out


def restore(status, items: list[dict]) -> None:
    """Spread stored unfinished rows over their sources after a restart.

    Clears prior-session progress and Downloaded previously so Reload does not
    keep old downloaded/similar/errors counts. The first source becomes the live
    one; the rest are parked. Incomplete rows set ``total`` with ``processed``
    at 0 so they do not look finished.
    """
    from backend.scraper.pipeline import SkippedItem

    reset(status)
    # Drop the previous process's progress line and session download list.
    status.recent_media_ids = []
    status.downloaded = 0
    status.similar = 0
    status.errors = []
    status.error_items = []
    status.message = ""
    status.current_url = None
    status.last_gallery_url = None
    status.pending_urls = []
    status.accepted_urls = set()
    status.counted_urls = set()
    status.finished_urls = set()
    status.processed_urls = set()
    status.released_urls = set()
    status.retry_urls = set()
    status.leftover_urls = set()
    status.continue_counts = False
    status.queue_open = False
    groups: dict[str, list[dict]] = {}
    for item in items:
        key = item.get("source") or SOURCE_UNSUPPORTED
        groups.setdefault(key, []).append(item)
    status.skipped_items = []
    status.error_items = []
    status.cancelled_urls = []
    status.skipped = 0
    status.total = 0
    status.processed = 0
    first = True
    for key, rows in groups.items():
        _labels[key] = label_for(key)
        skipped = [
            SkippedItem(url=row["url"], reason=row["reason"], detail=row["detail"])
            for row in rows
            if row.get("reason") not in {"cancelled", "error"}
        ]
        error_items = [
            SkippedItem(url=row["url"], reason="error", detail=row.get("detail") or "")
            for row in rows
            if row.get("reason") == "error"
        ]
        cancelled = [row["url"] for row in rows if row["reason"] == "cancelled"]
        error_lines = [
            f"{row.url}: {row.detail}" if row.detail else row.url for row in error_items
        ]
        if first:
            first = False
            status.source_key = key
            status.source_label = _labels[key]
            status.skipped_items = skipped
            status.skipped = len(skipped)
            status.error_items = error_items
            status.errors = error_lines
            status.cancelled_urls = cancelled
            status.total = len(rows)
            status.processed = 0
            continue
        snap = _fresh()
        snap["skipped_items"] = skipped
        snap["skipped"] = len(skipped)
        snap["error_items"] = error_items
        snap["errors"] = error_lines
        snap["cancelled_urls"] = cancelled
        snap["total"] = len(rows)
        snap["processed"] = 0
        _archive[key] = snap


def drop_url(status, url: str) -> None:
    """Remove one URL from live and parked Skipped / Cancelled / counted sets."""
    from backend.app.services.scrape_leftovers import identity

    key = identity(url)
    if not key:
        return

    def _scrub(skipped_items, error_items, cancelled_urls, counted_urls, finished_urls, released_urls, errors):
        next_skipped = [row for row in skipped_items if identity(row.url) != key]
        removed = len(skipped_items) - len(next_skipped)
        next_errors_items = [row for row in error_items if identity(row.url) != key]
        next_cancelled = [item for item in cancelled_urls if identity(item) != key]
        next_counted = {item for item in counted_urls if identity(item) != key}
        next_finished = {item for item in finished_urls if identity(item) != key}
        next_released = {item for item in released_urls if identity(item) != key}
        prefix_hit = False
        next_errors = []
        for item in errors:
            text = str(item or "")
            url, sep, _ = text.partition(": ")
            check = url if sep else text
            if identity(check) == key:
                prefix_hit = True
                continue
            next_errors.append(item)
        return (
            next_skipped,
            next_errors_items,
            next_cancelled,
            next_counted,
            next_finished,
            next_released,
            next_errors,
            removed,
            prefix_hit or len(error_items) != len(next_errors_items),
        )

    (
        status.skipped_items,
        status.error_items,
        status.cancelled_urls,
        status.counted_urls,
        status.finished_urls,
        status.released_urls,
        status.errors,
        removed,
        _err_removed,
    ) = _scrub(
        status.skipped_items,
        getattr(status, "error_items", []) or [],
        status.cancelled_urls,
        status.counted_urls,
        status.finished_urls,
        status.released_urls,
        status.errors,
    )
    if removed:
        status.skipped = max(0, int(status.skipped) - removed)
    status.pending_urls = [item for item in status.pending_urls if identity(item) != key]
    if status.current_url and identity(status.current_url) == key:
        status.current_url = None
    for snap in _archive.values():
        (
            snap["skipped_items"],
            snap["error_items"],
            snap["cancelled_urls"],
            snap["counted_urls"],
            snap["finished_urls"],
            snap["released_urls"],
            snap["errors"],
            removed,
            _err_removed,
        ) = _scrub(
            snap["skipped_items"],
            snap.get("error_items") or [],
            snap["cancelled_urls"],
            snap["counted_urls"],
            snap.get("finished_urls") or set(),
            snap.get("released_urls") or set(),
            snap.get("errors") or [],
        )
        if removed:
            snap["skipped"] = max(0, int(snap["skipped"]) - removed)


def note_queued_totals(status, queues: dict[str, list[str]]) -> None:
    """After restore, fold Queue to scrape lengths into each panel's incomplete total."""
    for key, urls in queues.items():
        if not urls:
            continue
        if key == status.source_key:
            status.total = int(status.total or 0) + len(urls)
            status.processed = 0
            continue
        snap = _archive.get(key)
        if snap is None:
            snap = _fresh()
            _labels[key] = label_for(key)
            _archive[key] = snap
        snap["total"] = int(snap.get("total") or 0) + len(urls)
        snap["processed"] = 0


def _sort_key(key: str, label: str) -> tuple[int, str]:
    if key == SOURCE_LOCAL:
        return (0, "")
    if key == SOURCE_UNSUPPORTED:
        return (2, "")
    return (1, label.lower())


def panels(status, queues: dict[str, list[str]]) -> list[dict]:
    """One dict per source with activity: parked, live, or holding Queue to scrape URLs."""
    keys = set(_archive) | set(queues)
    if status.source_key:
        keys.add(status.source_key)
    out: list[dict] = []
    for key in keys:
        live = key == status.source_key
        snap = _take(status) if live else (_archive.get(key) or _fresh())
        label = status.source_label if live and status.source_label else label_for(key)
        out.append(
            {
                "key": key,
                "label": label,
                "running": bool(live and status.running),
                "total": snap["total"],
                "processed": snap["processed"],
                "downloaded": snap["downloaded"],
                "skipped": snap["skipped"],
                "similar": snap["similar"],
                "message": snap["message"],
                "current_url": snap["current_url"],
                "last_gallery_url": snap["last_gallery_url"],
                "errors": list(snap["errors"]),
                "skipped_items": [
                    {"url": row.url, "reason": row.reason, "detail": row.detail}
                    for row in snap["skipped_items"]
                    if getattr(row, "reason", "") != "error"
                ],
                "error_items": [
                    {"url": row.url, "reason": row.reason, "detail": row.detail}
                    for row in (snap.get("error_items") or [])
                ],
                "cancelled_urls": list(snap["cancelled_urls"]),
                "queue_urls": list(queues.get(key, [])),
            }
        )
    out.sort(key=lambda panel: _sort_key(panel["key"], panel["label"]))
    return out
