"""Load and install scrape adapter packages (catalog metadata only).

Dev packages live under ROOT/adapters/<id>/. The running app only reads
installed copies under data/adapters/<id>/ (gitignored with data/).
"""

from __future__ import annotations

import json
import logging
import re
import shutil
from pathlib import Path
from typing import Any

from backend.app.config import ROOT_DIR, settings

logger = logging.getLogger(__name__)

MANIFEST_NAME = "adapter.json"
SECRETS_NAME = "secrets.json"


def installed_adapters_dir() -> Path:
    return settings.data_dir / "adapters"


def project_adapters_dir() -> Path:
    return ROOT_DIR / "adapters"


def secrets_path(adapter_dir: Path) -> Path:
    return adapter_dir / SECRETS_NAME


def site_api_auth_configured(site: dict[str, Any]) -> bool:
    """True when the site opts into API auth and both credentials are set."""
    if not site.get("requires_api_auth"):
        return False
    user_id = str(site.get("api_user_id") or "").strip()
    api_key = str(site.get("api_key") or "").strip()
    return bool(user_id and api_key)


def read_adapter_secrets(adapter_dir: Path) -> dict[str, dict[str, str]]:
    """Return ``{site_id: {api_user_id, api_key}}`` from secrets.json (empty if missing)."""
    path = secrets_path(adapter_dir)
    raw = _read_manifest(path)  # same JSON object load; name is historical
    if raw is None:
        return {}
    sites_raw = raw.get("sites")
    if not isinstance(sites_raw, dict):
        return {}
    out: dict[str, dict[str, str]] = {}
    for site_id, entry in sites_raw.items():
        if not isinstance(site_id, str) or not site_id.strip():
            continue
        if not isinstance(entry, dict):
            continue
        row: dict[str, str] = {}
        for key in ("api_user_id", "api_key"):
            value = entry.get(key)
            if isinstance(value, str) and value.strip():
                row[key] = value.strip()
        if row:
            out[site_id.strip()] = row
    return out


def write_site_secrets(
    adapter_dir: Path,
    site_id: str,
    *,
    api_user_id: str,
    api_key: str,
) -> dict[str, str]:
    """Update one site in secrets.json. Empty strings clear that site's entry."""
    adapter_dir.mkdir(parents=True, exist_ok=True)
    path = secrets_path(adapter_dir)
    existing = read_adapter_secrets(adapter_dir)
    user = api_user_id.strip()
    key = api_key.strip()
    if user or key:
        existing[site_id] = {"api_user_id": user, "api_key": key}
    else:
        existing.pop(site_id, None)
    payload = {"sites": existing}
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return existing.get(site_id, {"api_user_id": "", "api_key": ""})


def _apply_secrets_to_site(site: dict[str, Any], secrets: dict[str, dict[str, str]]) -> None:
    row = secrets.get(site["id"])
    if not row:
        return
    for key in ("api_user_id", "api_key"):
        value = row.get(key)
        if isinstance(value, str) and value.strip():
            site[key] = value.strip()


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
    profile = raw.get("profile")
    if isinstance(profile, str) and profile.strip():
        site["profile"] = profile.strip()
    api_base = raw.get("api_base")
    if isinstance(api_base, str) and api_base.strip():
        site["api_base"] = api_base.strip()
    # Prefer secrets.json; still accept inline values for older local copies.
    for secret_key in ("api_user_id", "api_key"):
        secret = raw.get(secret_key)
        if isinstance(secret, str) and secret.strip():
            site[secret_key] = secret.strip()
    if raw.get("requires_api_auth") is True:
        site["requires_api_auth"] = True
    order = raw.get("tag_fetch_order")
    if isinstance(order, list):
        site["tag_fetch_order"] = [str(item) for item in order if isinstance(item, str) and item]
    extension = _normalize_extension(raw.get("extension"), site_id=site["id"])
    if extension:
        site["extension"] = extension
    return site


def _string_list(raw: object) -> list[str]:
    if not isinstance(raw, list):
        return []
    return [item.strip() for item in raw if isinstance(item, str) and item.strip()]


