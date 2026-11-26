import threading

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from backend.app.api.guards import require_scrape_page
from backend.app.db.models import MediaItem
from backend.app.db.session import get_db
from backend.app.schemas import (
    LocalImportRunRequest,
    LocalPathsOut,
    MediaListOut,
    ScrapeRunRequest,
    ScrapeStatusOut,
)
from backend.app.schemas.session_settings import (
    SessionSettingsOut,
    SessionSettingsPatch,
    session_settings_out,
)
from backend.app.services import scrape_leftovers, scrape_panels
from backend.app.services.hash_backfill import backfill_status
from backend.app.services.media_service import (
    build_media_summaries,
    media_ids_for_tags,
    media_ids_with_excluded_tags,
)
from backend.scraper.job import compile_scrape_job
from backend.scraper.pipeline import (
    _release_queue,
    abandon_running_job,
    append_leftover_urls,
    _mark_retry_already_in_total,
    begin_enqueue_queue,
    begin_remote_retry,
    begin_scrape_queue,
    run_enqueue_job,
    run_job,
    scrape_lock,
    scrape_status,
)
from backend.scraper.sites import (
    SOURCE_LOCAL,
    ensure_session_settings_file,
    get_selected_scraper,
    get_selected_site,
    get_selected_source,
    list_known_scrapers,
    list_known_sites,
    list_known_sources,
    save_session_settings,
    scrapers_for_site,
)

router = APIRouter(prefix="/scrape", tags=["scrape"])


def _session_response() -> SessionSettingsOut:
    data = ensure_session_settings_file()
    sites = list_known_sites()
    scrapers = list_known_scrapers()
    selected_site = get_selected_site()
    selected_scraper = get_selected_scraper()
    return session_settings_out(
        data,
        sites,
        scrapers,
        selected_site,
        selected_scraper,
        sources=list_known_sources(),
        selected_source=get_selected_source(),
    )


def _status_out() -> ScrapeStatusOut:
    from backend.app.services import scrape_panels
    from backend.app.services.scrape_leftovers import queue_by_source, queue_urls

    scrape_status.queue_urls = queue_urls()
    return ScrapeStatusOut(
        source_key=scrape_status.source_key,
        source_label=scrape_status.source_label,
        sources=scrape_panels.panels(scrape_status, queue_by_source()),
        running=scrape_status.running,
        total=scrape_status.total,
        processed=scrape_status.processed,
        downloaded=scrape_status.downloaded,
        skipped=scrape_status.skipped,
        similar=scrape_status.similar,
        errors=scrape_status.errors,
        last_gallery_url=scrape_status.last_gallery_url,
        message=scrape_status.message,
        current_url=scrape_status.current_url,
        skipped_items=[
            {
                "url": item.url,
                "reason": item.reason,
                "detail": item.detail,
                **(
                    {"existing_media_id": int(item.existing_media_id)}
                    if getattr(item, "existing_media_id", None)
                    else {}
                ),
            }
            for item in scrape_status.skipped_items
            if item.reason != "error"
        ],
        error_items=[
            {"url": item.url, "reason": item.reason, "detail": item.detail}
            for item in getattr(scrape_status, "error_items", []) or []
        ],
        cancelled_urls=list(scrape_status.cancelled_urls),
        queue_urls=list(scrape_status.queue_urls),
        hash_backfill_running=bool(backfill_status["running"]),
        hash_backfill_total=int(backfill_status["total"]),
        hash_backfill_done=int(backfill_status["done"]),
        recent_media_ids=list(scrape_status.recent_media_ids),
        ran_this_session=bool(scrape_status.ran_this_session),
        missing_linked=[
            {"id": int(item["id"]), "path": str(item["path"])}
            for item in scrape_status.missing_linked
            if isinstance(item, dict) and item.get("id") is not None
        ],
    )


def _recent_ids_newest_first(db: Session) -> list[int]:
    """Newest-first session ids, dropping rows that no longer exist in the DB."""
    raw = list(reversed(scrape_status.recent_media_ids))
    if not raw:
        return []
    existing = {
        row[0] for row in db.query(MediaItem.id).filter(MediaItem.id.in_(raw)).all()
    }
    pruned = [media_id for media_id in raw if media_id in existing]
    # Keep append order (oldest → newest) in process state after pruning deletions.
    scrape_status.recent_media_ids = list(reversed(pruned))
    return pruned


