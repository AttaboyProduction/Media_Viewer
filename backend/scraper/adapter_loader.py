"""Load and install scrape adapter packages (catalog metadata only).

Dev packages live under ROOT/adapters/<id>/. The running app only reads
installed copies under data/adapters/<id>/ (gitignored with data/).
"""

from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path
from typing import Any

from backend.app.config import ROOT_DIR, settings

logger = logging.getLogger(__name__)

MANIFEST_NAME = "adapter.json"


def installed_adapters_dir() -> Path:
    return settings.data_dir / "adapters"


def project_adapters_dir() -> Path:
    return ROOT_DIR / "adapters"


def _read_manifest(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Skipping adapter manifest %s: %s", path, exc)
        return None
    if not isinstance(data, dict):
        logger.warning("Skipping adapter manifest %s: root must be an object", path)
        return None
    return data


def _normalize_site(raw: object) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    sid = raw.get("id")
    name = raw.get("name")
    if not isinstance(sid, str) or not sid.strip():
        return None
    if not isinstance(name, str) or not name.strip():
        return None
    site: dict[str, Any] = {
        "id": sid.strip(),
        "name": name.strip(),
        "base_url": str(raw.get("base_url") or "").rstrip("/"),
        "default_gallery_url": str(raw.get("default_gallery_url") or raw.get("base_url") or "").rstrip(
            "/"
        ),
    }
    cdn = raw.get("media_cdn_host")
    if isinstance(cdn, str) and cdn.strip():
        site["media_cdn_host"] = cdn.strip().rstrip("/")
    order = raw.get("tag_fetch_order")
    if isinstance(order, list):
        site["tag_fetch_order"] = [str(item) for item in order if isinstance(item, str) and item]
    return site


def _normalize_scraper(raw: object) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    sid = raw.get("id")
    name = raw.get("name")
    if not isinstance(sid, str) or not sid.strip():
        return None
    if not isinstance(name, str) or not name.strip():
        return None
    site_ids_raw = raw.get("site_ids")
    if not isinstance(site_ids_raw, list):
        return None
    site_ids = [str(item).strip() for item in site_ids_raw if isinstance(item, str) and item.strip()]
    if not site_ids:
        return None
    scraper: dict[str, Any] = {
        "id": sid.strip(),
        "name": name.strip(),
        "description": str(raw.get("description") or "").strip(),
        "site_ids": site_ids,
    }
    return scraper


def parse_adapter_manifest(data: dict[str, Any], *, folder_id: str | None = None) -> dict[str, Any] | None:
    """Return {id, sites, scrapers, template} or None if invalid."""
    aid = data.get("id")
    if not isinstance(aid, str) or not aid.strip():
        aid = folder_id
    if not isinstance(aid, str) or not aid.strip():
        return None
    aid = aid.strip()
    sites: list[dict[str, Any]] = []
    for item in data.get("sites") or []:
        site = _normalize_site(item)
        if site:
            sites.append(site)
    scrapers: list[dict[str, Any]] = []
    for item in data.get("scrapers") or []:
        scraper = _normalize_scraper(item)
        if scraper:
            scrapers.append(scraper)
    if not sites:
        logger.warning("Adapter %s has no valid sites; skipping", aid)
        return None
    return {
        "id": aid,
        "template": bool(data.get("template")),
        "sites": sites,
        "scrapers": scrapers,
    }


def list_adapter_packages(root: Path, *, include_templates: bool = False) -> list[dict[str, Any]]:
    """Summaries of adapter packages under a root (project or installed).

    Template packages (``\"template\": true`` in adapter.json) are omitted from the
    app UI unless ``include_templates`` is set.
    """
    if not root.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for child in sorted(root.iterdir(), key=lambda p: p.name.lower()):
        if not child.is_dir():
            continue
        raw = _read_manifest(child / MANIFEST_NAME)
        if raw is None:
            continue
        parsed = parse_adapter_manifest(raw, folder_id=child.name)
        if not parsed:
            continue
        if parsed.get("template") and not include_templates:
            continue
        out.append(
            {
                "id": parsed["id"],
                "path": str(child),
                "site_ids": [s["id"] for s in parsed["sites"]],
                "site_names": [s["name"] for s in parsed["sites"]],
            }
        )
    return out


def load_catalog_from_installed() -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    """Scan data/adapters/*/adapter.json. First site/scraper id wins on duplicates.

    Template packages are never loaded into the live site catalog.
    """
    sites: dict[str, dict[str, Any]] = {}
    scrapers: dict[str, dict[str, Any]] = {}
    root = installed_adapters_dir()
    if not root.is_dir():
        return sites, scrapers
    for child in sorted(root.iterdir(), key=lambda p: p.name.lower()):
        if not child.is_dir():
            continue
        raw = _read_manifest(child / MANIFEST_NAME)
        if raw is None:
            continue
        parsed = parse_adapter_manifest(raw, folder_id=child.name)
        if not parsed or parsed.get("template"):
            continue
        for site in parsed["sites"]:
            sid = site["id"]
            if sid in sites:
                logger.warning("Duplicate site id %s from %s; keeping first", sid, child)
                continue
            sites[sid] = site
        for scraper in parsed["scrapers"]:
            sid = scraper["id"]
            if sid in scrapers:
                logger.warning("Duplicate scraper id %s from %s; keeping first", sid, child)
                continue
            scrapers[sid] = scraper
    return sites, scrapers


def install_adapter_from_dir(src: Path) -> str:
    """Copy an adapter package into data/adapters/<id>/. Returns adapter id."""
    src = src.resolve()
    if not src.is_dir():
        raise ValueError(f"Adapter path is not a folder: {src}")
    raw = _read_manifest(src / MANIFEST_NAME)
    if raw is None:
        raise ValueError(f"Missing or invalid {MANIFEST_NAME} in {src}")
    parsed = parse_adapter_manifest(raw, folder_id=src.name)
    if not parsed:
        raise ValueError(f"Adapter package is invalid: {src}")
    if parsed.get("template"):
        raise ValueError(
            f"Adapter {parsed['id']!r} is a template (copy and edit it before installing)"
        )
    aid = parsed["id"]
    dest = installed_adapters_dir() / aid
    installed_adapters_dir().mkdir(parents=True, exist_ok=True)
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(src, dest)
    return aid


def install_adapter_from_project(adapter_id: str) -> str:
    src = project_adapters_dir() / adapter_id
    if not src.is_dir():
        raise ValueError(f"No project adapter named {adapter_id!r} under {project_adapters_dir()}")
    return install_adapter_from_dir(src)


def install_adapters_from_path(src: Path) -> list[str]:
    """Install one package (folder with adapter.json) or every package under a parent folder.

    Template packages are skipped when installing a parent folder; selecting a
    template folder itself still errors (copy and customize first).
    """
    src = src.resolve()
    if not src.is_dir():
        raise ValueError(f"Adapter path is not a folder: {src}")
    if (src / MANIFEST_NAME).is_file():
        return [install_adapter_from_dir(src)]
    installed: list[str] = []
    for child in sorted(src.iterdir(), key=lambda p: p.name.lower()):
        if not child.is_dir() or not (child / MANIFEST_NAME).is_file():
            continue
        raw = _read_manifest(child / MANIFEST_NAME)
        parsed = parse_adapter_manifest(raw or {}, folder_id=child.name)
        if not parsed or parsed.get("template"):
            continue
        installed.append(install_adapter_from_dir(child))
    if not installed:
        raise ValueError(
            f"No installable adapter packages found in {src} "
            f"(need non-template {MANIFEST_NAME} here or in immediate subfolders)"
        )
    return installed
