"""Scrape browser session. Engine (Obscura or Playwright Chromium) is chosen in Settings."""

from __future__ import annotations

from playwright.sync_api import Page

from backend.scraper.browsers.session import open_engine


class PlaywrightClient:
    def __init__(self, ignore_https_errors: bool = False) -> None:
        self._ignore_https_errors = ignore_https_errors
        self._engine = None

    def __enter__(self) -> "PlaywrightClient":
        self._engine = open_engine(ignore_https_errors=self._ignore_https_errors)
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self._engine is not None:
            self._engine.close()
            self._engine = None

    def new_page(self) -> Page:
        if self._engine is None:
            raise RuntimeError("Browser not started")
        return self._engine.new_page()

    def reset_context(self) -> None:
        if self._engine is None:
            raise RuntimeError("Browser not started")
        self._engine.reset_context()

    def request_json(self, url: str, *, headers: dict[str, str], timeout_ms: int) -> dict:
        if self._engine is None:
            raise RuntimeError("Browser not started")
        return self._engine.request_json(url, headers=headers, timeout_ms=timeout_ms)
