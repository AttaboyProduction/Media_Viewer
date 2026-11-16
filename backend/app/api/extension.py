"""Browser extension: which page URLs the app can scrape, and adding them to that queue."""

from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException

from backend.app.api.guards import require_scrape_page
from backend.app.api.scrape import _status_out, start_scrape_run
from backend.app.schemas import (
    ExtensionEnqueueOut,
    ExtensionFileIn,
    ExtensionSavedOut,
    ExtensionScrapeIn,
    ExtensionSiteOut,
    ExtensionSitesOut,
    ExtensionUrlsIn,
    ScrapeFilterIn,
    ScrapeRunRequest,
)
from backend.app.services.app_settings import scrape_page_enabled
from backend.scraper.pipeline import append_scrape_urls, begin_remote_download, scrape_status
from backend.scraper.sites import extension_scrape_target, list_extension_sites, select_source_for_site

router = APIRouter(prefix="/extension", tags=["extension"])


def _pending_or_saved(urls: list[str]) -> tuple[list[str], list[str]]:
    """Posts not in the library (or saved as a smaller video) vs already saved."""
    from backend.app.db.models import MediaItem
    from backend.app.db.session import SessionLocal
    from backend.scraper.gallery import extract_post_id
    from backend.scraper.storage import video_can_improve

    db = SessionLocal()
    try:
        todo: list[str] = []
        saved: list[str] = []
        for url in urls:
            post_id = extract_post_id(url)
            row = (
                db.query(MediaItem).filter(MediaItem.source_post_id == post_id).first()
                if post_id
                else None
            )
            if row is not None and not (
                row.media_type == "video" and video_can_improve(row.local_path or "")
            ):
                saved.append(url)
            else:
                todo.append(url)
        return todo, saved
    finally:
        db.close()


def _existing_post_ids(post_ids: set[str]) -> set[str]:
    if not post_ids:
        return set()
    from backend.app.db.models import MediaItem
    from backend.app.db.session import SessionLocal

    db = SessionLocal()
    try:
        rows = (
            db.query(MediaItem.source_post_id)
            .filter(MediaItem.source_post_id.in_(post_ids))
            .all()
        )
        return {row[0] for row in rows}
    finally:
        db.close()


def saved_post_urls(urls: list[str]) -> list[str]:
    """Input URLs whose post id is already a library row.

    A CDN file URL counts as that post. A smaller video encode still counts as saved.
    """
    from backend.scraper.sites import resolve_extension_url

    pairs: list[tuple[str, str]] = []
    for raw in urls:
        hit = resolve_extension_url(raw)
        if hit is None:
            continue
        _site_id, post_id, _post_url = hit
        if post_id:
            pairs.append((raw, post_id))
    found = _existing_post_ids({post_id for _raw, post_id in pairs})
    return [raw for raw, post_id in pairs if post_id in found]


def _targets(urls: list[str]) -> tuple[dict[str, str], list[str]]:
    """``{url to scrape: site_id}`` in first-seen order, and rejected inputs."""
    chosen: dict[str, str] = {}
    rejected: list[str] = []
    for raw in urls:
        hit = extension_scrape_target(raw)
        if hit is None:
            rejected.append(raw)
            continue
        site_id, scrape_url = hit
        chosen.setdefault(scrape_url, site_id)
    return chosen, rejected


@router.get("/sites", response_model=ExtensionSitesOut)
def get_extension_sites() -> ExtensionSitesOut:
    sites = [
        ExtensionSiteOut(
            id=site["id"],
            name=site["name"],
            page_matches=list(site.get("page_matches") or []),
            url_patterns=list(site["post_id_patterns"]),
            file_matches=list(site.get("file_matches") or []),
        )
        for site in list_extension_sites()
    ]
    return ExtensionSitesOut(scrape_enabled=scrape_page_enabled(), sites=sites)


@router.post(
    "/saved",
    response_model=ExtensionSavedOut,
    dependencies=[Depends(require_scrape_page)],
)
def post_extension_saved(payload: ExtensionUrlsIn) -> ExtensionSavedOut:
    return ExtensionSavedOut(saved=saved_post_urls(payload.urls))


