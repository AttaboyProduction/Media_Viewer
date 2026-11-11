from __future__ import annotations

import hashlib
import shutil
import subprocess
import sys
from io import BytesIO
from pathlib import Path

import imagehash
from PIL import Image
from sqlalchemy.orm import Session

from backend.app.db.models import MediaItem

# Hamming 0–2 is the same picture (re-encode / resize). Capped by the sensitivity setting.
IDENTICAL_MAX_DISTANCE = 2
# Four frames. Identical only: every frame must fall in the identical band. No "similar" for video.
_VIDEO_FRACTIONS = (0.1, 0.35, 0.6, 0.85)
_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def perceptual_hash(path: Path, media_type: str) -> str | None:
    if media_type == "video":
        return video_perceptual_hash(path)
    if media_type not in {"image", "gif"}:
        return None
    try:
        with Image.open(path) as img:
            img.seek(0)
            return str(imagehash.phash(img.convert("RGB")))
    except Exception:
        return None


def video_perceptual_hash(path: Path) -> str | None:
    """Frame hashes for identical-video matching. None when ffmpeg cannot read the file."""
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe or not path.is_file():
        return None
    duration = _video_duration(ffprobe, path)
    if duration is None or duration <= 0:
        return None
    hashes: list[str] = []
    for fraction in _VIDEO_FRACTIONS:
        frame = _video_frame(ffmpeg, path, max(0.0, duration * fraction - 0.05))
        if frame is None:
            return None
        hashes.append(str(imagehash.phash(frame)))
    return "v:" + ",".join(hashes)


def _video_duration(ffprobe: str, path: Path) -> float | None:
    completed = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
            str(path),
        ],
        capture_output=True,
        text=True,
        timeout=30,
        creationflags=_NO_WINDOW,
    )
    if completed.returncode != 0:
        return None
    try:
        return float(completed.stdout.strip())
    except ValueError:
        return None


def _video_frame(ffmpeg: str, path: Path, timestamp: float) -> Image.Image | None:
    completed = subprocess.run(
        [
            ffmpeg,
            "-ss",
            f"{timestamp:.3f}",
            "-i",
            str(path),
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
    try:
        with Image.open(BytesIO(completed.stdout)) as img:
            return img.convert("RGB")
    except Exception:
        return None


def hamming_distance(left: str, right: str) -> int:
    return imagehash.hex_to_hash(left) - imagehash.hex_to_hash(right)


def _threshold(explicit: int | None) -> int:
    if explicit is not None:
        return explicit
    from backend.app.services.app_settings import get_phash_threshold

    return get_phash_threshold()


def classify_distance(distance: int, threshold: int | None = None) -> str | None:
    """``identical``, ``similar``, or None if outside the sensitivity setting."""
    limit = _threshold(threshold)
    identical_cap = min(IDENTICAL_MAX_DISTANCE, limit)
    if distance <= identical_cap:
        return "identical"
    if distance <= limit:
        return "similar"
    return None


def classify_video_hash(left: str | None, right: str | None, threshold: int | None = None) -> str | None:
    """Identical when every sampled frame is within the identical band. Never returns similar."""
    if not (left or "").startswith("v:") or not (right or "").startswith("v:"):
        return None
    left_parts = left[2:].split(",")
    right_parts = right[2:].split(",")
    if len(left_parts) != len(right_parts) or not left_parts:
        return None
    limit = _threshold(threshold)
    cap = min(IDENTICAL_MAX_DISTANCE, limit)
    try:
        distances = [hamming_distance(a, b) for a, b in zip(left_parts, right_parts)]
    except Exception:
        return None
    if max(distances) <= cap:
        return "identical"
    return None


def classify_stored_hash(left: str | None, right: str | None, threshold: int | None = None) -> str | None:
    if (left or "").startswith("v:") or (right or "").startswith("v:"):
        return classify_video_hash(left, right, threshold)
    return classify_phash(left, right, threshold)


def classify_phash(left: str | None, right: str | None, threshold: int | None = None) -> str | None:
    if not left or not right:
        return None
    try:
        return classify_distance(hamming_distance(left, right), threshold)
    except Exception:
        return None


def find_earlier_phash_match(
    db: Session,
    phash: str | None,
    *,
    exclude_id: int | None = None,
    threshold: int | None = None,
) -> tuple[MediaItem, str] | None:
    """Earliest (lowest id) visual match. Loads id + phash only, then the matching row."""
    if not phash:
        return None
    query = db.query(MediaItem.id, MediaItem.phash).filter(MediaItem.phash.isnot(None))
    if exclude_id is not None:
        query = query.filter(MediaItem.id < exclude_id)
    for other_id, other_hash in query.order_by(MediaItem.id.asc()).all():
        kind = classify_stored_hash(phash, other_hash, threshold)
        if kind:
            item = db.query(MediaItem).filter(MediaItem.id == other_id).first()
            if item is not None:
                return item, kind
    return None
