"""URL-filter scrapes ignore the download limit."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from backend.app.schemas import ScrapeFilterIn, ScrapeRunRequest
from backend.scraper.job import compile_scrape_job
from backend.scraper import pipeline


class ScrapeJobLimitTests(unittest.TestCase):
    def test_url_filters_ignore_download_limit(self) -> None:
        with (
            patch(
                "backend.scraper.sites.require_selected_site",
                return_value={"base_url": "https://rule34.xyz"},
            ),
            patch("backend.scraper.sites.require_selected_scraper", return_value={}),
        ):
            job = compile_scrape_job(
                ScrapeRunRequest(
                    filters=[ScrapeFilterIn(type="url", value="https://rule34.xyz/post/123")],
                    limit=2,
                )
            )
        self.assertTrue(job.ignore_download_limit)
        self.assertFalse(pipeline._quota_met(job))

    def test_multiline_url_filter_expands_to_seed_list(self) -> None:
        with (
            patch(
                "backend.scraper.sites.require_selected_site",
                return_value={"base_url": "https://rule34.xyz"},
            ),
            patch("backend.scraper.sites.require_selected_scraper", return_value={}),
        ):
            job = compile_scrape_job(
                ScrapeRunRequest(
                    filters=[
                        ScrapeFilterIn(
                            type="url",
                            value=(
                                "https://rule34.xyz/post/1\n"
                                "https://rule34.xyz/post/2\r\n"
                                "https://rule34.xyz/post/2, https://rule34.xyz/post/3"
                            ),
                        )
                    ],
                    limit=1,
                )
            )
        self.assertEqual(
            job.seed_urls,
            [
                "https://rule34.xyz/post/1",
                "https://rule34.xyz/post/2",
                "https://rule34.xyz/post/3",
            ],
        )
        self.assertTrue(job.ignore_download_limit)

    def test_tag_scrapes_keep_download_limit(self) -> None:
        with (
            patch(
                "backend.scraper.sites.require_selected_site",
                return_value={"base_url": "https://rule34.xyz"},
            ),
            patch("backend.scraper.sites.require_selected_scraper", return_value={}),
        ):
            job = compile_scrape_job(
                ScrapeRunRequest(
                    filters=[ScrapeFilterIn(type="tag", value="example")],
                    limit=2,
                )
            )
        self.assertFalse(job.ignore_download_limit)
        pipeline.scrape_status.downloaded = 2
        self.assertTrue(pipeline._quota_met(job))
        pipeline.scrape_status.downloaded = 0


if __name__ == "__main__":
    unittest.main()
