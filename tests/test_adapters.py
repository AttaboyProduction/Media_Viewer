"""Adapter catalog load, Local default, and install-from-project."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.scraper import adapter_loader, sites


SAMPLE_MANIFEST = {
    "id": "demo_site",
    "sites": [
        {
            "id": "demo_site",
            "name": "Demo",
            "base_url": "https://example.com",
            "default_gallery_url": "https://example.com",
            "media_cdn_host": "https://cdn.example.com",
            "tag_fetch_order": ["httpx"],
        }
    ],
    "scrapers": [
        {
            "id": "demo_default",
            "name": "Default",
            "description": "Demo scraper",
            "site_ids": ["demo_site"],
        }
    ],
}


class AdapterLoaderTests(unittest.TestCase):
    def tearDown(self) -> None:
        # Restore process catalog from the real data/adapters tree after patches.
        sites.reload_adapter_catalog()

    def test_empty_catalog_normalizes_to_local(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp) / "data"
            data_dir.mkdir()
            with (
                patch.object(sites.settings, "data_dir", data_dir),
                patch.object(adapter_loader.settings, "data_dir", data_dir),
            ):
                sites.reload_adapter_catalog()
                self.assertEqual(sites.KNOWN_SITES, {})
                normalized = sites._normalize_settings({})
                self.assertEqual(normalized["selected_source_id"], sites.SOURCE_LOCAL)
                self.assertIsNone(normalized["selected_site_id"])

    def test_missing_installed_site_coerces_to_local(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp) / "data"
            data_dir.mkdir()
            with (
                patch.object(sites.settings, "data_dir", data_dir),
                patch.object(adapter_loader.settings, "data_dir", data_dir),
            ):
                sites.reload_adapter_catalog()
                normalized = sites._normalize_settings(
                    {
                        "selected_source_id": "gone_site",
                        "selected_site_id": "gone_site",
                        "selected_scraper_id": "gone_scraper",
                    }
                )
                self.assertEqual(normalized["selected_source_id"], sites.SOURCE_LOCAL)
                self.assertIsNone(normalized["selected_site_id"])
                self.assertIsNone(normalized["selected_scraper_id"])

    def test_install_from_project_and_load(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data_dir = root / "data"
            project = root / "adapters" / "demo_site"
            project.mkdir(parents=True)
            (project / "adapter.json").write_text(json.dumps(SAMPLE_MANIFEST), encoding="utf-8")
            with (
                patch.object(sites.settings, "data_dir", data_dir),
                patch.object(adapter_loader.settings, "data_dir", data_dir),
                patch.object(adapter_loader, "ROOT_DIR", root),
            ):
                aid = adapter_loader.install_adapter_from_project("demo_site")
                self.assertEqual(aid, "demo_site")
                self.assertTrue((data_dir / "adapters" / "demo_site" / "adapter.json").is_file())
                sites.reload_adapter_catalog()
                self.assertIn("demo_site", sites.KNOWN_SITES)
                self.assertIn("demo_default", sites.KNOWN_SCRAPERS)
                sources = sites.list_known_sources()
                self.assertEqual(sources[0]["id"], sites.SOURCE_LOCAL)
                self.assertEqual(sources[1]["id"], "demo_site")
                normalized = sites._normalize_settings(
                    {"selected_source_id": "demo_site", "selected_site_id": "demo_site"}
                )
                self.assertEqual(normalized["selected_source_id"], "demo_site")
                self.assertEqual(normalized["selected_scraper_id"], "demo_default")

    def test_parse_rejects_empty_sites(self) -> None:
        self.assertIsNone(adapter_loader.parse_adapter_manifest({"id": "x", "sites": [], "scrapers": []}))

    def test_template_adapters_are_hidden_from_app(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data_dir = root / "data"
            project = root / "adapters" / "example"
            project.mkdir(parents=True)
            manifest = dict(SAMPLE_MANIFEST)
            manifest["id"] = "example"
            manifest["template"] = True
            manifest["sites"] = [{**SAMPLE_MANIFEST["sites"][0], "id": "example", "name": "Example"}]
            manifest["scrapers"] = [
                {**SAMPLE_MANIFEST["scrapers"][0], "id": "example_default", "site_ids": ["example"]}
            ]
            (project / "adapter.json").write_text(json.dumps(manifest), encoding="utf-8")
            with (
                patch.object(sites.settings, "data_dir", data_dir),
                patch.object(adapter_loader.settings, "data_dir", data_dir),
                patch.object(adapter_loader, "ROOT_DIR", root),
            ):
                listed = adapter_loader.list_adapter_packages(adapter_loader.project_adapters_dir())
                self.assertEqual(listed, [])
                with self.assertRaises(ValueError):
                    adapter_loader.install_adapter_from_project("example")
                # Even if copied into data/adapters, templates stay out of the catalog.
                dest = data_dir / "adapters" / "example"
                dest.mkdir(parents=True)
                (dest / "adapter.json").write_text(json.dumps(manifest), encoding="utf-8")
                sites.reload_adapter_catalog()
                self.assertNotIn("example", sites.KNOWN_SITES)

    def test_install_all_from_parent_adapters_folder(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data_dir = root / "data"
            parent = root / "adapters"
            pkg = parent / "demo_site"
            pkg.mkdir(parents=True)
            (pkg / "adapter.json").write_text(json.dumps(SAMPLE_MANIFEST), encoding="utf-8")
            with (
                patch.object(sites.settings, "data_dir", data_dir),
                patch.object(adapter_loader.settings, "data_dir", data_dir),
            ):
                ids = adapter_loader.install_adapters_from_path(parent)
                self.assertEqual(ids, ["demo_site"])
                self.assertTrue((data_dir / "adapters" / "demo_site" / "adapter.json").is_file())


if __name__ == "__main__":
    unittest.main()
