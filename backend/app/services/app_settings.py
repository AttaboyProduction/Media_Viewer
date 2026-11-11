import json
import uuid
from pathlib import Path
from typing import Literal

from backend.app.config import settings
from backend.scraper.browsers.metered import connection_is_metered
from backend.app.services.tag_group_colors import (
    TAG_GROUP_COLOR_PALETTE,
    TAG_GROUP_DEFAULT_COLOR,
)

DisplayMode = Literal["browser", "window"]
ThemePreference = Literal["dark", "light", "system"]

_DEFAULTS: dict = {
    "display_mode": "browser",
    "display_tag_aliases": True,
    "hide_scrape_page": False,
    "theme": "system",
    "viewer_exclude_tags": "",
    "viewer_exclude_tag_groups": "",
    "viewer_hide_excluded_tags": False,
    "viewer_sort": "date_desc",
    "viewer_page_size": 36,
    "viewer_page_sizes": [12, 24, 36, 48, 60, 72, 84, 96],
    "viewer_include_discarded": False,
    "scrape_default_limit": 10,
    "scrape_default_sort": "date_desc",
    "scrape_default_exclude_tags": "",
    "phash_threshold": 8,
    "tags_page_size": 50,
    "tags_page_sizes": [25, 50, 100],
    "grid_thumbnail_size": "normal",
    "grid_video_autoplay": False,
    "media_open_on_double_click": False,
    # Fresh installs start at 0; existing installs migrate to exhausted (see ensure_app_settings_file).
    "tag_group_color_palette": list(TAG_GROUP_COLOR_PALETTE),
    "tag_group_color_next_index": 0,
    "tag_group_default_color": TAG_GROUP_DEFAULT_COLOR,
    # When site tag has no type: "unknown" (system Unknown) or "default" (default tag group).
    "tags_untyped_group": "default",
    "tags_sort_mode": "order",
    # When creating a tag/group without an explicit order: alphabetical insert or append.
    "tags_auto_order_mode": "by_name",
    # highlight | front | panel — how selected tags/groups show in pickers and viewer filter.
    "tags_select_display_mode": "panel",
    # chips = filter chips above the grid; sidebar = left tag column on the viewer.
    "viewer_tag_layout": "chips",
    "launch_on_startup": False,
    "start_minimized": True,
    "viewer_media_numbering": "source",
    "media_detail_tags_collapsed": True,
    # Scrape "Downloaded previously" panel: False = this session only; True = all DB media.
    "scrape_downloads_show_all": False,
    "scrape_downloads_page_size": 18,
    # Skip a new download when its picture or video frames match an earlier file (identical band).
    "scrape_skip_identical": False,
    # auto = Obscura when installed, otherwise Playwright Chromium.
    "scrape_browser": "auto",
    # Missing key uses the metered-connection default (see _normalize_settings), then it is saved.
    "check_browser_updates_on_start": True,
    # Blur media that have any of these tags until the rule id is revealed (persisted).
    "content_hide_rules": [],
    "content_hide_revealed_rule_ids": [],
}

_VIEWER_SORTS = {"date_desc", "date_asc", "rating_desc", "rating_asc", "random"}
_SCRAPE_SORTS = {"date_desc", "date_asc"}
_GRID_SIZES = {"compact", "normal", "large"}
_SCRAPE_DOWNLOAD_PAGE_SIZES = {18, 36, 54, 72, 90}
_VIEWER_PAGE_SIZE_MIN = 1
_VIEWER_PAGE_SIZE_MAX = 200
_TAGS_PAGE_SIZE_MIN = 1
_TAGS_PAGE_SIZE_MAX = 500


def _settings_path() -> Path:
    return settings.data_dir / "app_settings.json"


def _clamp_int(value: int, low: int, high: int, default: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, n))


