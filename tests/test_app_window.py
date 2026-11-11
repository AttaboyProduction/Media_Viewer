"""Single-instance viewer window host: show / quit over the localhost socket."""

from __future__ import annotations

import json
import secrets
import tempfile
import threading
import time
import unittest
from multiprocessing.connection import Listener
from pathlib import Path
from unittest import mock

from backend.app.services import app_window


class FakeWindow:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.on_top = False

    def restore(self) -> None:
        self.calls.append("restore")

    def show(self) -> None:
        self.calls.append("show")

    def destroy(self) -> None:
        self.calls.append("destroy")


class AppWindowHostTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        data = Path(self.tmp.name)
        self.patches = [
            mock.patch.object(app_window, "DATA_DIR", data),
            mock.patch.object(app_window, "STATE_FILE", data / "app_window.json"),
            mock.patch.object(app_window, "SPAWN_MARKER", data / "app_window.starting"),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self) -> None:
        for patch in self.patches:
            patch.stop()
        self.tmp.cleanup()

    def _start_host(self) -> tuple[FakeWindow, threading.Thread]:
        authkey = secrets.token_bytes(16)
        listener = Listener(("127.0.0.1", 0), authkey=authkey)
        app_window.STATE_FILE.write_text(
            json.dumps({"port": listener.address[1], "authkey": authkey.hex(), "pid": 1}),
            encoding="utf-8",
        )
        window = FakeWindow()
        thread = threading.Thread(
            target=app_window._serve_commands, args=(listener, window), daemon=True
        )
        thread.start()
        self.addCleanup(listener.close)
        return window, thread

    def _wait_for(self, window: FakeWindow, call: str) -> None:
        deadline = time.time() + 2
        while call not in window.calls and time.time() < deadline:
            time.sleep(0.01)

    def test_no_host_means_send_fails(self) -> None:
        self.assertFalse(app_window.send_command("show"))

    def test_running_host_is_focused_not_respawned(self) -> None:
        window, _ = self._start_host()
        with mock.patch.object(app_window, "spawn_app_window") as spawn:
            self.assertTrue(app_window.open_or_focus_app_window("http://x"))
        spawn.assert_not_called()
        self._wait_for(window, "show")
        self.assertEqual(window.calls, ["restore", "show"])
        self.assertFalse(window.on_top)

    def test_spawns_when_no_host(self) -> None:
        with mock.patch.object(app_window, "spawn_app_window", return_value=True) as spawn:
            self.assertTrue(app_window.open_or_focus_app_window("http://x"))
        spawn.assert_called_once_with("http://x")

    def test_recent_spawn_blocks_second_spawn(self) -> None:
        app_window.SPAWN_MARKER.write_text("1", encoding="utf-8")
        with mock.patch.object(app_window, "spawn_app_window") as spawn:
            self.assertTrue(app_window.open_or_focus_app_window("http://x"))
        spawn.assert_not_called()

    def test_stale_state_file_falls_back_to_spawn(self) -> None:
        app_window.STATE_FILE.write_text(
            json.dumps({"port": 1, "authkey": "00", "pid": 1}), encoding="utf-8"
        )
        with mock.patch.object(app_window, "spawn_app_window", return_value=True) as spawn:
            self.assertTrue(app_window.open_or_focus_app_window("http://x"))
        spawn.assert_called_once()

    def test_quit_destroys_window_and_stops_serving(self) -> None:
        window, thread = self._start_host()
        with mock.patch.object(app_window, "_kill_leftover_hosts"):
            app_window.close_app_windows()
        thread.join(timeout=2)
        self.assertIn("destroy", window.calls)
        self.assertFalse(thread.is_alive())
        self.assertFalse(app_window.STATE_FILE.exists())


if __name__ == "__main__":
    unittest.main()
