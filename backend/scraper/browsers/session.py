"""Pick an installed browser and open it. Auto prefers Obscura."""

from __future__ import annotations

import logging

from backend.app.services.app_settings import load_app_settings
from backend.scraper.browsers.base import BrowserEngine
from backend.scraper.browsers.catalog import normalize_choice, obscura_executable, resolve_engine
from backend.scraper.browsers.obscura_engine import ObscuraEngine
from backend.scraper.browsers.playwright_engine import PlaywrightChromiumEngine

logger = logging.getLogger(__name__)

# Why the last Auto session fell back from Obscura to Playwright; cleared when Obscura starts.
last_fallback_error: str | None = None


def open_engine(*, ignore_https_errors: bool = False) -> BrowserEngine:
    global last_fallback_error
    choice = normalize_choice(load_app_settings().get("scrape_browser"))
    present = obscura_executable() is not None
    if resolve_engine(choice, obscura_present=present) == "obscura":
        if not present:
            raise RuntimeError("Obscura is not installed. Download it in Settings.")
        engine: BrowserEngine = ObscuraEngine(ignore_https_errors=ignore_https_errors)
        try:
            engine.start()
        except Exception as exc:
            engine.close()
            if choice != "auto":
                raise
            last_fallback_error = str(exc) or exc.__class__.__name__
            logger.warning("Obscura failed to start, using Playwright Chromium: %s", last_fallback_error)
        else:
            last_fallback_error = None
            return engine
    engine = PlaywrightChromiumEngine(ignore_https_errors=ignore_https_errors)
    engine.start()
    return engine
