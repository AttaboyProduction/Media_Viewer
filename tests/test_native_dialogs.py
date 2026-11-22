"""Native picker options that Windows otherwise turns into an empty OK result."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from backend.app.services import native_dialogs


class PickFolderTests(unittest.TestCase):
    def test_folder_dialog_does_not_use_mustexist(self) -> None:
        captured: dict = {}

        def fake_run(fn):
            return fn(object())

        def fake_askdirectory(**kwargs):
            captured.update(kwargs)
            return r"D:\Pics"

        with (
            patch.object(native_dialogs, "_run_tk", fake_run),
            patch("tkinter.filedialog.askdirectory", fake_askdirectory),
        ):
            chosen = native_dialogs.pick_folder()

        self.assertNotIn("mustexist", captured)
        self.assertIn("parent", captured)
        self.assertTrue(chosen)
        self.assertIn("Pics", chosen or "")