def _normalize_page_size_list(
    value: object,
    *,
    low: int,
    high: int,
    default: list[int],
) -> list[int]:
    if not isinstance(value, list):
        return list(default)
    seen: set[int] = set()
    out: list[int] = []
    for item in value:
        try:
            n = int(item)
        except (TypeError, ValueError):
            continue
        if n < low or n > high or n in seen:
            continue
        seen.add(n)
        out.append(n)
    out.sort()
    return out if out else list(default)


def _pick_page_size(current: object, options: list[int], *, allow_zero: bool, default: int) -> int:
    allowed = set(options)
    if allow_zero:
        allowed.add(0)
    try:
        n = int(current)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        n = default
    if n in allowed:
        return n
    if default in allowed:
        return default
    return options[0] if options else default


def _normalize_content_hide_rules(value: object) -> list[dict]:
    if not isinstance(value, list):
        return []
    out: list[dict] = []
    seen_ids: set[str] = set()
    for item in value:
        if not isinstance(item, dict):
            continue
        rid = str(item.get("id") or "").strip()
        if not rid:
            rid = str(uuid.uuid4())
        if rid in seen_ids:
            continue
        seen_ids.add(rid)
        raw_tags = item.get("tag_names", [])
        names: list[str] = []
        if isinstance(raw_tags, str):
            raw_tags = [t.strip() for t in raw_tags.split(",") if t.strip()]
        if isinstance(raw_tags, list):
            seen_names: set[str] = set()
            for tag in raw_tags:
                name = str(tag).strip()
                if not name or name in seen_names:
                    continue
                seen_names.add(name)
                names.append(name)
        message = str(item.get("message") or "").strip()
        label = str(item.get("label") or "").strip()
        out.append({"id": rid, "label": label, "tag_names": names, "message": message})
    for index, rule in enumerate(out, start=1):
        if not rule["label"]:
            rule["label"] = f"Rule #{index}"
    return out


def _normalize_content_hide_revealed_ids(value: object, rule_ids: set[str]) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in value:
        rid = str(item).strip()
        if not rid or rid in seen or rid not in rule_ids:
            continue
        seen.add(rid)
        out.append(rid)
    return out


def _fresh_defaults() -> dict:
    data = dict(_DEFAULTS)
    data["tag_group_color_palette"] = list(TAG_GROUP_COLOR_PALETTE)
    data["viewer_page_sizes"] = list(_DEFAULTS["viewer_page_sizes"])
    data["tags_page_sizes"] = list(_DEFAULTS["tags_page_sizes"])
    data["content_hide_rules"] = []
    data["content_hide_revealed_rule_ids"] = []
    return data


