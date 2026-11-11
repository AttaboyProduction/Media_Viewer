"""Playwright-bundled Chromium. Fallback when Obscura is not installed."""

from __future__ import annotations

from playwright.sync_api import Playwright, sync_playwright

from backend.scraper.browsers.base import BrowserEngine

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


class PlaywrightChromiumEngine(BrowserEngine):
    engine_id = "playwright"

    def __init__(self, *, ignore_https_errors: bool = False) -> None:
        super().__init__(ignore_https_errors=ignore_https_errors)
        self._playwright: Playwright | None = None

    def start(self) -> None:
        self._playwright = sync_playwright().start()
        self._browser = self._playwright.chromium.launch(headless=True)

    def _context_options(self) -> dict:
        return {**super()._context_options(), "user_agent": USER_AGENT}

    def _stop(self) -> None:
        if self._browser is not None:
            self._browser.close()
            self._browser = None
        if self._playwright is not None:
            self._playwright.stop()
            self._playwright = None
