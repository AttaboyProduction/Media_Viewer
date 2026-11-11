"""Install missing dependencies, start the app, open the browser, and run in the tray."""

from __future__ import annotations

import hashlib
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

from versioning import (
    read_installed_version,
    read_repo_version,
    version_needs_update as _version_needs_update,
    write_installed_version as _write_installed_version,
)

ROOT = Path(__file__).resolve().parent
VENV_DIR = ROOT / ".venv"
DEPS_HASH_PATH = VENV_DIR / ".deps-hash"
REQUIREMENTS = ROOT / "requirements.txt"
FRONTEND_DIR = ROOT / "frontend"
DIST_INDEX = FRONTEND_DIR / "dist" / "index.html"
ASSETS_DIR = ROOT / "assets"
ICON_PATH = ASSETS_DIR / "tray-icon.png"
DATA_DIR = ROOT / "data"
HOST = "127.0.0.1"
PORT = 8000
APP_URL = f"http://{HOST}:{PORT}"
HEALTH_URL = f"{APP_URL}/api/health"
SERVER_LOG_PATH = DATA_DIR / "server.log"
LAUNCHER_LOG_PATH = DATA_DIR / "launcher.log"


def venv_python() -> Path:
    if sys.platform == "win32":
        return VENV_DIR / "Scripts" / "python.exe"
    return VENV_DIR / "bin" / "python"


def venv_pythonw() -> Path:
    if sys.platform == "win32":
        candidate = VENV_DIR / "Scripts" / "pythonw.exe"
        if candidate.is_file():
            return candidate
    return venv_python()


def log(message: str) -> None:
    print(message, flush=True)
    try:
        LAUNCHER_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LAUNCHER_LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(message + "\n")
    except OSError:
        pass


def read_log_tail(log_path: Path, max_lines: int = 50) -> str:
    if not log_path.is_file():
        return ""
    try:
        lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
        return "\n".join(lines[-max_lines:])
    except OSError:
        return ""


def report_server_startup_failure(proc: subprocess.Popen | None) -> None:
    exit_code = proc.poll() if proc is not None else None
    log("")
    log("=" * 60)
    log("SERVER FAILED TO START")
    log("=" * 60)
    if exit_code is not None:
        log(f"Server process exited with code {exit_code}")
    else:
        log("Server did not become healthy within the timeout")
    tail = read_log_tail(SERVER_LOG_PATH)
    if tail:
        log("")
        log(f"Last lines from {SERVER_LOG_PATH.relative_to(ROOT)}:")
        log("-" * 60)
        log(tail)
        log("-" * 60)
    else:
        log(f"No output in {SERVER_LOG_PATH.relative_to(ROOT)} yet.")
    log("")


