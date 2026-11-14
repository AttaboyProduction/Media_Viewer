"""Browser extension: which page URLs the app can scrape, and adding them to that queue."""

from fastapi import APIRouter, Depends, HTTPException

from backend.app.api.guards import require_scrape_page
from backend.app.api.scrape import _status_out, start_scrape_run
from backend.app.schemas import (
    ExtensionEnqueueOut,
    ExtensionSiteOut,
    ExtensionSitesOut,
    ExtensionUrlsIn,
    ScrapeFilterIn,
    ScrapeRunRequest,
)
from backend.app.services.app_settings import scrape_page_enabled
from backend.scraper.pipeline import append_scrape_urls, scrape_status
from backend.scraper.sites import extension_scrape_target, list_extension_sites, select_source_for_site

router = APIRouter(prefix="/extension", tags=["extension"])


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
        ExtensionSiteOut(id=site["id"], name=site["name"], url_patterns=list(site["post_id_patterns"]))
        for site in list_extension_sites()
    ]
    return ExtensionSitesOut(scrape_enabled=scrape_page_enabled(), sites=sites)


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

    urls = list(chosen)
    added = append_scrape_urls(urls, site_id)
    if added is not None:
        return ExtensionEnqueueOut(
            started=False,
            appended=True,
            site_id=site_id,
            queued=added,
            rejected=rejected,
            status=_status_out(),
        )
    if scrape_status.running:
        raise HTTPException(status_code=409, detail="Scrape already running")

    select_source_for_site(site_id)
    run = ScrapeRunRequest(
        filters=[ScrapeFilterIn(type="url", value="\n".join(urls))],
        limit=0,
    )
    status = start_scrape_run(run)
    return ExtensionEnqueueOut(
        started=True,
        site_id=site_id,
        queued=urls,
        rejected=rejected,
        status=status,
    )