def _normalize_settings(data: dict) -> dict:
    if "hide_ai_default" in data and "viewer_hide_excluded_tags" not in data:
        data = dict(data)
        data["viewer_hide_excluded_tags"] = bool(data["hide_ai_default"])

    merged = _fresh_defaults()
    merged.update({k: v for k, v in data.items() if k in _DEFAULTS})

    if merged["display_mode"] not in ("browser", "window"):
        merged["display_mode"] = "browser"
    if merged["theme"] not in ("dark", "light", "system"):
        merged["theme"] = "system"
    merged["display_tag_aliases"] = bool(merged.get("display_tag_aliases", True))
    merged["hide_scrape_page"] = bool(merged.get("hide_scrape_page", False))
    merged["viewer_hide_excluded_tags"] = bool(merged.get("viewer_hide_excluded_tags", False))
    merged["viewer_include_discarded"] = bool(merged.get("viewer_include_discarded", False))
    merged["grid_video_autoplay"] = bool(merged.get("grid_video_autoplay", False))
    merged["media_open_on_double_click"] = bool(merged.get("media_open_on_double_click", False))
    merged["launch_on_startup"] = bool(merged.get("launch_on_startup", False))
    merged["start_minimized"] = bool(merged.get("start_minimized", True))
    if merged.get("viewer_media_numbering") not in ("source", "db"):
        merged["viewer_media_numbering"] = "source"
    merged["media_detail_tags_collapsed"] = bool(merged.get("media_detail_tags_collapsed", True))
    merged["scrape_downloads_show_all"] = bool(merged.get("scrape_downloads_show_all", False))
    merged["scrape_skip_identical"] = bool(merged.get("scrape_skip_identical", False))
    scrape_dl_size = _clamp_int(merged.get("scrape_downloads_page_size", 18), 18, 90, 18)
    merged["scrape_downloads_page_size"] = (
        scrape_dl_size if scrape_dl_size in _SCRAPE_DOWNLOAD_PAGE_SIZES else 18
    )

    if merged["viewer_sort"] not in _VIEWER_SORTS:
        merged["viewer_sort"] = "date_desc"
    merged["viewer_page_sizes"] = _normalize_page_size_list(
        merged.get("viewer_page_sizes"),
        low=_VIEWER_PAGE_SIZE_MIN,
        high=_VIEWER_PAGE_SIZE_MAX,
        default=list(_DEFAULTS["viewer_page_sizes"]),
    )
    merged["viewer_page_size"] = _pick_page_size(
        merged.get("viewer_page_size"),
        merged["viewer_page_sizes"],
        allow_zero=False,
        default=36,
    )

    if merged["scrape_default_sort"] not in _SCRAPE_SORTS:
        merged["scrape_default_sort"] = "date_desc"
    merged["scrape_default_limit"] = _clamp_int(merged["scrape_default_limit"], 0, 500, 10)
    merged["scrape_default_exclude_tags"] = str(merged.get("scrape_default_exclude_tags", ""))
    merged["viewer_exclude_tags"] = str(merged.get("viewer_exclude_tags", ""))
    merged["viewer_exclude_tag_groups"] = str(merged.get("viewer_exclude_tag_groups", ""))

    merged["phash_threshold"] = _clamp_int(merged["phash_threshold"], 1, 32, 8)

    merged["tags_page_sizes"] = _normalize_page_size_list(
        merged.get("tags_page_sizes"),
        low=_TAGS_PAGE_SIZE_MIN,
        high=_TAGS_PAGE_SIZE_MAX,
        default=list(_DEFAULTS["tags_page_sizes"]),
    )
    merged["tags_page_size"] = _pick_page_size(
        merged.get("tags_page_size"),
        merged["tags_page_sizes"],
        allow_zero=True,
        default=50,
    )

    if merged["grid_thumbnail_size"] not in _GRID_SIZES:
        merged["grid_thumbnail_size"] = "normal"

    palette = merged.get("tag_group_color_palette")
    if not isinstance(palette, list) or not palette:
        merged["tag_group_color_palette"] = list(TAG_GROUP_COLOR_PALETTE)
    else:
        merged["tag_group_color_palette"] = [str(c).strip() for c in palette if str(c).strip()]
        if not merged["tag_group_color_palette"]:
            merged["tag_group_color_palette"] = list(TAG_GROUP_COLOR_PALETTE)

    try:
        merged["tag_group_color_next_index"] = max(0, int(merged.get("tag_group_color_next_index", 0)))
    except (TypeError, ValueError):
        merged["tag_group_color_next_index"] = 0

    default_color = str(merged.get("tag_group_default_color") or "").strip()
    merged["tag_group_default_color"] = default_color or TAG_GROUP_DEFAULT_COLOR

    if merged.get("tags_untyped_group") not in ("unknown", "default"):
        merged["tags_untyped_group"] = "default"

    if merged.get("tags_sort_mode") not in ("name", "order"):
        merged["tags_sort_mode"] = "order"

    if merged.get("tags_auto_order_mode") not in ("end", "by_name"):
        merged["tags_auto_order_mode"] = "by_name"

    if merged.get("tags_select_display_mode") not in ("highlight", "front", "panel"):
        merged["tags_select_display_mode"] = "panel"

    if merged.get("viewer_tag_layout") not in ("chips", "sidebar"):
        merged["viewer_tag_layout"] = "chips"

    if merged.get("scrape_browser") not in ("auto", "obscura", "playwright"):
        merged["scrape_browser"] = "auto"

    if "check_browser_updates_on_start" not in data:
        merged["check_browser_updates_on_start"] = not connection_is_metered()
    else:
        merged["check_browser_updates_on_start"] = bool(merged.get("check_browser_updates_on_start"))

    merged["content_hide_rules"] = _normalize_content_hide_rules(merged.get("content_hide_rules"))
    rule_ids = {str(r["id"]) for r in merged["content_hide_rules"]}
    merged["content_hide_revealed_rule_ids"] = _normalize_content_hide_revealed_ids(
        merged.get("content_hide_revealed_rule_ids"),
        rule_ids,
    )

    return merged