def refresh_windows_path() -> None:
    """Rebuild PATH from the registry + known extras without stacking duplicates.

    Reload inherits the server env (already refreshed once). Calling this again used
    to prepend registry paths onto themselves until PATH grew so large that ``npm run
    build`` could no longer resolve ``tsc`` from ``node_modules/.bin``.
    """
    if sys.platform != "win32":
        return
    import winreg

    parts: list[str] = []
    for hive, key in (
        (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
        (winreg.HKEY_CURRENT_USER, r"Environment"),
    ):
        try:
            with winreg.OpenKey(hive, key) as handle:
                value, _ = winreg.QueryValueEx(handle, "Path")
                if value:
                    parts.append(value)
        except OSError:
            continue
    extras = [
        str(Path.home() / "AppData/Local/Programs/Python/Python312"),
        str(Path.home() / "AppData/Local/Programs/Python/Python312/Scripts"),
        str(Path.home() / "AppData/Local/Programs/Python/Python313"),
        str(Path.home() / "AppData/Local/Programs/Python/Python313/Scripts"),
        r"C:\Program Files\nodejs",
        str(Path.home() / "AppData/Roaming/npm"),
    ]
    merged: list[str] = []
    seen: set[str] = set()
    for chunk in (*parts, *extras, os.environ.get("PATH", "")):
        for item in chunk.split(os.pathsep):
            item = item.strip().strip('"')
            if not item:
                continue
            key = os.path.normcase(item)
            if key in seen:
                continue
            seen.add(key)
            merged.append(item)
    os.environ["PATH"] = os.pathsep.join(merged)


def which(name: str) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    if sys.platform == "win32":
        return shutil.which(f"{name}.cmd") or shutil.which(f"{name}.exe")
    return None


def run(cmd: list[str] | str, **kwargs) -> None:
    """Run a bootstrap command; on failure log stderr/stdout and raise CalledProcessError."""
    cwd = kwargs.pop("cwd", ROOT)
    display = cmd if isinstance(cmd, str) else " ".join(cmd)
    log(f"> {display}")
    # Capture output so pythonw (no console) still records why install steps fail.
    # Do not force CREATE_NO_WINDOW here: npm.cmd / winget need a console when started
    # from a console-attached Run.bat; Reload uses pythonw which has none either way.
    completed = subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        **kwargs,
    )
    if completed.returncode == 0:
        return
    detail = (completed.stderr or completed.stdout or "").strip()
    if detail:
        # Keep the alert readable; full text is in data/launcher.log.
        for line in detail.splitlines()[-40:]:
            log(line)
    raise subprocess.CalledProcessError(
        completed.returncode,
        cmd,
        output=completed.stdout,
        stderr=completed.stderr,
    )


def winget_install(package_id: str) -> None:
    winget = which("winget")
    if not winget:
        raise RuntimeError(f"winget is not available; install {package_id} manually.")
    run(
        [
            winget,
            "install",
            "-e",
            "--id",
            package_id,
            "--accept-package-agreements",
            "--accept-source-agreements",
        ]
    )
    refresh_windows_path()


def alert(message: str, title: str = "Scrap Download") -> None:
    log(message)
    if sys.platform == "win32":
        import ctypes

        ctypes.windll.user32.MessageBoxW(0, message, title, 0x10)


def hide_console() -> None:
    """Hide and detach from the console so Run.bat / cmd windows can exit."""
    if sys.platform != "win32":
        return
    import ctypes

    hwnd = ctypes.windll.kernel32.GetConsoleWindow()
    if hwnd:
        ctypes.windll.user32.ShowWindow(hwnd, 0)
    try:
        ctypes.windll.kernel32.FreeConsole()
    except Exception:
        pass


def relaunch_detached() -> int:
    """Spawn launcher under pythonw (no console) and exit this process."""
    if sys.platform != "win32":
        return 1
    exe = venv_pythonw()
    creationflags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    cmd = [str(exe), str(ROOT / "launcher.py"), "--in-venv", *launcher_extra_args()]
    env = os.environ.copy()
    if skip_open_viewer():
        env["SCRAP_SKIP_OPEN_VIEWER"] = "1"
    subprocess.Popen(
        cmd,
        cwd=ROOT,
        creationflags=creationflags,
        close_fds=True,
        env=env,
    )
    return 0


def port_open() -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((HOST, PORT)) == 0


