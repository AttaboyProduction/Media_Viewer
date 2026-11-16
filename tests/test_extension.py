"""Browser extension: adapter `extension` block, URL → post resolution, check / enqueue."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import HTTPException

from backend.app.api import extension as extension_api
from backend.app.services import scrape_leftovers
from backend.app.schemas import ExtensionFileIn, ExtensionScrapeIn, ExtensionUrlsIn, ScrapeStatusOut
from backend.scraper import adapter_loader, pipeline, sites
from backend.scraper.job import ScrapeJob

GALLERY_EXTENSION = {
    "page_matches": ["https://gallery.test/*", "https://cdn.gallery.test/*"],
    "post_id_patterns": [
        "^https?://(?:[\\w-]+\\.)?gallery\\.test/post/(\\d+)",
        "^https?://cdn\\.gallery\\.test/posts/\\d+/(\\d+)/",
    ],
    "post_url_template": "https://gallery.test/post/{id}",
    "file_matches": [
        "https://gallery.test/post/*",
        "https://cdn.gallery.test/posts/*",
    ],
}


def _manifest(site_id: str, host: str, extension: object | None) -> dict:
    site: dict = {
        "id": site_id,
        "name": site_id,
        "base_url": f"https://{host}",
        "media_cdn_host": f"https://cdn.{host}",
    }
    if extension is not None:
        site["extension"] = extension
    return {
        "id": site_id,
        "sites": [site],
        "scrapers": [{"id": f"{site_id}_default", "name": "Default", "site_ids": [site_id]}],
    }


def _parsed_site(site_id: str, host: str, extension: object | None) -> dict:
    parsed = adapter_loader.parse_adapter_manifest(_manifest(site_id, host, extension))
    assert parsed is not None
    return parsed["sites"][0]


class ExtensionBlockParseTests(unittest.TestCase):
    def test_valid_block_is_kept(self) -> None:
        site = _parsed_site("gallery", "gallery.test", GALLERY_EXTENSION)
        self.assertEqual(site["extension"], GALLERY_EXTENSION)

    def test_invalid_and_groupless_patterns_are_dropped(self) -> None:
        block = {
            **GALLERY_EXTENSION,
            "post_id_patterns": ["([", "^https://gallery\\.test/post/\\d+", *GALLERY_EXTENSION["post_id_patterns"]],
        }
        site = _parsed_site("gallery", "gallery.test", block)
        self.assertEqual(site["extension"]["post_id_patterns"], GALLERY_EXTENSION["post_id_patterns"])

    def test_template_without_id_drops_block(self) -> None:
        block = {**GALLERY_EXTENSION, "post_url_template": "https://gallery.test/post/"}
        self.assertNotIn("extension", _parsed_site("gallery", "gallery.test", block))

    def test_missing_matches_or_patterns_drops_block(self) -> None:
        self.assertNotIn(
            "extension",
            _parsed_site("gallery", "gallery.test", {**GALLERY_EXTENSION, "page_matches": []}),
        )
        self.assertNotIn(
            "extension",
            _parsed_site("gallery", "gallery.test", {**GALLERY_EXTENSION, "post_id_patterns": ["(["]}),
        )

    def test_site_without_block_still_loads(self) -> None:
        site = _parsed_site("gallery", "gallery.test", None)
        self.assertNotIn("extension", site)

    def test_file_matches_keep_only_match_patterns(self) -> None:
        block = {**GALLERY_EXTENSION, "file_matches": ["https://gallery.test/post/*", "not a pattern"]}
        site = _parsed_site("gallery", "gallery.test", block)
        self.assertEqual(site["extension"]["file_matches"], ["https://gallery.test/post/*"])


class ResolveExtensionUrlTests(unittest.TestCase):
    def setUp(self) -> None:
        catalog = {
            "gallery": _parsed_site("gallery", "gallery.test", GALLERY_EXTENSION),
            "plain": _parsed_site("plain", "plain.test", None),
        }
        self._patch = patch.dict(sites.KNOWN_SITES, catalog, clear=True)
        self._patch.start()

    def tearDown(self) -> None:
        self._patch.stop()

    def test_only_sites_with_block_are_listed(self) -> None:
        self.assertEqual([s["id"] for s in sites.list_extension_sites()], ["gallery"])

    def test_every_media_form_maps_to_full_post(self) -> None:
        expected = ("gallery", "4725351", "https://gallery.test/post/4725351")
        for url in (
            "https://gallery.test/post/4725351",
            "https://gallery.test/post/4725351?from=search#comments",
            "https://www.gallery.test/post/4725351",
            "https://cdn.gallery.test/posts/4725/4725351/4725351.pic.jpg",
            "https://cdn.gallery.test/posts/4725/4725351/4725351.picsmall.jpg",
            "https://cdn.gallery.test/posts/4725/4725351/4725351.pic256.avif",
            "https://cdn.gallery.test/posts/4725/4725351/4725351.mov480.mp4",
            "  https://gallery.test/post/4725351  ",
        ):
            with self.subTest(url=url):
                self.assertEqual(sites.resolve_extension_url(url), expected)

    def test_unsupported_urls_are_rejected(self) -> None:
        for url in (
            "",
            "https://gallery.test/",
            "https://gallery.test/post/abc",
            "https://evil.test/post/1?u=https://gallery.test/post/1",
            "https://gallery.test.evil.test/post/1",
            "https://plain.test/post/1",
        ):
            with self.subTest(url=url):
                self.assertIsNone(sites.resolve_extension_url(url))


_LEFTOVER_DIR = tempfile.TemporaryDirectory()


def setUpModule() -> None:
    scrape_leftovers.leftovers_path = lambda: Path(_LEFTOVER_DIR.name) / "scrape_leftovers.json"


def tearDownModule() -> None:
    _LEFTOVER_DIR.cleanup()


def _idle_status() -> None:
    pipeline.scrape_status.running = False
    pipeline.scrape_status.queue_open = False
    pipeline.scrape_status.kind = ""
    pipeline.scrape_status.site_id = None
    pipeline.scrape_status.pending_urls = []
    pipeline.scrape_status.accepted_urls = set()
    pipeline.scrape_status.total = 0
    pipeline.scrape_status.processed = 0
    pipeline.scrape_status.downloaded = 0
    pipeline.scrape_status.skipped = 0
    pipeline.scrape_status.cancel = False
    pipeline.scrape_status.continue_counts = False
    pipeline.scrape_status.ran_this_session = False
    pipeline.scrape_status.errors = []
    pipeline.scrape_status.skipped_items = []
    pipeline.scrape_status.cancelled_urls = []
    pipeline.scrape_status.queue_urls = []
    pipeline.scrape_status.retry_urls = set()
    pipeline.scrape_status.counted_urls = set()
    pipeline.scrape_status.leftover_urls = set()
    pipeline.scrape_status.job_id = 0
    path = scrape_leftovers.leftovers_path()
    if path.is_file():
        path.unlink()


def _extension_enqueue_routes(app):
    """Mounted POST /api/extension/enqueue handlers.

    This FastAPI keeps included routers as ``_IncludedRouter`` entries, so the
    path lives on each effective route rather than on ``app.routes`` itself.
    """
    found = []
    for route in app.routes:
        if getattr(route, "path", None) == "/api/extension/enqueue":
            found.append(route)
        effective = getattr(route, "effective_candidates", None)
        if not callable(effective):
            continue
        for ctx in effective():
            if getattr(ctx, "path", None) == "/api/extension/enqueue":
                found.append(ctx)
    return found


class ExtensionApiTests(unittest.TestCase):
    def setUp(self) -> None:
        catalog = {
            "gallery": _parsed_site("gallery", "gallery.test", GALLERY_EXTENSION),
            "other": _parsed_site(
                "other",
                "other.test",
                {
                    "page_matches": ["https://other.test/*"],
                    "post_id_patterns": ["^https?://other\\.test/post/(\\d+)"],
                    "post_url_template": "https://other.test/post/{id}",
                },
            ),
        }
        self._patch = patch.dict(sites.KNOWN_SITES, catalog, clear=True)
        self._patch.start()
        self._auto = patch.object(extension_api, "never_auto_run_scrape", return_value=False)
        self._auto.start()
        self._saved = patch.object(
            extension_api,
            "_pending_or_saved",
            side_effect=lambda urls: (list(urls), []),
        )
        self._saved.start()
        _idle_status()

    def tearDown(self) -> None:
        self._auto.stop()
        self._saved.stop()
        self._patch.stop()
        _idle_status()

    def test_never_auto_run_defaults_off(self) -> None:
        # setUp replaces the helper; this case needs the real fallback.
        self._auto.stop()
        try:
            with patch(
                "backend.app.services.app_settings.load_app_settings",
                return_value={},
            ):
                self.assertFalse(extension_api.never_auto_run_scrape())
        finally:
            self._auto.start()

    def test_enqueue_route_points_at_post_extension_enqueue(self) -> None:
        from backend.app.main import app

        routes = _extension_enqueue_routes(app)
        self.assertTrue(routes)
        self.assertEqual(routes[0].endpoint.__name__, "post_extension_enqueue")

    def test_post_page_drops_query_and_starts_url_filter(self) -> None:
        captured: dict = {}

        def fake_start(run, before_start=None, *, continue_counts=False):
            captured["run"] = run
            return ScrapeStatusOut(
                running=True, total=1, processed=0, downloaded=0, skipped=0, errors=[], last_gallery_url=None
            )

        with (
            patch.object(extension_api, "start_scrape_run", side_effect=fake_start),
            patch.object(extension_api, "select_source_for_site") as select_source,
        ):
            out = extension_api.post_extension_enqueue(
                ExtensionUrlsIn(
                    urls=[
                        "https://gallery.test/post/4776344?page=3&cursor=4776333&providerId=root",
                        "javascript:alert(1)",
                    ]
                )
            )
        select_source.assert_called_once_with("gallery")
        self.assertTrue(out.started)
        self.assertFalse(out.appended)
        self.assertEqual(out.queued, ["https://gallery.test/post/4776344"])
        self.assertEqual(out.rejected, ["javascript:alert(1)"])
        self.assertEqual(captured["run"].filters[0].value, "https://gallery.test/post/4776344")
        self.assertEqual(captured["run"].limit, 0)
        self.assertEqual(scrape_leftovers.queue_urls(), ["https://gallery.test/post/4776344"])

    def test_cdn_page_is_queued_as_the_post(self) -> None:
        captured: dict = {}

        def fake_start(run, before_start=None, *, continue_counts=False):
            captured["run"] = run
            return ScrapeStatusOut(
                running=True, total=1, processed=0, downloaded=0, skipped=0, errors=[], last_gallery_url=None
            )

        with patch.object(extension_api, "start_scrape_run", side_effect=fake_start):
            out = extension_api.post_extension_enqueue(
                ExtensionUrlsIn(urls=["https://cdn.gallery.test/posts/0/300/300.picsmall.jpg"])
            )
        self.assertEqual(out.queued, ["https://gallery.test/post/300"])
        self.assertEqual(captured["run"].filters[0].value, "https://gallery.test/post/300")

    def test_second_file_after_done_keeps_session_counts(self) -> None:
        """A finished 1/1 must become 1/2 when the next extension file starts."""
        pipeline.scrape_status.ran_this_session = True
        pipeline.scrape_status.total = 1
        pipeline.scrape_status.processed = 1
        pipeline.scrape_status.downloaded = 1
        pipeline.scrape_status.skipped = 0
        pipeline.scrape_status.accepted_urls = {"https://gallery.test/post/1"}
        pipeline.scrape_status.pending_urls = []
        job = ScrapeJob(
            seed_urls=["https://gallery.test/post/2"],
            tags=[],
            tag_mode="and",
            date_from=None,
            date_to=None,
            media_type=None,
            sort="date_desc",
            limit=0,
            ignore_download_limit=True,
        )
        with pipeline.scrape_lock:
            pipeline.begin_scrape_queue(job, "gallery", continue_counts=True)
        self.assertTrue(pipeline.scrape_status.continue_counts)
        self.assertEqual(pipeline.scrape_status.total, 2)
        self.assertEqual(pipeline.scrape_status.processed, 1)
        self.assertEqual(pipeline.scrape_status.downloaded, 1)
        self.assertEqual(pipeline.scrape_status.pending_urls, ["https://gallery.test/post/2"])
        pipeline._reset_status("https://gallery.test/post/2")
        self.assertEqual(pipeline.scrape_status.processed, 1)
        self.assertEqual(pipeline.scrape_status.downloaded, 1)
        self.assertEqual(pipeline.scrape_status.total, 2)
        self.assertFalse(pipeline.scrape_status.continue_counts)

    def test_finished_url_can_be_queued_again(self) -> None:
        """A cancelled or failed post stays in accepted_urls and must still download later."""
        pipeline.scrape_status.ran_this_session = True
        pipeline.scrape_status.total = 1
        pipeline.scrape_status.processed = 1
        pipeline.scrape_status.accepted_urls = {"https://gallery.test/post/9"}
        pipeline.scrape_status.pending_urls = []
        job = ScrapeJob(
            seed_urls=["https://gallery.test/post/9"],
            tags=[],
            tag_mode="and",
            date_from=None,
            date_to=None,
            media_type=None,
            sort="date_desc",
            limit=0,
            ignore_download_limit=True,
        )
        with pipeline.scrape_lock:
            pipeline.begin_scrape_queue(job, "gallery", continue_counts=True)
        self.assertEqual(pipeline.scrape_status.pending_urls, ["https://gallery.test/post/9"])
        self.assertEqual(pipeline.scrape_status.total, 2)

    def test_saved_check_uses_the_post_number(self) -> None:
        with patch.object(extension_api, "_existing_post_ids", return_value={"1"}) as existing:
            out = extension_api.post_extension_saved(
                ExtensionUrlsIn(
                    urls=[
                        "https://gallery.test/post/1?page=2",
                        "https://cdn.gallery.test/posts/0/2/2.jpg",
                        "https://example.com/nope",
                    ]
                )
            )
        existing.assert_called_once()
        self.assertEqual(existing.call_args.args[0], {"1", "2"})
        self.assertEqual(out.saved, ["https://gallery.test/post/1?page=2"])

    def test_saved_post_is_not_queued_again(self) -> None:
        with (
            patch.object(
                extension_api,
                "_pending_or_saved",
                return_value=([], ["https://gallery.test/post/1"]),
            ),
            patch.object(extension_api, "start_scrape_run") as start,
        ):
            out = extension_api.post_extension_enqueue(
                ExtensionUrlsIn(urls=["https://gallery.test/post/1"])
            )
        start.assert_not_called()
        self.assertFalse(out.started)
        self.assertEqual(out.already_saved, ["https://gallery.test/post/1"])
        self.assertEqual(out.queued, [])

    def test_never_auto_run_keeps_the_link_without_starting(self) -> None:
        with (
            patch.object(extension_api, "never_auto_run_scrape", return_value=True),
            patch.object(extension_api, "start_scrape_run") as start,
        ):
            out = extension_api.post_extension_enqueue(
                ExtensionUrlsIn(urls=["https://gallery.test/post/9"])
            )
        start.assert_not_called()
        self.assertFalse(out.started)
        self.assertFalse(out.appended)
        self.assertEqual(out.queued, ["https://gallery.test/post/9"])
        self.assertEqual(scrape_leftovers.queue_urls(), ["https://gallery.test/post/9"])

    def test_never_auto_run_keeps_a_raw_file_without_starting(self) -> None:
        with patch.object(extension_api, "never_auto_run_scrape", return_value=True):
            with patch.object(pipeline, "begin_remote_download") as begin:
                out = extension_api.post_extension_save_file(
                    ExtensionFileIn(url="https://cdn.example/a.jpg")
                )
        begin.assert_not_called()
        self.assertFalse(out.started)
        self.assertFalse(out.appended)
        self.assertEqual(out.queued, ["https://cdn.example/a.jpg"])
        self.assertEqual(scrape_leftovers.queue_urls(), ["https://cdn.example/a.jpg"])

    def test_save_file_queues_before_download_when_auto_run_is_on(self) -> None:
        # setUp leaves never_auto_run_scrape false.
        order: list[str] = []

        def fake_add(urls: list[str]) -> list[str]:
            order.append("queue")
            return list(urls)

        def fake_begin(url: str) -> str:
            order.append("download")
            return "started"

        with (
            patch("backend.app.services.scrape_leftovers.add_queue", side_effect=fake_add) as add,
            patch.object(extension_api, "begin_remote_download", side_effect=fake_begin) as begin,
        ):
            out = extension_api.post_extension_save_file(
                ExtensionFileIn(url="https://cdn.example/a.jpg")
            )
        self.assertFalse(extension_api.never_auto_run_scrape())
        add.assert_called_once_with(["https://cdn.example/a.jpg"])
        begin.assert_called_once_with("https://cdn.example/a.jpg")
        self.assertEqual(order, ["queue", "download"])
        self.assertTrue(out.started)
        self.assertEqual(out.queued, ["https://cdn.example/a.jpg"])

    def test_enqueue_after_done_asks_to_continue_counts(self) -> None:
        captured: dict = {}

        def fake_start(run, before_start=None, *, continue_counts=False):
            captured["continue_counts"] = continue_counts
            return ScrapeStatusOut(
                running=True, total=2, processed=1, downloaded=1, skipped=0, errors=[], last_gallery_url=None
            )

        with (
            patch.object(extension_api, "start_scrape_run", side_effect=fake_start),
            patch.object(extension_api, "select_source_for_site"),
        ):
            extension_api.post_extension_enqueue(
                ExtensionUrlsIn(urls=["https://gallery.test/post/9"])
            )
        self.assertTrue(captured["continue_counts"])

    def test_running_scrape_grows_its_queue(self) -> None:
        pipeline.scrape_status.running = True
        pipeline.scrape_status.kind = "scrape"
        pipeline.scrape_status.queue_open = True
        pipeline.scrape_status.site_id = "gallery"
        pipeline.scrape_status.total = 2
        pipeline.scrape_status.accepted_urls = {"https://gallery.test/post/1"}
        with patch.object(extension_api, "start_scrape_run") as start:
            out = extension_api.post_extension_enqueue(
                ExtensionUrlsIn(
                    urls=[
                        "https://gallery.test/post/9?page=3&cursor=1",
                        "https://gallery.test/post/1",
                    ]
                )
            )
        start.assert_not_called()
        self.assertTrue(out.appended)
        self.assertFalse(out.started)
        self.assertEqual(out.queued, ["https://gallery.test/post/9"])
        self.assertEqual(
            scrape_leftovers.queue_urls(),
            ["https://gallery.test/post/9", "https://gallery.test/post/1"],
        )
        self.assertEqual(pipeline.scrape_status.total, 3)
        self.assertEqual(pipeline.scrape_status.pending_urls, ["https://gallery.test/post/9"])

    def test_enqueue_rejects_mixed_sites(self) -> None:
        with patch.object(extension_api, "start_scrape_run") as start:
            with self.assertRaises(HTTPException) as ctx:
                extension_api.post_extension_enqueue(
                    ExtensionUrlsIn(urls=["https://gallery.test/post/1", "https://other.test/post/2"])
                )
        self.assertEqual(ctx.exception.status_code, 400)
        start.assert_not_called()

    def test_other_job_is_a_conflict(self) -> None:
        pipeline.scrape_status.running = True
        pipeline.scrape_status.kind = "import"
        with patch.object(extension_api, "start_scrape_run") as start:
            with self.assertRaises(HTTPException) as ctx:
                extension_api.post_extension_enqueue(
                    ExtensionUrlsIn(urls=["https://gallery.test/post/9"])
                )
        self.assertEqual(ctx.exception.status_code, 409)
        start.assert_not_called()

    def test_url_list_bounds(self) -> None:
        with self.assertRaises(ValueError):
            ExtensionUrlsIn(urls=[])
        with self.assertRaises(ValueError):
            ExtensionUrlsIn(urls=["https://gallery.test/post/1"] * 501)

    def test_popup_filters_start_a_gallery_scrape(self) -> None:
        captured: dict = {}

        def fake_start(run, before_start=None, *, continue_counts=False):
            captured["run"] = run
            return ScrapeStatusOut(
                running=True, total=10, processed=0, downloaded=0, skipped=0, errors=[], last_gallery_url=None
            )

        with (
            patch.object(extension_api, "start_scrape_run", side_effect=fake_start),
            patch.object(extension_api, "select_source_for_site") as select_source,
        ):
            out = extension_api.post_extension_scrape(
                ExtensionScrapeIn(
                    site_id="gallery",
                    tags=["solo", " "],
                    tag_mode="or",
                    exclude_tags=["comic"],
                    date_from="2026-01-01T00:00",
                    date_to="",
                    media_type="image",
                    sort="date_asc",
                    limit=4,
                )
            )
        select_source.assert_called_once_with("gallery")
        self.assertTrue(out.started)
        self.assertEqual(captured["run"].tag_mode, "or")
        self.assertEqual(captured["run"].sort, "date_asc")
        self.assertEqual(captured["run"].limit, 4)
        self.assertEqual(captured["run"].exclude_tags, ["comic"])
        kinds = [(item.type, item.value) for item in captured["run"].filters]
        self.assertEqual(
            kinds,
            [("tag", "solo"), ("date_range", "2026-01-01T00:00.."), ("media_type", "image")],
        )

    def test_popup_filters_reject_an_unknown_site(self) -> None:
        with patch.object(extension_api, "start_scrape_run") as start:
            with self.assertRaises(HTTPException) as ctx:
                extension_api.post_extension_scrape(ExtensionScrapeIn(site_id="missing"))
        self.assertEqual(ctx.exception.status_code, 400)
        start.assert_not_called()

    def test_save_file_rejects_a_non_http_url(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            extension_api.post_extension_save_file(ExtensionFileIn(url="file:///C:/picture.jpg"))
        self.assertEqual(ctx.exception.status_code, 400)

    def test_save_file_conflicts_with_a_scrape(self) -> None:
        pipeline.scrape_status.running = True
        pipeline.scrape_status.kind = "scrape"
        with self.assertRaises(HTTPException) as ctx:
            extension_api.post_extension_save_file(ExtensionFileIn(url="https://cdn.example/a.jpg"))
        self.assertEqual(ctx.exception.status_code, 409)

    def test_second_raw_file_grows_the_queue(self) -> None:
        pipeline.scrape_status.running = True
        pipeline.scrape_status.kind = "download"
        pipeline.scrape_status.queue_open = True
        pipeline.scrape_status.total = 1
        pipeline.scrape_status.processed = 0
        pipeline.scrape_status.downloaded = 0
        pipeline.scrape_status.skipped = 0
        pipeline.scrape_status.accepted_urls = {"https://cdn.example/a.jpg"}
        pipeline.scrape_status.pending_urls = ["https://cdn.example/a.jpg"]
        out = extension_api.post_extension_save_file(
            ExtensionFileIn(url="https://cdn.example/b.png?token=1")
        )
        self.assertTrue(out.appended)
        self.assertFalse(out.started)
        self.assertEqual(pipeline.scrape_status.total, 2)
        self.assertEqual(pipeline.scrape_status.processed, 0)
        self.assertEqual(
            pipeline.scrape_status.pending_urls,
            ["https://cdn.example/a.jpg", "https://cdn.example/b.png?token=1"],
        )

    def test_raw_file_after_done_keeps_session_counts(self) -> None:
        pipeline.scrape_status.running = False
        pipeline.scrape_status.ran_this_session = True
        pipeline.scrape_status.total = 1
        pipeline.scrape_status.processed = 1
        pipeline.scrape_status.downloaded = 1
        pipeline.scrape_status.skipped = 0
        pipeline.scrape_status.accepted_urls = {"https://cdn.example/a.jpg"}
        pipeline.scrape_status.pending_urls = []
        with patch.object(pipeline.threading, "Thread") as thread:
            out = extension_api.post_extension_save_file(
                ExtensionFileIn(url="https://cdn.example/b.png")
            )
        thread.assert_called_once()
        self.assertTrue(out.started)
        self.assertEqual(pipeline.scrape_status.total, 2)
        self.assertEqual(pipeline.scrape_status.processed, 1)
        self.assertEqual(pipeline.scrape_status.downloaded, 1)
        self.assertEqual(pipeline.scrape_status.pending_urls, ["https://cdn.example/b.png"])


class ExtensionQueueDrainTests(unittest.TestCase):
    def tearDown(self) -> None:
        _idle_status()

    def test_url_added_during_the_job_is_scraped(self) -> None:
        seen: list[str] = []

        def fake_process(client, db, job, url, existing):
            seen.append(url)
            if url.endswith("/1"):
                added = pipeline.append_scrape_urls(["https://gallery.test/post/2"], "gallery")
                self.assertEqual(added, ["https://gallery.test/post/2"])
            return "ok"

        job = ScrapeJob(
            seed_urls=["https://gallery.test/post/1"],
            tags=[],
            tag_mode="and",
            date_from=None,
            date_to=None,
            media_type=None,
            sort="date_desc",
            limit=0,
            ignore_download_limit=True,
        )
        db = MagicMock()
        db.query.return_value.all.return_value = []

        class Client:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        _idle_status()
        with (
            patch.object(pipeline, "_process_post_url", side_effect=fake_process),
            patch.object(pipeline, "PlaywrightClient", Client),
            patch.object(pipeline, "SessionLocal", return_value=db),
            patch.object(pipeline, "seed_database"),
        ):
            with pipeline.scrape_lock:
                pipeline.scrape_status.job_id += 1
                pipeline.scrape_status.running = True
                pipeline.begin_scrape_queue(job, "gallery")
            pipeline.run_job(job)

        self.assertEqual(seen, ["https://gallery.test/post/1", "https://gallery.test/post/2"])
        self.assertEqual(pipeline.scrape_status.total, 2)
        self.assertFalse(pipeline.scrape_status.running)


class CancelRemainderTests(unittest.TestCase):
    def tearDown(self) -> None:
        _idle_status()

    def test_stop_is_not_cleared_and_the_rest_is_skipped(self) -> None:
        pipeline.scrape_status.cancel = True
        pipeline._reset_status("https://gallery.test/")
        self.assertTrue(pipeline.scrape_status.cancel)

        pipeline.scrape_status.job_id = 4
        pipeline.scrape_status.total = 3
        pipeline.scrape_status.processed = 1
        pipeline.scrape_status.downloaded = 1
        pipeline.scrape_status.skipped = 0
        pipeline.scrape_status.pending_urls = [
            "https://gallery.test/post/2",
            "https://gallery.test/post/3",
        ]
        pipeline.scrape_status.running = True
        job = ScrapeJob(
            seed_urls=["https://gallery.test/post/1"],
            tags=[],
            tag_mode="and",
            date_from=None,
            date_to=None,
            media_type=None,
            sort="date_desc",
            limit=0,
            ignore_download_limit=True,
        )
        pipeline._finish_queue(4, None, None, job, {})
        self.assertEqual(pipeline.scrape_status.processed, 3)
        self.assertEqual(pipeline.scrape_status.skipped, 2)
        self.assertEqual(pipeline.scrape_status.downloaded, 1)
        self.assertEqual(pipeline.scrape_status.message, "Cancelled")
        self.assertFalse(pipeline.scrape_status.running)
        self.assertEqual([item.reason for item in pipeline.scrape_status.skipped_items], ["cancelled", "cancelled"])
        self.assertEqual(
            pipeline.scrape_status.cancelled_urls,
            ["https://gallery.test/post/2", "https://gallery.test/post/3"],
        )

    def test_stop_releases_a_hung_job_without_waiting(self) -> None:
        """Stop must free the queue even while one post fetch is still blocked."""
        pipeline.scrape_status.running = True
        pipeline.scrape_status.queue_open = True
        pipeline.scrape_status.kind = "scrape"
        pipeline.scrape_status.job_id = 4
        pipeline.scrape_status.total = 10
        pipeline.scrape_status.processed = 8
        pipeline.scrape_status.downloaded = 8
        pipeline.scrape_status.skipped = 0
        pipeline.scrape_status.pending_urls = ["https://gallery.test/post/9"]
        pipeline.scrape_status.message = "Cancelling..."
        pipeline.abandon_running_job()
        self.assertFalse(pipeline.scrape_status.running)
        self.assertFalse(pipeline.scrape_status.queue_open)
        self.assertEqual(pipeline.scrape_status.message, "Cancelled")
        self.assertEqual(pipeline.scrape_status.processed, 10)
        self.assertEqual(pipeline.scrape_status.skipped, 2)
        self.assertEqual(pipeline.scrape_status.job_id, 5)
        self.assertEqual(pipeline.scrape_status.pending_urls, [])
        self.assertEqual(pipeline.scrape_status.cancelled_urls, ["https://gallery.test/post/9"])
        job = ScrapeJob(
            seed_urls=["https://gallery.test/post/1"],
            tags=[],
            tag_mode="and",
            date_from=None,
            date_to=None,
            media_type=None,
            sort="date_desc",
            limit=0,
            ignore_download_limit=True,
        )
        pipeline._finish_queue(4, None, None, job, {})
        self.assertFalse(pipeline.scrape_status.running)
        self.assertEqual(pipeline.scrape_status.processed, 10)
        self.assertEqual(pipeline.scrape_status.pending_urls, [])

    def test_stop_counts_a_limit_that_was_not_reached(self) -> None:
        pipeline.scrape_status.total = 10
        pipeline.scrape_status.processed = 3
        pipeline.scrape_status.skipped = 1
        pipeline.scrape_status.pending_urls = []
        pipeline._skip_cancelled_remainder()
        self.assertEqual(pipeline.scrape_status.skipped, 8)
        self.assertEqual(pipeline.scrape_status.processed, 10)

    def test_classify_remote_picture(self) -> None:
        from backend.scraper.storage import classify_remote_media

        self.assertEqual(
            classify_remote_media("https://cdn.example/a", b"\x89PNG\r\n\x1a\nrest"),
            ("image", ".png"),
        )
        self.assertEqual(classify_remote_media("https://cdn.example/a.gif", b"GIF89arest"), ("gif", ".gif"))
        with self.assertRaises(ValueError):
            classify_remote_media("https://cdn.example/a.jpg", b"<html>not a picture</html>")


if __name__ == "__main__":
    unittest.main()
