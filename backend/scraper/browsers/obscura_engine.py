"""Obscura via CDP. Playwright drives the page; Obscura is the browser process."""

from __future__ import annotations

import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import Playwright, sync_playwright

from backend.scraper.browsers.base import BrowserEngine
from backend.scraper.browsers.catalog import app_obscura_dir, obscura_executable


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class ObscuraEngine(BrowserEngine):
    engine_id = "obscura"

    def __init__(self, *, ignore_https_errors: bool = False) -> None:
        super().__init__(ignore_https_errors=ignore_https_errors)
        self._playwright: Playwright | None = None
        self._proc: subprocess.Popen[bytes] | None = None
        self._log: Path | None = None
        self._log_handle = None

    def start(self) -> None:
        binary = obscura_executable()
        if binary is None:
            raise RuntimeError("Obscura is not installed. Download it in Settings.")
        port = _free_port()
        # One log per session: a scrape and a tag refresh can run Obscura at the same time.
        self._log = app_obscura_dir() / f"serve-{port}.log"
        self._log.parent.mkdir(parents=True, exist_ok=True)
        self._log_handle = self._log.open("w", encoding="utf-8", errors="replace")
        flags = {"creationflags": 0x08000000} if sys.platform == "win32" else {}
        self._proc = subprocess.Popen(
            [str(binary), "serve", "--stealth", "--port", str(port)],
            stdout=subprocess.DEVNULL,
            stderr=self._log_handle,
            **flags,
        )
        endpoint = f"http://127.0.0.1:{port}"
        self._wait_until_ready(endpoint)
        self._playwright = sync_playwright().start()
        self._browser = self._playwright.chromium.connect_over_cdp(endpoint)

    def _stop(self) -> None:
        if self._browser is not None:
            try:
                self._browser.close()
            except Exception:
                pass
            self._browser = None
        if self._playwright is not None:
            try:
                self._playwright.stop()
            except Exception:
                pass
            self._playwright = None
        if self._proc is not None and self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
        self._proc = None
        if self._log_handle is not None:
            self._log_handle.close()
            self._log_handle = None
        if self._log is not None:
            self._log.unlink(missing_ok=True)
            self._log = None

    def _wait_until_ready(self, endpoint: str) -> None:
        deadline = time.monotonic() + 20
        last_error = ""
        while time.monotonic() < deadline:
            if self._proc is not None and self._proc.poll() is not None:
                raise RuntimeError(self._failure_text() or "Obscura exited before CDP was ready")
            try:
                with urllib.request.urlopen(f"{endpoint}/json/version", timeout=0.5) as response:
                    if response.status == 200:
                        return
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last_error = str(exc)
            time.sleep(0.2)
        raise RuntimeError(self._failure_text() or last_error or "Obscura CDP did not start")

    def _failure_text(self) -> str:
        if self._log_handle is not None:
            self._log_handle.flush()
        if self._log is None or not self._log.is_file():
            return ""
        text = self._log.read_text(encoding="utf-8", errors="replace").strip()
        return text[-500:]
