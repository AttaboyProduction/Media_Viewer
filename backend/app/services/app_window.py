"""Native app-style viewer window (Windows WebView2 via pywebview).

Opened as a detached process so the tray/server keep running while the window
blocks in ``webview.start``.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CREATE_NO_WINDOW = 0x08000000
DETACHED_PROCESS = 0x00000008


def _viewer_python() -> str:
    exe = Path(sys.executable)
    if sys.platform == "win32" and exe.name.lower() == "python.exe":
        pythonw = exe.with_name("pythonw.exe")
        if pythonw.is_file():
            return str(pythonw)
    return str(exe)


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


def run_app_window(url: str) -> None:
    """Block in a native window until the user closes it."""
    import webview

    webview.create_window(
        "Scrap Download",
        url,
        width=1280,
        height=900,
        min_size=(800, 600),
    )
    # Prefer Edge Chromium (WebView2): normal Windows title bar, no browser chrome.
    try:
        webview.start(gui="edgechromium")
    except Exception:
        webview.start()


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
