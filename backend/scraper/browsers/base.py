"""Shared browser-engine interface. Engines only differ in how the browser process starts."""

from __future__ import annotations

from playwright.sync_api import Browser, BrowserContext, Page

BLOCKED_ASSETS = "**/*.{png,jpg,jpeg,gif,svg,webp,css,woff,woff2}"


class BrowserEngine:
    engine_id = ""

    def __init__(self, *, ignore_https_errors: bool = False) -> None:
        self._ignore_https_errors = ignore_https_errors
        self._browser: Browser | None = None
        self._contexts: list[BrowserContext] = []
        self._api: BrowserContext | None = None

    def start(self) -> None:
        raise NotImplementedError

    def _stop(self) -> None:
        """Release the browser process (and driver). Contexts are already closed."""
        raise NotImplementedError

    def _context_options(self) -> dict:
        return {"ignore_https_errors": self._ignore_https_errors}

    def close(self) -> None:
        for context in [*self._contexts, self._api]:
            if context is not None:
                _close_quietly(context)
        self._contexts = []
        self._api = None
        self._stop()

    def _require_browser(self) -> Browser:
        if self._browser is None:
            raise RuntimeError("Browser not started")
        return self._browser

    def new_page(self) -> Page:
        """New page in its own context (fresh cookies). Closing the page frees the context later."""
        self._prune_contexts()
        context = self._require_browser().new_context(**self._context_options())
        self._contexts.append(context)
        page = context.new_page()
        try:
            page.route(BLOCKED_ASSETS, lambda route: route.abort())
        except Exception:
            pass
        return page

    def _prune_contexts(self) -> None:
        alive: list[BrowserContext] = []
        for context in self._contexts:
            if context.pages:
                alive.append(context)
            else:
                _close_quietly(context)
        self._contexts = alive

    def _api_context(self) -> BrowserContext:
        if self._api is None:
            self._api = self._require_browser().new_context(**self._context_options())
        return self._api

    def reset_context(self) -> None:
        if self._api is not None:
            _close_quietly(self._api)
            self._api = None

    def request_json(self, url: str, *, headers: dict[str, str], timeout_ms: int) -> dict:
        response = self._api_context().request.get(url, headers=headers, timeout=timeout_ms)
        if not response.ok:
            raise RuntimeError(f"HTTP {response.status} for {url}")
        data = response.json()
        if not isinstance(data, dict):
            raise ValueError(f"Unexpected API response for {url}")
        return data


def _close_quietly(context: BrowserContext) -> None:
    try:
        context.close()
    except Exception:
        pass