def _start_job(job, job_id: int, remote_leftovers: list[str] | None = None) -> None:
    try:
        run_job(job)
        # Stop already counted the rest as skipped. Do not start a new download.
        if remote_leftovers and not scrape_status.cancel:
            _begin_remote_leftovers(remote_leftovers)
    except Exception as exc:
        scrape_status.errors.append(str(exc))
        scrape_status.message = f"Failed: {exc}"
        _release_queue(job_id)


def _start_enqueue_job(job, job_id: int) -> None:
    try:
        run_enqueue_job(job)
    except Exception:
        pass


@router.get("/session", response_model=SessionSettingsOut)
def get_scrape_session() -> SessionSettingsOut:
    return _session_response()


@router.patch("/session", response_model=SessionSettingsOut)
def patch_scrape_session(payload: SessionSettingsPatch) -> SessionSettingsOut:
    updates: dict = {}
    if "selected_source_id" in payload.model_fields_set:
        updates["selected_source_id"] = payload.selected_source_id
    if "selected_site_id" in payload.model_fields_set:
        updates["selected_site_id"] = payload.selected_site_id
    if "selected_scraper_id" in payload.model_fields_set:
        updates["selected_scraper_id"] = payload.selected_scraper_id
    if "local_import_folders" in payload.model_fields_set:
        updates["local_import_folders"] = payload.local_import_folders or []
    if "local_import_files" in payload.model_fields_set:
        updates["local_import_files"] = payload.local_import_files or []
    if "local_import_recursive" in payload.model_fields_set:
        updates["local_import_recursive"] = bool(payload.local_import_recursive)
    if updates:
        # Validate scraper belongs to the (possibly new) site before persisting.
        tentative = {**ensure_session_settings_file(), **updates}
        source_id = tentative.get("selected_source_id")
        # Source change also changes the site; do not validate against a stale site id.
        if source_id == SOURCE_LOCAL:
            site_id = None
        elif isinstance(source_id, str) and source_id in {s["id"] for s in list_known_sites()}:
            site_id = source_id
        else:
            site_id = tentative.get("selected_site_id")
        # Source-only change drops the old scraper in save_session_settings; do not
        # reject against a scraper that still belongs to the previous site.
        scraper_id = (
            updates["selected_scraper_id"]
            if "selected_scraper_id" in updates
            else None
            if "selected_source_id" in updates
            else tentative.get("selected_scraper_id")
        )
        known_source_ids = {s["id"] for s in list_known_sources()}
        if source_id is not None and source_id not in known_source_ids:
            raise HTTPException(status_code=400, detail=f"Unknown source: {source_id}")
        if site_id is not None and site_id not in {s["id"] for s in list_known_sites()}:
            raise HTTPException(status_code=400, detail=f"Unknown site: {site_id}")
        if scraper_id is not None and source_id != SOURCE_LOCAL:
            allowed = {s["id"] for s in scrapers_for_site(site_id)}
            if scraper_id not in allowed:
                raise HTTPException(
                    status_code=400,
                    detail="Scraper is not available for the selected site",
                )
        save_session_settings(updates)
    return _session_response()


def _filters_have_work(payload: ScrapeRunRequest) -> bool:
    """True when the form asked for a gallery, tags, dates, or URL list."""
    for item in payload.filters:
        value = (item.value or "").strip()
        if item.type == "media_type" and value in {"", "all"}:
            continue
        if item.type == "date_range" and value.replace(".", "").strip() == "":
            continue
        if value:
            return True
    return any((tag or "").strip() for tag in payload.exclude_tags)


