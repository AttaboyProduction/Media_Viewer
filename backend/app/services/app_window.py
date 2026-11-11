"""Native app-style viewer window (Windows WebView2 via pywebview).

Opened as a detached process so the tray/server keep running while the window
blocks in ``webview.start``.

Each window gets its own WebView2 user-data folder so concurrent instances do
not fight over a shared UserDataFolder. Open viewer focuses an existing window
when one is already open; tray Quit / Exit kill these processes.
"""

from __future__ import annotations

import json
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
PIDS_FILE = SESSIONS_DIR / "pids.json"
WINDOW_TITLE = "Scrap Download"
# Appended to the WebView user-agent so the SPA can detect app-shell (WebView2 UA
# does not include "WebView").
UA_MARKER = "ScrapDownloadApp/1"


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


def _run_powershell(script: str) -> subprocess.CompletedProcess[str] | None:
    if sys.platform != "win32":
        return None
    try:
        return subprocess.run(
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
            capture_output=True,
            text=True,
        )
    except OSError:
        return None


def _load_pids() -> list[int]:
    try:
        raw = json.loads(PIDS_FILE.read_text(encoding="utf-8"))
        if isinstance(raw, list):
            return [int(x) for x in raw if int(x) > 0]
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass
    return []


def _save_pids(pids: list[int]) -> None:
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    alive = []
    for pid in pids:
        try:
            os.kill(pid, 0)
            alive.append(pid)
        except OSError:
            continue
    PIDS_FILE.write_text(json.dumps(alive), encoding="utf-8")


def _record_pid(pid: int) -> None:
    pids = _load_pids()
    if pid not in pids:
        pids.append(pid)
    _save_pids(pids)


def _existing_window_count() -> int:
    """How many native viewer windows are currently open (by process scan)."""
    if sys.platform != "win32":
        return 0
    script = (
        "$n = 0;"
        "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {"
        "  $_.CommandLine -and ($_.CommandLine -match 'backend\\.app\\.services\\.app_window')"
        "} | ForEach-Object { $n++ };"
        "Get-Process -ErrorAction SilentlyContinue | Where-Object {"
        f"  $_.MainWindowTitle -eq '{WINDOW_TITLE}' -and $_.ProcessName -match '^pythonw?$'"
        "} | ForEach-Object { $n++ };"
        "Write-Output $n"
    )
    result = _run_powershell(script)
    if not result or not result.stdout:
        return len(_load_pids())
    try:
        return int(result.stdout.strip().splitlines()[-1])
    except ValueError:
        return len(_load_pids())


def focus_existing_app_window() -> bool:
    """Bring an existing native viewer to the front. Returns True if one was found."""
    if sys.platform != "win32":
        return False
    pid_list = ",".join(str(p) for p in _load_pids())
    script = (
        "Add-Type -TypeDefinition @'\n"
        "using System;\n"
        "using System.Runtime.InteropServices;\n"
        "public static class ScrapWin {\n"
        "  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);\n"
        "  [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);\n"
        "  [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr hWnd);\n"
        "}\n"
        "'@ -ErrorAction SilentlyContinue;\n"
        "$found = $false;\n"
        "function Focus-Handle([IntPtr]$h) {\n"
        "  if ($h -eq [IntPtr]::Zero) { return }\n"
        "  if ([ScrapWin]::IsIconic($h)) { [void][ScrapWin]::ShowWindow($h, 9) }\n"
        "  [void][ScrapWin]::SetForegroundWindow($h)\n"
        "  $script:found = $true\n"
        "}\n"
        "Get-Process -ErrorAction SilentlyContinue | Where-Object {\n"
        f"  $_.MainWindowTitle -eq '{WINDOW_TITLE}' -and $_.MainWindowHandle -ne 0\n"
        "} | ForEach-Object { Focus-Handle $_.MainWindowHandle };\n"
        "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {\n"
        "  $_.CommandLine -and ($_.CommandLine -match 'backend\\.app\\.services\\.app_window')\n"
        "} | ForEach-Object {\n"
        "  $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue;\n"
        "  if ($p) { Focus-Handle $p.MainWindowHandle }\n"
        "};\n"
        f"$extra = @({pid_list});\n"
        "foreach ($procId in $extra) {\n"
        "  if ($procId -gt 0) {\n"
        "    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue;\n"
        "    if ($p) { Focus-Handle $p.MainWindowHandle }\n"
        "  }\n"
        "};\n"
        "if ($found) { Write-Output '1' } else { Write-Output '0' }\n"
    )
    result = _run_powershell(script)
    return bool(
        result and result.stdout and result.stdout.strip().splitlines()[-1].strip() == "1"
    )


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def spawn_app_window(url: str) -> bool:
    """Start a detached native window loading ``url``. Returns False if spawn failed."""
    if sys.platform != "win32":
        return False
    env = os.environ.copy()
    env["PYTHONPATH"] = str(ROOT) + os.pathsep + env.get("PYTHONPATH", "")
    try:
        proc = subprocess.Popen(
            [_viewer_python(), "-m", "backend.app.services.app_window", url],
            cwd=ROOT,
            env=env,
            creationflags=DETACHED_PROCESS | CREATE_NO_WINDOW,
            close_fds=True,
        )
        if proc.pid:
            _record_pid(proc.pid)
        return True
    except OSError:
        return False


