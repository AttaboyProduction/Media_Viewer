"""API-first post scrape and soft Show more expand."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from backend.scraper import post as post_mod


class ExpandTagsTests(unittest.TestCase):
    def test_expand_tags_swallows_click_timeout(self) -> None:
        page = MagicMock()
        button = MagicMock()
        page.locator.return_value.first = button
        button.count.return_value = 1
        button.is_visible.return_value = True
        page.locator.return_value.count.return_value = 3
        button.click.side_effect = TimeoutError("waiting for navigation")

        post_mod.expand_tags(page)  # must not raise
        button.click.assert_called_once()
        kwargs = button.click.call_args.kwargs
        self.assertTrue(kwargs.get("no_wait_after"))


class ScrapePostFromApiTests(unittest.TestCase):
    def test_builds_cdn_media_and_tags_without_browser(self) -> None:
        payload = {
            "type": 0,
            "createdAt": "2026-11-09T11:37:33",
            "tags": [
                {"value": "Ada Wong", "type": 4},
                {"value": "resident_evil", "type": 2},
            ],
        }
        with (
            patch(
                "backend.scraper.site_api.fetch_post_payload",
                return_value=payload,
            ),
            patch(
                "backend.app.services.app_settings.get_untyped_tag_group_key",
                return_value="unknown",
            ),
            patch(
                "backend.scraper.sites.get_selected_site",
                return_value={"media_cdn_host": "https://rule34xyz.b-cdn.net"},
            ),
        ):
            data = post_mod.scrape_post_from_api("https://rule34.xyz/post/4772932")

        self.assertIsNotNone(data)
        assert data is not None
        self.assertEqual(data.post_id, "4772932")
        self.assertEqual(data.media_type, "image")
        self.assertEqual(
            data.media_url,
            "https://rule34xyz.b-cdn.net/posts/4772/4772932/4772932.pic.jpg",
        )
        self.assertEqual({tag.name for tag in data.tags}, {"ada_wong", "resident_evil"})
        self.assertEqual(data.posted_at.isoformat(), "2026-11-09T11:37:33")


class GotoPostRetryTests(unittest.TestCase):
    def test_retries_transient_ssl_then_succeeds(self) -> None:
        page = MagicMock()
        page.goto.side_effect = [
            RuntimeError("SSL WRONG_VERSION_NUMBER"),
            None,
        ]
        with patch.object(post_mod.time, "sleep"):
            post_mod.goto_post(page, "https://rule34.xyz/post/1", attempts=3)
        self.assertEqual(page.goto.call_count, 2)


class FetchMediaBytesTests(unittest.TestCase):
    def test_retries_transient_tls_then_succeeds(self) -> None:
        from backend.scraper import storage

        tls = RuntimeError("curl: (35) TLS connect error: WRONG_VERSION_NUMBER")
        with patch.object(storage, "_get_curl_cffi", side_effect=[tls, b"ok"]) as get:
            data = storage.fetch_media_bytes("https://cdn/x.jpg", sleep=lambda _s: None)
        self.assertEqual(data, b"ok")
        self.assertEqual(get.call_count, 2)

    def test_falls_back_to_httpx_after_curl_attempts(self) -> None:
        from backend.scraper import storage

        tls = RuntimeError("TLS connect error")
        with (
            patch.object(storage, "_get_curl_cffi", side_effect=tls) as get,
            patch.object(storage, "_get_httpx", return_value=b"via-httpx"),
        ):
            data = storage.fetch_media_bytes("https://cdn/x.jpg", sleep=lambda _s: None)
        self.assertEqual(data, b"via-httpx")
        self.assertEqual(get.call_count, storage.MEDIA_FETCH_ATTEMPTS)

    def test_http_4xx_is_not_retried(self) -> None:
        from backend.scraper import storage

        err = RuntimeError("404")
        err.response = MagicMock(status_code=404)  # type: ignore[attr-defined]
        with patch.object(storage, "_get_curl_cffi", side_effect=err) as get:
            with self.assertRaises(RuntimeError):
                storage.fetch_media_bytes("https://cdn/x.jpg", sleep=lambda _s: None)
        self.assertEqual(get.call_count, 1)


if __name__ == "__main__":
    unittest.main()
