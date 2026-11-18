"""Stored unfinished URLs and the extension queue survive a restart."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from backend.app.api.scrape import _with_leftovers
from backend.app.api import scrape as scrape_api
from backend.app.config import settings
from backend.app.schemas import ScrapeRunRequest
from backend.app.services import scrape_leftovers, scrape_panels
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
        real = (settings.data_dir / "scrape_leftovers.json").resolve()
        if self._path.resolve() == real:
            raise AssertionError(f"tests must not use the app leftovers file: {real}")
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
        pipeline.scrape_status.cancel = False
        pipeline.scrape_status.last_gallery_url = None
        pipeline.scrape_status.similar = 0
        pipeline.scrape_status.errors = []
        pipeline.scrape_status.message = ""
        pipeline.scrape_status.current_url = None
        scrape_panels.reset(pipeline.scrape_status)

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

    def test_queue_move_keeps_one_copy_across_sources(self) -> None:
        url = "https://gallery.test/post/9"
        scrape_leftovers.add_queue([url], source="site_a")
        scrape_leftovers.add_queue(["https://gallery.test/post/8"], source="site_a")
        scrape_leftovers.add_queue([url], source="site_b")
        self.assertEqual(scrape_leftovers.queue_urls("site_a"), ["https://gallery.test/post/8"])
        self.assertEqual(scrape_leftovers.queue_urls("site_b"), [url])
        # Same queue again moves it to the end.
        scrape_leftovers.add_queue(["https://gallery.test/post/7", url], source="site_b")
        self.assertEqual(
            scrape_leftovers.queue_urls("site_b"),
            ["https://gallery.test/post/7", url],
        )

    def test_queue_keeps_page_url_until_forget(self) -> None:
        file_url = "https://cdn.example/pic.jpg"
        page = "https://blog.example/view/9"
        scrape_leftovers.add_queue([file_url], {file_url: page})
        self.assertEqual(scrape_leftovers.page_url_for(file_url), page)
        scrape_leftovers.forget(file_url)
        self.assertIsNone(scrape_leftovers.page_url_for(file_url))

    def test_finished_raw_download_is_session_media_without_the_row(self) -> None:
        from backend.scraper.storage import UpsertResult

        url = "https://cdn.example/clip.mp4"
        scrape_leftovers.add_queue([url])
        pipeline.scrape_status.recent_media_ids = []
        pipeline._finish_remote_download(url, UpsertResult(media=None, media_id=42))
        self.assertEqual(pipeline.scrape_status.recent_media_ids, [42])
        self.assertEqual(pipeline.scrape_status.downloaded, 1)
        self.assertEqual(scrape_leftovers.queue_urls(), [])

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
        scrape_leftovers.add_queue([url], source="unsupported")

        with (
            patch.object(scrape_api, "get_selected_site", return_value=None),
            patch.object(scrape_api, "compile_scrape_job") as compile_job,
            patch.object(pipeline, "_claim_remote_download", return_value="started") as begin,
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

    def test_stopped_scrape_does_not_start_raw_files(self) -> None:
        url = "https://cdn.example/a.jpg"

        def stop(_job) -> None:
            pipeline.scrape_status.cancel = True

        with (
            patch.object(scrape_api, "run_job", side_effect=stop),
            patch.object(pipeline, "begin_remote_download") as begin,
        ):
            scrape_api._start_job(_job([]), 1, [url])

        begin.assert_not_called()

    def test_raw_files_start_after_a_finished_scrape(self) -> None:
        url = "https://cdn.example/a.jpg"
        with (
            patch.object(scrape_api, "run_job"),
            patch.object(pipeline, "begin_remote_download", return_value="started") as begin,
        ):
            scrape_api._start_job(_job([]), 1, [url])
        begin.assert_called_once_with(url)

    def test_scrape_job_is_compiled_once(self) -> None:
        job = _job(["https://gallery.test/post/1"])

        class _Now:
            def __init__(self, target=None, args=(), kwargs=None, daemon=None):
                self._target = target
                self._args = args

            def start(self) -> None:
                if self._target is not None:
                    self._target(*self._args)

        with (
            patch.object(scrape_api, "compile_scrape_job", return_value=job) as compile_job,
            patch.object(scrape_api, "run_job"),
            patch.object(scrape_api, "get_selected_site", return_value=None),
            patch.object(scrape_api.threading, "Thread", _Now),
        ):
            scrape_api.start_scrape_run(ScrapeRunRequest(filters=[], limit=0))
        compile_job.assert_called_once()

    def test_discovered_spelling_of_an_accepted_post_is_not_queued(self) -> None:
        url = "https://gallery.test/post/43"
        with pipeline.scrape_lock:
            pipeline.scrape_status.running = True
            pipeline.scrape_status.kind = "scrape"
            pipeline.scrape_status.queue_open = True
            pipeline.scrape_status.site_id = "gallery"
            pipeline.scrape_status.pending_urls = [url]
            pipeline.scrape_status.accepted_urls = {url}
            pipeline.scrape_status.total = 1
        added = pipeline.enqueue_discovered_urls(
            ["https://www.gallery.test/post/43?x=1"], site_id="gallery"
        )
        self.assertEqual(added, [])
        self.assertEqual(scrape_leftovers.queue_urls(), [])
        self.assertEqual(pipeline.scrape_status.total, 1)
        self.assertEqual(pipeline.scrape_status.pending_urls, [url])

    def test_append_ignores_a_different_spelling(self) -> None:
        url = "https://gallery.test/post/9"
        with pipeline.scrape_lock:
            pipeline.scrape_status.running = True
            pipeline.scrape_status.kind = "scrape"
            pipeline.scrape_status.queue_open = True
            pipeline.scrape_status.site_id = "gallery"
            pipeline.scrape_status.accepted_urls = {url}
            pipeline.scrape_status.pending_urls = [url]
            pipeline.scrape_status.total = 1
        added = pipeline.append_scrape_urls(["https://www.gallery.test/post/9"], "gallery")
        self.assertEqual(added, [])
        self.assertEqual(pipeline.scrape_status.total, 1)
        self.assertEqual(pipeline.scrape_status.pending_urls, [url])

    def test_failed_raw_file_retries_without_growing_total(self) -> None:
        url = "https://cdn.example/a.jpg"
        pipeline.scrape_status.ran_this_session = True
        pipeline.scrape_status.total = 1
        pipeline.scrape_status.processed = 1
        pipeline.scrape_status.skipped = 1
        pipeline.scrape_status.accepted_urls = {url}
        pipeline.scrape_status.counted_urls = {url}
        pipeline.scrape_status.skipped_items = [SkippedItem(url=url, reason="error", detail="x")]
        scrape_leftovers.remember_unfinished(url, "error", "x", "unsupported")
        with (
            patch.object(scrape_api, "get_selected_site", return_value=None),
            patch.object(pipeline.threading, "Thread"),
        ):
            scrape_api.start_scrape_run(
                ScrapeRunRequest(filters=[], limit=0), include_leftovers=True
            )
        self.assertEqual(pipeline.scrape_status.total, 1)
        self.assertEqual(pipeline.scrape_status.processed, 1)
        self.assertEqual(pipeline.scrape_status.pending_urls, [url])
        self.assertIn(url, pipeline.scrape_status.retry_urls)
        self.assertTrue(pipeline.scrape_status.running)

    def _seed_queues(self) -> None:
        queued = "https://cdn.example/q.jpg"
        failed = "https://gallery.test/post/20"
        stopped = "https://gallery.test/post/21"
        scrape_leftovers.add_queue([queued], {queued: "https://blog.example/view/1"})
        scrape_leftovers.remember_unfinished(failed, "error", "boom")
        scrape_leftovers.remember_unfinished(stopped, "cancelled", "")
        scrape_leftovers.sync_open(["https://gallery.test/post/22"])
        scrape_leftovers.restore_into_status()
        pipeline.scrape_status.recent_media_ids = [5, 6]

    def test_clear_queues_empties_the_stored_lists(self) -> None:
        self._seed_queues()
        scrape_leftovers.clear_queues()
        self.assertEqual(scrape_leftovers.queue_urls(), [])
        self.assertEqual(scrape_leftovers.unfinished_items(), [])
        self.assertIsNone(scrape_leftovers.page_url_for("https://cdn.example/q.jpg"))
        # a file still open (crash recovery list) is dropped too
        scrape_leftovers.sync_open(["https://gallery.test/post/23"])
        scrape_leftovers.clear_queues()
        scrape_leftovers.adopt_open_as_unfinished()
        self.assertEqual(scrape_leftovers.unfinished_items(), [])
        scrape_leftovers.clear_queues()  # empty again is fine

    def test_clear_queues_endpoint_resets_status_and_keeps_session_downloads(self) -> None:
        self._seed_queues()
        self.assertGreater(len(pipeline.scrape_status.skipped_items), 0)
        self.assertGreater(len(pipeline.scrape_status.cancelled_urls), 0)
        out = scrape_api.post_clear_queues()
        self.assertEqual(out.queue_urls, [])
        self.assertEqual(out.skipped_items, [])
        self.assertEqual(out.cancelled_urls, [])
        self.assertEqual(out.skipped, 0)
        self.assertEqual(out.recent_media_ids, [5, 6])
        self.assertEqual(scrape_leftovers.unfinished_items(), [])
        self.assertEqual(scrape_leftovers.queue_urls(), [])

    def test_clear_queues_endpoint_refuses_while_running(self) -> None:
        self._seed_queues()
        pipeline.scrape_status.running = True
        with self.assertRaises(HTTPException) as ctx:
            scrape_api.post_clear_queues()
        self.assertEqual(ctx.exception.status_code, 409)
        # failed + stopped + the open file restore_into_status adopted as interrupted
        self.assertEqual(len(scrape_leftovers.unfinished_items()), 3)
        self.assertEqual(len(scrape_leftovers.queue_urls()), 1)

    def test_queue_reread_when_the_file_is_removed_or_replaced(self) -> None:
        url = "https://gallery.test/post/8"
        scrape_leftovers.add_queue([url])
        self.assertEqual(scrape_leftovers.queue_urls(), [url])
        self._path.unlink()
        self.assertEqual(scrape_leftovers.queue_urls(), [])
        other = Path(self._dir.name) / "other.json"
        scrape_leftovers.leftovers_path = lambda: other
        self.assertEqual(scrape_leftovers.queue_urls(), [])


    # --- Session history split into one panel per source ---

    def _panel(self, out, key):
        return next((p for p in out.sources if p.key == key), None)

    def test_queue_and_unfinished_follow_their_source(self) -> None:
        a = "https://site-a.test/post/1"
        b = "https://site-b.test/post/2"
        raw = "https://cdn.example/c.jpg"
        scrape_leftovers.add_queue([a], source="site_a")
        scrape_leftovers.add_queue([raw], source="unsupported")
        scrape_leftovers.remember_unfinished(b, "error", "boom", "site_b")
        self.assertEqual(scrape_leftovers.queue_by_source(), {"site_a": [a], "unsupported": [raw]})
        self.assertEqual(scrape_leftovers.queue_urls("site_a"), [a])
        self.assertEqual([i["url"] for i in scrape_leftovers.unfinished_items("site_b")], [b])
        self.assertEqual(scrape_leftovers.unfinished_items("site_a"), [])
        # A queued URL that fails keeps the panel it was queued under.
        scrape_leftovers.remember_unfinished(a, "error", "x", "unsupported")
        self.assertEqual([i["url"] for i in scrape_leftovers.unfinished_items("site_a")], [a])
        self.assertEqual(scrape_leftovers.queue_urls("site_a"), [])
        # Finished files lose their source.
        scrape_leftovers.forget(a)
        self.assertEqual(scrape_leftovers.unfinished_items("site_a"), [])

    def test_unknown_source_is_guessed_from_the_url(self) -> None:
        scrape_leftovers.add_queue(["https://cdn.example/guess.jpg"])
        self.assertEqual(
            scrape_leftovers.queue_by_source(),
            {"unsupported": ["https://cdn.example/guess.jpg"]},
        )
        with patch(
            "backend.scraper.sites.extension_scrape_target",
            return_value=("site_a", "https://site-a.test/post/9"),
        ):
            self.assertEqual(scrape_leftovers.derive_source("https://site-a.test/post/9"), "site_a")

    def test_clear_one_source_leaves_the_others(self) -> None:
        a = "https://site-a.test/post/1"
        b = "https://site-b.test/post/2"
        scrape_leftovers.add_queue([a], {a: "https://page.test/a"}, source="site_a")
        scrape_leftovers.add_queue([b], source="site_b")
        scrape_leftovers.remember_unfinished("https://site-a.test/post/3", "error", "", "site_a")
        scrape_leftovers.remember_unfinished("https://site-b.test/post/4", "error", "", "site_b")
        scrape_leftovers.clear_queues("site_a")
        self.assertEqual(scrape_leftovers.queue_urls(), [b])
        self.assertEqual(
            [i["url"] for i in scrape_leftovers.unfinished_items()],
            ["https://site-b.test/post/4"],
        )
        self.assertIsNone(scrape_leftovers.page_url_for(a))
        scrape_leftovers.clear_queues("site_a")  # empty panel is fine
        self.assertEqual(scrape_leftovers.queue_urls(), [b])

    def test_with_leftovers_retries_only_the_chosen_source(self) -> None:
        a = "https://gallery.test/post/1"
        b = "https://gallery.test/post/2"
        scrape_leftovers.remember_unfinished(a, "error", "", "site_a")
        scrape_leftovers.remember_unfinished(b, "error", "", "site_b")
        payload, _keep, retries, _extra, _remote = _with_leftovers(
            ScrapeRunRequest(filters=[], limit=0), continue_counts=False, source="site_b"
        )
        self.assertEqual(retries, [b])
        self.assertEqual(payload.filters[0].value, b)

    def test_switching_source_parks_and_restores_each_panels_numbers(self) -> None:
        status = pipeline.scrape_status
        scrape_panels.activate(status, "site_a", "Site A")
        status.total, status.processed, status.downloaded = 5, 5, 4
        status.skipped_items = [SkippedItem(url="https://site-a.test/post/1", reason="error")]
        status.skipped = 1
        scrape_panels.activate(status, "local")
        self.assertEqual((status.total, status.downloaded, status.skipped), (0, 0, 0))
        self.assertEqual(status.skipped_items, [])
        status.total, status.processed, status.downloaded = 2, 2, 2
        scrape_panels.activate(status, "site_a")
        self.assertEqual((status.total, status.processed, status.downloaded), (5, 5, 4))
        self.assertEqual(len(status.skipped_items), 1)
        self.assertEqual(status.source_label, "Site A")

        out = scrape_api._status_out()
        self.assertEqual([p.key for p in out.sources], ["local", "site_a"])
        self.assertEqual(self._panel(out, "local").downloaded, 2)
        self.assertEqual(self._panel(out, "local").label, "Local")
        self.assertEqual(self._panel(out, "site_a").downloaded, 4)
        self.assertEqual(out.source_key, "site_a")
        self.assertEqual(out.downloaded, 4)

    def test_panel_lists_queue_skipped_and_cancelled_by_source(self) -> None:
        status = pipeline.scrape_status
        raw = "https://cdn.example/q.jpg"
        stopped = "https://site-a.test/post/7"
        scrape_leftovers.add_queue([raw], source="unsupported")
        scrape_panels.activate(status, "site_a", "Site A")
        pipeline._record_cancelled(stopped)
        out = scrape_api._status_out()
        site = self._panel(out, "site_a")
        self.assertEqual(site.cancelled_urls, [stopped])
        self.assertEqual(site.queue_urls, [])
        self.assertEqual(self._panel(out, "unsupported").queue_urls, [raw])
        self.assertEqual(self._panel(out, "unsupported").cancelled_urls, [])
        self.assertEqual([i["url"] for i in scrape_leftovers.unfinished_items("site_a")], [stopped])

    def test_restore_spreads_unfinished_over_panels(self) -> None:
        scrape_leftovers.remember_unfinished("https://site-a.test/post/1", "error", "x", "site_a")
        scrape_leftovers.remember_unfinished("https://cdn.example/f.jpg", "cancelled", "", "unsupported")
        scrape_leftovers.restore_into_status()
        out = scrape_api._status_out()
        self.assertEqual([p.key for p in out.sources], ["site_a", "unsupported"])
        self.assertEqual(len(self._panel(out, "site_a").skipped_items), 1)
        self.assertEqual(self._panel(out, "unsupported").cancelled_urls, ["https://cdn.example/f.jpg"])

    def test_clear_endpoint_clears_only_the_clicked_panel(self) -> None:
        status = pipeline.scrape_status
        scrape_panels.activate(status, "site_a", "Site A")
        pipeline._record_skip("https://site-a.test/post/1", "error", "a")
        scrape_panels.activate(status, "site_b", "Site B")
        pipeline._record_skip("https://site-b.test/post/2", "error", "b")
        out = scrape_api.post_clear_queues("site_a")
        self.assertEqual(self._panel(out, "site_a").skipped_items, [])
        self.assertEqual(len(self._panel(out, "site_b").skipped_items), 1)
        self.assertEqual(
            [i["url"] for i in scrape_leftovers.unfinished_items()],
            ["https://site-b.test/post/2"],
        )

    def test_clear_endpoint_blocks_only_the_running_source(self) -> None:
        status = pipeline.scrape_status
        scrape_panels.activate(status, "site_a", "Site A")
        pipeline._record_skip("https://site-a.test/post/1", "error", "a")
        scrape_panels.activate(status, "site_b", "Site B")
        status.running = True
        with self.assertRaises(HTTPException) as ctx:
            scrape_api.post_clear_queues("site_b")
        self.assertEqual(ctx.exception.status_code, 409)
        out = scrape_api.post_clear_queues("site_a")  # another source may be cleared mid-run
        self.assertEqual(self._panel(out, "site_a").skipped_items, [])
        self.assertTrue(self._panel(out, "site_b").running)

    def test_run_rejects_a_panel_that_is_not_the_selected_source(self) -> None:
        with patch.object(scrape_api, "get_selected_site", return_value={"id": "site_a"}):
            with self.assertRaises(HTTPException) as ctx:
                scrape_api.start_scrape_run(
                    ScrapeRunRequest(filters=[], limit=0, source_key="site_b")
                )
        self.assertEqual(ctx.exception.status_code, 400)

    def test_unsupported_panel_run_needs_something_to_retry(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            scrape_api.start_scrape_run(
                ScrapeRunRequest(filters=[], limit=0, source_key="unsupported")
            )
        self.assertEqual(ctx.exception.status_code, 400)

    def test_unsupported_panel_run_starts_only_its_own_urls(self) -> None:
        raw = "https://cdn.example/a.jpg"
        site_url = "https://site-a.test/post/1"
        scrape_leftovers.add_queue([raw], source="unsupported")
        scrape_leftovers.add_queue([site_url], source="site_a")
        with (
            patch.object(scrape_api, "compile_scrape_job") as compile_job,
            patch.object(pipeline, "_claim_remote_download", return_value="started") as claim,
        ):
            scrape_api.start_scrape_run(
                ScrapeRunRequest(filters=[], limit=0, source_key="unsupported")
            )
        compile_job.assert_not_called()
        claim.assert_called_once_with(raw)

    def test_remote_download_uses_the_unsupported_panel(self) -> None:
        status = pipeline.scrape_status
        scrape_panels.activate(status, "site_a", "Site A")
        status.total, status.processed, status.downloaded = 3, 3, 3
        with patch.object(pipeline.threading, "Thread"):
            self.assertEqual(pipeline.begin_remote_download("https://cdn.example/n.jpg"), "started")
        self.assertEqual(status.source_key, "unsupported")
        self.assertEqual(status.total, 1)
        out = scrape_api._status_out()
        self.assertEqual(self._panel(out, "site_a").downloaded, 3)
        self.assertEqual(self._panel(out, "unsupported").total, 1)
