"""Helpers for linked (on-disk) local media — no copy into media/."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from urllib.parse import quote

STORAGE_MANAGED = "managed"
STORAGE_LINKED = "linked"

_IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
_GIF_EXT = {".gif"}
_VIDEO_EXT = {".mp4", ".webm", ".mkv", ".mov", ".avi", ".m4v"}


def normalize_absolute_path(path: str | Path) -> Path:
    """Resolve to a stable absolute path for identity / DB storage."""
    return Path(path).expanduser().resolve()


def linked_source_post_id(path: Path) -> str:
    """Stable unique source_post_id (≤32 chars) from an absolute path."""
    key = str(normalize_absolute_path(path)).casefold().replace("\\", "/")
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
    return f"loc_{digest}"


def file_uri_for_path(path: Path) -> str:
    abs_path = normalize_absolute_path(path)
    # Windows: file:///C:/Users/...
    as_posix = abs_path.as_posix()
    if re.match(r"^[A-Za-z]:/", as_posix):
        return "file:///" + quote(as_posix, safe="/:")
    return abs_path.as_uri()


def media_type_for_path(path: Path) -> str | None:
    ext = path.suffix.lower()
    if ext in _GIF_EXT:
        return "gif"
    if ext in _IMAGE_EXT:
        return "image"
    if ext in _VIDEO_EXT:
        return "video"
    return None


def is_supported_media_path(path: Path) -> bool:
    return path.is_file() and media_type_for_path(path) is not None


def iter_media_files(paths: list[str], *, recursive: bool) -> list[Path]:
    """Expand folder/file picks into a de-duplicated list of supported media files."""
    found: list[Path] = []
    seen: set[str] = set()
    for raw in paths:
        root = Path(raw)
        if not root.exists():
            continue
        if root.is_file():
            candidates = [root]
        elif root.is_dir():
            pattern = "**/*" if recursive else "*"
            candidates = [p for p in root.glob(pattern) if p.is_file()]
        else:
            continue
        for candidate in candidates:
            if not is_supported_media_path(candidate):
                continue
            resolved = normalize_absolute_path(candidate)
            key = str(resolved).casefold()
            if key in seen:
                continue
            seen.add(key)
            found.append(resolved)
    return found
