"""Native OS file/folder dialogs (real absolute paths for link-in-place import)."""

from __future__ import annotations

import sys
import threading
from pathlib import Path


_dialog_lock = threading.Lock()


def _run_tk(fn):
    """Run a tkinter dialog on a short-lived root; serialize so two dialogs never overlap."""
    import tkinter as tk

    with _dialog_lock:
        root = tk.Tk()
        root.withdraw()
        try:
            root.attributes("-topmost", True)
        except tk.TclError:
            pass
        try:
            return fn(root)
        finally:
            try:
                root.destroy()
            except tk.TclError:
                pass


def pick_files() -> list[str]:
    """Multi-select image/video files; returns absolute paths (empty if cancelled)."""
    from tkinter import filedialog

    filetypes = [
        (
            "Media",
            "*.jpg *.jpeg *.png *.gif *.webp *.bmp *.tif *.tiff "
            "*.mp4 *.webm *.mkv *.mov *.avi *.m4v",
        ),
        ("All files", "*.*"),
    ]

    def _open(_root) -> tuple[str, ...] | str:
        return filedialog.askopenfilenames(title="Select media files", filetypes=filetypes)

    result = _run_tk(_open)
    if not result:
        return []
    paths = list(result) if isinstance(result, (tuple, list)) else [result]
    return [str(Path(p).resolve()) for p in paths if p]


def pick_folder(*, title: str = "Select a media folder", initial_dir: str | Path | None = None) -> str | None:
    """Pick one folder; returns absolute path or None if cancelled.

    Call repeatedly from the UI to accumulate multiple folders (OS has no
    reliable multi-folder picker).
    """
    from tkinter import filedialog

    start = None
    if initial_dir is not None:
        candidate = Path(initial_dir)
        if candidate.is_dir():
            start = str(candidate.resolve())

    def _open(_root) -> str:
        kwargs: dict = {"title": title, "mustexist": True}
        if start:
            kwargs["initialdir"] = start
        return filedialog.askdirectory(**kwargs)

    result = _run_tk(_open)
    if not result:
        return None
    return str(Path(result).resolve())


def dialogs_available() -> bool:
    if sys.platform != "win32" and sys.platform != "darwin" and not sys.platform.startswith("linux"):
        return False
    try:
        import tkinter  # noqa: F401
    except Exception:
        return False
    return True
