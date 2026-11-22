"""Square card previews are cached and reused until the source file changes."""

from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path

from PIL import Image

from backend.app.config import settings
from backend.app.services import preview_cache


class PreviewCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self._root = Path(self._dir.name)
        self._orig = settings.data_dir
        settings.data_dir = self._root / "data"
        self._source = self._root / "wide.png"
        Image.new("RGB", (80, 40), (10, 20, 30)).save(self._source)

    def tearDown(self) -> None:
        settings.data_dir = self._orig
        self._dir.cleanup()

    def test_preview_is_a_square_jpeg_and_is_reused(self) -> None:
        first = preview_cache.ensure_preview(7, self._source, "image", "compact")
        with Image.open(first) as image:
            self.assertEqual(image.size, (240, 240))
            self.assertEqual(image.format, "JPEG")
        stamp = first.stat().st_mtime_ns
        again = preview_cache.ensure_preview(7, self._source, "image", "compact")
        self.assertEqual(again, first)
        self.assertEqual(again.stat().st_mtime_ns, stamp)

    def test_a_newer_source_rebuilds_the_preview(self) -> None:
        import os

        first = preview_cache.ensure_preview(7, self._source, "image", "normal")
        before = first.read_bytes()
        Image.new("RGB", (40, 90), (200, 0, 0)).save(self._source)
        future = time.time() + 5
        os.utime(self._source, (future, future))
        second = preview_cache.ensure_preview(7, self._source, "image", "normal")
        self.assertEqual(second, first)
        self.assertNotEqual(second.read_bytes(), before)
        with Image.open(second) as image:
            self.assertEqual(image.size, (360, 360))

    def test_unknown_size_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            preview_cache.ensure_preview(1, self._source, "image", "huge")
