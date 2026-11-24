# Adapter site API credentials (Settings + Scrape hint)

## Goal

Let users enter per-Source API User ID and API key in Settings, keep those secrets local next to the installed adapter (never in git or in `adapter.json`), and show a Scrape-page reminder only when a selected Source needs auth and credentials are still missing.

## Decisions (locked)

| Topic | Choice |
|-------|--------|
| Scope | Per-site fields (only sites that opt in) |
| Opt-in | Adapter authors set a flag on the site by hand (`requires_api_auth`) after verifying the API |
| Storage | Per-adapter `secrets.json` beside the package under `data/adapters/<adapter_id>/` |
| Scrape hint | Only when selected Source needs auth and User ID or API key is empty |
| Adapters | Remain install-local / gitignored; not shipped as a shared catalog in-repo for now |

## Data model

### Site flag (public, in `adapter.json`)

On a site object:

```json
"requires_api_auth": true
```

- Opt-in only. First site: `rule34_xxx` in the Gelbooru adapter (when that package is installed locally).
- Tracked samples (if any) may include the flag with **no** secrets.
- Sites without the flag never show Settings fields or Scrape hints for API auth.

### Secrets file (local only)

Path: `data/adapters/<adapter_id>/secrets.json`

```json
{
  "sites": {
    "rule34_xxx": {
      "api_user_id": "…",
      "api_key": "…"
    }
  }
}
```

- Not committed (`data/` is gitignored).
- Not part of the adapter package copy source; lives only under the installed tree.
- Keys stay out of `adapter.json`. Any credentials currently written into a local `adapter.json` should be moved into `secrets.json` and removed from the adapter JSON.

### Catalog merge

On `reload_adapter_catalog()`:

1. Load `adapter.json` as today.
2. If `secrets.json` exists beside it, for each site id under `sites`, copy non-empty `api_user_id` / `api_key` onto the in-memory site dict.
3. Existing Gelbooru DAPI code already appends those query params when both are set — no change to request shape.

`api_auth_configured` for a site = `requires_api_auth` and both secret fields non-empty after merge.

### Install / update

`install_adapter_from_dir` (and folder install) must **preserve** an existing destination `secrets.json` when replacing package files. Copy/overwrite package contents; do not delete or replace secrets.

## API

Dedicated routes (not folded into generic `app_settings`):

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/adapters/site-auth` | List installed sites with `requires_api_auth`: `site_id`, `name`, `adapter_id`, `api_user_id`, `api_key` (for editing), `configured` |
| PUT | `/api/adapters/site-auth/{site_id}` | Body `{ api_user_id, api_key }` — write that site’s entry in the owning adapter’s `secrets.json`, reload catalog, return updated row |

- Behind the same scrape-page gate as other scrape adapter routes when applicable (`require_scrape_page` / hide scrape).
- Unknown site or site without `requires_api_auth` → 404.
- Empty strings clear that site’s stored values (or omit the site entry).

### Session / catalog for Scrape UI

Expose on site/source session payload (no secrets):

- `requires_api_auth: bool`
- `api_auth_configured: bool`

So the Scrape page can decide without calling the secrets GET.

## Settings UI

- Location: **Other → Scrape**, only when Scrape page is not hidden.
- Block title: **Source API credentials**.
- For each row from `GET /api/adapters/site-auth`:
  - Site display name as subheading.
  - Short instruction: open that site’s Account → Options (or equivalent), copy **User ID** and **API key**, paste here.
  - Inputs: User ID (text), API key (password-type).
  - Save immediately on field commit (blur / Enter), PATCH/PUT both current values for that site — same pattern as other Scrape SettingsOption controls. No separate Save button.
- If the list is empty, hide the whole block.

## Scrape page

- When the selected **Source** has `requires_api_auth && !api_auth_configured`, show a short `settings-hint`-style notice near Source/Scraper: set User ID and API key under Settings → Other → Scrape (name the site).
- Local, Unsupported, and sites without the flag: no notice.
- After credentials are saved, refetch session/catalog so the notice disappears without a full app restart.

## Out of scope

- Adapter shop / remote install marketplace.
- Auto-detecting auth from `api_base` alone.
- Committing adapters or secrets.
- Per-scraper credentials (auth is per Source/site).

## Tests

Extend existing gelbooru / adapter loader coverage (`tests/test_gelbooru.py` and related):

- Merge secrets from `secrets.json` onto the site.
- Install/update leaves an existing `secrets.json` intact.
- `requires_api_auth` without secrets ⇒ `api_auth_configured` false.
- Optional thin API tests for GET/PUT site-auth if a small harness already exists nearby; otherwise ask before adding a new suite.

## Docs / rules

- Brief note in `.cursor/rules/product-rules.mdc` and `README.md`: local `secrets.json`, Settings fields, Scrape empty-state hint; adapters stay install-local.
