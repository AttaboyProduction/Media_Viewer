import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from backend.app.api.guards import require_scrape_page
from backend.app.config import settings
from backend.app.schemas.app_settings import AppSettingsOut, AppSettingsPatch, app_settings_out
from backend.app.services.app_settings import (
    load_app_settings,
    load_app_settings_persisting_update_default,
    save_app_settings,
)
from backend.scraper.browsers.catalog import normalize_choice, obscura_executable, resolve_engine
from backend.scraper.browsers.metered import connection_is_metered
from backend.scraper.browsers.install import (
    install_obscura,
    install_playwright_chromium,
    installed_obscura_version,
    last_update_check,
    playwright_chromium_path,
    playwright_version,
)

ROOT = Path(__file__).resolve().parents[3]

router = APIRouter(prefix="/app", tags=["app"])


def _powershell_kill_script() -> str:
    """Stop server/tray and any detached windowed-mode viewers for this project."""
    root = str(ROOT).replace("'", "''")
    return (
        f"$root = '{root}';"
        "Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | "
        "Where-Object { $_.OwningProcess -and $_.OwningProcess -gt 0 } | "
        "ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue };"
        "Get-CimInstance Win32_Process | "
        "Where-Object { $_.Name -match '^python(w)?\\.exe$' -and $_.CommandLine -and "
        "($_.CommandLine -like \"*$root*launcher.py*\" -or "
        "$_.CommandLine -like \"*$root*uvicorn*backend.app.main*\" -or "
        "$_.CommandLine -match 'backend\\.app\\.services\\.app_window') } | "
        "ForEach-Object { if ($_.ProcessId -gt 0) { "
        "Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } };"
        "Get-Process -ErrorAction SilentlyContinue | Where-Object {"
        "  $_.MainWindowTitle -eq 'Scrap Download' -and $_.ProcessName -match '^pythonw?$'"
        "} | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue };"
        "$sessions = Join-Path $root 'data\\browser_app_sessions';"
        "if (Test-Path -LiteralPath $sessions) {"
        "  Get-CimInstance Win32_Process | Where-Object {"
        "    $_.CommandLine -and ("
        "      $_.CommandLine -like ('*--user-data-dir=' + $sessions + '*') -or"
        "      $_.CommandLine -like ('*--user-data-dir=\"' + $sessions + '*')"
        "    )"
        "  } | ForEach-Object {"
        "    if ($_.ProcessId -gt 0) {"
        "      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue"
        "    }"
        "  }"
        "}"
    )


def _run_powershell(script: str) -> None:
    if sys.platform == "win32":
        subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
            cwd=ROOT,
            creationflags=0x08000000,
        )
    else:
        os._exit(0)


class BrowserEngineStatus(BaseModel):
    id: str
    name: str
    installed: bool
    path: str | None = None
    version: str | None = None


class BrowserUpdateCheck(BaseModel):
    checked_at: float
    results: list[str]


class BrowsersStatusOut(BaseModel):
    selected: str
    resolved: str
    engines: list[BrowserEngineStatus]
    # Set when the last Auto scrape could not start Obscura and used Playwright instead.
    fallback_error: str | None = None
    # Written by the launcher's daily update check.
    last_update_check: BrowserUpdateCheck | None = None
    connection_metered: bool = False


class BrowserInstallRequest(BaseModel):
    engine: str = Field(pattern="^(obscura|playwright)$")