def _read_raw_settings() -> tuple[bool, dict]:
    """Return (file_existed, raw_dict). Missing/invalid file → (False, {})."""
    path = _settings_path()
    if not path.is_file():
        return False, {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return True, {}
    if not isinstance(data, dict):
        return True, {}
    return True, data


def load_app_settings_persisting_update_default() -> dict:
    """Settings for the UI. Saves the metered-connection default the first time it is shown."""
    existed, raw = _read_raw_settings()
    current = load_app_settings()
    if existed and "check_browser_updates_on_start" in raw:
        return current
    return persist_app_settings(current)


def load_app_settings() -> dict:
    existed, data = _read_raw_settings()
    if not existed:
        fresh = _fresh_defaults()
        fresh["check_browser_updates_on_start"] = not connection_is_metered()
        return fresh
    normalized = _normalize_settings(data)
    # Pre-palette installs: treat the ordered set as already used up.
    if "tag_group_color_next_index" not in data:
        normalized["tag_group_color_next_index"] = len(normalized["tag_group_color_palette"])
    return normalized


def save_app_settings(updates: dict) -> dict:
    current = load_app_settings()
    for key, value in updates.items():
        if key in _DEFAULTS and value is not None:
            current[key] = value
    persisted = persist_app_settings(current)
    if "launch_on_startup" in updates and updates["launch_on_startup"] is not None:
        from backend.app.services.windows_startup import sync_launch_on_startup

        sync_launch_on_startup(bool(persisted.get("launch_on_startup")))
    return persisted


def persist_app_settings(data: dict | None = None) -> dict:
    """Write normalized settings to disk (all keys, stable across restarts)."""
    current = _normalize_settings(data if data is not None else load_app_settings())
    path = _settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(current, indent=2), encoding="utf-8")
    return current


def ensure_app_settings_file() -> dict:
    """Create or upgrade app_settings.json with every known field.

    Existing installs that pre-date the color palette get an exhausted index so
    new groups use the default color. Brand-new installs keep index 0.
    """
    return persist_app_settings(load_app_settings())


def get_display_mode() -> DisplayMode:
    return load_app_settings()["display_mode"]


def get_display_tag_aliases() -> bool:
    return bool(load_app_settings().get("display_tag_aliases", True))


def scrape_page_enabled() -> bool:
    """Scraping, rescrape, tag refresh and scrape browsers are all off while the Scrape page is hidden."""
    return not load_app_settings().get("hide_scrape_page", False)


def get_phash_threshold() -> int:
    return int(load_app_settings().get("phash_threshold", 8))


def get_untyped_tag_group_key(db=None) -> str:
    """Group key for site tags with missing/unrecognized type.

    Setting `tags_untyped_group`:
    - ``default`` (product default): current default tag group (e.g. General)
    - ``unknown``: system Unknown group
    """
    mode = load_app_settings().get("tags_untyped_group", "default")
    if mode != "default":
        return "unknown"

    close = False
    session = db
    if session is None:
        from backend.app.db.session import SessionLocal

        session = SessionLocal()
        close = True
    try:
        from backend.app.services.tag_service import get_default_tag_group

        group = get_default_tag_group(session)
        return group.key if group else "unknown"
    finally:
        if close:
            session.close()