def never_auto_run_scrape() -> bool:
    """True when extension links wait for Run scrape instead of starting immediately."""
    from backend.app.services.app_settings import load_app_settings

    return bool(load_app_settings().get("never_auto_run_scrape", False))


@router.post(
    "/enqueue",
    response_model=ExtensionEnqueueOut,
    dependencies=[Depends(require_scrape_page)],
)
def post_extension_enqueue(payload: ExtensionUrlsIn) -> ExtensionEnqueueOut:
    chosen, rejected = _targets(payload.urls)
    site_ids = set(chosen.values())
    if len(site_ids) > 1:
        raise HTTPException(status_code=400, detail="Send URLs from one site per request")
    site_id = next(iter(site_ids), None)
    if site_id is None:
        return ExtensionEnqueueOut(started=False, rejected=rejected)

    todo, already_saved = _pending_or_saved(list(chosen))
    if not todo:
        return ExtensionEnqueueOut(
            started=False,
            site_id=site_id,
            already_saved=already_saved,
            rejected=rejected,
        )
    added = append_scrape_urls(todo, site_id)
    if added is not None:
        return ExtensionEnqueueOut(
            started=False,
            appended=True,
            site_id=site_id,
            queued=added,
            already_saved=already_saved,
            rejected=rejected,
            status=_status_out(),
        )
    if scrape_status.running:
        raise HTTPException(status_code=409, detail="Scrape already running")

    select_source_for_site(site_id)
    run = ScrapeRunRequest(
        filters=[ScrapeFilterIn(type="url", value="\n".join(todo))],
        limit=0,
    )
    # After a finished 1/1, the next file must grow the queue (1/2 → 2/2), not reset.
    status = start_scrape_run(run, continue_counts=True)
    return ExtensionEnqueueOut(
        started=True,
        site_id=site_id,
        queued=todo,
        already_saved=already_saved,
        rejected=rejected,
        status=status,
    )


@router.post(
    "/scrape",
    response_model=ExtensionEnqueueOut,
    dependencies=[Depends(require_scrape_page)],
)
def post_extension_scrape(payload: ExtensionScrapeIn) -> ExtensionEnqueueOut:
    """Run the site's gallery with the same filters as the Scrape page."""
    known = {site["id"] for site in list_extension_sites()}
    if payload.site_id not in known:
        raise HTTPException(status_code=400, detail="Site is not supported")
    filters: list[ScrapeFilterIn] = []
    for tag in payload.tags:
        text = tag.strip()
        if text:
            filters.append(ScrapeFilterIn(type="tag", value=text))
    if payload.date_from.strip() or payload.date_to.strip():
        filters.append(
            ScrapeFilterIn(type="date_range", value=f"{payload.date_from.strip()}..{payload.date_to.strip()}")
        )
    media_type = payload.media_type.strip()
    if media_type and media_type != "all":
        if media_type not in {"image", "gif", "video"}:
            raise HTTPException(status_code=400, detail="Unknown media type")
        filters.append(ScrapeFilterIn(type="media_type", value=media_type))
    exclude = [tag.strip() for tag in payload.exclude_tags if tag.strip()]
    select_source_for_site(payload.site_id)
    status = start_scrape_run(
        ScrapeRunRequest(
            filters=filters,
            sort=payload.sort,
            limit=payload.limit,
            exclude_tags=exclude,
            tag_mode=payload.tag_mode,
        )
    )
    return ExtensionEnqueueOut(started=True, site_id=payload.site_id, status=status)


@router.post(
    "/save-file",
    response_model=ExtensionEnqueueOut,
    dependencies=[Depends(require_scrape_page)],
)
def post_extension_save_file(payload: ExtensionFileIn) -> ExtensionEnqueueOut:
    """Download one picture the gallery adapters don't know. No tags."""
    url = payload.url.strip()
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=400, detail="Need an http(s) file URL")
    mode = begin_remote_download(url)
    if mode == "busy":
        raise HTTPException(status_code=409, detail="Scrape already running")
    return ExtensionEnqueueOut(
        started=mode == "started",
        appended=mode == "appended",
        queued=[] if mode == "duplicate" else [url],
        status=_status_out(),
    )