def _browsers_status() -> BrowsersStatusOut:
    from backend.scraper.browsers import session

    data = load_app_settings()
    selected = normalize_choice(data.get("scrape_browser"))
    obscura = obscura_executable()
    chromium = playwright_chromium_path()
    check = last_update_check(settings.data_dir)
    try:
        update = BrowserUpdateCheck.model_validate(check) if check else None
    except ValueError:
        update = None
    return BrowsersStatusOut(
        selected=selected,
        resolved=resolve_engine(selected, obscura_present=obscura is not None),
        fallback_error=session.last_fallback_error if selected == "auto" else None,
        last_update_check=update,
        connection_metered=connection_is_metered(),
        engines=[
            BrowserEngineStatus(
                id="obscura",
                name="Obscura",
                installed=obscura is not None,
                path=str(obscura) if obscura else None,
                version=installed_obscura_version() if obscura else None,
            ),
            BrowserEngineStatus(
                id="playwright",
                name="Playwright Chromium",
                installed=chromium is not None,
                path=chromium,
                version=playwright_version() if chromium else None,
            ),
        ],
    )


@router.get("/browsers", response_model=BrowsersStatusOut)
def get_browsers() -> BrowsersStatusOut:
    return _browsers_status()


@router.post(
    "/browsers/install",
    response_model=BrowsersStatusOut,
    dependencies=[Depends(require_scrape_page)],
)
def install_browser(payload: BrowserInstallRequest) -> BrowsersStatusOut:
    try:
        if payload.engine == "obscura":
            install_obscura()
        else:
            install_playwright_chromium()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _browsers_status()


class AdapterPackageOut(BaseModel):
    id: str
    path: str
    site_ids: list[str] = Field(default_factory=list)
    site_names: list[str] = Field(default_factory=list)


class AdaptersStatusOut(BaseModel):
    installed: list[AdapterPackageOut]
    project: list[AdapterPackageOut]


class AdapterInstallRequest(BaseModel):
    path: str | None = None
    from_project: str | None = None


def _adapters_status() -> AdaptersStatusOut:
    from backend.scraper.adapter_loader import (
        installed_adapters_dir,
        list_adapter_packages,
        project_adapters_dir,
    )

    return AdaptersStatusOut(
        installed=[AdapterPackageOut(**item) for item in list_adapter_packages(installed_adapters_dir())],
        project=[AdapterPackageOut(**item) for item in list_adapter_packages(project_adapters_dir())],
    )


@router.get("/adapters", response_model=AdaptersStatusOut, dependencies=[Depends(require_scrape_page)])
def get_adapters() -> AdaptersStatusOut:
    return _adapters_status()


@router.post(
    "/adapters/install",
    response_model=AdaptersStatusOut,
    dependencies=[Depends(require_scrape_page)],
)
def install_adapter(payload: AdapterInstallRequest) -> AdaptersStatusOut:
    from backend.scraper import sites as sites_mod
    from backend.scraper.adapter_loader import (
        install_adapter_from_project,
        install_adapters_from_path,
    )

    if payload.from_project and payload.path:
        raise HTTPException(status_code=400, detail="Provide either from_project or path, not both")
    try:
        if payload.from_project:
            install_adapter_from_project(payload.from_project.strip())
        elif payload.path:
            install_adapters_from_path(Path(payload.path.strip()))
        else:
            raise HTTPException(status_code=400, detail="Provide from_project or path")
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    sites_mod.reload_adapter_catalog()
    # Coerce stale site selection if the previous catalog vanished / changed.
    sites_mod.persist_session_settings(sites_mod.load_session_settings())
    return _adapters_status()


@router.post(
    "/adapters/pick-folder",
    dependencies=[Depends(require_scrape_page)],
)
def pick_adapter_folder() -> dict:
    """Native folder picker starting in project adapters/ (or one package under it)."""
    from backend.app.services.native_dialogs import dialogs_available, pick_folder
    from backend.scraper.adapter_loader import project_adapters_dir

    if not dialogs_available():
        raise HTTPException(status_code=501, detail="Native folder dialogs are not available")
    start = project_adapters_dir()
    if not start.is_dir():
        start = ROOT
    folder = pick_folder(title="Select adapters folder or one adapter package", initial_dir=start)
    return {"path": folder}


@router.get("/settings", response_model=AppSettingsOut)
def get_settings() -> AppSettingsOut:
    return app_settings_out(load_app_settings_persisting_update_default())


