"""Download and update Obscura and Playwright Chromium."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path

from backend.scraper.browsers.catalog import app_obscura_dir, app_obscura_executable, obscura_executable

# Stealth build: `obscura serve --stealth` needs the render+stealth binary.
OBSCURA_REPO = "h4ckf0r0day/obscura"
OBSCURA_ASSET = "obscura-x86_64-windows-stealth.zip"
# Used when the GitHub release API is unreachable; bump the digest together with the version.
OBSCURA_VERSION = "v0.2.3"
OBSCURA_SHA256 = "4d7311c69c3263bb8376055f9cb846968b75c77c444d4b5efa74b1018b456fb9"

UPDATE_CHECK_SECONDS = 24 * 60 * 60

_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

_chromium_path_cache: tuple[bool, str | None] = (False, None)


class BrowserInstallError(RuntimeError):
    pass


@dataclass(frozen=True)
class ObscuraRelease:
    version: str
    url: str
    sha256: str


def _playwright_env() -> dict[str, str]:
    env = os.environ.copy()
    browsers = env.get("PLAYWRIGHT_BROWSERS_PATH", "")
    if "cursor-sandbox-cache" in browsers.replace("\\", "/").lower():
        env.pop("PLAYWRIGHT_BROWSERS_PATH", None)
    return env


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd, env=_playwright_env(), capture_output=True, text=True, creationflags=_NO_WINDOW
    )


def _probe_chromium_path() -> str | None:
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        return None
    try:
        playwright = sync_playwright().start()
    except Exception:
        return None
    try:
        path = playwright.chromium.executable_path
    finally:
        playwright.stop()
    if path and Path(path).is_file():
        return path
    return None


def playwright_chromium_path() -> str | None:
    """Chromium path Playwright expects. Probed once per process (starting Playwright is slow)."""
    global _chromium_path_cache
    probed, path = _chromium_path_cache
    if probed and (path is None or Path(path).is_file()):
        return path
    path = _probe_chromium_path()
    _chromium_path_cache = (True, path)
    return path


def playwright_version() -> str | None:
    """Version of the loaded playwright code (dist-info METADATA can be missing after a synced-folder copy)."""
    try:
        from playwright._repo_version import version

        return str(version)
    except Exception:
        pass
    try:
        from importlib.metadata import version

        return version("playwright")
    except Exception:
        return None


def _playwright_cli_js() -> Path | None:
    try:
        import playwright
    except Exception:
        return None
    root = Path(playwright.__file__).resolve().parent
    return root / "driver" / "package" / "cli.js"


def _playwright_package_ok() -> bool:
    """False when the package is missing or the bundled Node driver was stripped/corrupt."""
    cli = _playwright_cli_js()
    return cli is not None and cli.is_file()


def _reinstall_playwright_package(python: str) -> None:
    """Reinstall the playwright wheel (needed when driver/package/cli.js is gone or dist-info is damaged)."""
    pip = [python, "-m", "pip", "install", "--upgrade", "--disable-pip-version-check"]
    upgrade = _run([*pip, "playwright"])
    if upgrade.returncode != 0:
        # Damaged dist-info (no RECORD) blocks uninstall; overwrite in place instead.
        upgrade = _run([*pip, "--ignore-installed", "--no-deps", "playwright"])
    if upgrade.returncode != 0:
        detail = (upgrade.stderr or upgrade.stdout or "").strip()
        raise BrowserInstallError(detail or "Playwright package reinstall failed")
    if not _playwright_package_ok():
        raise BrowserInstallError(
            "Playwright was reinstalled but its driver is still missing (driver/package/cli.js)"
        )


def install_playwright_chromium() -> str:
    global _chromium_path_cache
    if not _playwright_package_ok():
        _reinstall_playwright_package(sys.executable)
    completed = _run([sys.executable, "-m", "playwright", "install", "chromium"])
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise BrowserInstallError(detail or "Playwright Chromium install failed")
    _chromium_path_cache = (False, None)
    path = playwright_chromium_path()
    if not path:
        raise BrowserInstallError("Playwright Chromium install finished but the browser was not found")
    return path


def latest_obscura_release() -> ObscuraRelease:
    request = urllib.request.Request(
        f"https://api.github.com/repos/{OBSCURA_REPO}/releases/latest",
        headers={"User-Agent": "scrap-download", "Accept": "application/vnd.github+json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        data = json.load(response)
    asset = next((a for a in data.get("assets", []) if a.get("name") == OBSCURA_ASSET), None)
    if asset is None:
        raise BrowserInstallError(f"Latest Obscura release has no {OBSCURA_ASSET}")
    digest = str(asset.get("digest") or "")
    if not digest.startswith("sha256:"):
        raise BrowserInstallError("Latest Obscura release does not publish a SHA-256 digest")
    return ObscuraRelease(
        version=str(data.get("tag_name") or ""),
        url=str(asset["browser_download_url"]),
        sha256=digest.removeprefix("sha256:").lower(),
    )


def pinned_obscura_release() -> ObscuraRelease:
    return ObscuraRelease(
        version=OBSCURA_VERSION,
        url=f"https://github.com/{OBSCURA_REPO}/releases/download/{OBSCURA_VERSION}/{OBSCURA_ASSET}",
        sha256=OBSCURA_SHA256,
    )


def _version_file(data_dir: Path | None) -> Path:
    return app_obscura_dir(data_dir) / "version.txt"


def installed_obscura_version(data_dir: Path | None = None) -> str | None:
    """Version of the app-downloaded Obscura; None when absent or installed before versions were recorded."""
    if not app_obscura_executable(data_dir).is_file():
        return None
    try:
        return _version_file(data_dir).read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def _download(url: str, dest: Path) -> str:
    """Stream url to dest and return its SHA-256 hex digest."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    request = urllib.request.Request(url, headers={"User-Agent": "scrap-download"})
    with urllib.request.urlopen(request, timeout=180) as response, dest.open("wb") as handle:
        for chunk in iter(lambda: response.read(1024 * 1024), b""):
            digest.update(chunk)
            handle.write(chunk)
    return digest.hexdigest()


