"""Windows login startup.

Task Manager names a startup item from the target program's file description.
A shortcut to pythonw.exe therefore shows up as Python, so startup launches a
small Scrap Download.exe whose description is the app name.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
# Older installs registered this Run value, which Task Manager lists as pythonw.exe.
LEGACY_RUN_VALUE = "ScrapDownloadViewer"
APP_NAME = "Scrap Download"
# Bump when the stub source changes so an existing exe is rebuilt.
STUB_ID = "1"
STUB_PATH = ROOT / f"{APP_NAME}.exe"

_STUB_SOURCE = r"""
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

[assembly: AssemblyTitle("Scrap Download")]
[assembly: AssemblyProduct("Scrap Download")]
[assembly: AssemblyCompany("Scrap Download")]
[assembly: AssemblyDescription("Scrap Download")]
[assembly: AssemblyFileVersion("1.0.0.0")]
[assembly: AssemblyVersion("1.0.0.0")]

namespace ScrapDownloadStartup
{
    static class Program
    {
        static void Main()
        {
            string root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string pythonw = Path.Combine(root, ".venv", "Scripts", "pythonw.exe");
            string python = Path.Combine(root, ".venv", "Scripts", "python.exe");
            string exe = File.Exists(pythonw) ? pythonw : python;
            string launcher = Path.Combine(root, "launcher.py");
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = exe;
            psi.Arguments = "\"" + launcher + "\" --in-venv";
            psi.WorkingDirectory = root;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            Process.Start(psi);
        }
    }
}
"""


def _startup_dir() -> Path:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise OSError("APPDATA is not set")
    return Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"


def shortcut_path() -> Path:
    return _startup_dir() / f"{APP_NAME}.lnk"


def _stamp_path() -> Path:
    return ROOT / "data" / ".scrap_download_stub"


def _csc_path() -> Path | None:
    windir = Path(os.environ.get("WINDIR", r"C:\Windows"))
    for candidate in (
        windir / "Microsoft.NET" / "Framework64" / "v4.0.30319" / "csc.exe",
        windir / "Microsoft.NET" / "Framework" / "v4.0.30319" / "csc.exe",
    ):
        if candidate.is_file():
            return candidate
    return None


def _compile_stub(dest: Path) -> None:
    csc = _csc_path()
    if csc is None:
        raise RuntimeError("Could not find the .NET Framework C# compiler (csc.exe).")
    dest.parent.mkdir(parents=True, exist_ok=True)
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "ScrapDownloadStartup.cs"
        built = Path(tmp) / "ScrapDownload.exe"
        source.write_text(_STUB_SOURCE, encoding="utf-8")
        subprocess.run(
            [
                str(csc),
                "/nologo",
                "/target:winexe",
                "/optimize+",
                f"/out:{built}",
                str(source),
            ],
            check=True,
            creationflags=flags,
        )
        shutil.copyfile(built, dest)


def ensure_launcher_exe() -> Path | None:
    """Build Scrap Download.exe beside the project when it is missing. Windows only."""
    if sys.platform != "win32":
        return None
    return _ensure_stub()


def _ensure_stub() -> Path:
    stamp = _stamp_path()
    current = stamp.read_text(encoding="utf-8").strip() if stamp.is_file() else ""
    if not (STUB_PATH.is_file() and current == STUB_ID):
        _compile_stub(STUB_PATH)
        stamp.parent.mkdir(parents=True, exist_ok=True)
        stamp.write_text(STUB_ID, encoding="utf-8")
        _set_friendly_name(STUB_PATH)
    return STUB_PATH


def _set_friendly_name(exe: Path) -> None:
    """Shell display name. Task Manager falls back to the exe file description."""
    import winreg

    key_path = r"Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache"
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
        winreg.SetValueEx(key, f"{exe}.FriendlyAppName", 0, winreg.REG_SZ, APP_NAME)
        winreg.SetValueEx(key, f"{exe}.ApplicationCompany", 0, winreg.REG_SZ, APP_NAME)


def _ps_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _write_shortcut(link: Path, target: Path) -> None:
    link.parent.mkdir(parents=True, exist_ok=True)
    script = "\n".join(
        [
            "$shell = New-Object -ComObject WScript.Shell",
            f"$shortcut = $shell.CreateShortcut({_ps_quote(str(link))})",
            f"$shortcut.TargetPath = {_ps_quote(str(target))}",
            '$shortcut.Arguments = ""',
            f"$shortcut.WorkingDirectory = {_ps_quote(str(ROOT))}",
            f"$shortcut.Description = {_ps_quote(APP_NAME)}",
            "$shortcut.WindowStyle = 1",
            "$shortcut.Save()",
        ]
    )
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        check=True,
        creationflags=flags,
    )


def _remove_legacy_run_value() -> None:
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
            winreg.DeleteValue(key, LEGACY_RUN_VALUE)
    except FileNotFoundError:
        pass


def sync_launch_on_startup(enabled: bool) -> None:
    if sys.platform != "win32":
        return
    link = shortcut_path()
    if enabled:
        _write_shortcut(link, _ensure_stub())
        _remove_legacy_run_value()
        return
    _remove_legacy_run_value()
    link.unlink(missing_ok=True)


def is_launch_on_startup_registered() -> bool:
    if sys.platform != "win32":
        return False
    return shortcut_path().is_file()
