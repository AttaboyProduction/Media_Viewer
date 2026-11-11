"""Native app-style viewer window (Windows WebView2 via pywebview).

One window host process at a time. It runs detached so the tray/server keep
running while it blocks in ``webview.start``, and listens on a localhost socket
(address + auth key in ``data/app_window.json``) for ``show`` / ``quit``.

Open viewer sends ``show`` and only spawns a host when none answers; tray Quit
and in-app Exit send ``quit``. Reload / ``Run.bat restart`` leave the host alone.
"""

from __future__ import annotations

import json
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
from multiprocessing.connection import Client, Listener
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = ROOT / "data"
STATE_FILE = DATA_DIR / "app_window.json"
SPAWN_MARKER = DATA_DIR / "app_window.starting"
PROFILE_DIR = DATA_DIR / "webview_profile"
# Chrome/Edge --app= fallback when WebView2 is unavailable.
BROWSER_APP_PROFILE_DIR = DATA_DIR / "browser_app_profile"
CREATE_NO_WINDOW = 0x08000000
DETACHED_PROCESS = 0x00000008
WINDOW_TITLE = "Scrap Download"
MODULE = "backend.app.services.app_window"
# A host that was just spawned has not written its state yet; treat it as open.
SPAWN_GRACE_SECONDS = 15.0
CONNECT_TIMEOUT_SECONDS = 2.0


def _read_state() -> dict | None:
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or "port" not in data or "authkey" not in data:
        return None
    return data


def send_command(command: str) -> bool:
    """Send ``command`` to the running window host. False when no host answers."""
    state = _read_state()
    if state is None:
        return False
    previous_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(CONNECT_TIMEOUT_SECONDS)
    try:
        with Client(
            ("127.0.0.1", int(state["port"])),
            authkey=bytes.fromhex(str(state["authkey"])),
        ) as conn:
            conn.send(command)
            return conn.recv() == "ok"
    except (OSError, EOFError, ValueError, TypeError):
        return False
    finally:
        socket.setdefaulttimeout(previous_timeout)


def _spawn_pending() -> bool:
    try:
        return time.time() - SPAWN_MARKER.stat().st_mtime < SPAWN_GRACE_SECONDS
    except OSError:
        return False


def _viewer_python() -> str:
    exe = Path(sys.executable)
    if sys.platform == "win32" and exe.name.lower() == "python.exe":
        pythonw = exe.with_name("pythonw.exe")
        if pythonw.is_file():
            return str(pythonw)
    return str(exe)


def spawn_app_window(url: str) -> bool:
    """Start a detached window host loading ``url``. Returns False if spawn failed."""
    if sys.platform != "win32":
        return False
    env = os.environ.copy()
    env["PYTHONPATH"] = str(ROOT) + os.pathsep + env.get("PYTHONPATH", "")
    try:
        subprocess.Popen(
            [_viewer_python(), "-m", MODULE, url],
            cwd=ROOT,
            env=env,
            creationflags=DETACHED_PROCESS | CREATE_NO_WINDOW,
            close_fds=True,
        )
    except OSError:
        return False
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SPAWN_MARKER.write_text(str(time.time()), encoding="utf-8")
    return True


def open_or_focus_app_window(url: str) -> bool:
    """Focus the existing viewer window, or start one when none is running."""
    if send_command("show"):
        return True
    if _spawn_pending():
        return True
    return spawn_app_window(url)


def _kill_leftover_hosts() -> None:
    """Kill hosts that did not answer ``quit`` (hung, or pre-IPC builds) and --app= fallbacks.

    Matches on the command line, so the venv ``pythonw.exe`` redirector and its
    ``pythonw3.x.exe`` child both go.
    """
    if sys.platform != "win32":
        return
    profile = str(BROWSER_APP_PROFILE_DIR).replace("'", "''")
    # This script's own command line contains both patterns, so skip $PID.
    script = (
        "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {"
        " $_.ProcessId -ne $PID -and $_.CommandLine -and"
        f" ($_.CommandLine -like '*-m {MODULE}*'"
        f" -or $_.CommandLine -like '*--user-data-dir={profile}*')"
        "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    )
    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
            cwd=ROOT,
            creationflags=CREATE_NO_WINDOW,
            check=False,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        pass


def close_app_windows() -> None:
    """Close the viewer window (tray Quit / in-app Exit)."""
    send_command("quit")
    _kill_leftover_hosts()
    for path in (STATE_FILE, SPAWN_MARKER):
        try:
            path.unlink()
        except OSError:
            pass


def _bring_to_front(window) -> None:
    window.restore()
    window.show()
    # Windows refuses SetForegroundWindow from a background process; a brief
    # topmost toggle reliably raises the window instead.
    window.on_top = True
    window.on_top = False


def _serve_commands(listener: Listener, window) -> None:
    while True:
        try:
            conn = listener.accept()
        except (OSError, EOFError):
            return
        with conn:
            try:
                command = conn.recv()
            except (OSError, EOFError):
                continue
            conn.send("ok")
        if command == "show":
            _bring_to_front(window)
        elif command == "quit":
            window.destroy()
            return


def run_app_window(url: str) -> None:
    """Block in the native window until the user closes it."""
    import webview

    # Another host won the race (double click, Run.bat while starting): focus it and leave.
    if send_command("show"):
        return

    authkey = secrets.token_bytes(32)
    listener = Listener(("127.0.0.1", 0), authkey=authkey)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(
        json.dumps({"port": listener.address[1], "authkey": authkey.hex(), "pid": os.getpid()}),
        encoding="utf-8",
    )
    try:
        SPAWN_MARKER.unlink()
    except OSError:
        pass

    window = webview.create_window(WINDOW_TITLE, url, width=1280, height=900, min_size=(800, 600))
    threading.Thread(target=_serve_commands, args=(listener, window), daemon=True).start()
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        # Prefer Edge Chromium (WebView2): normal Windows title bar, no browser chrome.
        try:
            webview.start(gui="edgechromium", private_mode=False, storage_path=str(PROFILE_DIR))
        except Exception:
            webview.start(private_mode=False, storage_path=str(PROFILE_DIR))
    finally:
        listener.close()
        state = _read_state()
        if state and state.get("pid") == os.getpid():
            try:
                STATE_FILE.unlink()
            except OSError:
                pass


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