def app_is_healthy() -> bool:
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=2) as response:
            return response.status == 200
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def wait_for_health(timeout: float = 90.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if app_is_healthy():
            return True
        time.sleep(0.5)
    return False


def requirements_hash() -> str:
    return hashlib.sha256(REQUIREMENTS.read_bytes()).hexdigest()


def venv_is_usable(python: Path) -> bool:
    """True if the venv interpreter runs and is Python 3.11+."""
    if not python.is_file():
        return False
    try:
        result = subprocess.run(
            [
                str(python),
                "-c",
                "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def ensure_venv() -> Path:
    python = venv_python()
    if venv_is_usable(python):
        return python
    if VENV_DIR.exists():
        log("Existing .venv is broken or too old; recreating...")
        shutil.rmtree(VENV_DIR, ignore_errors=True)
    if sys.version_info < (3, 11):
        raise RuntimeError(
            f"Python 3.11+ is required to create .venv (found {sys.version.split()[0]}). "
            "Run Run.bat so it can install a newer Python via winget."
        )
    log("Creating virtual environment...")
    run([sys.executable, "-m", "venv", str(VENV_DIR)])
    if not venv_is_usable(python):
        raise RuntimeError(f"Failed to create a usable virtualenv at {VENV_DIR}")
    return python


def repo_version() -> str:
    return read_repo_version(ROOT)


def installed_version() -> str | None:
    return read_installed_version(DATA_DIR)


def version_needs_update() -> bool:
    return _version_needs_update(ROOT, DATA_DIR)


def write_installed_version(version: str) -> None:
    _write_installed_version(DATA_DIR, version)


def ensure_python_packages(*, force: bool = False) -> None:
    current = requirements_hash()
    previous = DEPS_HASH_PATH.read_text(encoding="utf-8").strip() if DEPS_HASH_PATH.exists() else ""
    installed = any(VENV_DIR.rglob("fastapi/__init__.py"))
    if not force and previous == current and installed:
        return
    if force and DEPS_HASH_PATH.exists():
        try:
            DEPS_HASH_PATH.unlink()
        except OSError:
            pass
    log("Installing Python packages...")
    run([str(venv_python()), "-m", "pip", "install", "--upgrade", "pip"])
    run([str(venv_python()), "-m", "pip", "install", "-r", str(REQUIREMENTS)])
    DEPS_HASH_PATH.write_text(current, encoding="utf-8")


def playwright_env() -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(ROOT)
    # Cursor agent shells redirect Playwright into a temp sandbox cache.
    # That path is incomplete/unstable for normal Run.bat runs — prefer the
    # default user browsers directory instead of re-downloading Chromium.
    browsers = env.get("PLAYWRIGHT_BROWSERS_PATH", "")
    if "cursor-sandbox-cache" in browsers.replace("\\", "/").lower():
        env.pop("PLAYWRIGHT_BROWSERS_PATH", None)
    return env


def read_app_settings() -> dict:
    path = ROOT / "data" / "app_settings.json"
    try:
        import json

        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def update_scrape_browsers() -> None:
    """Browsers are only for scraping: skip them while the Scrape page is hidden.

    Missing browsers are not installed here; the Scrape page and Settings offer the download.
    """
    settings = read_app_settings()
    if settings.get("hide_scrape_page", False):
        return
    # Stdlib-only module, so this runs in the launcher process before the server imports playwright.
    from backend.scraper.browsers.metered import updates_on_start_enabled

    if not updates_on_start_enabled(settings):
        reason = (
            "turned off in Settings"
            if "check_browser_updates_on_start" in settings
            else "metered connection"
        )
        log(f"Skipping scrape browser update check ({reason}).")
        return
    from backend.scraper.browsers.install import update_browsers

    results = update_browsers(ROOT / "data", str(venv_python()))
    if results is None:
        return
    log("Checked scrape browsers for updates:")
    for line in results or ["No scrape browsers installed"]:
        log(f"  {line}")


def frontend_needs_build() -> bool:
    if not DIST_INDEX.is_file():
        return True
    dist_mtime = DIST_INDEX.stat().st_mtime
    for path in [FRONTEND_DIR / "package.json", FRONTEND_DIR / "index.html", FRONTEND_DIR / "vite.config.ts"]:
        if path.is_file() and path.stat().st_mtime > dist_mtime:
            return True
    src = FRONTEND_DIR / "src"
    if src.is_dir():
        for path in src.rglob("*"):
            if path.is_file() and path.stat().st_mtime > dist_mtime:
                return True
    return False


def ensure_node() -> str:
    npm = which("npm")
    if npm:
        return npm
    log("Node.js not found. Installing Node.js LTS via winget (needs network)...")
    winget_install("OpenJS.NodeJS.LTS")
    refresh_windows_path()
    # Give the shell a moment; winget PATH updates are often delayed.
    for _ in range(20):
        npm = which("npm")
        if npm:
            return npm
        time.sleep(0.5)
    npm = which("npm")
    if not npm:
        raise RuntimeError(
            "Node.js/npm is still not available after install. "
            "Close this window and run Run.bat again (or install Node.js LTS manually)."
        )
    return npm


def npm_argv(*args: str) -> list[str]:
    """Build an argv that runs npm without shell=True (avoids .cmd failures under pythonw)."""
    npm = ensure_node()
    if sys.platform == "win32" and npm.lower().endswith((".cmd", ".bat")):
        node = which("node")
        if node:
            for base in (Path(npm).resolve().parent, Path(node).resolve().parent):
                cli = base / "node_modules" / "npm" / "bin" / "npm-cli.js"
                if cli.is_file():
                    return [node, str(cli), *args]
    return [npm, *args]


def ensure_frontend(*, force: bool = False) -> None:
    if not force and not frontend_needs_build():
        return
    ensure_node()
    log("Building the viewer UI...")
    env = os.environ.copy()
    bin_dir = FRONTEND_DIR / "node_modules" / ".bin"
    if bin_dir.is_dir():
        env["PATH"] = str(bin_dir) + os.pathsep + env.get("PATH", "")
    run(npm_argv("install"), cwd=FRONTEND_DIR, env=env)
    run(npm_argv("run", "build"), cwd=FRONTEND_DIR, env=env)


def stop_running_app() -> None:
    """Stop server/tray for this project (same idea as Run.bat restart), excluding this process."""
    my_pid = os.getpid()
    if sys.platform == "win32":
        root_ps = str(ROOT).replace("'", "''")
        script = (
            f"$root = '{root_ps}';"
            f"$skip = {my_pid};"
            "Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | "
            "Where-Object { $_.OwningProcess -and $_.OwningProcess -gt 0 -and $_.OwningProcess -ne $skip } | "
            "ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue };"
            "Get-CimInstance Win32_Process | "
            "Where-Object { $_.ProcessId -ne $skip -and $_.Name -match '^python(w)?\\.exe$' "
            "-and $_.CommandLine -and "
            "($_.CommandLine -like \"*$root*launcher.py*\" -or "
            "$_.CommandLine -like \"*$root*uvicorn*backend.app.main*\") } | "
            "ForEach-Object { if ($_.ProcessId -gt 0) { "
            "Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }"
        )
        kwargs: dict = {"cwd": ROOT}
        kwargs["creationflags"] = 0x08000000
        subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-WindowStyle",
                "Hidden",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ],
            **kwargs,
        )
        time.sleep(2)
        for _ in range(30):
            if not port_open():
                break
            time.sleep(0.2)
        return
    # Non-Windows: best-effort free the listen port only.
    if port_open():
        log(f"Port {PORT} is still in use; stop the running app and try again.")


def force_update_install() -> None:
    """Forced pip + frontend rebuild + launcher exe after a VERSION mismatch."""
    ensure_python_packages(force=True)
    ensure_frontend(force=True)
    ensure_windows_launcher()


def ensure_windows_launcher() -> None:
    """First Run.bat install writes Scrap Download.exe next to the project."""
    if sys.platform != "win32":
        return
    from backend.app.services.windows_startup import STUB_PATH, ensure_launcher_exe

    if not STUB_PATH.is_file():
        log("Creating Scrap Download.exe...")
    ensure_launcher_exe()


def ensure_icon() -> Path:
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    if ICON_PATH.exists():
        return ICON_PATH
    from PIL import Image, ImageDraw

    image = Image.new("RGBA", (64, 64), (23, 26, 33, 255))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((6, 6, 58, 58), radius=12, fill=(37, 99, 235, 255))
    draw.rectangle((18, 22, 46, 42), outline=(232, 234, 237, 255), width=3)
    image.save(ICON_PATH)
    return ICON_PATH


def start_server() -> subprocess.Popen:
    SERVER_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    log_file = open(SERVER_LOG_PATH, "a", encoding="utf-8")
    env = playwright_env()
    kwargs: dict = {
        "cwd": ROOT,
        "stdout": log_file,
        "stderr": subprocess.STDOUT,
        "env": env,
    }
    if sys.platform == "win32":
        kwargs["creationflags"] = 0x08000000
    proc = subprocess.Popen(
        [
            str(venv_python()),
            "-m",
            "uvicorn",
            "backend.app.main:app",
            "--host",
            HOST,
            "--port",
            str(PORT),
        ],
        **kwargs,
    )
    proc.log_file = log_file  # type: ignore[attr-defined]
    return proc


def stop_server(proc: subprocess.Popen | None) -> None:
    if proc is None:
        return
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
    log_file = getattr(proc, "log_file", None)
    if log_file:
        log_file.close()


def open_app_window(url: str) -> bool:
    """Focus or open the native app window (WebView2). Fall back to Chrome/Edge --app=."""
    if sys.platform != "win32":
        return False
    try:
        from backend.app.services.app_window import open_or_focus_app_window

        if open_or_focus_app_window(url):
            return True
    except Exception as exc:
        log(f"Native app window unavailable ({exc}); trying browser app mode.")

    from backend.app.services.app_window import BROWSER_APP_PROFILE_DIR

    BROWSER_APP_PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    app_args = [f"--user-data-dir={BROWSER_APP_PROFILE_DIR}", f"--app={url}"]
    local = os.environ.get("LOCALAPPDATA", "")
    candidates = [
        os.path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
        "msedge",
        os.path.join(os.environ.get("PROGRAMFILES", ""), "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(os.environ.get("PROGRAMFILES(X86)", ""), "Google", "Chrome", "Application", "chrome.exe"),
    ]
    for exe in candidates:
        if Path(exe).is_file() or which(exe):
            try:
                subprocess.Popen([exe, *app_args], creationflags=0x08000000)
                return True
            except OSError:
                continue
    return False


def open_viewer_ui() -> None:
    mode = read_app_settings().get("display_mode", "browser")
    if mode == "window" and open_app_window(APP_URL):
        return
    webbrowser.open(APP_URL)


SKIP_OPEN_FLAG = ROOT / "data" / ".skip_open_viewer"
# Keep the flag across kill → Start → pythonw races; do not delete on first reader.
SKIP_OPEN_TTL_SEC = 120


def skip_open_viewer() -> bool:
    """True when Reload / Restart asked not to open another viewer.

    Checks env, CLI ``--no-open-viewer``, and a fresh ``data/.skip_open_viewer``.
    The flag is TTL-based (not consume-on-read) so a late "already running" launcher
    still skips after an earlier process started the tray.
    """
    env_skip = os.environ.get("SCRAP_SKIP_OPEN_VIEWER", "").strip().lower() in (
        "1",
        "true",
        "yes",
    )
    arg_skip = "--no-open-viewer" in sys.argv
    file_skip = False
    if SKIP_OPEN_FLAG.is_file():
        try:
            age = time.time() - SKIP_OPEN_FLAG.stat().st_mtime
            if age <= SKIP_OPEN_TTL_SEC:
                file_skip = True
            else:
                SKIP_OPEN_FLAG.unlink(missing_ok=True)
        except OSError:
            file_skip = SKIP_OPEN_FLAG.is_file()
    return env_skip or arg_skip or file_skip


def write_skip_open_viewer_flag() -> None:
    """Touch the skip flag so Restart / Reload relaunches do not open a viewer."""
    SKIP_OPEN_FLAG.parent.mkdir(parents=True, exist_ok=True)
    SKIP_OPEN_FLAG.write_text("1", encoding="utf-8")


def launcher_extra_args() -> list[str]:
    """Args to preserve across venv / pythonw relaunch."""
    extra: list[str] = []
    if "--bootstrap-only" in sys.argv:
        extra.append("--bootstrap-only")
    if skip_open_viewer():
        extra.append("--no-open-viewer")
    return extra


def run_tray(owned_process: subprocess.Popen | None) -> None:
    import pystray
    from PIL import Image

    image = Image.open(ensure_icon())

    def open_viewer(icon=None, item=None) -> None:
        open_viewer_ui()

    def on_quit(icon, item) -> None:
        # Windowed mode viewers are separate processes; close them with the tray.
        try:
            from backend.app.services.app_window import close_app_windows

            close_app_windows()
        except Exception as exc:
            log(f"Could not close app windows on quit: {exc}")
        stop_server(owned_process)
        icon.stop()

    menu = pystray.Menu(
        pystray.MenuItem("Open viewer", open_viewer, default=True),
        pystray.MenuItem("Quit", on_quit),
    )
    icon = pystray.Icon("scrap_download", image, "Scrap Download", menu)
    hide_console()
    if not skip_open_viewer() and not read_app_settings().get("start_minimized", True):
        open_viewer_ui()
    icon.run()


def bootstrap_and_run() -> int:
    args = set(sys.argv[1:])
    bootstrap_only = "--bootstrap-only" in args

    refresh_windows_path()
    if not bootstrap_only:
        log("Checking environment...")
    python = ensure_venv()
    exe_path = Path(sys.executable).resolve()
    venv_py = python.resolve()
    venv_pw = venv_pythonw().resolve()
    if exe_path not in (venv_py, venv_pw):
        log("Switching to project virtual environment...")
        if sys.platform == "win32" and not bootstrap_only:
            return relaunch_detached()
        cmd = [str(python), str(ROOT / "launcher.py"), "--in-venv", *launcher_extra_args()]
        return subprocess.call(cmd, cwd=ROOT)

    if version_needs_update():
        wanted = repo_version()
        previous = installed_version() or "(none)"
        log(f"App version changed ({previous} -> {wanted}). Updating install...")
        if port_open() or app_is_healthy():
            log("Stopping running app for version update...")
            stop_running_app()
        force_update_install()
        write_installed_version(wanted)
        log(f"Installed version stamped as {wanted}.")
    else:
        ensure_python_packages()
        ensure_frontend()
        ensure_windows_launcher()

    update_scrape_browsers()
    ensure_icon()

    if bootstrap_only:
        log("Environment ready.")
        return 0

    # Console-attached python.exe: hand off to pythonw so closing the terminal does not kill the app.
    if sys.platform == "win32" and not sys.executable.lower().endswith("pythonw.exe"):
        return relaunch_detached()

    hide_console()

    owned_process = None
    if port_open():
        if app_is_healthy():
            # Same as the tray "Open viewer" item. Do not start a second tray icon.
            # Reload / Restart must not open another tab/window here (common race).
            if skip_open_viewer():
                log("App is already running (reload/restart). Not opening another viewer.")
                return 0
            log("App is already running. Opening the viewer...")
            open_viewer_ui()
            return 0
        alert(f"Port {PORT} is already in use by another program.")
        return 1
    else:
        log("Starting server...")
        owned_process = start_server()
        if not wait_for_health():
            stop_server(owned_process)
            report_server_startup_failure(owned_process)
            alert("Server failed to start. See the error output above.")
            return 1

    try:
        run_tray(owned_process)
    except KeyboardInterrupt:
        stop_server(owned_process)
    return 0


def _format_install_failure(exc: subprocess.CalledProcessError) -> str:
    cmd = exc.cmd
    if isinstance(cmd, (list, tuple)):
        cmd_text = " ".join(str(part) for part in cmd)
    else:
        cmd_text = str(cmd or "")
    detail = (exc.stderr or exc.output or "").strip()
    lines = [
        f"Install step failed with exit code {exc.returncode}.",
    ]
    if cmd_text:
        lines.extend(["", "Command:", cmd_text])
    if detail:
        tail = "\n".join(detail.splitlines()[-12:])
        lines.extend(["", "Output:", tail])
    lines.extend(["", f"See {LAUNCHER_LOG_PATH.relative_to(ROOT)} for details."])
    return "\n".join(lines)


if __name__ == "__main__":
    try:
        raise SystemExit(bootstrap_and_run())
    except subprocess.CalledProcessError as exc:
        message = _format_install_failure(exc)
        log(message)
        alert(message)
        raise SystemExit(exc.returncode)
    except Exception as exc:
        log(f"Error: {exc}")
        import traceback

        traceback.print_exc()
        alert(str(exc))
        raise SystemExit(1)
