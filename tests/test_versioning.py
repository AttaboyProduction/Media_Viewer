"""Unit tests for VERSION vs data/installed_version helpers (no npm/pip)."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from versioning import (
    DEFAULT_REPO_VERSION,
    read_installed_version,
    read_repo_version,
    version_needs_update,
    write_installed_version,
)


class VersioningTests(unittest.TestCase):
    def test_missing_repo_version_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertEqual(read_repo_version(root), DEFAULT_REPO_VERSION)

    def test_empty_repo_version_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "VERSION").write_text("  \n", encoding="utf-8")
            self.assertEqual(read_repo_version(root), DEFAULT_REPO_VERSION)

    def test_reads_trimmed_repo_version(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "VERSION").write_text(" 0.1 \n", encoding="utf-8")
            self.assertEqual(read_repo_version(root), "0.1")

    def test_missing_installed_is_none(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(read_installed_version(Path(tmp)))

    def test_empty_installed_is_none(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            (data / "installed_version").write_text("\n", encoding="utf-8")
            self.assertIsNone(read_installed_version(data))

    def test_missing_installed_needs_update(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = root / "data"
            data.mkdir()
            (root / "VERSION").write_text("0.1\n", encoding="utf-8")
            self.assertTrue(version_needs_update(root, data))

    def test_mismatch_needs_update(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = root / "data"
            data.mkdir()
            (root / "VERSION").write_text("0.2\n", encoding="utf-8")
            write_installed_version(data, "0.1")
            self.assertTrue(version_needs_update(root, data))

    def test_match_does_not_need_update(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = root / "data"
            (root / "VERSION").write_text("0.1\n", encoding="utf-8")
            write_installed_version(data, "0.1")
            self.assertFalse(version_needs_update(root, data))
            self.assertEqual(read_installed_version(data), "0.1")

    def test_write_creates_data_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp) / "nested" / "data"
            write_installed_version(data, "0.1")
            self.assertEqual((data / "installed_version").read_text(encoding="utf-8").strip(), "0.1")


if __name__ == "__main__":
    unittest.main()
