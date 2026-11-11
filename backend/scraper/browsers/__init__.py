"""Scraper browsers: one session interface, several engines.

Open a session with ``backend.scraper.browsers.session.open_engine``. This package
imports nothing on load so the launcher can use ``catalog`` / ``install`` before
Playwright and the app settings are importable.
"""
