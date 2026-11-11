"""Scrape browser engines: choice resolution, install/update, context cleanup, Auto fallback,
and the Scrape page guard.

No network and no real browser: downloads, binaries, pip and Playwright objects are faked.

Run:
  python -m unittest tests.test_browser_engines -v
"""

from __future__ import annotations

import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

from backend.app.api import guards
from backend.app.services import app_settings
from backend.scraper.browsers import install, metered, session
from backend.scraper.browsers.base import BrowserEngine
from backend.scraper.browsers.catalog import normalize_choice, resolve_engine


class BrowserChoiceTests(unittest.TestCase):
    def test_unknown_choice_is_auto(self):
        self.assertEqual(normalize_choice("chrome"), "auto")
        self.assertEqual(normalize_choice(None), "auto")

    def test_auto_prefers_obscura(self):
        self.assertEqual(resolve_engine("auto", obscura_present=True), "obscura")
        self.assertEqual(resolve_engine("auto", obscura_present=False), "playwright")

    def test_explicit_choice_is_kept(self):
        self.assertEqual(resolve_engine("playwright", obscura_present=True), "playwright")
        self.assertEqual(resolve_engine("obscura", obscura_present=False), "obscura")


RELEASE = install.ObscuraRelease(version="v9.9.9", url="https://example.invalid/o.zip", sha256="ab" * 32)


def _fake_download(exe_bytes: bytes = b"exe", digest: str = RELEASE.sha256):
    def download(_url, dest: Path) -> str:
        with zipfile.ZipFile(dest, "w") as bundle:
            bundle.writestr("obscura.exe", exe_bytes)
        return digest

    return download


