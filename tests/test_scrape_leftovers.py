"""Stored unfinished URLs and the extension queue survive a restart."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import HTTPException

from backend.app.api.scrape import _with_leftovers
from backend.app.api import scrape as scrape_api
from backend.app.config import settings
from backend.app.schemas import ScrapeFilterIn, ScrapeRunRequest
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


class ScrapeLeftoverIdentityTests(unittest.TestCase):
    def test_gelbooru_view_urls_differ_by_post_id(self) -> None:
        site = {
            "id": "rule34_xxx",
            "extension": {
                "post_id_patterns": [
                    r"https?://(?:[\w-]+\.)?rule34\.xxx/index\.php\?(?=[^#]*page=post)(?=[^#]*s=view)[^#]*[?&]id=(\d+)"
                ],
            },
        }
        u1 = "https://rule34.xxx/index.php?page=post&s=view&id=1"
        u2 = "https://rule34.xxx/index.php?page=post&s=view&id=2"
        same = "http://www.rule34.xxx/index.php?page=post&s=view&id=1#top"
        with patch("backend.scraper.sites.get_selected_site", return_value=site):
            self.assertNotEqual(scrape_leftovers.identity(u1), scrape_leftovers.identity(u2))
            self.assertEqual(scrape_leftovers.identity(u1), scrape_leftovers.identity(same))


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
        pipeline.scrape_status.finished_urls = set()
        pipeline.scrape_status.processed_urls = set()
        pipeline.scrape_status.released_urls = set()
        pipeline.scrape_status.leftover_urls = set()
        pipeline.scrape_status.continue_counts = False
        pipeline.scrape_status.queue_open = False
        pipeline.scrape_status.cancel = False
        pipeline.scrape_status.last_gallery_url = None
        pipeline.scrape_status.similar = 0
        pipeline.scrape_status.errors = []
        pipeline.scrape_status.error_items = []
        pipeline.scrape_status.message = ""
        pipeline.scrape_status.current_url = None
        pipeline.scrape_status.recent_media_ids = []
        scrape_panels.reset(pipeline.scrape_status)

    def tearDown(self) -> None:
        scrape_leftovers.leftovers_path = self._orig
        self._dir.cleanup()

    def test_intentional_skip_is_kept_with_existing_media_id(self) -> None:
        url = "https://gallery.test/post/keep"
        scrape_leftovers.note_outcome(
            url,
            downloaded=False,
            reason="already_have",
            existing_media_id=42,
            source="site_a",
        )
        rows = scrape_leftovers.unfinished_items("site_a")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["existing_media_id"], 42)

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
        # 13 downloads plus the two errors, which already counted as settled.
        pipeline.scrape_status.processed = 15
        pipeline.scrape_status.processed_urls = {first, second}
        pipeline.scrape_status.downloaded = 13
        pipeline.scrape_status.skipped = 0
        pipeline.scrape_status.skipped_items = []
        pipeline.scrape_status.error_items = [
            SkippedItem(url=first, reason="error", detail="a"),
            SkippedItem(url=second, reason="error", detail="b"),
        ]
        pipeline.scrape_status.errors = [f"{first}: a", f"{second}: b"]
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
        # Both errors leave processed until they settle again.
        self.assertEqual(pipeline.scrape_status.processed, 13)
        pipeline._complete_download(first)
        self.assertEqual(pipeline.scrape_status.downloaded, 14)
        self.assertEqual(pipeline.scrape_status.skipped, 0)
        self.assertEqual(pipeline.scrape_status.processed, 14)
        self.assertEqual(pipeline.scrape_status.total, 15)
        self.assertEqual([row.url for row in pipeline.scrape_status.error_items], [second])
        self.assertEqual(pipeline.scrape_status.errors, [f"{second}: b"])
        self.assertEqual(scrape_leftovers.unfinished_items()[0]["url"], second)

    def test_settled_skips_errors_and_cancels_count_in_processed(self) -> None:
        downloaded = "https://gallery.test/post/got"
        filtered = "https://gallery.test/post/skip"
        failed = "https://gallery.test/post/bad"
        pipeline.scrape_status.total = 3
        pipeline.scrape_status.errors.append(f"{failed}: timeout")
        pipeline._complete_download(downloaded)
        pipeline._complete_skip(filtered, "already_have")
        pipeline._complete_skip(failed, "error", "timeout")
        self.assertEqual(pipeline.scrape_status.processed, 3)
        self.assertEqual(pipeline.scrape_status.downloaded, 1)
        self.assertEqual(pipeline.scrape_status.total, 3)
        self.assertIn(downloaded, pipeline.scrape_status.finished_urls)
        self.assertNotIn(filtered, pipeline.scrape_status.finished_urls)
        self.assertNotIn(failed, pipeline.scrape_status.finished_urls)
        self.assertIn(failed, pipeline.scrape_status.processed_urls)
        unfinished = {row["url"]: row for row in scrape_leftovers.unfinished_items()}
        self.assertIn(failed, unfinished)
        self.assertEqual(unfinished[failed]["reason"], "error")
        self.assertIn(filtered, unfinished)
        self.assertEqual(unfinished[filtered]["reason"], "already_have")

        pipeline._record_cancelled("https://gallery.test/post/stop")
        self.assertEqual(pipeline.scrape_status.processed, 4)
        self.assertEqual(pipeline.scrape_status.total, 4)

        pipeline.scrape_status.total = 2
        pipeline.scrape_status.processed = 0
        pipeline.scrape_status.downloaded = 0
        pipeline.scrape_status.finished_urls = set()
        pipeline.scrape_status.processed_urls = set()
        pipeline.scrape_status.counted_urls = set()
        pipeline.scrape_status.released_urls = set()
        pipeline._complete_download(downloaded)
        pipeline._complete_skip(filtered, "tag_mismatch")
        self.assertEqual(pipeline.scrape_status.processed, 2)
        self.assertEqual(pipeline.scrape_status.total, 2)

    def test_download_after_an_error_clears_it_and_counts_once(self) -> None:
        url = "https://gallery.test/post/bad"
        pipeline.scrape_status.total = 1
        pipeline.scrape_status.errors = [f"{url}: timeout"]
        pipeline._complete_skip(url, "error", "timeout")
        self.assertEqual(pipeline.scrape_status.processed, 1)
        self.assertEqual(pipeline.scrape_status.skipped, 0)
        self.assertEqual([row.url for row in pipeline.scrape_status.error_items], [url])
        self.assertEqual(pipeline.scrape_status.skipped_items, [])
        self.assertEqual(len(scrape_leftovers.unfinished_items()), 1)
        pipeline._complete_download(url)
        self.assertEqual(pipeline.scrape_status.processed, 1)
        self.assertEqual(pipeline.scrape_status.downloaded, 1)
        self.assertEqual(pipeline.scrape_status.total, 1)
        self.assertEqual(pipeline.scrape_status.skipped_items, [])
        self.assertEqual(pipeline.scrape_status.error_items, [])
        self.assertEqual(pipeline.scrape_status.errors, [])
        self.assertEqual(scrape_leftovers.unfinished_items(), [])

    def test_error_attempts_follow_never_auto_run(self) -> None:
        with patch(
            "backend.app.services.app_settings.load_app_settings",
            return_value={"never_auto_run_scrape": False},
        ):
            self.assertEqual(pipeline._download_error_attempts(), 3)
        with patch(
            "backend.app.services.app_settings.load_app_settings",
            return_value={"never_auto_run_scrape": True},
        ):
            self.assertEqual(pipeline._download_error_attempts(), 1)

    def test_queue_urls_increase_the_total(self) -> None:
        done = "https://gallery.test/post/1"
        fresh = "https://gallery.test/post/9"
        pipeline.scrape_status.ran_this_session = True
        pipeline.scrape_status.total = 15
        pipeline.scrape_status.processed = 14
        pipeline.scrape_status.processed_urls = {done}
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
        self.assertEqual(pipeline.scrape_status.processed, 13)
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

    def test_begin_enqueue_queue_keeps_persisted_queue_and_skipped(self) -> None:
        queued = "https://gallery.test/post/1"
        skipped_url = "https://gallery.test/post/2"
        scrape_leftovers.add_queue([queued], source="gallery")
        with pipeline.scrape_lock:
            pipeline.scrape_status.source_key = "gallery"
            pipeline.scrape_status.skipped_items = [
                pipeline.SkippedItem(
                    url=skipped_url,
                    reason="identical",
                    existing_media_id=5,
                )
            ]
            pipeline.scrape_status.skipped = 1
        pipeline.begin_enqueue_queue(_job([]), "gallery")
        self.assertEqual(scrape_leftovers.queue_urls("gallery"), [queued])
        self.assertIn(queued, pipeline.scrape_status.accepted_urls)
        self.assertEqual(len(pipeline.scrape_status.skipped_items), 1)
        self.assertEqual(pipeline.scrape_status.skipped_items[0].reason, "identical")

    def test_discovered_url_already_queued_is_not_duplicated(self) -> None:
        """Gallery listing must not re-queue a URL that is already in Queue to scrape."""
        queued = "https://gallery.test/post/1"
        spelling = "https://www.gallery.test/post/1?ref=1"
        scrape_leftovers.add_queue([queued], source="gallery")
        with pipeline.scrape_lock:
            pipeline.scrape_status.running = True
            pipeline.scrape_status.kind = "enqueue"
            pipeline.scrape_status.queue_open = True
            pipeline.scrape_status.site_id = "gallery"
            pipeline.scrape_status.source_key = "gallery"
            pipeline.scrape_status.pending_urls = []
            pipeline.scrape_status.accepted_urls = set()
            pipeline.scrape_status.total = 0
            pipeline.scrape_status.queue_urls = scrape_leftovers.queue_urls("gallery")

        added = pipeline.enqueue_discovered_urls([spelling], site_id="gallery")

        self.assertEqual(added, [])
        self.assertEqual(scrape_leftovers.queue_urls("gallery"), [queued])
        self.assertEqual(pipeline.scrape_status.total, 0)

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

    def test_enqueue_kind_queues_without_pending(self) -> None:
        """Listing-only jobs persist finds without opening download pending URLs."""
        url = "https://gallery.test/post/99"
        with pipeline.scrape_lock:
            pipeline.scrape_status.running = True
            pipeline.scrape_status.kind = "enqueue"
            pipeline.scrape_status.queue_open = True
            pipeline.scrape_status.site_id = "gallery"
            pipeline.scrape_status.source_key = "gallery"
            pipeline.scrape_status.pending_urls = []
            pipeline.scrape_status.accepted_urls = set()
            pipeline.scrape_status.total = 0

        added = pipeline.enqueue_discovered_urls([url], site_id="gallery")

        self.assertEqual(added, [url])
        self.assertEqual(scrape_leftovers.queue_urls("gallery"), [url])
        self.assertEqual(pipeline.scrape_status.pending_urls, [])
        self.assertEqual(pipeline.scrape_status.total, 1)

    def test_enqueue_already_have_goes_to_skipped_not_queue(self) -> None:
        url = "https://gallery.test/post/88"
        with pipeline.scrape_lock:
            pipeline.scrape_status.running = True
            pipeline.scrape_status.kind = "enqueue"
            pipeline.scrape_status.queue_open = True
            pipeline.scrape_status.site_id = "gallery"
            pipeline.scrape_status.source_key = "gallery"
            pipeline.scrape_status.pending_urls = []
            pipeline.scrape_status.accepted_urls = set()
            pipeline.scrape_status.total = 0
            pipeline.scrape_status.skipped_items = []

        mock_db = MagicMock()
        media_row = MagicMock()
        media_row.id = 7
        mock_db.query.return_value.filter.return_value.first.return_value = media_row

        with patch.object(pipeline, "extract_post_id", return_value="88"):
            added = pipeline.enqueue_discovered_urls(
                [url],
                site_id="gallery",
                existing_posts={"88": None},
                db=mock_db,
            )

        self.assertEqual(added, [])
        self.assertEqual(scrape_leftovers.queue_urls("gallery"), [])
        rows = scrape_leftovers.unfinished_items("gallery")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["reason"], "already_have")
        self.assertEqual(rows[0]["existing_media_id"], 7)
        self.assertEqual(pipeline.scrape_status.skipped, 1)
        self.assertEqual(pipeline.scrape_status.skipped_items[0].reason, "already_have")

    def test_enqueue_unknown_post_urls_still_queue_without_file_probe(self) -> None:
        url = "https://gallery.test/post/77"
        with pipeline.scrape_lock:
            pipeline.scrape_status.running = True
            pipeline.scrape_status.kind = "enqueue"
            pipeline.scrape_status.queue_open = True
            pipeline.scrape_status.site_id = "gallery"
            pipeline.scrape_status.source_key = "gallery"
            pipeline.scrape_status.accepted_urls = set()
            pipeline.scrape_status.total = 0

        added = pipeline.enqueue_discovered_urls(
            [url],
            site_id="gallery",
            existing_posts={},
            db=MagicMock(),
            client=MagicMock(),
            job=_job([url]),
        )

        self.assertEqual(added, [url])
        self.assertEqual(scrape_leftovers.queue_urls("gallery"), [url])

    def test_skip_reason_matches_library_updated_group(self) -> None:
        from backend.app.services.scrape_leftovers import skip_reason_matches

        self.assertFalse(skip_reason_matches("identical", "library_updated"))
        self.assertTrue(skip_reason_matches("identical", "identical"))
        self.assertTrue(
            skip_reason_matches("identical", "duplicate_hash") is False
        )

    def test_start_enqueue_run_opens_enqueue_job(self) -> None:
        job = _job(["https://gallery.test/post/1"])
        site = {"id": "gallery", "name": "Gallery"}

        class _Now:
            def __init__(self, target=None, args=(), kwargs=None, daemon=None):
                self._target = target
                self._args = args

            def start(self) -> None:
                if self._target is not None:
                    self._target(*self._args)

        with (
            patch.object(scrape_api, "get_selected_site", return_value=site),
            patch.object(scrape_api, "compile_scrape_job", return_value=job) as compile_job,
            patch.object(scrape_api, "run_enqueue_job") as run_enqueue,
            patch.object(scrape_api.threading, "Thread", _Now),
        ):
            status = scrape_api.start_enqueue_run(
                ScrapeRunRequest(
                    filters=[{"type": "tag", "value": "test"}],
                    limit=0,
                    source_key="gallery",
                )
            )

        compile_job.assert_called_once()
        run_enqueue.assert_called_once_with(job)
        self.assertTrue(status.running)
        self.assertEqual(pipeline.scrape_status.kind, "enqueue")

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
        pipeline.scrape_status.processed_urls = {url}
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
            scrape_api.start_scrape_run(
                ScrapeRunRequest(
                    filters=[ScrapeFilterIn(type="tag_or", value="solo")],
                    limit=0,
                )
            )
        compile_job.assert_called_once()

    def test_run_rejects_empty_filters_without_leftovers(self) -> None:
        with patch.object(scrape_api, "get_selected_site", return_value={"id": "site_a", "name": "A"}):
            with self.assertRaises(HTTPException) as ctx:
                scrape_api.start_scrape_run(
                    ScrapeRunRequest(filters=[], limit=0, source_key="site_a"),
                    include_leftovers=True,
                )
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("filters", (ctx.exception.detail or "").lower())

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
        pipeline.scrape_status.processed_urls = {url}
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
        self.assertEqual(pipeline.scrape_status.processed, 0)
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

    def test_clear_skipped_shrinks_total_when_nothing_settled(self) -> None:
        from backend.scraper.pipeline import SkippedItem

        status = pipeline.scrape_status
        scrape_panels.activate(status, "rule34_xxx", "rule34.xxx")
        urls = [f"https://rule34.xxx/index.php?page=post&s=view&id={i}" for i in range(1, 12)]
        for url in urls:
            scrape_leftovers.remember_unfinished(url, "unavailable", "", "rule34_xxx")
        status.total = 11
        status.processed = 0
        status.skipped = 11
        status.skipped_items = [
            SkippedItem(url=url, reason="unavailable") for url in urls
        ]
        out = scrape_api.post_clear_queues("rule34_xxx", which="skipped")
        panel = self._panel(out, "rule34_xxx")
        self.assertEqual(panel.skipped_items, [])
        self.assertEqual(panel.total, 0)
        self.assertEqual(panel.processed, 0)

    def test_clear_cancelled_shrinks_progress_to_downloads(self) -> None:
        """After Stop, clearing Cancelled must not leave processed < total."""
        from backend.scraper.pipeline import SkippedItem

        status = pipeline.scrape_status
        scrape_panels.activate(status, "site_a", "Site A")
        done = [f"https://gallery.test/post/{i}" for i in range(1, 11)]
        stopped = [f"https://gallery.test/post/{i}" for i in range(11, 24)]
        status.total = 23
        status.processed = 23
        status.downloaded = 10
        status.skipped = 13
        status.processed_urls = set(done + stopped)
        status.cancelled_urls = list(stopped)
        status.skipped_items = [
            SkippedItem(url=url, reason="cancelled") for url in stopped
        ]
        out = scrape_api.post_clear_queues("site_a", which="cancelled")
        panel = self._panel(out, "site_a")
        self.assertEqual(panel.cancelled_urls, [])
        self.assertEqual(panel.skipped_items, [])
        self.assertEqual(panel.downloaded, 10)
        self.assertEqual(panel.processed, 10)
        self.assertEqual(panel.total, 10)

    def test_idle_status_clamps_progress_when_queues_are_empty(self) -> None:
        status = pipeline.scrape_status
        scrape_panels.activate(status, "site_a", "Site A")
        status.running = False
        status.total = 23
        status.processed = 10
        status.downloaded = 10
        status.cancelled_urls = []
        status.skipped_items = []
        status.error_items = []
        status.errors = []
        status.queue_urls = []
        panels = scrape_panels.panels(status, {})
        panel = next(p for p in panels if p["key"] == "site_a")
        self.assertEqual((panel["processed"], panel["total"]), (10, 10))
        self.assertEqual((status.processed, status.total), (10, 10))

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
        self.assertEqual(len(self._panel(out, "site_a").error_items), 1)
        self.assertEqual(self._panel(out, "site_a").skipped_items, [])
        self.assertEqual(self._panel(out, "unsupported").cancelled_urls, ["https://cdn.example/f.jpg"])

    def test_run_after_restore_does_not_double_the_total(self) -> None:
        """Reload shows 0/N for the queue. Run must finish at N/N, not N/2N."""
        urls = [f"https://gallery.test/post/{i}" for i in range(1, 4)]
        scrape_leftovers.add_queue(urls, source="site_a")
        scrape_leftovers.restore_into_status()
        out = scrape_api._status_out()
        panel = self._panel(out, "site_a")
        self.assertEqual((panel.processed, panel.total), (0, 3))
        self.assertTrue(pipeline.scrape_status.ran_this_session)
        with pipeline.scrape_lock:
            # Same order as start_scrape_run: load the parked panel, then open the queue.
            scrape_panels.activate(pipeline.scrape_status, "site_a", "Site A")
            pipeline.begin_scrape_queue(
                _job(urls), "site_a", continue_counts=True, retry_urls=set()
            )
        self.assertEqual(pipeline.scrape_status.total, 3)
        self.assertEqual(pipeline.scrape_status.processed, 0)
        for url in urls:
            pipeline._complete_download(url)
        self.assertEqual(pipeline.scrape_status.processed, 3)
        self.assertEqual(pipeline.scrape_status.total, 3)

    def test_restore_clears_prior_session_progress_and_downloads(self) -> None:
        """Reload must drop old progress / Downloaded previously; total = leftover queues."""
        status = pipeline.scrape_status
        status.total = 40
        status.processed = 22
        status.downloaded = 20
        status.similar = 2
        status.skipped = 5
        status.errors = ["boom"]
        status.message = "Downloading..."
        status.recent_media_ids = [11, 12, 13]
        status.finished_urls = {"https://gallery.test/post/old"}
        status.counted_urls = {"https://gallery.test/post/old"}
        queued = "https://cdn.example/q.jpg"
        failed = "https://site-a.test/post/20"
        cancelled = "https://site-a.test/post/21"
        scrape_leftovers.add_queue([queued], source="unsupported")
        scrape_leftovers.remember_unfinished(failed, "error", "boom", "site_a")
        scrape_leftovers.remember_unfinished(cancelled, "cancelled", "", "site_a")
        scrape_leftovers.restore_into_status()
        self.assertEqual(status.recent_media_ids, [])
        self.assertEqual(status.downloaded, 0)
        self.assertEqual(status.similar, 0)
        self.assertEqual(status.message, "")
        self.assertEqual(status.processed, 0)
        self.assertEqual(status.finished_urls, set())
        self.assertEqual(status.counted_urls, set())
        out = scrape_api._status_out()
        self.assertEqual(out.recent_media_ids, [])
        site = self._panel(out, "site_a")
        raw = self._panel(out, "unsupported")
        self.assertEqual((site.processed, site.downloaded, site.similar, site.total), (0, 0, 0, 2))
        self.assertEqual((raw.processed, raw.downloaded, raw.similar, raw.total), (0, 0, 0, 1))
        self.assertEqual([i.url for i in site.error_items], [failed])
        self.assertEqual(site.skipped_items, [])
        self.assertEqual(site.cancelled_urls, [cancelled])
        self.assertEqual(raw.queue_urls, [queued])

    def test_clear_endpoint_clears_only_the_clicked_panel(self) -> None:
        status = pipeline.scrape_status
        scrape_panels.activate(status, "site_a", "Site A")
        pipeline._record_skip("https://site-a.test/post/1", "error", "a")
        scrape_panels.activate(status, "site_b", "Site B")
        pipeline._record_skip("https://site-b.test/post/2", "error", "b")
        out = scrape_api.post_clear_queues("site_a")
        self.assertEqual(self._panel(out, "site_a").error_items, [])
        self.assertEqual(self._panel(out, "site_a").skipped_items, [])
        self.assertEqual(len(self._panel(out, "site_b").error_items), 1)
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

    def test_clear_one_list_leaves_the_others(self) -> None:
        queued = "https://cdn.example/q.jpg"
        failed = "https://gallery.test/post/20"
        stopped = "https://gallery.test/post/21"
        kept = "https://gallery.test/post/22"
        scrape_leftovers.add_queue([queued], source="site_a")
        scrape_leftovers.remember_unfinished(failed, "error", "boom", "site_a")
        scrape_leftovers.remember_unfinished(stopped, "cancelled", "", "site_a")
        scrape_leftovers.remember_unfinished(kept, "error", "nope", "site_b")
        scrape_leftovers.restore_into_status()
        pipeline.scrape_status.errors = [f"{failed}: boom"]

        out = scrape_api.post_clear_queues("site_a", which="queue")
        panel = self._panel(out, "site_a")
        self.assertEqual(panel.queue_urls, [])
        self.assertEqual(panel.cancelled_urls, [stopped])
        self.assertIn(failed, [item.url for item in panel.error_items])
        self.assertEqual(scrape_leftovers.queue_urls(), [])
        self.assertEqual(scrape_leftovers.queue_urls("site_b"), [])
        self.assertEqual(
            [item["url"] for item in scrape_leftovers.unfinished_items()],
            [failed, stopped, kept],
        )

        out = scrape_api.post_clear_queues("site_a", which="cancelled")
        panel = self._panel(out, "site_a")
        self.assertEqual(panel.cancelled_urls, [])
        self.assertEqual([item.url for item in panel.error_items], [failed])
        self.assertEqual(
            [item["url"] for item in scrape_leftovers.unfinished_items("site_a")],
            [failed],
        )
        self.assertEqual(
            [item["url"] for item in scrape_leftovers.unfinished_items("site_b")],
            [kept],
        )

        out = scrape_api.post_clear_queues("site_a", which="skipped")
        panel = self._panel(out, "site_a")
        self.assertEqual(panel.skipped_items, [])
        self.assertEqual([item.url for item in panel.error_items], [failed])
        self.assertEqual(
            [item["url"] for item in scrape_leftovers.unfinished_items("site_a")],
            [failed],
        )

        out = scrape_api.post_clear_queues("site_a", which="errors")
        panel = self._panel(out, "site_a")
        self.assertEqual(panel.error_items, [])
        self.assertEqual(panel.errors, [])
        self.assertEqual(scrape_leftovers.unfinished_items("site_a"), [])
        self.assertEqual(
            [item["url"] for item in scrape_leftovers.unfinished_items()],
            [kept],
        )

    def test_clear_rejects_an_unknown_list(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            scrape_api.post_clear_queues(which="nope")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_clear_skipped_by_reason_only(self) -> None:
        have = "https://gallery.test/post/1"
        identical = "https://gallery.test/post/2"
        scrape_leftovers.remember_unfinished(have, "already_have", "", "site_a")
        scrape_leftovers.remember_unfinished(identical, "identical", "", "site_a")
        status = pipeline.scrape_status
        scrape_panels.activate(status, "site_a", "Site A")
        status.skipped_items = [
            SkippedItem(url=have, reason="already_have"),
            SkippedItem(url=identical, reason="identical"),
        ]
        status.skipped = 2

        out = scrape_api.post_clear_queues("site_a", which="skipped", skip_reason="identical")
        panel = self._panel(out, "site_a")
        self.assertEqual(len(panel.skipped_items), 1)
        self.assertEqual(panel.skipped_items[0].url, have)
        self.assertEqual(panel.skipped_items[0].reason, "already_have")
        self.assertEqual(
            {item["reason"] for item in scrape_leftovers.unfinished_items("site_a")},
            {"already_have"},
        )

    def test_clear_already_have_merges_identical_and_duplicate_hash(self) -> None:
        urls = [
            ("https://gallery.test/post/1", "already_have"),
            ("https://gallery.test/post/2", "identical"),
            ("https://gallery.test/post/3", "duplicate_hash"),
            ("https://gallery.test/post/4", "tag_mismatch"),
        ]
        for url, reason in urls:
            scrape_leftovers.remember_unfinished(url, reason, "", "site_a")
        status = pipeline.scrape_status
        scrape_panels.activate(status, "site_a", "Site A")
        status.skipped_items = [SkippedItem(url=u, reason=r) for u, r in urls]
        status.skipped = len(urls)

        out = scrape_api.post_clear_queues("site_a", which="skipped", skip_reason="already_have")
        panel = self._panel(out, "site_a")
        self.assertEqual(len(panel.skipped_items), 1)
        self.assertEqual(panel.skipped_items[0].reason, "tag_mismatch")
        self.assertEqual(
            {item["reason"] for item in scrape_leftovers.unfinished_items("site_a")},
            {"tag_mismatch"},
        )

    def test_retry_skipped_by_reason_only(self) -> None:
        have = "https://gallery.test/post/1"
        identical = "https://gallery.test/post/2"
        scrape_leftovers.remember_unfinished(have, "already_have", "", "site_a")
        scrape_leftovers.remember_unfinished(identical, "identical", "", "site_a")
        status = pipeline.scrape_status
        scrape_panels.activate(status, "site_a", "Site A")
        status.skipped_items = [
            SkippedItem(url=have, reason="already_have"),
            SkippedItem(url=identical, reason="identical"),
        ]

        def _compiled(payload: ScrapeRunRequest) -> ScrapeJob:
            urls: list[str] = []
            for item in payload.filters:
                urls.extend(part for part in item.value.split("\n") if part)
            return _job(urls)

        with (
            patch.object(
                scrape_api, "get_selected_site", return_value={"id": "site_a", "name": "Site A"}
            ),
            patch.object(scrape_api, "compile_scrape_job", side_effect=_compiled),
            patch.object(scrape_api.threading, "Thread"),
        ):
            scrape_api.post_retry_skipped("site_a", which="skipped", skip_reason="identical")
        self.assertEqual(status.pending_urls, [identical])
        self.assertNotIn(have, status.pending_urls)

    def test_retry_runs_only_skipped_and_errors(self) -> None:
        queued = "https://gallery.test/post/1"
        failed = "https://gallery.test/post/2"
        skipped = "https://gallery.test/post/3"
        stopped = "https://gallery.test/post/4"
        scrape_leftovers.add_queue([queued], source="site_a")
        scrape_leftovers.remember_unfinished(failed, "error", "boom", "site_a")
        scrape_leftovers.remember_unfinished(stopped, "cancelled", "", "site_a")
        status = pipeline.scrape_status
        scrape_panels.activate(status, "site_a", "Site A")
        status.ran_this_session = True
        status.total = 4
        status.processed = 4
        status.processed_urls = {queued, failed, skipped, stopped}
        status.counted_urls = set(status.processed_urls)
        status.skipped_items = [
            SkippedItem(url=skipped, reason="already_have"),
            SkippedItem(url=stopped, reason="cancelled"),
        ]
        status.error_items = [SkippedItem(url=failed, reason="error", detail="boom")]
        status.cancelled_urls = [stopped]
        status.errors = [f"{failed}: boom"]

        def _compiled(payload: ScrapeRunRequest) -> ScrapeJob:
            urls: list[str] = []
            for item in payload.filters:
                urls.extend(part for part in item.value.split("\n") if part)
            return _job(urls)

        with (
            patch.object(
                scrape_api, "get_selected_site", return_value={"id": "site_a", "name": "Site A"}
            ),
            patch.object(scrape_api, "compile_scrape_job", side_effect=_compiled),
            patch.object(scrape_api.threading, "Thread"),
        ):
            scrape_api.post_retry_skipped("site_a")
        self.assertEqual(status.pending_urls, [skipped, failed])
        self.assertNotIn(stopped, status.pending_urls)
        self.assertNotIn(queued, status.pending_urls)
        self.assertEqual(status.processed, 2)
        self.assertEqual(status.total, 4)
        self.assertEqual(scrape_leftovers.queue_urls("site_a"), [queued])
        self.assertEqual(
            [item["url"] for item in scrape_leftovers.unfinished_items("site_a")],
            [failed, stopped],
        )

        # Errors-only retry leaves intentional skips alone.
        status.running = False
        status.pending_urls = []
        status.processed = 4
        status.processed_urls = {queued, failed, skipped, stopped}
        with (
            patch.object(
                scrape_api, "get_selected_site", return_value={"id": "site_a", "name": "Site A"}
            ),
            patch.object(scrape_api, "compile_scrape_job", side_effect=_compiled),
            patch.object(scrape_api.threading, "Thread"),
        ):
            scrape_api.post_retry_skipped("site_a", which="errors")
        self.assertEqual(status.pending_urls, [failed])
        self.assertNotIn(skipped, status.pending_urls)

    def test_run_queue_prepare_clears_prior_skip_so_already_have_counts_again(self) -> None:
        url = "https://site-a.test/post/7"
        scrape_leftovers.add_queue([url], source="site_a")
        status = pipeline.scrape_status
        scrape_panels.activate(status, "site_a", "Site A")
        status.running = False
        status.skipped_items = [SkippedItem(url=url, reason="identical", existing_media_id=3)]
        status.skipped = 1

        def _compiled(payload: ScrapeRunRequest) -> ScrapeJob:
            urls = [
                part
                for item in payload.filters
                for part in item.value.split("\n")
                if part
            ]
            return _job(urls)

        with (
            patch.object(
                scrape_api, "get_selected_site", return_value={"id": "site_a", "name": "Site A"}
            ),
            patch.object(scrape_api, "compile_scrape_job", side_effect=_compiled),
            patch.object(scrape_api.threading, "Thread"),
        ):
            scrape_api.post_run_queue("site_a")

        self.assertEqual(len(status.skipped_items), 0)
        self.assertEqual(status.skipped, 0)

        with pipeline.scrape_lock:
            pipeline._complete_skip(url, "already_have", "", existing_media_id=3)

        self.assertEqual(len(status.skipped_items), 1)
        self.assertEqual(status.skipped, 1)
        self.assertEqual(status.skipped_items[0].reason, "already_have")

    def test_run_queue_only_queued_urls(self) -> None:
        queued = "https://site-a.test/post/9"
        skipped = "https://site-a.test/post/8"
        scrape_leftovers.add_queue([queued], source="site_a")
        scrape_leftovers.remember_unfinished(skipped, "already_have", "", "site_a")
        status = pipeline.scrape_status
        scrape_panels.activate(status, "site_a", "Site A")
        status.running = False
        status.ran_this_session = True
        status.total = 4
        status.processed = 4
        status.skipped = 1
        status.skipped_items = [SkippedItem(url=skipped, reason="already_have")]

        def _compiled(payload: ScrapeRunRequest) -> ScrapeJob:
            urls: list[str] = []
            for item in payload.filters:
                urls.extend(part for part in item.value.split("\n") if part)
            return _job(urls)

        with (
            patch.object(
                scrape_api, "get_selected_site", return_value={"id": "site_a", "name": "Site A"}
            ),
            patch.object(scrape_api, "compile_scrape_job", side_effect=_compiled),
            patch.object(scrape_api.threading, "Thread"),
        ):
            scrape_api.post_run_queue("site_a")
        self.assertEqual(status.pending_urls, [queued])
        self.assertNotIn(skipped, status.pending_urls)
        self.assertEqual(status.total, 1)
        self.assertEqual(status.processed, 0)
        self.assertEqual(len(status.skipped_items), 1)
        self.assertEqual(scrape_leftovers.unfinished_items("site_a")[0]["url"], skipped)

    def test_run_queue_unsupported_only_queue(self) -> None:
        raw_q = "https://cdn.example/q.jpg"
        raw_skip = "https://cdn.example/s.jpg"
        scrape_leftovers.add_queue([raw_q], source="unsupported")
        scrape_leftovers.remember_unfinished(raw_skip, "already_have", "", "unsupported")
        status = pipeline.scrape_status
        scrape_panels.activate(status, "unsupported", "Unsupported")
        status.ran_this_session = True
        status.total = 3
        status.processed = 3
        with patch.object(pipeline.threading, "Thread"):
            scrape_api.post_run_queue("unsupported")
        self.assertEqual(status.pending_urls, [raw_q])
        self.assertEqual(status.total, 1)
        self.assertEqual(status.processed, 0)
        self.assertEqual(scrape_leftovers.queue_urls("unsupported"), [raw_q])

    def test_retry_unsupported_skips_the_queue_and_cancelled(self) -> None:
        raw_q = "https://cdn.example/q.jpg"
        raw_err = "https://cdn.example/e.jpg"
        raw_cancel = "https://cdn.example/c.jpg"
        scrape_leftovers.add_queue([raw_q], source="unsupported")
        scrape_leftovers.remember_unfinished(raw_err, "error", "x", "unsupported")
        scrape_leftovers.remember_unfinished(raw_cancel, "cancelled", "", "unsupported")
        status = pipeline.scrape_status
        scrape_panels.activate(status, "unsupported", "Unsupported")
        status.ran_this_session = True
        status.processed = 2
        status.total = 2
        status.processed_urls = {raw_err, raw_cancel}
        status.counted_urls = {raw_err, raw_cancel}
        status.skipped_items = [SkippedItem(url=raw_cancel, reason="cancelled")]
        status.error_items = [SkippedItem(url=raw_err, reason="error", detail="x")]
        status.errors = [f"{raw_err}: x"]
        status.cancelled_urls = [raw_cancel]
        with patch.object(pipeline.threading, "Thread"):
            scrape_api.post_retry_skipped("unsupported")
        self.assertEqual(status.pending_urls, [raw_err])
        self.assertEqual(status.processed, 1)
        self.assertEqual(scrape_leftovers.queue_urls(), [raw_q])
        self.assertEqual(
            [item["url"] for item in scrape_leftovers.unfinished_items()],
            [raw_err, raw_cancel],
        )

    def test_retry_local_imports_only_skipped_paths(self) -> None:
        failed = r"D:\pics\a.jpg"
        stopped = r"D:\pics\b.jpg"
        status = pipeline.scrape_status
        scrape_panels.activate(status, "local", "Local")
        status.skipped_items = [SkippedItem(url=stopped, reason="cancelled")]
        status.error_items = [SkippedItem(url=failed, reason="error", detail="x")]
        status.errors = [f"{failed}: x"]
        status.cancelled_urls = [stopped]
        with patch.object(scrape_api.threading, "Thread") as thread:
            scrape_api.post_retry_skipped("local")
        self.assertEqual(thread.call_args.kwargs["kwargs"]["paths"], [failed])
        self.assertFalse(thread.call_args.kwargs["kwargs"]["recursive"])

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
