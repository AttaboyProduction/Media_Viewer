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
from backend.app.services.hash_backfill import backfill_status
from backend.app.services.media_service import (
    build_media_summaries,
    media_ids_for_tags,
    media_ids_with_excluded_tags,
)
from backend.scraper.job import compile_scrape_job
from backend.scraper.pipeline import run_job, scrape_status
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

_scrape_lock = threading.Lock()


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
    return ScrapeStatusOut(
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
            {"url": item.url, "reason": item.reason} for item in scrape_status.skipped_items
        ],
        hash_backfill_running=bool(backfill_status["running"]),
        hash_backfill_total=int(backfill_status["total"]),
        hash_backfill_done=int(backfill_status["done"]),
        recent_media_ids=list(scrape_status.recent_media_ids),
        ran_this_session=bool(scrape_status.ran_this_session),
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


def _start_job(payload: ScrapeRunRequest) -> None:
    try:
        job = compile_scrape_job(payload)
        run_job(job)
    except Exception as exc:
        scrape_status.errors.append(str(exc))
        scrape_status.running = False
        scrape_status.message = f"Failed: {exc}"


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
        site_id = tentative.get("selected_site_id")
        scraper_id = tentative.get("selected_scraper_id")
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


@router.post("/run", response_model=ScrapeStatusOut, dependencies=[Depends(require_scrape_page)])
def post_scrape_run(payload: ScrapeRunRequest) -> ScrapeStatusOut:
    with _scrape_lock:
        if scrape_status.running:
            raise HTTPException(status_code=409, detail="Scrape already running")
        try:
            compile_scrape_job(payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        scrape_status.running = True
        scrape_status.cancel = False
        scrape_status.message = "Queued"
        thread = threading.Thread(target=_start_job, args=(payload,), daemon=True)
        thread.start()
    return _status_out()


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
    "/import/run",
    response_model=ScrapeStatusOut,
    dependencies=[Depends(require_scrape_page)],
)
def post_import_run(payload: LocalImportRunRequest) -> ScrapeStatusOut:
    from backend.app.services.local_import import run_local_import

    paths = [p.strip() for p in payload.paths if p and p.strip()]
    if not paths:
        raise HTTPException(status_code=400, detail="At least one path is required")
    with _scrape_lock:
        if scrape_status.running:
            raise HTTPException(status_code=409, detail="Scrape already running")
        scrape_status.running = True
        scrape_status.cancel = False
        scrape_status.message = "Queued"
        thread = threading.Thread(
            target=run_local_import,
            kwargs={"paths": paths, "recursive": payload.recursive},
            daemon=True,
        )
        thread.start()
    return _status_out()


@router.post("/cancel", response_model=ScrapeStatusOut)
def post_scrape_cancel() -> ScrapeStatusOut:
    scrape_status.cancel = True
    if scrape_status.running:
        scrape_status.message = "Cancelling..."
    return _status_out()


@router.get("/status", response_model=ScrapeStatusOut)
def get_scrape_status() -> ScrapeStatusOut:
    return _status_out()


@router.post("/clear-recent", response_model=ScrapeStatusOut)
def post_clear_recent() -> ScrapeStatusOut:
    scrape_status.recent_media_ids = []
    return _status_out()


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
