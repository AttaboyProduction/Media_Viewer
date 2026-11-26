"""Queued media downloads run scrape_concurrency at a time."""

from __future__ import annotations

import threading
import unittest
from unittest.mock import MagicMock, patch

from backend.scraper import pipeline
from backend.scraper.job import ScrapeJob


def _job() -> ScrapeJob:
    return ScrapeJob(
        seed_urls=[],
        tags=[],
        tag_mode="and",
        date_from=None,
        date_to=None,
        media_type=None,
        sort="date_desc",
        limit=0,
        ignore_download_limit=True,
    )


class ParallelDownloadTests(unittest.TestCase):
    def setUp(self) -> None:
        self._sync = patch.object(pipeline, "_sync_open_urls")
        self._sync.start()
        self._db = patch.object(pipeline, "SessionLocal", return_value=MagicMock())
        self._db.start()
        pipeline.scrape_status.running = True
        pipeline.scrape_status.cancel = False
        pipeline.scrape_status.job_id = 7
        pipeline.scrape_status.pending_urls = []
        pipeline.scrape_status.queue_open = True
        pipeline.scrape_status.downloaded = 0
        pipeline.scrape_status.processed = 0
        pipeline.scrape_status.skipped = 0
        pipeline.scrape_status.total = 2
        pipeline._inflight_urls.clear()

    def tearDown(self) -> None:
        self._db.stop()
        self._sync.stop()
        pipeline._inflight_urls.clear()
        pipeline.scrape_status.running = False
        pipeline.scrape_status.pending_urls = []
        pipeline.scrape_status.cancel = False

    def test_two_posts_download_at_the_same_time(self) -> None:
        overlap = threading.Event()
        lock = threading.Lock()
        current = 0
        peak = 0

        def fake_process(client, db, job, url, existing):
            nonlocal current, peak
            del client, db, job, url, existing
            with lock:
                current += 1
                peak = max(peak, current)
                if current >= 2:
                    overlap.set()
            overlap.wait(timeout=2)
            with lock:
                current -= 1
            return "ok"

        pipeline.scrape_status.pending_urls = [
            "https://gallery.test/post/1",
            "https://gallery.test/post/2",
        ]
        with patch("backend.app.services.app_settings.get_scrape_concurrency", return_value=2):
            with patch.object(pipeline, "_process_post_url", side_effect=fake_process):
                lanes = pipeline._DownloadLanes(None, _job(), {})
                try:
                    lanes.drain()
                finally:
                    lanes.close()
        self.assertEqual(peak, 2)
        self.assertEqual(pipeline.scrape_status.pending_urls, [])

    def test_listing_stops_only_after_successful_download_quota(self) -> None:
        pipeline.scrape_status.downloaded = 3
        pipeline.scrape_status.pending_urls = ["https://gallery.test/post/9"]
        pipeline._inflight_urls.add("https://gallery.test/post/8")
        job = _job()
        job.limit = 3
        job.ignore_download_limit = False
        self.assertTrue(pipeline._listing_saturated(job))
        pipeline.scrape_status.downloaded = 2
        self.assertFalse(pipeline._listing_saturated(job))

    def test_concurrency_one_stays_on_the_caller(self) -> None:
        threads: list[int] = []

        def fake_process(client, db, job, url, existing):
            del client, db, job, url, existing
            threads.append(threading.get_ident())
            return "ok"

        pipeline.scrape_status.pending_urls = [
            "https://gallery.test/post/1",
            "https://gallery.test/post/2",
        ]
        with patch("backend.app.services.app_settings.get_scrape_concurrency", return_value=1):
            with patch.object(pipeline, "_process_post_url", side_effect=fake_process):
                lanes = pipeline._DownloadLanes(None, _job(), {})
                try:
                    lanes.drain()
                finally:
                    lanes.close()
        self.assertEqual(threads, [threading.get_ident(), threading.get_ident()])


if __name__ == "__main__":
    unittest.main()
