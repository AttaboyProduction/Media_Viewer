"""Normalize viewer/tags page-size option lists and selected values."""

from __future__ import annotations

import unittest

from backend.app.services import app_settings


class TestAppSettingsPageSizes(unittest.TestCase):
    def test_defaults(self) -> None:
        n = app_settings._normalize_settings({})
        self.assertEqual(n["viewer_page_sizes"], [12, 24, 36, 48, 60, 72, 84, 96])
        self.assertEqual(n["viewer_page_size"], 36)
        self.assertEqual(n["tags_page_sizes"], [25, 50, 100])
        self.assertEqual(n["tags_page_size"], 50)

    def test_normalize_lists(self) -> None:
        n = app_settings._normalize_settings(
            {
                "viewer_page_sizes": [48, 12, 12, 0, 250, "36"],
                "viewer_page_size": 48,
                "tags_page_sizes": [100, 10, 10, 999],
                "tags_page_size": 0,
            }
        )
        self.assertEqual(n["viewer_page_sizes"], [12, 36, 48])
        self.assertEqual(n["viewer_page_size"], 48)
        self.assertEqual(n["tags_page_sizes"], [10, 100])
        self.assertEqual(n["tags_page_size"], 0)

    def test_clamp_selected_when_removed(self) -> None:
        n = app_settings._normalize_settings(
            {
                "viewer_page_sizes": [12, 36],
                "viewer_page_size": 48,
                "tags_page_sizes": [25],
                "tags_page_size": 100,
            }
        )
        # Prefer default 36 when still in the list; otherwise first option.
        self.assertEqual(n["viewer_page_size"], 36)
        self.assertEqual(n["tags_page_size"], 25)

        n2 = app_settings._normalize_settings(
            {
                "viewer_page_sizes": [12, 24],
                "viewer_page_size": 48,
            }
        )
        self.assertEqual(n2["viewer_page_size"], 12)

    def test_empty_list_falls_back(self) -> None:
        n = app_settings._normalize_settings({"viewer_page_sizes": [], "tags_page_sizes": []})
        self.assertEqual(n["viewer_page_sizes"], [12, 24, 36, 48, 60, 72, 84, 96])
        self.assertEqual(n["tags_page_sizes"], [25, 50, 100])

    def test_content_hide_rules_normalize(self) -> None:
        n = app_settings._normalize_settings(
            {
                "content_hide_rules": [
                    {"id": "r1", "tag_names": ["a", "a", "b"], "message": " hi "},
                    {"tag_names": ["c"]},
                    {"id": "r1", "tag_names": ["dup"], "message": "ignored"},
                ],
                "content_hide_revealed_rule_ids": ["r1", "missing", "r1"],
            }
        )
        self.assertEqual(len(n["content_hide_rules"]), 2)
        self.assertEqual(n["content_hide_rules"][0]["id"], "r1")
        self.assertEqual(n["content_hide_rules"][0]["label"], "Rule #1")
        self.assertEqual(n["content_hide_rules"][0]["tag_names"], ["a", "b"])
        self.assertEqual(n["content_hide_rules"][0]["message"], "hi")
        self.assertTrue(n["content_hide_rules"][1]["id"])
        self.assertEqual(n["content_hide_rules"][1]["label"], "Rule #2")
        self.assertEqual(n["content_hide_rules"][1]["tag_names"], ["c"])
        self.assertEqual(n["content_hide_revealed_rule_ids"], ["r1"])


if __name__ == "__main__":
    unittest.main()