def _with_leftovers(
    payload: ScrapeRunRequest, *, continue_counts: bool, source: str | None = None
) -> tuple[ScrapeRunRequest, bool, list[str], list[str], list[str]]:
    """Attach stored unfinished URLs and the extension queue.

    With an empty form, only those URLs run. A gallery limit must not turn two
    retries into a new listing that pushes processed past total. ``source`` keeps
    only that panel's rows (``None`` = every panel).
    """
    from backend.app.schemas import ScrapeFilterIn
    from backend.app.services.scrape_leftovers import identity, snapshot
    from backend.scraper.gallery import extract_post_id

    unfinished, queued_all = snapshot(source)
    retry_urls = [item["url"] for item in unfinished]
    retry_keys = {identity(url) for url in retry_urls}
    queued_urls = [url for url in queued_all if identity(url) not in retry_keys]
    if not retry_urls and not queued_urls:
        return payload, continue_counts, [], [], []

    retries = [url for url in retry_urls if extract_post_id(url)]
    remote_retries = [url for url in retry_urls if not extract_post_id(url)]
    queued = [url for url in queued_urls if extract_post_id(url)]
    remote_queued = [url for url in queued_urls if not extract_post_id(url)]
    remote_urls = list(dict.fromkeys(remote_retries + remote_queued))
    keep = continue_counts or scrape_status.ran_this_session
    if not _filters_have_work(payload):
        ordered = list(dict.fromkeys(retries + queued))
        if ordered:
            payload = payload.model_copy(
                update={
                    "filters": [ScrapeFilterIn(type="url", value="\n".join(ordered))],
                    "limit": 0,
                    "exclude_tags": [],
                }
            )
        return payload, keep, retries, [], remote_urls
    return payload, keep, retries, retries + queued, remote_urls


def _begin_remote_leftovers(urls: list[str], *, locked: bool = False) -> None:
    """Drain raw file leftovers through the same worker as /extension/save-file.

    ``locked`` means the caller already holds ``scrape_lock``, so this claims the
    download directly. Taking the lock again would deadlock.
    """
    from backend.app.services.scrape_leftovers import forget
    from backend.scraper.pipeline import _claim_remote_download, begin_remote_download

    claim = _claim_remote_download if locked else begin_remote_download
    for url in urls:
        if scrape_status.cancel:
            return
        mode = claim(url)
        if mode == "duplicate":
            forget(url, keep_open=True)


def start_scrape_run(
    payload: ScrapeRunRequest,
    before_start=None,
    *,
    continue_counts: bool = False,
    include_leftovers: bool = False,
    only_urls: list[str] | None = None,
) -> ScrapeStatusOut:
    """Start a scrape job in the background (409 if one is running).

    ``before_start`` runs under the scrape lock once the job is known to start
    (e.g. the extension switching the session Source to the post's site).
    """
    extra: list[str] = []
    retries: list[str] = []
    remote_leftovers: list[str] = []
    remote_only = False
    panel_key = (payload.source_key or "").strip() or None
    with scrape_lock:
        if scrape_status.running:
            raise HTTPException(status_code=409, detail="Scrape already running")
        if before_start is not None:
            before_start()
        site = get_selected_site()
        if only_urls is not None and panel_key == scrape_panels.SOURCE_UNSUPPORTED:
            ordered = list(dict.fromkeys(url.strip() for url in only_urls if url and url.strip()))
            if not ordered:
                raise HTTPException(status_code=400, detail="Nothing to retry.")
            begin_remote_retry(ordered)
            return _status_out()
        if panel_key == scrape_panels.SOURCE_UNSUPPORTED:
            # Raw-file panel: no gallery, only that panel's stored URLs.
            unfinished, queued = scrape_leftovers.snapshot(panel_key)
            remote_leftovers = list(
                dict.fromkeys([item["url"] for item in unfinished] + queued)
            )
            if not remote_leftovers:
                raise HTTPException(
                    status_code=400, detail="Nothing is queued or skipped for Unsupported."
                )
            remote_only = True
        elif only_urls is not None:
            ordered = list(dict.fromkeys(url.strip() for url in only_urls if url and url.strip()))
            if not ordered:
                raise HTTPException(status_code=400, detail="Nothing to retry.")
            if site is None or site["id"] != panel_key:
                raise HTTPException(
                    status_code=400,
                    detail="That panel's source is not the selected Source.",
                )
            from backend.app.schemas import ScrapeFilterIn

            payload = ScrapeRunRequest(
                filters=[ScrapeFilterIn(type="url", value="\n".join(ordered))],
                limit=0,
                exclude_tags=[],
                source_key=panel_key,
            )
            _mark_retry_already_in_total(ordered)
            scrape_status.ran_this_session = True
            continue_counts = True
            retries = list(ordered)
            include_leftovers = False
        elif panel_key is not None and (site is None or site["id"] != panel_key):
            raise HTTPException(
                status_code=400,
                detail="That panel's source is not the selected Source.",
            )
        elif include_leftovers:
            payload, continue_counts, retries, extra, remote_leftovers = _with_leftovers(
                payload,
                continue_counts=continue_counts,
                source=site["id"] if site else None,
            )
            remote_only = bool(remote_leftovers) and not _filters_have_work(payload)
        if remote_only:
            # Claim before releasing the lock so another Run cannot start in between.
            scrape_status.cancel = False
            _begin_remote_leftovers(remote_leftovers, locked=True)
        else:
            try:
                job = compile_scrape_job(payload)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            if site:
                # Park the previous source's numbers before this job touches them.
                scrape_panels.activate(scrape_status, site["id"], site.get("name", ""))
            scrape_status.job_id += 1
            job_id = scrape_status.job_id
            scrape_status.running = True
            scrape_status.cancel = False
            scrape_status.message = "Queued"
            begin_scrape_queue(
                job,
                site["id"] if site else None,
                continue_counts=continue_counts,
                retry_urls=set(retries),
            )
            if extra:
                append_leftover_urls(extra, set(retries))
            elif retries:
                scrape_status.leftover_urls.update(retries)
                scrape_status.leftover_urls.update(
                    url for url in scrape_status.pending_urls if url not in scrape_status.retry_urls
                )
            thread = threading.Thread(
                target=_start_job,
                args=(job, job_id, remote_leftovers),
                daemon=True,
            )
            thread.start()
    return _status_out()


