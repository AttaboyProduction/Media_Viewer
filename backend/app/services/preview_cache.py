"""Square, low-quality JPEGs for media cards, stored under data/previews/.

The grid asks for compact, normal, or large. Each file is a center cover-crop
at that card's pixel size (2× the CSS minimum) so the browser does not download
the original image or video just to paint a card.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import threading
from io import BytesIO
from pathlib import Path

from PIL import Image

from backend.app.config import settings

# 2× the viewer card minimums (compact 120, normal 180, large 240).
PREVIEW_EDGES: dict[str, int] = {"compact": 240, "normal": 360, "large": 480}
JPEG_QUALITY = 62

_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0
_guard = threading.Lock()
_locks: dict[tuple[int, str], threading.Lock] = {}


def preview_edge(size: str) -> int:
    try:
        return PREVIEW_EDGES[size]
    except KeyError as exc:
        raise ValueError("size must be compact, normal, or large") from exc


def _lock_for(media_id: int, size: str) -> threading.Lock:
    key = (media_id, size)
    with _guard:
        lock = _locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _locks[key] = lock
        return lock


def preview_file(media_id: int, size: str) -> Path:
    preview_edge(size)
    return settings.data_dir / "previews" / size / f"{media_id}.jpg"


def _fresh(cache: Path, source: Path) -> bool:
    if not cache.is_file():
        return False
    try:
        return cache.stat().st_mtime >= source.stat().st_mtime
    except OSError:
        return False


def _cover_square(image: Image.Image, edge: int) -> Image.Image:
    image = image.convert("RGB")
    width, height = image.size
    if width < 1 or height < 1:
        raise ValueError("Image has no pixels")
    scale = max(edge / width, edge / height)
    resized = image.resize(
        (max(edge, round(width * scale)), max(edge, round(height * scale))),
        Image.Resampling.LANCZOS,
    )
    left = max(0, (resized.width - edge) // 2)
    top = max(0, (resized.height - edge) // 2)
    return resized.crop((left, top, left + edge, top + edge))


def _still_frame(source: Path) -> Image.Image:
    with Image.open(source) as image:
        image.seek(0)
        return image.convert("RGB")


def _video_frame(source: Path) -> Image.Image | None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return None
    completed = subprocess.run(
        [
            ffmpeg,
            "-ss",
            "0.5",
            "-i",
            str(source),
            "-frames:v",
            "1",
            "-f",
            "image2pipe",
            "-vcodec",
            "png",
            "-",
        ],
        capture_output=True,
        timeout=60,
        creationflags=_NO_WINDOW,
    )
    if completed.returncode != 0 or not completed.stdout:
        return None
    with Image.open(BytesIO(completed.stdout)) as image:
        return image.convert("RGB")


def _source_image(source: Path, media_type: str) -> Image.Image:
    if media_type == "video":
        frame = _video_frame(source)
        if frame is None:
            raise ValueError("Could not read a video frame")
        return frame
    return _still_frame(source)


def ensure_preview(media_id: int, source: Path, media_type: str, size: str = "normal") -> Path:
    """Return the cached square JPEG, building it when the file is new or newer."""
    dest = preview_file(media_id, size)
    edge = preview_edge(size)
    with _lock_for(media_id, size):
        if _fresh(dest, source):
            return dest
        image = _source_image(source, media_type)
        square = _cover_square(image, edge)
        dest.parent.mkdir(parents=True, exist_ok=True)
        payload = BytesIO()
        square.save(payload, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        temporary = dest.with_suffix(".jpg.part")
        temporary.write_bytes(payload.getvalue())
        temporary.replace(dest)
        return dest
