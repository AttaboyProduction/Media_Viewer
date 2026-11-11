"""Native app-style viewer window (Windows WebView2 via pywebview).

Opened as a detached process so the tray/server keep running while the window
blocks in ``webview.start``.

Each window gets its own WebView2 user-data folder so a second Open viewer /
Run.bat does not close or navigate an already-open window (WebView2 only allows
one process per shared UserDataFolder).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CREATE_NO_WINDOW = 0x08000000
DETACHED_PROCESS = 0x00000008
SESSIONS_DIR = ROOT / "data" / "webview_sessions"


def _viewer_python() -> str:
    exe = Path(sys.executable)
    if sys.platform == "win32" and exe.name.lower() == "python.exe":
        pythonw = exe.with_name("pythonw.exe")
        if pythonw.is_file():
            return str(pythonw)
    return str(exe)


def _new_session_dir() -> Path:
    path = SESSIONS_DIR / uuid.uuid4().hex
    path.mkdir(parents=True, exist_ok=True)
    return path


def spawn_app_window(url: str) -> bool:
    """Start a detached native window loading ``url``. Returns False if spawn failed."""
    if sys.platform != "win32":
        return False
    env = os.environ.copy()
    env["PYTHONPATH"] = str(ROOT) + os.pathsep + env.get("PYTHONPATH", "")
    try:
        subprocess.Popen(
            [_viewer_python(), "-m", "backend.app.services.app_window", url],
            cwd=ROOT,
            env=env,
            creationflags=DETACHED_PROCESS | CREATE_NO_WINDOW,
            close_fds=True,
        )
        return True
    except OSError:
        return False


def close_app_windows() -> None:
    """Kill detached native viewer windows for this project (tray Quit / Exit).

    Reload / ``Run.bat restart`` intentionally leave these open.
    """
    if sys.platform != "win32":
        return
    root_ps = str(ROOT).replace("'", "''")
    script = (
        f"$root = '{root_ps}';"
        "Get-CimInstance Win32_Process | Where-Object {"
        "  $_.Name -match '^python(w)?\\.exe$' -and $_.CommandLine -and"
        "  ($_.CommandLine -like \"*$root*\") -and"
        "  ($_.CommandLine -like '*backend.app.services.app_window*')"
        "} | ForEach-Object {"
        "  if ($_.ProcessId -gt 0) {"
        "    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue"
        "  }"
        "};"
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
    try:
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
            cwd=ROOT,
            creationflags=CREATE_NO_WINDOW,
            check=False,
        )
    except OSError:
        pass


def run_app_window(url: str) -> None:
    """Block in a native window until the user closes it."""
    import webview

    session = _new_session_dir()
    webview.create_window(
        "Scrap Download",
        url,
        width=1280,
        height=900,
        min_size=(800, 600),
    )
    # Prefer Edge Chromium (WebView2): normal Windows title bar, no browser chrome.
    # Unique storage_path per process keeps multiple app windows independent.
    try:
        try:
            webview.start(gui="edgechromium", storage_path=str(session))
        except Exception:
            webview.start(storage_path=str(session))
    finally:
        shutil.rmtree(session, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    url = args[0] if args else "http://127.0.0.1:8000"
    try:
        run_app_window(url)
    except Exception as exc:
        # Visible when launched under python.exe for debugging; pythonw has no console.
        sys.stderr.write(f"App window failed: {exc}\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