class _TempDataDir(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.folder = self.data_dir / "browsers" / "obscura"
        windows = mock.patch.object(install.sys, "platform", "win32")
        windows.start()
        self.addCleanup(windows.stop)

    def _install_app_obscura(self, version: str | None):
        self.folder.mkdir(parents=True, exist_ok=True)
        (self.folder / "obscura.exe").write_bytes(b"old")
        if version:
            (self.folder / "version.txt").write_text(version, encoding="utf-8")


class ObscuraInstallTests(_TempDataDir):
    def test_checksum_mismatch_rejects_download(self):
        with mock.patch.object(install, "_download", _fake_download(digest="0" * 64)):
            with self.assertRaises(install.BrowserInstallError):
                install.install_obscura(self.data_dir, RELEASE)
        self.assertFalse((self.folder / "obscura.zip").exists())
        self.assertFalse((self.folder / "obscura.exe").exists())
        self.assertFalse((self.folder / "_new").exists())

    def test_install_records_version_and_replaces_binary(self):
        self._install_app_obscura("v0.0.1")
        with mock.patch.object(install, "_download", _fake_download(b"new")):
            install.install_obscura(self.data_dir, RELEASE)
        self.assertEqual((self.folder / "obscura.exe").read_bytes(), b"new")
        self.assertEqual(install.installed_obscura_version(self.data_dir), "v9.9.9")
        self.assertFalse((self.folder / "_new").exists())

    def test_unreachable_github_falls_back_to_pinned_build(self):
        with mock.patch.object(
            install, "latest_obscura_release", side_effect=OSError("offline")
        ), mock.patch.object(
            install, "_download", _fake_download(digest=install.OBSCURA_SHA256)
        ):
            install.install_obscura(self.data_dir)
        self.assertEqual(install.installed_obscura_version(self.data_dir), install.OBSCURA_VERSION)


class BrowserUpdateTests(_TempDataDir):
    def setUp(self):
        super().setUp()
        no_external = mock.patch.object(install, "obscura_executable", return_value=None)
        no_external.start()
        self.addCleanup(no_external.stop)

    def _update(self, *, chromium: bool = False, pip_stdout: str = "", force: bool = True):
        runs: list[list[str]] = []

        def run(cmd):
            runs.append(cmd)
            return subprocess.CompletedProcess(cmd, 0, stdout=pip_stdout, stderr="")

        with mock.patch.object(install, "latest_obscura_release", return_value=RELEASE), mock.patch.object(
            install, "_chromium_installed", return_value=chromium
        ), mock.patch.object(install, "_run", side_effect=run), mock.patch.object(
            install, "install_obscura"
        ) as obscura_install:
            results = install.update_browsers(self.data_dir, "python", force=force)
        return results, obscura_install, runs

    def test_missing_browsers_are_not_installed(self):
        results, obscura_install, runs = self._update()
        self.assertEqual(results, [])
        obscura_install.assert_not_called()
        self.assertEqual(runs, [])

    def test_outdated_obscura_is_updated(self):
        self._install_app_obscura("v0.2.3")
        results, obscura_install, _ = self._update()
        obscura_install.assert_called_once_with(self.data_dir, RELEASE)
        self.assertEqual(results, ["Obscura updated to v9.9.9"])

    def test_current_obscura_is_left_alone(self):
        self._install_app_obscura("v9.9.9")
        results, obscura_install, _ = self._update()
        obscura_install.assert_not_called()
        self.assertEqual(results, ["Obscura v9.9.9 is up to date"])

    def test_external_obscura_is_not_updated(self):
        with mock.patch.object(install, "obscura_executable", return_value=Path("C:/tools/obscura.exe")):
            results, obscura_install, _ = self._update()
        obscura_install.assert_not_called()
        self.assertIn("managed outside the app", results[0])

    def test_playwright_upgrade_reinstalls_chromium(self):
        _, _, runs = self._update(chromium=True, pip_stdout="Successfully installed playwright-9.0")
        self.assertEqual(runs[0][1:4], ["-m", "pip", "install"])
        self.assertEqual(runs[1][1:], ["-m", "playwright", "install", "chromium"])

    def test_damaged_playwright_install_is_overwritten(self):
        replies = iter(
            [
                (1, "", "hint: pip install --ignore-installed --no-deps playwright==1.62.0"),
                (0, "Successfully installed playwright-9.0", ""),
                (0, "", ""),
            ]
        )
        runs: list[list[str]] = []

        def run(cmd):
            runs.append(cmd)
            code, out, err = next(replies)
            return subprocess.CompletedProcess(cmd, code, stdout=out, stderr=err)

        with mock.patch.object(install, "_chromium_installed", return_value=True), mock.patch.object(
            install, "_run", side_effect=run
        ):
            self.assertEqual(install._update_playwright("python"), "Playwright and its Chromium were updated")
        self.assertIn("--ignore-installed", runs[1])
        self.assertEqual(runs[2][1:], ["-m", "playwright", "install", "chromium"])

    def test_playwright_up_to_date_skips_chromium_install(self):
        results, _, runs = self._update(chromium=True, pip_stdout="Requirement already satisfied")
        self.assertEqual(len(runs), 1)
        self.assertEqual(results, ["Playwright Chromium is up to date"])

    def test_check_runs_at_most_once_a_day(self):
        self._update(force=False)
        results, _, _ = self._update(force=False)
        self.assertIsNone(results)
        self.assertEqual(install.last_update_check(self.data_dir)["results"], [])
        with mock.patch.object(install, "UPDATE_CHECK_SECONDS", 0):
            results, _, _ = self._update(force=False)
        self.assertEqual(results, [])


class PlaywrightChromiumInstallTests(unittest.TestCase):
    def test_broken_driver_is_reinstalled_before_chromium(self):
        runs: list[list[str]] = []
        replies = iter(
            [
                (0, "Successfully installed playwright-1.0", ""),
                (0, "", ""),
            ]
        )

        def run(cmd):
            runs.append(cmd)
            code, out, err = next(replies)
            return subprocess.CompletedProcess(cmd, code, stdout=out, stderr=err)

        with mock.patch.object(install, "_playwright_package_ok", side_effect=[False, True, True]), mock.patch.object(
            install, "_run", side_effect=run
        ), mock.patch.object(
            install, "playwright_chromium_path", return_value=r"C:\chromium\chrome.exe"
        ), mock.patch.object(install.sys, "executable", "python"):
            path = install.install_playwright_chromium()
        self.assertEqual(path, r"C:\chromium\chrome.exe")
        self.assertEqual(runs[0][1:], ["-m", "pip", "install", "--upgrade", "--disable-pip-version-check", "playwright"])
        self.assertEqual(runs[1][1:], ["-m", "playwright", "install", "chromium"])

    def test_healthy_package_skips_reinstall(self):
        runs: list[list[str]] = []

        def run(cmd):
            runs.append(cmd)
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

        with mock.patch.object(install, "_playwright_package_ok", return_value=True), mock.patch.object(
            install, "_run", side_effect=run
        ), mock.patch.object(
            install, "playwright_chromium_path", return_value=r"C:\chromium\chrome.exe"
        ), mock.patch.object(install.sys, "executable", "python"):
            install.install_playwright_chromium()
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0][1:], ["-m", "playwright", "install", "chromium"])


