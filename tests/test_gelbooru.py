"""Gelbooru profile: post ids, original file URL, list seeds, checkbox page."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from backend.scraper import gelbooru
from backend.scraper.adapter_loader import (
    install_adapter_from_dir,
    parse_adapter_manifest,
    read_adapter_secrets,
    site_api_auth_configured,
    write_site_secrets,
)
from backend.scraper.gallery import extract_post_id
from backend.scraper.storage import video_download_urls


XXX_POST = "https://rule34.xxx/index.php?page=post&s=view&id=19370927&tags=djcomps"

SITE = {
    "id": "rule34_xxx",
    "profile": "gelbooru",
    "base_url": "https://rule34.xxx",
    "default_gallery_url": "https://rule34.xxx/index.php?page=post&s=list",
    "api_base": "https://api.rule34.xxx/index.php?page=dapi",
    "extension": {
        "post_id_patterns": [
            r"https?://(?:[\w-]+\.)?rule34\.xxx/index\.php\?(?=[^#]*page=post)(?=[^#]*s=view)[^#]*[?&]id=(\d+)"
        ],
        "post_url_template": "https://rule34.xxx/index.php?page=post&s=view&id={id}",
    },
}


class PostIdTests(unittest.TestCase):
    def test_query_post_url_and_path_post_url(self) -> None:
        self.assertEqual(extract_post_id("https://rule34.xyz/post/123"), "123")
        with (
            patch("backend.scraper.sites.get_selected_site", return_value=SITE),
            patch("backend.scraper.sites.KNOWN_SITES", {"rule34_xxx": SITE}),
        ):
            self.assertEqual(extract_post_id(XXX_POST), "19370927")
            self.assertIsNone(
                extract_post_id("https://rule34.xxx/index.php?page=post&s=list&tags=djcomps")
            )


class ParseListTests(unittest.TestCase):
    def test_index_list_rejects_lone_post_dict(self) -> None:
        lone = {"id": 1, "file_url": "https://cdn.example/a.png", "tags": "a"}
        self.assertIsNone(gelbooru.parse_post_index_list(lone))
        self.assertEqual(gelbooru.parse_post_record(lone), lone)

    def test_index_list_accepts_wrapped_and_array(self) -> None:
        rows = [{"id": 1, "file_url": "https://a"}, {"id": 2, "file_url": "https://b"}]
        self.assertEqual(gelbooru.parse_post_index_list(rows), rows)
        self.assertEqual(gelbooru.parse_post_index_list({"post": rows}), rows)
        self.assertEqual(
            gelbooru.parse_post_index_list({"0": rows[0], "1": rows[1]}),
            rows,
        )


class FileUrlTests(unittest.TestCase):
    def test_original_file_url_and_tag_groups(self) -> None:
        def fake(url: str, *, referer: str):
            del referer
            if "s=tag" in url:
                return [
                    {"name": "artist_name", "type": 1},
                    {"name": "plain", "type": 0},
                ]
            return [
                {
                    "id": 19370927,
                    "file_url": "https://wimg.rule34.xxx/images/a.jpeg",
                    "tags": "artist_name plain",
                    "change": 1700000000,
                }
            ]

        with patch.object(gelbooru, "fetch_json", side_effect=fake):
            record = gelbooru.api_post_record(SITE, XXX_POST, "19370927")
        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record["media_url"], "https://wimg.rule34.xxx/images/a.jpeg")
        self.assertEqual(record["media_type"], "image")
        self.assertEqual(dict(record["tags"]), {"artist_name": "artist", "plain": "general"})
        self.assertIsNotNone(record["posted_at"])

    def test_gif_and_video_suffixes(self) -> None:
        self.assertEqual(
            gelbooru.media_from_file_url("https://cdn.example/a.gif"),
            ("gif", ".gif"),
        )
        self.assertEqual(
            gelbooru.media_from_file_url("https://cdn.example/a.mp4"),
            ("video", ".mp4"),
        )

    def test_plain_mp4_is_not_rewritten_to_mov(self) -> None:
        url = "https://wimg.rule34.xxx/images/clip.mp4"
        self.assertEqual(video_download_urls(url), [url])

    def test_auth_body_is_not_a_post(self) -> None:
        self.assertIsNone(gelbooru.parse_post_list("Missing authentication"))
        with patch.object(gelbooru, "fetch_json", return_value="Missing authentication"):
            self.assertIsNone(gelbooru.api_post_record(SITE, XXX_POST, "19370927"))


class ListSeedTests(unittest.TestCase):
    def _job(self, **kwargs):
        from backend.app.schemas import ScrapeFilterIn, ScrapeRunRequest
        from backend.scraper.job import compile_scrape_job

        filters = kwargs.pop("filters")
        with (
            patch("backend.scraper.sites.require_selected_site", return_value=SITE),
            patch("backend.scraper.sites.require_selected_scraper", return_value={}),
            patch("backend.scraper.gelbooru.is_gelbooru_site", return_value=True),
        ):
            # compile imports is_gelbooru_site from gelbooru inside the function,
            # so patch the name it looks up on the module.
            return compile_scrape_job(ScrapeRunRequest(filters=filters, **kwargs))

    def test_and_or_and_empty_filters(self) -> None:
        from backend.app.schemas import ScrapeFilterIn

        and_job = self._job(filters=[ScrapeFilterIn(type="tag", value="djcomps"), ScrapeFilterIn(type="tag", value="solo")])
        self.assertEqual(
            and_job.seed_urls,
            ["https://rule34.xxx/index.php?page=post&s=list&tags=djcomps%20solo"],
        )
        or_job = self._job(
            filters=[ScrapeFilterIn(type="tag", value="a"), ScrapeFilterIn(type="tag", value="b")],
            tag_mode="or",
        )
        self.assertEqual(
            or_job.seed_urls,
            [
                "https://rule34.xxx/index.php?page=post&s=list&tags=a",
                "https://rule34.xxx/index.php?page=post&s=list&tags=b",
            ],
        )
        empty = self._job(filters=[])
        self.assertEqual(empty.seed_urls, [SITE["default_gallery_url"]])

    def test_empty_api_list_falls_through_to_html(self) -> None:
        seen: list[str] = []

        def fake_html(client, site, gallery_url, *, sort, should_stop):
            del client, site, gallery_url, sort, should_stop
            seen.append("html")
            yield "https://rule34.xxx/index.php?page=post&s=view&id=1"

        with (
            patch.object(gelbooru, "_api_listing_enabled", return_value=True),
            patch.object(gelbooru, "_ApiPass") as pass_cls,
            patch.object(gelbooru, "iter_html_posts", side_effect=fake_html),
        ):
            inst = pass_cls.return_value
            inst.saw_list = True
            inst.yielded = 0
            inst.run.return_value = iter(())
            urls = list(
                gelbooru.iter_posts(
                    object(),
                    SITE,
                    "https://rule34.xxx/index.php?page=post&s=list&tags=djcomps",
                    sort="date_desc",
                    should_stop=None,
                )
            )
        self.assertEqual(seen, ["html"])
        self.assertEqual(urls, ["https://rule34.xxx/index.php?page=post&s=view&id=1"])

    def test_requires_auth_uses_html_without_credentials(self) -> None:
        need_auth = {**SITE, "requires_api_auth": True, "api_user_id": "", "api_key": ""}
        seen: list[str] = []

        def fake_html(client, site, gallery_url, *, sort, should_stop):
            del client, site, gallery_url, sort, should_stop
            seen.append("html")
            yield from ()

        with patch.object(gelbooru, "iter_html_posts", side_effect=fake_html):
            list(gelbooru.iter_posts(object(), need_auth, "https://example/list", sort="date_desc", should_stop=None))
        self.assertEqual(seen, ["html"])

    def test_oldest_sort_tag_on_the_api_list(self) -> None:
        seen: list[str] = []

        def fake(url: str, *, referer: str):
            del referer
            seen.append(url)
            return [{"id": 9, "file_url": "https://cdn.example/x.jpg", "tags": "djcomps"}]

        with patch.object(gelbooru, "fetch_json", side_effect=fake):
            urls = list(
                gelbooru.iter_posts(
                    None,
                    SITE,
                    "https://rule34.xxx/index.php?page=post&s=list&tags=djcomps",
                    sort="date_asc",
                    should_stop=None,
                )
            )
        self.assertEqual(len(urls), 1)
        self.assertIn("sort%3Aid%3Aasc", seen[0])
        self.assertIn("djcomps", seen[0])


class CheckboxTests(unittest.TestCase):
    def test_checkbox_page_is_not_a_post_or_a_list(self) -> None:
        gate = """
        <html><body>
          <p>Please verify you are human</p>
          <input type="checkbox" id="robot">
        </body></html>
        """
        listing = """
        <html><body><span class="thumb"><a href="index.php?page=post&s=view&id=5">x</a></span>
        <input type="checkbox"></body></html>
        """
        post = '<html><body><img id="image" src="https://cdn.example/full.jpg"></body></html>'
        self.assertTrue(gelbooru.is_checkbox_page(gate))
        self.assertFalse(gelbooru.is_checkbox_page(listing))
        self.assertFalse(gelbooru.is_checkbox_page(post))
        parsed = gelbooru.post_from_html(gate, XXX_POST, "19370927")
        self.assertIsNone(parsed)
        original = gelbooru.post_from_html(
            """
            <html><body>
              <a href="https://wimg.rule34.xxx/images/full.png"><img id="image" src="https://wimg.rule34.xxx/samples/small.jpg"></a>
              <ul id="tag-sidebar">
                <li class="tag-type-artist"><a href="list">artist_name</a></li>
                <li class="tag-type-general"><a href="list">plain</a></li>
              </ul>
              <li>Posted: 2024-01-02 03:04:05</li>
            </body></html>
            """,
            XXX_POST,
            "19370927",
        )
        self.assertIsNotNone(original)
        assert original is not None
        self.assertEqual(original["media_url"], "https://wimg.rule34.xxx/images/full.png")
        self.assertEqual(dict(original["tags"]), {"artist_name": "artist", "plain": "general"})


class ManifestTests(unittest.TestCase):
    def test_profile_and_api_base_are_kept(self) -> None:
        manifest = parse_adapter_manifest(
            {
                "id": "rule34_xxx",
                "sites": [
                    {
                        "id": "rule34_xxx",
                        "name": "rule34.xxx",
                        "profile": "gelbooru",
                        "base_url": "https://rule34.xxx",
                        "api_base": "https://api.rule34.xxx/index.php?page=dapi",
                        "api_user_id": "7",
                        "api_key": "secret",
                    }
                ],
                "scrapers": [
                    {
                        "id": "gelbooru_default",
                        "name": "Gelbooru",
                        "site_ids": ["gelbooru", "rule34_xxx"],
                    }
                ],
            }
        )
        self.assertIsNotNone(manifest)
        assert manifest is not None
        site = manifest["sites"][0]
        self.assertEqual(site["profile"], "gelbooru")
        self.assertEqual(site["api_base"], "https://api.rule34.xxx/index.php?page=dapi")
        self.assertEqual(site["api_user_id"], "7")
        self.assertEqual(site["api_key"], "secret")
        self.assertEqual(manifest["scrapers"][0]["name"], "Gelbooru")
        self.assertEqual(manifest["scrapers"][0]["site_ids"], ["gelbooru", "rule34_xxx"])

    def test_gelbooru_sites_share_one_source_group(self) -> None:
        from backend.scraper import sites as sites_mod

        catalog = {
            "gelbooru": {
                **SITE,
                "id": "gelbooru",
                "name": "gelbooru.com",
                "base_url": "https://gelbooru.com",
                "api_base": "https://gelbooru.com/index.php?page=dapi",
            },
            "rule34_xxx": {**SITE, "name": "rule34.xxx"},
            "rule34_xyz": {
                "id": "rule34_xyz",
                "name": "rule34.xyz",
                "base_url": "https://rule34.xyz",
            },
        }
        scrapers = {
            "gelbooru_default": {
                "id": "gelbooru_default",
                "name": "Gelbooru",
                "site_ids": ["gelbooru", "rule34_xxx"],
            },
            "rule34_xyz_default": {
                "id": "rule34_xyz_default",
                "name": "Rule34",
                "site_ids": ["rule34_xyz"],
            },
        }
        with (
            patch.dict(sites_mod.KNOWN_SITES, catalog, clear=True),
            patch.dict(sites_mod.KNOWN_SCRAPERS, scrapers, clear=True),
        ):
            sources = sites_mod.list_known_sources()
        by_id = {item["id"]: item for item in sources}
        self.assertIsNone(by_id["local"]["group"])
        self.assertEqual(by_id["rule34_xyz"]["group"], "Rule34")
        self.assertEqual(by_id["gelbooru"]["group"], "Gelbooru")
        self.assertEqual(by_id["gelbooru"]["name"], "gelbooru.com")
        self.assertEqual(by_id["rule34_xxx"]["group"], "Gelbooru")
        self.assertEqual(by_id["rule34_xxx"]["name"], "rule34.xxx")

    def test_requires_api_auth_flag_and_configured(self) -> None:
        manifest = parse_adapter_manifest(
            {
                "id": "gelbooru",
                "sites": [
                    {
                        "id": "rule34_xxx",
                        "name": "rule34.xxx",
                        "base_url": "https://rule34.xxx",
                        "requires_api_auth": True,
                    }
                ],
                "scrapers": [{"id": "g", "name": "Gelbooru", "site_ids": ["rule34_xxx"]}],
            }
        )
        assert manifest is not None
        site = manifest["sites"][0]
        self.assertTrue(site.get("requires_api_auth"))
        self.assertFalse(site_api_auth_configured(site))
        site["api_user_id"] = "1"
        site["api_key"] = "k"
        self.assertTrue(site_api_auth_configured(site))

    def test_secrets_merge_and_install_preserves_secrets(self) -> None:
        import tempfile
        from pathlib import Path

        from backend.scraper import adapter_loader as loader

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            installed = root / "installed"
            pkg = root / "pkg"
            pkg.mkdir()
            (pkg / "adapter.json").write_text(
                '{"id":"gelbooru","sites":[{"id":"rule34_xxx","name":"rule34.xxx",'
                '"base_url":"https://rule34.xxx","requires_api_auth":true}],'
                '"scrapers":[{"id":"g","name":"Gelbooru","site_ids":["rule34_xxx"]}]}',
                encoding="utf-8",
            )
            dest = installed / "gelbooru"
            dest.mkdir(parents=True)
            (dest / "adapter.json").write_text((pkg / "adapter.json").read_text(encoding="utf-8"), encoding="utf-8")
            write_site_secrets(dest, "rule34_xxx", api_user_id="449", api_key="secret-key")

            with patch.object(loader, "installed_adapters_dir", return_value=installed):
                sites, _ = loader.load_catalog_from_installed()
                self.assertEqual(sites["rule34_xxx"]["api_user_id"], "449")
                self.assertEqual(sites["rule34_xxx"]["api_key"], "secret-key")
                self.assertTrue(site_api_auth_configured(sites["rule34_xxx"]))

                install_adapter_from_dir(pkg)
                preserved = read_adapter_secrets(installed / "gelbooru")
                self.assertEqual(preserved["rule34_xxx"]["api_user_id"], "449")
                self.assertEqual(preserved["rule34_xxx"]["api_key"], "secret-key")


if __name__ == "__main__":
    unittest.main()