@router.patch("/settings", response_model=AppSettingsOut)
def patch_settings(payload: AppSettingsPatch) -> AppSettingsOut:
    updates = payload.model_dump(exclude_unset=True)
    data = save_app_settings(updates)
    return app_settings_out(data)


def _restart_launch_env() -> dict[str, str]:
    """Env for Run.bat restart: skip-viewer flag, no agent/npm junk, deduped PATH.

    The server process PATH already went through launcher.refresh_windows_path.
    Passing it through again on every Reload used to stack registry entries until
    ``npm run build`` could not resolve ``tsc``.
    """
    env = os.environ.copy()
    env["SCRAP_SKIP_OPEN_VIEWER"] = "1"
    for key in list(env):
        lower = key.lower()
        if lower.startswith("npm_config_") or lower == "npm_config" or lower.startswith("npm_"):
            env.pop(key, None)
    browsers = env.get("PLAYWRIGHT_BROWSERS_PATH", "")
    if "cursor-sandbox-cache" in browsers.replace("\\", "/").lower():
        env.pop("PLAYWRIGHT_BROWSERS_PATH", None)
    path = env.get("PATH", "")
    if path:
        merged: list[str] = []
        seen: set[str] = set()
        for item in path.split(os.pathsep):
            item = item.strip().strip('"')
            if not item:
                continue
            key = os.path.normcase(item)
            if key in seen:
                continue
            seen.add(key)
            merged.append(item)
        env["PATH"] = os.pathsep.join(merged)
    return env


@router.post("/restart")
def restart_app() -> dict:
    def _restart() -> None:
        time.sleep(0.4)
        run_bat = ROOT / "Run.bat"
        if run_bat.is_file() and sys.platform == "win32":
            # In-app Reload keeps the current browser/window and calls location.reload()
            # after health returns — do not open a second viewer on relaunch.
            # Run.bat restart also writes the flag + env; set both here so a partial path still skips.
            flag = ROOT / "data" / ".skip_open_viewer"
            flag.parent.mkdir(parents=True, exist_ok=True)
            flag.write_text("1", encoding="utf-8")
            # CREATE_NO_WINDOW: no console flash on Reload. Run.bat uses PowerShell
            # Sleep (not timeout); launcher builds the UI via node/npm-cli (not npm.cmd).
            subprocess.Popen(
                ["cmd", "/c", str(run_bat), "restart"],
                cwd=ROOT,
                creationflags=0x08000000,
                env=_restart_launch_env(),
            )
        else:
            _run_powershell(_powershell_kill_script())
            os._exit(0)

    threading.Thread(target=_restart, daemon=True).start()
    return {"ok": True}


@router.post("/shutdown")
def shutdown_app() -> dict:
    def _shutdown() -> None:
        time.sleep(0.4)
        try:
            from backend.app.services.app_window import close_app_windows

            close_app_windows()
        except Exception:
            pass
        _run_powershell(_powershell_kill_script())
        os._exit(0)

    threading.Thread(target=_shutdown, daemon=True).start()
    return {"ok": True}


@router.post("/open-viewer")
def open_viewer() -> dict:
    """Open the viewer using the saved display mode (native window or browser)."""
    url = "http://127.0.0.1:8000"
    mode = load_app_settings().get("display_mode", "browser")
    if mode == "window":
        from backend.app.services.app_window import open_or_focus_app_window

        if open_or_focus_app_window(url):
            return {"ok": True, "mode": "window"}
        # Fall through: client may open a popup if native window fails.
        raise HTTPException(
            status_code=503,
            detail="Native app window could not be started (is pywebview installed?)",
        )
    import webbrowser

    webbrowser.open(url)
    return {"ok": True, "mode": "browser"}


@router.get("/info")
def app_info() -> dict:
    return {
        "display_mode": load_app_settings()["display_mode"],
        "frontend_dist": str(settings.frontend_dist),
    }
