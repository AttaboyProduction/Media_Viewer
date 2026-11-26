"""Gallery listing must enqueue each discovered URL, not batch-collect first."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.scraper import listing, pipeline
from backend.app.services import scrape_leftovers


class GalleryDiscoveryQueueTests(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self._path = Path(self._dir.name) / "scrape_leftovers.json"
        self._orig = scrape_leftovers.leftovers_path
        scrape_leftovers.leftovers_path = lambda: self._path
        scrape_leftovers._cache = None
        scrape_leftovers._cache_path = None
        scrape_leftovers._cache_stamp = None

    def tearDown(self) -> None:
        scrape_leftovers.leftovers_path = self._orig
        scrape_leftovers._cache = None
        scrape_leftovers._cache_path = None
        scrape_leftovers._cache_stamp = None
        self._dir.cleanup()

    def test_run_gallery_discovery_calls_enqueue_per_url(self) -> None:
        urls = [
            "https://gallery.test/post/1",
            "https://gallery.test/post/2",
        ]
        seen: list[str] = []
        fills: list[int] = [0]

        def fake_iter(_client, _gallery, *, sort, should_stop, site_id=None):
            del sort, site_id
            for url in urls:
                if should_stop and should_stop():
                    break
                yield url

        def tick() -> None:
            fills[0] += 1

        with patch.object(listing, "iter_gallery_post_urls", side_effect=fake_iter):
            listing.run_gallery_discovery(
                object(),
                "https://gallery.test/tag",
                on_discovered=seen.append,
                after_discovered=tick,
            )

        self.assertEqual(seen, urls)
        self.assertEqual(fills[0], len(urls))

    def test_enqueue_falls_back_to_pending_when_append_refused(self) -> None:
        url = "https://gallery.test/post/55"
        with pipeline.scrape_lock:
            pipeline.scrape_status.running = True
            pipeline.scrape_status.kind = "scrape"
            pipeline.scrape_status.queue_open = True
            pipeline.scrape_status.site_id = "gallery"
            pipeline.scrape_status.pending_urls = []
            pipeline.scrape_status.accepted_urls = set()
            pipeline.scrape_status.total = 0

        with patch.object(pipeline, "append_scrape_urls", return_value=None):
            added = pipeline.enqueue_discovered_urls([url], site_id="gallery")

        self.assertEqual(added, [url])
        self.assertEqual(scrape_leftovers.queue_urls(), [url])
        self.assertEqual(pipeline.scrape_status.pending_urls, [url])
        self.assertEqual(pipeline.scrape_status.total, 1)

    def test_enqueue_gelbooru_posts_are_not_one_identity(self) -> None:
        urls = [
            "https://rule34.xxx/index.php?page=post&s=view&id=1",
            "https://rule34.xxx/index.php?page=post&s=view&id=2",
        ]
        with pipeline.scrape_lock:
            pipeline.scrape_status.running = True
            pipeline.scrape_status.kind = "scrape"
            pipeline.scrape_status.queue_open = True
            pipeline.scrape_status.site_id = "rule34_xxx"
            pipeline.scrape_status.pending_urls = []
            pipeline.scrape_status.accepted_urls = set()
            pipeline.scrape_status.total = 0

        site = {
            "id": "rule34_xxx",
            "extension": {
                "post_id_patterns": [
                    r"https?://(?:[\w-]+\.)?rule34\.xxx/index\.php\?(?=[^#]*page=post)(?=[^#]*s=view)[^#]*[?&]id=(\d+)"
                ],
            },
        }
        with (
            patch("backend.scraper.sites.get_selected_site", return_value=site),
            patch.object(pipeline, "append_scrape_urls", return_value=None),
        ):
            for url in urls:
                added = pipeline.enqueue_discovered_urls([url], site_id="rule34_xxx")
                self.assertEqual(added, [url])

        self.assertEqual(scrape_leftovers.queue_urls(), urls)
        self.assertEqual(pipeline.scrape_status.pending_urls, urls)
        self.assertEqual(pipeline.scrape_status.total, 2)


if __name__ == "__main__":
    unittest.main()