def open_or_focus_app_window(url: str) -> bool:
    """Focus an existing native viewer, or spawn one if none are open."""
    if focus_existing_app_window():
        # focus_existing returns True only when a window was actually focused.
        return True
    if _existing_window_count() > 0:
        # Title focus failed but processes exist — still avoid opening another.
        return True
    return spawn_app_window(url)


def close_app_windows() -> None:
    """Kill detached native viewer windows for this project (tray Quit / Exit).

    Reload / ``Run.bat restart`` intentionally leave these open.
    """
    if sys.platform != "win32":
        return
    pids = _load_pids()
    # Avoid `$PID` — it is a PowerShell automatic variable.
    script = (
        "$tracked = @(" + ",".join(str(p) for p in pids) + ");\n"
        "foreach ($procId in $tracked) {\n"
        "  if ($procId -gt 0) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue }\n"
        "}\n"
        "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {\n"
        "  $_.CommandLine -and ($_.CommandLine -match 'backend\\.app\\.services\\.app_window')\n"
        "} | ForEach-Object {\n"
        "  if ($_.ProcessId -gt 0) {\n"
        "    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue\n"
        "  }\n"
        "};\n"
        "Get-Process -ErrorAction SilentlyContinue | Where-Object {\n"
        f"  $_.MainWindowTitle -eq '{WINDOW_TITLE}' -and $_.ProcessName -match '^pythonw?$'\n"
        "} | ForEach-Object {\n"
        "  Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue\n"
        "};\n"
        "$sessions = Join-Path '"
        + str(ROOT).replace("'", "''")
        + "' 'data\\browser_app_sessions';\n"
        "if (Test-Path -LiteralPath $sessions) {\n"
        "  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {\n"
        "    $_.CommandLine -and (\n"
        "      $_.CommandLine -like ('*--user-data-dir=' + $sessions + '*') -or\n"
        "      $_.CommandLine -like ('*--user-data-dir=\"' + $sessions + '*')\n"
        "    )\n"
        "  } | ForEach-Object {\n"
        "    if ($_.ProcessId -gt 0) {\n"
        "      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue\n"
        "    }\n"
        "  }\n"
        "}\n"
    )
    _run_powershell(script)
    try:
        if PIDS_FILE.is_file():
            PIDS_FILE.unlink()
    except OSError:
        pass


def run_app_window(url: str) -> None:
    """Block in a native window until the user closes it."""
    import webview

    session = _new_session_dir()
    webview.create_window(
        WINDOW_TITLE,
        url,
        width=1280,
        height=900,
        min_size=(800, 600),
    )
    # Prefer Edge Chromium (WebView2): normal Windows title bar, no browser chrome.
    # Unique storage_path per process keeps multiple app windows independent.
    try:
        try:
            webview.start(
                gui="edgechromium",
                storage_path=str(session),
                user_agent=f"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 {UA_MARKER}",
            )
        except Exception:
            webview.start(
                storage_path=str(session),
                user_agent=f"Mozilla/5.0 (Windows NT 10.0; Win64; x64) {UA_MARKER}",
            )
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