def _normalize_extension(raw: object, *, site_id: str) -> dict[str, Any] | None:
    """Browser-extension block of a site: where it runs and how URLs map to post ids.

    ``post_id_patterns`` are evaluated by both Python ``re`` and JS ``RegExp``, so
    they must stay in the shared subset (no ``(?P<name>)``, no inline flags); group 1
    is the post id. ``post_url_template`` must contain ``{id}``.
    """
    if not isinstance(raw, dict):
        return None
    page_matches = _string_list(raw.get("page_matches"))
    patterns: list[str] = []
    for pattern in _string_list(raw.get("post_id_patterns")):
        try:
            compiled = re.compile(pattern)
        except re.error as exc:
            logger.warning("Site %s: invalid extension post_id_pattern %r: %s", site_id, pattern, exc)
            continue
        if compiled.groups < 1:
            logger.warning("Site %s: post_id_pattern %r has no capture group", site_id, pattern)
            continue
        patterns.append(pattern)
    template = raw.get("post_url_template")
    if not isinstance(template, str) or "{id}" not in template:
        logger.warning("Site %s: extension post_url_template must contain {id}", site_id)
        return None
    if not page_matches or not patterns:
        logger.warning("Site %s: extension needs page_matches and post_id_patterns", site_id)
        return None
    # Chrome match patterns for the right-click "Download this file" item
    # (a post link or a CDN file). Optional: when omitted, the item shows on
    # any link or image on the site and the click checks post_id_patterns.
    file_matches = [item for item in _string_list(raw.get("file_matches")) if "://" in item]
    return {
        "page_matches": page_matches,
        "post_id_patterns": patterns,
        "post_url_template": template.strip(),
        "file_matches": file_matches,
    }


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
    Merges ``secrets.json`` beside each package onto matching sites.
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
        secrets = read_adapter_secrets(child)
        for site in parsed["sites"]:
            sid = site["id"]
            if sid in sites:
                logger.warning("Duplicate site id %s from %s; keeping first", sid, child)
                continue
            site["adapter_id"] = parsed["id"]
            _apply_secrets_to_site(site, secrets)
            sites[sid] = site
        for scraper in parsed["scrapers"]:
            sid = scraper["id"]
            if sid in scrapers:
                logger.warning("Duplicate scraper id %s from %s; keeping first", sid, child)
                continue
            scrapers[sid] = scraper
    return sites, scrapers


def list_sites_requiring_api_auth() -> list[dict[str, Any]]:
    """Installed sites with ``requires_api_auth``, including current secret values."""
    sites, _ = load_catalog_from_installed()
    out: list[dict[str, Any]] = []
    for site in sites.values():
        if not site.get("requires_api_auth"):
            continue
        out.append(
            {
                "site_id": site["id"],
                "name": site["name"],
                "adapter_id": str(site.get("adapter_id") or ""),
                "api_user_id": str(site.get("api_user_id") or ""),
                "api_key": str(site.get("api_key") or ""),
                "configured": site_api_auth_configured(site),
            }
        )
    return out


def save_site_api_auth(site_id: str, *, api_user_id: str, api_key: str) -> dict[str, Any]:
    """Write secrets for an installed site that requires API auth. Reloads nothing."""
    sites, _ = load_catalog_from_installed()
    site = sites.get(site_id)
    if site is None or not site.get("requires_api_auth"):
        raise KeyError(site_id)
    adapter_id = str(site.get("adapter_id") or "").strip()
    if not adapter_id:
        raise KeyError(site_id)
    adapter_dir = installed_adapters_dir() / adapter_id
    if not adapter_dir.is_dir():
        raise KeyError(site_id)
    write_site_secrets(adapter_dir, site_id, api_user_id=api_user_id, api_key=api_key)
    user = api_user_id.strip()
    key = api_key.strip()
    return {
        "site_id": site_id,
        "name": site["name"],
        "adapter_id": adapter_id,
        "api_user_id": user,
        "api_key": key,
        "configured": bool(site.get("requires_api_auth") and user and key),
    }


def install_adapter_from_dir(src: Path) -> str:
    """Copy an adapter package into data/adapters/<id>/. Returns adapter id.

    Preserves an existing destination ``secrets.json`` across reinstall/update.
    """
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
    preserved_secrets: str | None = None
    dest_secrets = secrets_path(dest)
    if dest_secrets.is_file():
        try:
            preserved_secrets = dest_secrets.read_text(encoding="utf-8")
        except OSError as exc:
            logger.warning("Could not read existing secrets for %s: %s", aid, exc)
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(src, dest)
    # Never keep secrets that arrived from the source package; restore prior local file.
    copied_secrets = secrets_path(dest)
    if copied_secrets.is_file() and preserved_secrets is None:
        try:
            copied_secrets.unlink()
        except OSError:
            pass
    if preserved_secrets is not None:
        try:
            secrets_path(dest).write_text(preserved_secrets, encoding="utf-8")
        except OSError as exc:
            logger.warning("Could not restore secrets for %s: %s", aid, exc)
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
