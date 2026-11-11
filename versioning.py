"""App VERSION (repo) vs data/installed_version (local stamp after a successful update)."""

from __future__ import annotations

from pathlib import Path

VERSION_FILENAME = "VERSION"
INSTALLED_VERSION_FILENAME = "installed_version"
DEFAULT_REPO_VERSION = "0.0"


def read_repo_version(root: Path) -> str:
    path = root / VERSION_FILENAME
    if not path.is_file():
        return DEFAULT_REPO_VERSION
    text = path.read_text(encoding="utf-8").strip()
    return text or DEFAULT_REPO_VERSION


def read_installed_version(data_dir: Path) -> str | None:
    path = data_dir / INSTALLED_VERSION_FILENAME
    if not path.is_file():
        return None
    text = path.read_text(encoding="utf-8").strip()
    return text or None


def version_needs_update(root: Path, data_dir: Path) -> bool:
    local = read_installed_version(data_dir)
    if local is None:
        return True
    return local != read_repo_version(root)


def write_installed_version(data_dir: Path, version: str) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / INSTALLED_VERSION_FILENAME).write_text(f"{version.strip()}\n", encoding="utf-8")