@router.post("/run", response_model=ScrapeStatusOut, dependencies=[Depends(require_scrape_page)])
def post_scrape_run(payload: ScrapeRunRequest) -> ScrapeStatusOut:
    return start_scrape_run(payload, include_leftovers=True)


def start_enqueue_run(payload: ScrapeRunRequest) -> ScrapeStatusOut:
    """List matching posts into Queue to scrape without downloading."""
    panel_key = (payload.source_key or "").strip() or None
    with scrape_lock:
        if scrape_status.running:
            raise HTTPException(status_code=409, detail="Scrape already running")
        if panel_key == scrape_panels.SOURCE_UNSUPPORTED:
            raise HTTPException(
                status_code=400,
                detail="Find URLs is not available for Unsupported.",
            )
        if panel_key == scrape_panels.SOURCE_LOCAL:
            raise HTTPException(status_code=400, detail="Find URLs is not available for Local.")
        site = get_selected_site()
        if site is None:
            raise HTTPException(status_code=400, detail="Choose a site and scraper first.")
        if panel_key is not None and site["id"] != panel_key:
            raise HTTPException(
                status_code=400,
                detail="That panel's source is not the selected Source.",
            )
        if not _filters_have_work(payload):
            raise HTTPException(
                status_code=400,
                detail="Add tags, a gallery URL, or other filters before finding URLs.",
            )
        try:
            job = compile_scrape_job(payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        scrape_panels.activate(scrape_status, site["id"], site.get("name", ""))
        scrape_status.job_id += 1
        job_id = scrape_status.job_id
        scrape_status.running = True
        scrape_status.cancel = False
        scrape_status.message = "Queued"
        begin_enqueue_queue(job, site["id"])
        thread = threading.Thread(
            target=_start_enqueue_job,
            args=(job, job_id),
            daemon=True,
        )
        thread.start()
    return _status_out()


@router.post("/enqueue", response_model=ScrapeStatusOut, dependencies=[Depends(require_scrape_page)])
def post_scrape_enqueue(payload: ScrapeRunRequest) -> ScrapeStatusOut:
    return start_enqueue_run(payload)


@router.post(
    "/import/pick-files",
    response_model=LocalPathsOut,
    dependencies=[Depends(require_scrape_page)],
)
def post_import_pick_files() -> LocalPathsOut:
    from backend.app.services.native_dialogs import pick_files

    try:
        return LocalPathsOut(paths=pick_files())
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"File dialog failed: {exc}") from exc


@router.post(
    "/import/pick-folder",
    response_model=LocalPathsOut,
    dependencies=[Depends(require_scrape_page)],
)
def post_import_pick_folder() -> LocalPathsOut:
    from backend.app.services.native_dialogs import pick_folder

    try:
        folder = pick_folder()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Folder dialog failed: {exc}") from exc
    return LocalPathsOut(paths=[folder] if folder else [])


