"""Browser engines the scraper can open. Add a new engine by registering it here.

Stdlib-only at import time: the launcher checks for Obscura before app packages load.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

CHOICES = ("auto", "obscura", "playwright")
ENGINE_IDS = ("obscura", "playwright")


def normalize_choice(value: object) -> str:
    text = str(value or "auto").strip().lower()
    return text if text in CHOICES else "auto"


def _data_dir(data_dir: Path | None) -> Path:
    if data_dir is not None:
        return data_dir
    from backend.app.config import settings

    return settings.data_dir


def app_obscura_dir(data_dir: Path | None = None) -> Path:
    return _data_dir(data_dir) / "browsers" / "obscura"


def app_obscura_executable(data_dir: Path | None = None) -> Path:
    name = "obscura.exe" if sys.platform == "win32" else "obscura"
    return app_obscura_dir(data_dir) / name


def obscura_executable(data_dir: Path | None = None) -> Path | None:
    """First Obscura binary that exists: env, app download, user install, PATH."""
    candidates: list[Path] = []
    env = os.environ.get("OBSCURA_PATH", "").strip()
    if env:
        candidates.append(Path(env))
    candidates.append(app_obscura_executable(data_dir))
    local = os.environ.get("LOCALAPPDATA", "").strip()
    if local:
        candidates.append(Path(local) / "obscura" / "obscura.exe")
    found = shutil.which("obscura")
    if found:
        candidates.append(Path(found))
    for path in candidates:
        if path.is_file():
            return path
    return None


def resolve_engine(choice: str, *, obscura_present: bool) -> str:
    """Which engine a scrape should open. Explicit Obscura stays Obscura even if missing."""
    selected = normalize_choice(choice)
    if selected == "playwright":
        return "playwright"
    if selected == "obscura":
        return "obscura"
    return "obscura" if obscura_present else "playwright"
