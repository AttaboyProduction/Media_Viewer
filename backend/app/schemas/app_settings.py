from typing import Literal

from pydantic import BaseModel, Field


class ContentHideRule(BaseModel):
    id: str
    label: str = ""
    tag_names: list[str] = Field(default_factory=list)
    message: str = ""


class AppSettingsOut(BaseModel):
    display_mode: Literal["browser", "window"] = "browser"
    display_tag_aliases: bool = True
    hide_scrape_page: bool = True
    theme: Literal["dark", "light", "system"] = "system"
    viewer_exclude_tags: str = ""
    viewer_exclude_tag_groups: str = ""
    viewer_hide_excluded_tags: bool = False
    viewer_sort: Literal["date_desc", "date_asc", "rating_desc", "rating_asc", "random"] = "date_desc"
    viewer_page_size: int = 36
    viewer_page_sizes: list[int] = Field(default_factory=lambda: [12, 24, 36, 48, 60, 72, 84, 96])
    viewer_include_discarded: bool = False
    scrape_default_limit: int = 10
    scrape_default_sort: Literal["date_desc", "date_asc"] = "date_desc"
    scrape_default_exclude_tags: str = ""
    phash_threshold: int = 8
    tags_page_size: int = 50
    tags_page_sizes: list[int] = Field(default_factory=lambda: [25, 50, 100])
    grid_thumbnail_size: Literal["compact", "normal", "large"] = "normal"
    grid_video_autoplay: bool = False
    media_open_on_double_click: bool = False
    tag_group_color_palette: list[str] = Field(default_factory=list)
    tag_group_color_next_index: int = 0
    tag_group_default_color: str = "#bdc3c7"
    tag_group_next_color: str = "#bdc3c7"
    tags_untyped_group: Literal["unknown", "default"] = "default"
    tags_sort_mode: Literal["name", "order"] = "order"
    tags_auto_order_mode: Literal["end", "by_name"] = "by_name"
    tags_select_display_mode: Literal["highlight", "front", "panel"] = "panel"
    viewer_tag_layout: Literal["chips", "sidebar"] = "chips"
    launch_on_startup: bool = False
    start_minimized: bool = True
    viewer_media_numbering: Literal["source", "db"] = "source"
    media_detail_tags_collapsed: bool = True
    scrape_downloads_show_all: bool = False
    scrape_downloads_page_size: int = 18
    scrape_skip_identical: bool = False
    scrape_browser: Literal["auto", "obscura", "playwright"] = "auto"
    check_browser_updates_on_start: bool = True
    content_hide_rules: list[ContentHideRule] = Field(default_factory=list)
    content_hide_revealed_rule_ids: list[str] = Field(default_factory=list)


class AppSettingsPatch(BaseModel):
    display_mode: Literal["browser", "window"] | None = None
    display_tag_aliases: bool | None = None
    hide_scrape_page: bool | None = None
    theme: Literal["dark", "light", "system"] | None = None
    viewer_exclude_tags: str | None = None
    viewer_exclude_tag_groups: str | None = None
    viewer_hide_excluded_tags: bool | None = None
    viewer_sort: Literal["date_desc", "date_asc", "rating_desc", "rating_asc", "random"] | None = None
    viewer_page_size: int | None = None
    viewer_page_sizes: list[int] | None = None
    viewer_include_discarded: bool | None = None
    scrape_default_limit: int | None = None
    scrape_default_sort: Literal["date_desc", "date_asc"] | None = None
    scrape_default_exclude_tags: str | None = None
    phash_threshold: int | None = None
    tags_page_size: int | None = None
    tags_page_sizes: list[int] | None = None
    grid_thumbnail_size: Literal["compact", "normal", "large"] | None = None
    grid_video_autoplay: bool | None = None
    media_open_on_double_click: bool | None = None
    tag_group_color_palette: list[str] | None = None
    tag_group_color_next_index: int | None = None
    tag_group_default_color: str | None = None
    tags_untyped_group: Literal["unknown", "default"] | None = None
    tags_sort_mode: Literal["name", "order"] | None = None
    tags_auto_order_mode: Literal["end", "by_name"] | None = None
    tags_select_display_mode: Literal["highlight", "front", "panel"] | None = None
    viewer_tag_layout: Literal["chips", "sidebar"] | None = None
    launch_on_startup: bool | None = None
    start_minimized: bool | None = None
    viewer_media_numbering: Literal["source", "db"] | None = None
    media_detail_tags_collapsed: bool | None = None
    scrape_downloads_show_all: bool | None = None
    scrape_downloads_page_size: int | None = None
    scrape_skip_identical: bool | None = None
    scrape_browser: Literal["auto", "obscura", "playwright"] | None = None
    check_browser_updates_on_start: bool | None = None
    content_hide_rules: list[ContentHideRule] | None = None
    content_hide_revealed_rule_ids: list[str] | None = None


def app_settings_out(data: dict) -> AppSettingsOut:
    from backend.app.services.tag_group_colors import peek_next_tag_group_color

    payload = {k: data[k] for k in AppSettingsOut.model_fields if k != "tag_group_next_color"}
    payload["tag_group_next_color"] = peek_next_tag_group_color(data)
    return AppSettingsOut(**payload)