@router.post(
    "/import/ack-missing",
    response_model=ScrapeStatusOut,
    dependencies=[Depends(require_scrape_page)],
)
def post_ack_missing_linked() -> ScrapeStatusOut:
    """Clear the Sync folders missing-file prompt after the user answers."""
    with scrape_lock:
        scrape_status.missing_linked = []
    return _status_out()


@router.post(
    "/import/run",
    response_model=ScrapeStatusOut,
    dependencies=[Depends(require_scrape_page)],
)
def post_import_run(payload: LocalImportRunRequest) -> ScrapeStatusOut:
    from backend.app.services.local_import import run_local_import

    paths = [p.strip() for p in payload.paths if p and p.strip()]
    if not paths:
        raise HTTPException(status_code=400, detail="At least one path is required")
    with scrape_lock:
        if scrape_status.running:
            raise HTTPException(status_code=409, detail="Scrape already running")
        scrape_panels.activate(scrape_status, scrape_panels.SOURCE_LOCAL)
        scrape_status.job_id += 1
        job_id = scrape_status.job_id
        scrape_status.kind = "import"
        scrape_status.queue_open = False
        scrape_status.site_id = None
        scrape_status.running = True
        scrape_status.cancel = False
        scrape_status.message = "Queued"
        thread = threading.Thread(
            target=run_local_import,
            kwargs={"paths": paths, "recursive": payload.recursive, "job_id": job_id},
            daemon=True,
        )
        thread.start()
    return _status_out()


@router.post("/cancel", response_model=ScrapeStatusOut)
def post_scrape_cancel() -> ScrapeStatusOut:
    # Release the queue in this request. The in-flight fetch may still be
    # blocked, but it no longer owns the job, so the next download can start.
    abandon_running_job()
    return _status_out()


@router.get("/status", response_model=ScrapeStatusOut)
def get_scrape_status() -> ScrapeStatusOut:
    return _status_out()


@router.post("/clear-recent", response_model=ScrapeStatusOut)
def post_clear_recent() -> ScrapeStatusOut:
    scrape_status.recent_media_ids = []
    return _status_out()


@router.post("/clear-queues", response_model=ScrapeStatusOut)
def post_clear_queues(
    source: str | None = None,
    which: str | None = None,
    skip_reason: str | None = None,
) -> ScrapeStatusOut:
    """Empty Queue to scrape, Skipped, Errors, and Cancelled. Session downloads stay.

    ``source`` (a panel key) clears only that source; omitted clears every panel.
    ``which`` is ``queue``, ``skipped``, ``errors``, or ``cancelled``; omitted clears all four.
    ``skip_reason`` limits ``which=skipped`` to one reason group.
    """
    key = (source or "").strip() or None
    kind = (which or "").strip() or None
    reason = (skip_reason or "").strip() or None
    if kind not in (None, "queue", "skipped", "errors", "cancelled"):
        raise HTTPException(
            status_code=400,
            detail="which must be queue, skipped, errors, or cancelled.",
        )
    if reason and kind != "skipped":
        raise HTTPException(
            status_code=400,
            detail="skip_reason applies only when which is skipped.",
        )
    with scrape_lock:
        if scrape_status.running and (key is None or key == scrape_status.source_key):
            raise HTTPException(
                status_code=409,
                detail="A scrape or import is running. Stop it before clearing the queues.",
            )
        scrape_leftovers.clear_queues(key, which=kind, skip_reason=reason)
        scrape_panels.clear_panel(scrape_status, key, which=kind, skip_reason=reason)
    return _status_out()


