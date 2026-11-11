from pydantic import BaseModel, Field


class SiteOut(BaseModel):
    id: str
    name: str
    base_url: str
    default_gallery_url: str
    media_cdn_host: str


class ScrapeSourceOut(BaseModel):
    """Top-level scrape origin: a catalog site or Local import."""

    id: str
    name: str
    kind: str  # site | local
    base_url: str | None = None


class ScraperOut(BaseModel):
    """A scrape agent that can run against one or more catalog sites."""

    id: str
    name: str
    description: str = ""
    site_ids: list[str] = Field(default_factory=list)


class SessionSettingsOut(BaseModel):
    selected_source_id: str | None = None
    selected_source: ScrapeSourceOut | None = None
    available_sources: list[ScrapeSourceOut] = Field(default_factory=list)
    selected_site_id: str | None = None
    selected_site: SiteOut | None = None
    selected_scraper_id: str | None = None
    selected_scraper: ScraperOut | None = None
    available_sites: list[SiteOut] = Field(default_factory=list)
    available_scrapers: list[ScraperOut] = Field(default_factory=list)
    local_import_folders: list[str] = Field(default_factory=list)
    local_import_files: list[str] = Field(default_factory=list)
    local_import_recursive: bool = True


class SessionSettingsPatch(BaseModel):
    selected_source_id: str | None = None
    selected_site_id: str | None = None
    selected_scraper_id: str | None = None
    local_import_folders: list[str] | None = None
    local_import_files: list[str] | None = None
    local_import_recursive: bool | None = None


def _site_out(site: dict) -> SiteOut:
    return SiteOut(
        id=site["id"],
        name=site["name"],
        base_url=site["base_url"],
        default_gallery_url=site["default_gallery_url"],
        media_cdn_host=site["media_cdn_host"],
    )


def _source_out(source: dict) -> ScrapeSourceOut:
    return ScrapeSourceOut(
        id=source["id"],
        name=source["name"],
        kind=source["kind"],
        base_url=source.get("base_url"),
    )


def _scraper_out(scraper: dict) -> ScraperOut:
    return ScraperOut(
        id=scraper["id"],
        name=scraper["name"],
        description=str(scraper.get("description") or ""),
        site_ids=list(scraper.get("site_ids") or []),
    )


def session_settings_out(
    data: dict,
    sites: list[dict],
    scrapers: list[dict],
    selected_site: dict | None,
    selected_scraper: dict | None,
    sources: list[dict] | None = None,
    selected_source: dict | None = None,
) -> SessionSettingsOut:
    return SessionSettingsOut(
        selected_source_id=data.get("selected_source_id"),
        selected_source=_source_out(selected_source) if selected_source else None,
        available_sources=[_source_out(s) for s in (sources or [])],
        selected_site_id=data.get("selected_site_id"),
        selected_site=_site_out(selected_site) if selected_site else None,
        selected_scraper_id=data.get("selected_scraper_id"),
        selected_scraper=_scraper_out(selected_scraper) if selected_scraper else None,
        available_sites=[_site_out(s) for s in sites],
        available_scrapers=[_scraper_out(s) for s in scrapers],
        local_import_folders=list(data.get("local_import_folders") or []),
        local_import_files=list(data.get("local_import_files") or []),
        local_import_recursive=bool(data.get("local_import_recursive", True)),
    )
