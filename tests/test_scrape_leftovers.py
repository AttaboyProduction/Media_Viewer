"""Stored unfinished URLs and the extension queue survive a restart."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.app.api.scrape import _with_leftovers
from backend.app.api import scrape as scrape_api
from backend.app.schemas import ScrapeRunRequest
from backend.app.services import scrape_leftovers
from backend.scraper import pipeline
from backend.scraper.job import ScrapeJob
from backend.scraper.pipeline import SkippedItem


def _job(urls: list[str]) -> ScrapeJob:
    return ScrapeJob(
        seed_urls=urls,
        tags=[],
        tag_mode="and",
        date_from=None,
        date_to=None,
        media_type=None,
        sort="date_desc",
        limit=0,
        ignore_download_limit=True,
    )


class ScrapeLeftoverTests(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self._path = Path(self._dir.name) / "scrape_leftovers.json"
        self._orig = scrape_leftovers.leftovers_path
        scrape_leftovers.leftovers_path = lambda: self._path
        pipeline.scrape_status.running = False
        pipeline.scrape_status.ran_this_session = False
        pipeline.scrape_status.total = 0
        pipeline.scrape_status.processed = 0
        pipeline.scrape_status.downloaded = 0
        pipeline.scrape_status.skipped = 0
        pipeline.scrape_status.pending_urls = []
        pipeline.scrape_status.accepted_urls = set()
        pipeline.scrape_status.skipped_items = []
        pipeline.scrape_status.cancelled_urls = []
        pipeline.scrape_status.retry_urls = set()
        pipeline.scrape_status.counted_urls = set()
        pipeline.scrape_status.leftover_urls = set()
        pipeline.scrape_status.continue_counts = False
        pipeline.scrape_status.queue_open = False

    def tearDown(self) -> None:
        scrape_leftovers.leftovers_path = self._orig
        self._dir.cleanup()

    def test_error_is_kept_and_a_download_clears_it(self) -> None:
        scrape_leftovers.note_outcome(
            "https://gallery.test/post/1", downloaded=False, reason="error", detail="timeout"
        )
        self.assertEqual(scrape_leftovers.unfinished_items()[0]["detail"], "timeout")
        scrape_leftovers.note_outcome("https://gallery.test/post/1", downloaded=True)
        self.assertEqual(scrape_leftovers.unfinished_items(), [])

    def test_extension_queue_appends_and_a_readd_leaves_unfinished(self) -> None:
        scrape_leftovers.remember_unfinished("https://gallery.test/post/1", "error", "nope")
        scrape_leftovers.add_queue(
            ["https://gallery.test/post/1?page=2", "https://gallery.test/post/2"]
        )
        self.assertEqual(
            scrape_leftovers.queue_urls(),
            ["https://gallery.test/post/1?page=2", "https://gallery.test/post/2"],
        )
        self.assertEqual(scrape_leftovers.unfinished_items(), [])
        scrape_leftovers.add_queue(["https://www.gallery.test/post/2"])
        self.assertEqual(len(scrape_leftovers.queue_urls()), 2)

    def test_open_urls_become_unfinished_after_restart(self) -> None:
        scrape_leftovers.sync_open(["https://gallery.test/post/4"])
        scrape_leftovers.adopt_open_as_unfinished()
        items = scrape_leftovers.unfinished_items()
        self.assertEqual(items[0]["url"], "https://gallery.test/post/4")
        self.assertEqual(items[0]["reason"], "interrupted")
        scrape_leftovers.restore_into_status()
        self.assertEqual(pipeline.scrape_status.skipped, 1)
        self.assertTrue(pipeline.scrape_status.ran_this_session)

    def test_retrying_skipped_files_does_not_pass_the_old_total(self) -> None:
        first = "https://gallery.test/post/1"
        second = "https://gallery.test/post/2"
        pipeline.scrape_status.ran_this_session = True
        pipeline.scrape_status.total = 15
        pipeline.scrape_status.processed = 15
        pipeline.scrape_status.downloaded = 13
        pipeline.scrape_status.skipped = 2
        pipeline.scrape_status.skipped_items = [
            SkippedItem(url=first, reason="error", detail="a"),
            SkippedItem(url=second, reason="error", detail="b"),
        ]
        pipeline.scrape_status.counted_urls = {first, second}
        scrape_leftovers.remember_unfinished(first, "error", "a")
        scrape_leftovers.remember_unfinished(second, "error", "b")

        payload, keep, retries, extra, remote = _with_leftovers(
            ScrapeRunRequest(filters=[], limit=15), continue_counts=False
        )
        self.assertTrue(keep)
        self.assertEqual(extra, [])
        self.assertEqual(remote, [])
        self.assertEqual(payload.limit, 0)
        self.assertIn(first, payload.filters[0].value)

        with pipeline.scrape_lock:
            pipeline.begin_scrape_queue(
                _job([first, second]), "gallery", continue_counts=True, retry_urls=set(retries)
            )
        self.assertEqual(pipeline.scrape_status.total, 15)
        self.assertEqual(pipeline.scrape_status.processed, 15)
        pipeline._complete_download(first)
        self.assertEqual(pipeline.scrape_status.downloaded, 14)
        self.assertEqual(pipeline.scrape_status.skipped, 1)
        self.assertEqual(pipeline.scrape_status.processed, 15)
        self.assertEqual(pipeline.scrape_status.total, 15)
        self.assertEqual(scrape_leftovers.unfinished_items()[0]["url"], second)

    def test_queue_urls_increase_the_total(self) -> None:
        done = "https://gallery.test/post/1"
        fresh = "https://gallery.test/post/9"
        pipeline.scrape_status.ran_this_session = True
        pipeline.scrape_status.total = 15
        pipeline.scrape_status.processed = 15
        pipeline.scrape_status.downloaded = 13
        pipeline.scrape_status.skipped = 1
        pipeline.scrape_status.skipped_items = [SkippedItem(url=done, reason="error")]
        pipeline.scrape_status.counted_urls = {done}
        scrape_leftovers.remember_unfinished(done, "error", "")
        scrape_leftovers.add_queue([fresh])
        with pipeline.scrape_lock:
            pipeline.begin_scrape_queue(
                _job([done, fresh]),
                "gallery",
                continue_counts=True,
                retry_urls={done},
            )
        self.assertEqual(pipeline.scrape_status.total, 16)
        self.assertEqual(pipeline.scrape_status.processed, 15)
        self.assertEqual(pipeline.scrape_status.pending_urls, [done, fresh])

    def test_raw_file_queue_drains_through_remote_download(self) -> None:
        url = "https://cdn.example/a.jpg"
        scrape_leftovers.add_queue([url])

        with (
            patch.object(scrape_api, "compile_scrape_job") as compile_job,
            patch.object(pipeline, "begin_remote_download", return_value="started") as begin,
        ):
            status = scrape_api.start_scrape_run(
                ScrapeRunRequest(filters=[], limit=0),
                include_leftovers=True,
            )

        compile_job.assert_not_called()
        begin.assert_called_once_with(url)
        self.assertEqual(status.queue_urls, [url])

    def test_discovered_post_is_stored_in_queue_before_download(self) -> None:
        """Listing a post must hit Queue to scrape before the pending job drains."""
        url = "https://gallery.test/post/42"
        with pipeline.scrape_lock:
            pipeline.scrape_status.running = True
            pipeline.scrape_status.kind = "scrape"
            pipeline.scrape_status.queue_open = True
            pipeline.scrape_status.site_id = "gallery"
            pipeline.scrape_status.pending_urls = []
            pipeline.scrape_status.accepted_urls = set()
            pipeline.scrape_status.total = 0
            pipeline.scrape_status.processed = 0

        added = pipeline.enqueue_discovered_urls([url], site_id="gallery")

        self.assertEqual(added, [url])
        self.assertEqual(scrape_leftovers.queue_urls(), [url])
        self.assertEqual(pipeline.scrape_status.pending_urls, [url])
        self.assertEqual(pipeline.scrape_status.total, 1)

    def test_discovered_post_already_accepted_is_not_queued_again(self) -> None:
        """A re-discovered post accepted this run must not remain in Queue."""
        url = "https://gallery.test/post/43"
        with pipeline.scrape_lock:
            pipeline.scrape_status.running = True
            pipeline.scrape_status.kind = "scrape"
            pipeline.scrape_status.queue_open = True
            pipeline.scrape_status.site_id = "gallery"
            pipeline.scrape_status.pending_urls = []
            pipeline.scrape_status.accepted_urls = set()
            pipeline.scrape_status.total = 0
            pipeline.scrape_status.processed = 0

        self.assertEqual(pipeline.enqueue_discovered_urls([url], site_id="gallery"), [url])
        scrape_leftovers.forget(url)
        with pipeline.scrape_lock:
            pipeline.scrape_status.pending_urls = []
            pending_before = list(pipeline.scrape_status.pending_urls)
            total_before = pipeline.scrape_status.total

        self.assertEqual(pipeline.enqueue_discovered_urls([url], site_id="gallery"), [])
        self.assertEqual(scrape_leftovers.queue_urls(), [])
        self.assertEqual(pipeline.scrape_status.pending_urls, pending_before)
        self.assertEqual(pipeline.scrape_status.total, total_before)

    def test_complete_skip_on_retry_leaves_job_running(self) -> None:
        """A Skipped retry that fails again stays skipped without cancelling."""
        url = "https://gallery.test/post/7"
        pipeline.scrape_status.cancel = False
        pipeline.scrape_status.running = True
        pipeline.scrape_status.job_id = 3
        pipeline.scrape_status.counted_urls = {url}
        pipeline.scrape_status.retry_urls = {url}
        pipeline.scrape_status.total = 10
        pipeline.scrape_status.processed = 10
        pipeline.scrape_status.skipped = 1
        scrape_leftovers.remember_unfinished(url, "error", "first")

        pipeline._complete_skip(url, "error", "again")

        self.assertFalse(pipeline.scrape_status.cancel)
        self.assertTrue(pipeline.scrape_status.running)
        self.assertEqual(scrape_leftovers.unfinished_items()[0]["detail"], "again")