@router.post("/retry", response_model=ScrapeStatusOut, dependencies=[Depends(require_scrape_page)])
def post_retry_skipped(
    source: str,
    which: str | None = None,
    skip_reason: str | None = None,
) -> ScrapeStatusOut:
    """Run this panel's Skipped and/or Errors files. Queue and Cancelled stay.

    ``which`` is ``skipped``, ``errors``, or omitted for both.
    ``skip_reason`` limits a Skipped retry to one reason group.
    """
    key = (source or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="source is required.")
    kind = (which or "").strip() or None
    reason = (skip_reason or "").strip() or None
    if kind not in (None, "skipped", "errors"):
        raise HTTPException(status_code=400, detail="which must be skipped or errors.")
    if reason and kind == "errors":
        raise HTTPException(
            status_code=400,
            detail="skip_reason applies only when which is skipped or omitted.",
        )
    local = False
    urls: list[str] = []
    with scrape_lock:
        if scrape_status.running:
            raise HTTPException(
                status_code=409,
                detail="A scrape or import is running. Stop it before retrying.",
            )
        urls = scrape_panels.retry_targets(
            scrape_status, key, which=kind, skip_reason=reason
        )
        if not urls:
            raise HTTPException(status_code=400, detail="Nothing skipped or failed to retry.")
        local = key == scrape_panels.SOURCE_LOCAL
        if local:
            from backend.app.services.local_import import run_local_import

            scrape_panels.activate(scrape_status, scrape_panels.SOURCE_LOCAL)
            scrape_status.job_id += 1
            job_id = scrape_status.job_id
            scrape_status.kind = "import"
            scrape_status.queue_open = False
            scrape_status.site_id = None
            scrape_status.running = True
            scrape_status.cancel = False
            scrape_status.message = "Queued"
            threading.Thread(
                target=run_local_import,
                kwargs={"paths": urls, "recursive": False, "job_id": job_id},
                daemon=True,
            ).start()
    if local:
        return _status_out()
    return start_scrape_run(
        ScrapeRunRequest(filters=[], limit=0, source_key=key),
        only_urls=urls,
    )


def _split_csv(raw: str | None) -> list[str]:
    return [part.strip() for part in (raw or "").split(",") if part.strip()]


@router.get("/recent-media", response_model=MediaListOut)
def get_recent_media(
    page: int = Query(1, ge=1),
    page_size: int = Query(12, ge=1, le=100),
    tags: str | None = Query(None, description="Comma-separated tag names"),
    tag_mode: str = "and",
    exclude_tags: str | None = Query(None, description="Comma-separated tag names to exclude"),
    exclude_tag_groups: str | None = Query(
        None, description="Comma-separated tag group keys to exclude"
    ),
    scope: str = Query(
        "session",
        description="session = this scrape process; all = library by scraped_at desc",
    ),
    db: Session = Depends(get_db),
) -> MediaListOut:
    tag_names = sorted({part.strip() for part in (tags or "").split(",") if part.strip()})
    scope_key = (scope or "session").strip().lower()
    if scope_key not in ("session", "all"):
        raise HTTPException(status_code=400, detail="scope must be 'session' or 'all'")
    excluded_ids = media_ids_with_excluded_tags(
        db, _split_csv(exclude_tags), _split_csv(exclude_tag_groups)
    )

    if scope_key == "all":
        # All downloaded media, newest scrape first (local DB scraped_at).
        query = db.query(MediaItem)
        matched_ids = media_ids_for_tags(db, tag_names, tag_mode)
        if matched_ids is not None:
            query = query.filter(MediaItem.id.in_(matched_ids))
        if excluded_ids is not None:
            query = query.filter(~MediaItem.id.in_(excluded_ids))
        total = query.count()
        start = (page - 1) * page_size
        page_items = (
            query.order_by(MediaItem.scraped_at.desc(), MediaItem.id.desc())
            .offset(start)
            .limit(page_size)
            .all()
        )
        return MediaListOut(
            items=build_media_summaries(db, page_items),
            total=total,
            page=page,
            page_size=page_size,
        )

    ids = _recent_ids_newest_first(db)
    if tag_names and ids:
        matched_ids = media_ids_for_tags(db, tag_names, tag_mode, only_media_ids=ids)
        matching = {row[0] for row in matched_ids.all()} if matched_ids is not None else set()
        ids = [media_id for media_id in ids if media_id in matching]
    if excluded_ids is not None and ids:
        bad = {row[0] for row in excluded_ids.all()}
        ids = [media_id for media_id in ids if media_id not in bad]
    total = len(ids)
    start = (page - 1) * page_size
    page_ids = ids[start : start + page_size]
    by_id = {
        item.id: item
        for item in db.query(MediaItem).filter(MediaItem.id.in_(page_ids)).all()
    }
    page_items = [by_id[media_id] for media_id in page_ids if media_id in by_id]
    return MediaListOut(
        items=build_media_summaries(db, page_items),
        total=total,
        page=page,
        page_size=page_size,
    )
