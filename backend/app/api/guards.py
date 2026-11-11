from fastapi import HTTPException

from backend.app.services.app_settings import scrape_page_enabled


def require_scrape_page() -> None:
    """Dependency for endpoints that open a scrape browser."""
    if not scrape_page_enabled():
        raise HTTPException(
            status_code=409,
            detail="Scraping is off. Turn off Hide Scrape page in Settings to use it.",
        )
