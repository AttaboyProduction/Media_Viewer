"""Persisted Local import folder/file lists in session_settings."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.scraper import sites


class LocalSessionPathTests(unittest.TestCase):
    def test_normalize_and_persist_local_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "session_settings.json"
            with patch.object(sites, "_settings_path", return_value=path):
                saved = sites.save_session_settings(
                    {
                        "local_import_folders": [
                            r"D:\Pics",
                            r"D:\Pics",
                            "  ",
                            r"E:\More",
                        ],
                        "local_import_files": [r"D:\one.jpg"],
                        "local_import_recursive": False,
                    }
                )
                self.assertEqual(saved["local_import_folders"], [r"D:\Pics", r"E:\More"])
                self.assertEqual(saved["local_import_files"], [r"D:\one.jpg"])
                self.assertFalse(saved["local_import_recursive"])

                data = json.loads(path.read_text(encoding="utf-8"))
                loaded = sites._normalize_settings(data)
                self.assertEqual(loaded["local_import_folders"], [r"D:\Pics", r"E:\More"])
                self.assertFalse(loaded["local_import_recursive"])


if __name__ == "__main__":
    unittest.main()