class UpdateCheckSettingTests(unittest.TestCase):

    def test_saved_choice_wins_over_connection(self):
        with mock.patch.object(metered, "connection_is_metered", return_value=True):
            self.assertTrue(metered.updates_on_start_enabled({"check_browser_updates_on_start": True}))
        with mock.patch.object(metered, "connection_is_metered", return_value=False):
            self.assertFalse(metered.updates_on_start_enabled({"check_browser_updates_on_start": False}))

    def test_missing_choice_follows_metered_connection(self):
        with mock.patch.object(metered, "connection_is_metered", return_value=True):
            self.assertFalse(metered.updates_on_start_enabled({}))
        with mock.patch.object(metered, "connection_is_metered", return_value=False):
            self.assertTrue(metered.updates_on_start_enabled({}))

    def test_settings_default_follows_metered_connection(self):
        with mock.patch.object(app_settings, "connection_is_metered", return_value=True):
            normalized = app_settings._normalize_settings({})
        self.assertFalse(normalized["check_browser_updates_on_start"])
        with mock.patch.object(app_settings, "connection_is_metered", return_value=False):
            kept = app_settings._normalize_settings({"check_browser_updates_on_start": False})
        self.assertFalse(kept["check_browser_updates_on_start"])


class ScrapePageGuardTests(unittest.TestCase):
    def test_hidden_scrape_page_blocks_browser_endpoints(self):
        with mock.patch.object(guards, "scrape_page_enabled", return_value=False):
            with self.assertRaises(HTTPException) as ctx:
                guards.require_scrape_page()
        self.assertEqual(ctx.exception.status_code, 409)

    def test_enabled_scrape_page_passes(self):
        with mock.patch.object(guards, "scrape_page_enabled", return_value=True):
            guards.require_scrape_page()


class _FakePage:
    def __init__(self, context):
        self.context = context

    def route(self, *_args):
        pass

    def close(self):
        self.context.pages.remove(self)


class _FakeContext:
    def __init__(self):
        self.pages: list[_FakePage] = []
        self.closed = False

    def new_page(self):
        page = _FakePage(self)
        self.pages.append(page)
        return page

    def close(self):
        self.closed = True


class _FakeBrowser:
    def __init__(self):
        self.contexts: list[_FakeContext] = []

    def new_context(self, **_options):
        context = _FakeContext()
        self.contexts.append(context)
        return context


class _FakeEngine(BrowserEngine):
    def start(self):
        self._browser = _FakeBrowser()

    def _stop(self):
        self._browser = None


class ContextCleanupTests(unittest.TestCase):
    def test_closed_pages_release_their_context(self):
        engine = _FakeEngine()
        engine.start()
        browser = engine._browser
        for _ in range(5):
            engine.new_page().close()
        live = engine.new_page()
        self.assertEqual([c.closed for c in browser.contexts], [True] * 5 + [False])
        self.assertEqual(engine._contexts, [live.context])

    def test_open_pages_keep_their_context(self):
        engine = _FakeEngine()
        engine.start()
        first = engine.new_page()
        engine.new_page()
        self.assertFalse(first.context.closed)

    def test_json_context_is_created_on_first_use(self):
        engine = _FakeEngine()
        engine.start()
        engine.new_page()
        self.assertIsNone(engine._api)
        self.assertEqual(len(engine._browser.contexts), 1)

    def test_close_releases_every_context(self):
        engine = _FakeEngine()
        engine.start()
        browser = engine._browser
        engine.new_page()
        engine.new_page()
        engine.close()
        self.assertTrue(all(c.closed for c in browser.contexts))


class AutoFallbackTests(unittest.TestCase):
    def _open(self, choice: str, obscura_start):
        fallback = mock.MagicMock(name="playwright")
        with mock.patch.object(
            session, "load_app_settings", return_value={"scrape_browser": choice}
        ), mock.patch.object(
            session, "obscura_executable", return_value=Path("obscura.exe")
        ), mock.patch.object(session, "ObscuraEngine") as obscura_cls, mock.patch.object(
            session, "PlaywrightChromiumEngine", return_value=fallback
        ):
            obscura_cls.return_value.start.side_effect = obscura_start
            return session.open_engine(), obscura_cls.return_value, fallback

    def setUp(self):
        session.last_fallback_error = None

    def test_auto_falls_back_and_records_why(self):
        with self.assertLogs(session.logger, level="WARNING"):
            engine, obscura, fallback = self._open("auto", RuntimeError("bad build"))
        self.assertIs(engine, fallback)
        obscura.close.assert_called_once()
        self.assertEqual(session.last_fallback_error, "bad build")

    def test_successful_start_clears_previous_fallback(self):
        session.last_fallback_error = "old"
        engine, obscura, _ = self._open("auto", None)
        self.assertIs(engine, obscura)
        self.assertIsNone(session.last_fallback_error)

    def test_explicit_obscura_does_not_fall_back(self):
        with self.assertRaises(RuntimeError):
            self._open("obscura", RuntimeError("bad build"))


if __name__ == "__main__":
    unittest.main()
