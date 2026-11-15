"""Persistent download queue: order, identity, and when it is allowed to start."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.app.services import download_queue
from backend.scraper import pipeline


class DownloadQueueTests(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self._patch = patch.object(
            download_queue,
            "queue_path",
            return_value=Path(self._dir.name) / "download_queue.json",
        )
        self._patch.start()
        download_queue._attempted.clear()
        pipeline.scrape_status.running = False
        pipeline.scrape_status.queue_active = False
        pipeline.scrape_status.cancel = False

    def tearDown(self) -> None:
        self._patch.stop()
        self._dir.cleanup()
        download_queue._attempted.clear()
        pipeline.scrape_status.queue_active = False

    def test_identity_ignores_scheme_www_and_query(self) -> None:
        self.assertEqual(
            download_queue.queue_identity("https://www.Gallery.test/post/1?page=3#top"),
            download_queue.queue_identity("http://gallery.test/post/1"),
        )
        self.assertNotEqual(
            download_queue.queue_identity("https://gallery.test/post/1"),
            download_queue.queue_identity("https://gallery.test/post/2"),
        )

    def test_sources_merge_in_add_order_and_drop_the_same_page(self) -> None:
        download_queue.add_urls(
            "extension",
            ["https://rule.test/post/1?x=1", "http://www.rule.test/post/1"],
        )
        merged = download_queue.add_urls(
            "friend",
            ["https://rule.test/post/2", "https://rule.test/post/1#top"],
        )
        self.assertEqual(
            merged,
            ["https://rule.test/post/1?x=1", "https://rule.test/post/2"],
        )
        download_queue.remove_url("http://rule.test/post/1")
        self.assertEqual(download_queue.merged_urls(), ["https://rule.test/post/2"])
        self.assertFalse(pipeline.scrape_status.queue_active)

    def test_hidden_scrape_page_does_not_start(self) -> None:
        download_queue.add_urls("extension", ["https://gallery.test/post/1"])
        with patch(
            "backend.app.services.app_settings.scrape_page_enabled",
            return_value=False,
        ):
            self.assertFalse(download_queue.start_download_queue())
        self.assertFalse(pipeline.scrape_status.running)
        self.assertEqual(
            download_queue.merged_urls(),
            ["https://gallery.test/post/1"],
        )
