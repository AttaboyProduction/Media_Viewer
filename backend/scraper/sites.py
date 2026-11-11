"""Scraper site catalog, scrape agents (scrapers), and persisted session selection.

Site/scraper metadata comes from installed adapters under data/adapters/
(see adapter_loader.py). Core ships with an empty catalog; Local is the
default Source until the user installs an adapter and picks a site.

A *site* is a configured gallery source. A *scraper* (agent) is an implementation
that can scrape one or more sites.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from backend.app.config import settings
from backend.scraper.adapter_loader import load_catalog_from_installed

# Filled by reload_adapter_catalog() from data/adapters/*/adapter.json.
KNOWN_SITES: dict[str, dict[str, Any]] = {}
KNOWN_SCRAPERS: dict[str, dict[str, Any]] = {}

# selected_source_id: a known site id, or "local" for PC folder/file import.
SOURCE_LOCAL = "local"

_DEFAULTS: dict[str, Any] = {
    "selected_source_id": SOURCE_LOCAL,
    "selected_site_id": None,
    "selected_scraper_id": None,
    # Persisted Local import picks (absolute paths); folders are what Sync re-scans.
    "local_import_folders": [],
    "local_import_files": [],
    "local_import_recursive": True,
}


def reload_adapter_catalog() -> None:
    """Refresh in-memory site/scraper catalogs from installed adapters."""
    sites, scrapers = load_catalog_from_installed()
    KNOWN_SITES.clear()
    KNOWN_SITES.update(sites)
    KNOWN_SCRAPERS.clear()
    KNOWN_SCRAPERS.update(scrapers)


# Load once at import (and again after install).
reload_adapter_catalog()


def _normalize_path_list(raw: object, *, limit: int = 500) -> list[str]:
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, str):
            continue
        text = item.strip()
        if not text:
            continue
        key = text.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(text)
        if len(out) >= limit:
            break
    return out


def _settings_path() -> Path:
    return settings.data_dir / "session_settings.json"


def scrapers_for_site(site_id: str | None) -> list[dict[str, Any]]:
    if not site_id:
        return []
    return [
        dict(scraper)
        for scraper in KNOWN_SCRAPERS.values()
        if site_id in scraper.get("site_ids", [])
    ]


def _default_scraper_id_for_site(site_id: str | None) -> str | None:
    for scraper in scrapers_for_site(site_id):
        return scraper["id"]
    return None


def _coerce_to_local(merged: dict[str, Any]) -> None:
    merged["selected_source_id"] = SOURCE_LOCAL
    merged["selected_site_id"] = None
    merged["selected_scraper_id"] = None


def _normalize_settings(data: dict) -> dict:
    merged = dict(_DEFAULTS)
    merged["local_import_folders"] = _normalize_path_list(
        data.get("local_import_folders", merged["local_import_folders"])
    )
    merged["local_import_files"] = _normalize_path_list(
        data.get("local_import_files", merged["local_import_files"])
    )
    recursive = data.get("local_import_recursive", merged["local_import_recursive"])
    merged["local_import_recursive"] = bool(recursive) if recursive is not None else True

    if not KNOWN_SITES:
        _coerce_to_local(merged)
        return merged

    source = data.get("selected_source_id", SOURCE_LOCAL)
    legacy_site = data.get("selected_site_id")

    if source == SOURCE_LOCAL:
        _coerce_to_local(merged)
        return merged

    if source in (None, ""):
        # Legacy sessions: source missing but site id present.
        if isinstance(legacy_site, str) and legacy_site in KNOWN_SITES:
            merged["selected_source_id"] = legacy_site
            merged["selected_site_id"] = legacy_site
        else:
            _coerce_to_local(merged)
            return merged
    elif isinstance(source, str) and source in KNOWN_SITES:
        merged["selected_source_id"] = source
        merged["selected_site_id"] = source
    elif isinstance(legacy_site, str) and legacy_site in KNOWN_SITES:
        merged["selected_source_id"] = legacy_site
        merged["selected_site_id"] = legacy_site
    else:
        _coerce_to_local(merged)
        return merged

    scraper_id = data.get("selected_scraper_id", merged["selected_scraper_id"])
    site_id = merged["selected_site_id"]
    valid_ids = {s["id"] for s in scrapers_for_site(site_id)}
    if isinstance(scraper_id, str) and scraper_id in valid_ids:
        merged["selected_scraper_id"] = scraper_id
    else:
        merged["selected_scraper_id"] = _default_scraper_id_for_site(site_id)

    return merged


def load_session_settings() -> dict:
    path = _settings_path()
    if not path.is_file():
        return _normalize_settings({})
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return _normalize_settings({})
    if not isinstance(data, dict):
        return _normalize_settings({})
    return _normalize_settings(data)


def persist_session_settings(data: dict | None = None) -> dict:
    current = _normalize_settings(data if data is not None else load_session_settings())
    path = _settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(current, indent=2), encoding="utf-8")
    return current


def save_session_settings(updates: dict) -> dict:
    current = load_session_settings()
    if "selected_source_id" in updates:
        source = updates["selected_source_id"]
        current["selected_source_id"] = source
        if source == SOURCE_LOCAL:
            current["selected_site_id"] = None
            current["selected_scraper_id"] = None
        elif isinstance(source, str) and source in KNOWN_SITES:
            current["selected_site_id"] = source
            if "selected_scraper_id" not in updates:
                current["selected_scraper_id"] = None
    if "selected_site_id" in updates:
        current["selected_site_id"] = updates["selected_site_id"]
        if updates["selected_site_id"] and current.get("selected_source_id") != SOURCE_LOCAL:
            current["selected_source_id"] = updates["selected_site_id"]
        # Site change: keep scraper only if it still supports the new site.
        if "selected_scraper_id" not in updates:
            current["selected_scraper_id"] = None
    if "selected_scraper_id" in updates:
        current["selected_scraper_id"] = updates["selected_scraper_id"]
    if "local_import_folders" in updates:
        current["local_import_folders"] = _normalize_path_list(updates["local_import_folders"])
    if "local_import_files" in updates:
        current["local_import_files"] = _normalize_path_list(updates["local_import_files"])
    if "local_import_recursive" in updates:
        current["local_import_recursive"] = bool(updates["local_import_recursive"])
    return persist_session_settings(current)


def list_known_sources() -> list[dict[str, Any]]:
    """Top-level scrape sources: Local first, then each installed catalog site."""
    sources = [
        {
            "id": SOURCE_LOCAL,
            "name": "Local",
            "kind": "local",
            "base_url": None,
        }
    ]
    sources.extend(
        {
            "id": site["id"],
            "name": site["name"],
            "kind": "site",
            "base_url": site.get("base_url"),
        }
        for site in KNOWN_SITES.values()
    )
    return sources


def get_selected_source() -> dict[str, Any] | None:
    data = load_session_settings()
    source_id = data.get("selected_source_id") or SOURCE_LOCAL
    for source in list_known_sources():
        if source["id"] == source_id:
            return dict(source)
    return {
        "id": SOURCE_LOCAL,
        "name": "Local",
        "kind": "local",
        "base_url": None,
    }


def ensure_session_settings_file() -> dict:
    """Create or upgrade session_settings.json (Local default on first run)."""
    return persist_session_settings(load_session_settings())


def list_known_sites() -> list[dict[str, Any]]:
    return [dict(site) for site in KNOWN_SITES.values()]


def list_known_scrapers() -> list[dict[str, Any]]:
    return [dict(scraper) for scraper in KNOWN_SCRAPERS.values()]


def get_selected_site() -> dict[str, Any] | None:
    sid = load_session_settings().get("selected_site_id")
    if not sid:
        return None
    site = KNOWN_SITES.get(sid)
    return dict(site) if site else None


def get_selected_scraper() -> dict[str, Any] | None:
    data = load_session_settings()
    scraper_id = data.get("selected_scraper_id")
    if not scraper_id:
        return None
    scraper = KNOWN_SCRAPERS.get(scraper_id)
    if not scraper:
        return None
    site_id = data.get("selected_site_id")
    if site_id and site_id not in scraper.get("site_ids", []):
        return None
    return dict(scraper)


def require_selected_site() -> dict[str, Any]:
    site = get_selected_site()
    if site is None:
        raise ValueError("No site selected. Choose a site before scraping.")
    return site


def require_selected_scraper() -> dict[str, Any]:
    require_selected_site()
    scraper = get_selected_scraper()
    if scraper is None:
        raise ValueError("No scraper selected for this site.")
    return scraper