def install_obscura(data_dir: Path | None = None, release: ObscuraRelease | None = None) -> Path:
    """Download Obscura into the app data folder (latest release, pinned build if GitHub is unreachable)."""
    if sys.platform != "win32":
        raise BrowserInstallError(
            "Automatic Obscura download is set up for Windows. Install the binary and set OBSCURA_PATH."
        )
    if release is None:
        try:
            release = latest_obscura_release()
        except Exception:
            release = pinned_obscura_release()
    folder = app_obscura_dir(data_dir)
    folder.mkdir(parents=True, exist_ok=True)
    archive = folder / "obscura.zip"
    staging = folder / "_new"
    try:
        actual = _download(release.url, archive)
        if actual != release.sha256:
            raise BrowserInstallError(
                f"Obscura download checksum mismatch (got {actual}, expected {release.sha256})"
            )
        with zipfile.ZipFile(archive) as bundle:
            member = next(
                (name for name in bundle.namelist() if Path(name).name.lower() == "obscura.exe"),
                None,
            )
            if member is None:
                raise BrowserInstallError("Obscura archive has no obscura.exe")
            bundle.extract(member, staging)
        target = app_obscura_executable(data_dir)
        os.replace(staging / member, target)
        _version_file(data_dir).write_text(release.version, encoding="utf-8")
        return target
    finally:
        archive.unlink(missing_ok=True)
        shutil.rmtree(staging, ignore_errors=True)


def _update_obscura(data_dir: Path) -> str | None:
    if not app_obscura_executable(data_dir).is_file():
        external = obscura_executable(data_dir)
        return f"Obscura at {external} is managed outside the app; not updated" if external else None
    try:
        release = latest_obscura_release()
        if installed_obscura_version(data_dir) == release.version:
            return f"Obscura {release.version} is up to date"
        install_obscura(data_dir, release)
        return f"Obscura updated to {release.version}"
    except Exception as exc:
        return f"Obscura update failed: {exc}"


def _chromium_installed(python: str) -> bool:
    completed = _run(
        [
            python,
            "-c",
            "from pathlib import Path; from playwright.sync_api import sync_playwright; "
            "p=sync_playwright().start(); print(Path(p.chromium.executable_path).is_file()); p.stop()",
        ]
    )
    return completed.returncode == 0 and completed.stdout.strip().endswith("True")


def _update_playwright(python: str) -> str | None:
    """Chromium builds are tied to the playwright package, so updating Chromium = upgrading the package."""
    if not _chromium_installed(python):
        return None
    pip = [python, "-m", "pip", "install", "--upgrade", "--disable-pip-version-check"]
    upgrade = _run([*pip, "playwright"])
    if upgrade.returncode != 0 and "--ignore-installed" in (upgrade.stderr + upgrade.stdout):
        # Damaged dist-info (no RECORD) blocks uninstall; overwrite the package in place instead.
        upgrade = _run([*pip, "--ignore-installed", "--no-deps", "playwright"])
    if upgrade.returncode != 0:
        detail = (upgrade.stderr or upgrade.stdout or "").strip().splitlines()
        return f"Playwright update failed: {detail[-1] if detail else 'pip error'}"
    if "Successfully installed" not in upgrade.stdout:
        return "Playwright Chromium is up to date"
    browser = _run([python, "-m", "playwright", "install", "chromium"])
    if browser.returncode != 0:
        detail = (browser.stderr or browser.stdout or "").strip().splitlines()
        return f"Playwright Chromium update failed: {detail[-1] if detail else 'install error'}"
    return "Playwright and its Chromium were updated"


def _update_stamp(data_dir: Path) -> Path:
    return data_dir / "browsers" / "update-check.json"


def last_update_check(data_dir: Path) -> dict | None:
    """``{"checked_at": epoch, "results": [...]}`` from the last update check, if any."""
    try:
        data = json.loads(_update_stamp(data_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def update_browsers(data_dir: Path, python: str, *, force: bool = False) -> list[str] | None:
    """Update installed browsers at most once per UPDATE_CHECK_SECONDS. Missing browsers are left alone.

    Returns the result lines, or None when the check was skipped as too recent.
    Run it before the server starts: replacing obscura.exe or the playwright package under a
    running scrape fails on Windows.
    """
    stamp = _update_stamp(data_dir)
    if not force and stamp.is_file() and time.time() - stamp.stat().st_mtime < UPDATE_CHECK_SECONDS:
        return None
    results = [line for line in (_update_obscura(data_dir), _update_playwright(python)) if line]
    stamp.parent.mkdir(parents=True, exist_ok=True)
    stamp.write_text(json.dumps({"checked_at": time.time(), "results": results}), encoding="utf-8")
    return results
