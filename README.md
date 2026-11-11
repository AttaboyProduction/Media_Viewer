# Scrap Download Viewer

Local Windows app: scrape configured gallery sources (or link local folders), store files + SQLite metadata, and browse them in a viewer with tags, ratings, and duplicate review.

## Features

- `Run.bat` installs missing deps, starts the server, opens the viewer, and keeps a tray icon (`Open viewer` / `Quit`). Use `Run.bat restart` (or in-app **Reload**) to kill and relaunch without a second viewer.
- Scrape from the UI: **Source** defaults to **Local**; gallery sites appear only after you install an adapter. Site sources use a scraper agent plus filters (tags with AND/OR, date/time, URLs, media type), exclude tags, gallery sort Oldest/Latest before the download limit. **Local** links folders/files on disk without copying into `media/` (hashes for duplicates, no tags). Limit counts successful downloads and is skipped when any URL filter is used; the scrape also stops when the gallery has no more unseen posts. **Downloaded previously** defaults to this session (optional show-all); Select on the page for bulk discard, permanent delete, or **Add tags** to the selection.
- Half-star ratings `0.5`–`5` (partial fill on averages); local user.
- Exact byte duplicates skipped by SHA-256 (tags and URL copied onto the kept row). Near-identical pictures (pHash Hamming 0–2) and videos with the same four sampled frames go to **Identical** for merge. Looser picture matches (crops, watermarks) go to **Similar**. **Skip identical** (Settings and the Scrape page, off by default) drops a new identical download and copies its tags and URL onto the kept file. Media detail can hand-mark another post or database id as identical or similar. Review uses **Keep all** and **Keep selected**.
- Viewer grid with tag filters (**AND** / **OR**; search uses the full tag list, not only tags on the current page); hide tags/groups and **Show discarded** persist in settings across reload. **Hide content** (Settings → Tags, separate from hidden tags) blurs matching previews on viewer, detail, scrape, related, and duplicates without removing items from lists; unlock via **Show hidden content** (Viewer toolbar, after the hidden-tags control) or tap blur, with optional per-rule messages. In Select mode, tapping a blurred card selects it instead of opening the reveal dialog. Current-page tag chips/sidebar omit tags that appear only on still-blurred files. With a tag filter active, still-blurred files are left out of the result list until unlocked. Settings can **Hide again** per rule or **Hide all content again**. Detail modal: Fit/Fill/zoom/pan, multi-URL sources, rescrape, refresh tags, delete. Esc closes nested panels before the modal.
- Tags and groups: rename, multi-group assign, merge/alias, drag reorder (order islands), palette colors.
- Settings groups: **General** (theme, display), **Tags** (aliases, hidden tags, hide-content blur rules, recalculate counts), **Viewer** (chip or left-sidebar tag layout, plus viewer options), **Other** (scrape). Browser tab or native app window (WebView2 title bar). In window mode there is one viewer window: tray **Open viewer** and `Run.bat` bring it to the front instead of opening another, and tray **Quit** / **Exit** close it. The first `Run.bat` install writes `Scrap Download.exe` in the project folder. **Launch on startup** adds a Startup shortcut to that exe (Task Manager shows Scrap Download, not pythonw). That program and `Run.bat` open the viewer when the app is already running, instead of starting a second tray icon. Scrape browser Auto / Obscura / Playwright lives under Other → Scrape (with limit, sort, exclude tags, and skip identical) and is hidden while **Hide Scrape page** is on; nav **Reload** / **Exit**.
- The Scrape page is on by default. You can hide it with **Hide Scrape page** (Settings → Other → Scrape). While hidden, settings below that checkbox stay hidden, the app does not check, download or update browsers, and media detail hides **Rescrape** and **Update tags from URLs**.

## Setup and run

### Download (no git)

[Download ZIP](https://github.com/AttaboyProduction/Media_Viewer/archive/refs/heads/main.zip) of the latest `main` branch, unpack it, then double-click `Run.bat`.

Or on GitHub: **Code** → **Download ZIP**. Private repos only work for signed-in users with access.

### Clone

```bash
git clone https://github.com/AttaboyProduction/Media_Viewer.git
cd Media_Viewer
```

Then double-click `Run.bat` (needs network on a fresh Windows PC).

On first run it will, as needed:

1. Install **Python 3.12** via `winget` (needs [App Installer](https://apps.microsoft.com/detail/9nblggh4nns1) / winget)
2. Create `.venv` and install Python packages
3. Install **Node.js LTS** via winget and build the viewer if `frontend/dist` is missing or stale
4. Write `Scrap Download.exe` next to `Run.bat` (opens the app; if it is already running, only opens the viewer)
5. Start the server, open the viewer, show a tray icon

Scrape browsers are not downloaded at setup. With the Scrape page visible (default; or after turning off **Hide Scrape page**), the Scrape page and Settings offer **Download** for **Obscura** (stealth build, into `data/browsers/obscura/`) and **Playwright Chromium** (~300 MB). While the Scrape page is on, each start checks installed browsers for updates at most once a day, unless **Check for updates on start** is off. That checkbox starts off when Windows reports a metered connection, and on otherwise.

Later runs reuse `.venv` and skip installs. A broken `.venv` (for example copied from another PC whose Python path no longer exists) is detected and recreated automatically.

### Updating

Double-click **`Update.bat`**: it downloads a fresh ZIP of `main` from GitHub and merges files into this folder (keeps `data/`, `media/`, `.venv/`, etc.). It does **not** use git and does **not** start or restart the app. Run `Run.bat` when you want to launch; the version gate below decides whether to rebuild.

Private repo: ZIP download needs a public repo, or download the ZIP while signed in via the GitHub UI.

### App version gate

Tracked `VERSION` is compared to local `data/installed_version` on every `Run.bat` / `Scrap Download.exe` launch (including after `Update.bat`):

- **Mismatch or missing stamp** — stop a running app if needed, force `pip` + frontend rebuild, recreate the exe stub if missing, then stamp `data/installed_version` and start the server.
- **Match** — light checks only (rebuild when requirements/UI mtimes require it). If the server is already healthy, only open the viewer; otherwise start the server.

Bump `VERSION` by hand when recipients should rebuild after an update (do not commit `frontend/dist/`). First successful update path stamps `0.1`.

After local code changes without a version bump, use `Run.bat restart` or the in-app **Reload** button (same kill + start path). Reload keeps the current tab and only refreshes it after `/api/health` returns a new `boot_id` (so it does not reload against the dying process). Both use `data/.skip_open_viewer` + `--no-open-viewer` so relaunch does not open a second viewer; use the tray **Open viewer** item or a normal `Run.bat` when the app is already up if you want another tab. If an install/build step fails on relaunch, the dialog includes the command and recent output; full detail is appended to `data/launcher.log`.

Then:

1. Server at http://127.0.0.1:8000
2. Browser or app window (see Settings → Display)
3. Tray icon for reopen / quit

If `winget` is unavailable, install Python 3.11+ manually from https://www.python.org/downloads/, then run `Run.bat` again.

## UI pages

| Page | Path | Purpose |
|------|------|---------|
| Viewer | `/` | Browse media, filters, tag chips for current page |
| Tags | `/tags` | Browse and edit tags; group filter |
| Add tags | `/tags/add` | Create tags |
| Tag groups | `/tags/groups` | Create/order groups, colors, default group |
| Tag settings | `/tags/settings` | Merge tags, aliases, reset tag order |
| Tag group settings | `/tags/groups/settings` | Merge groups, reset group order |
| Scrape | `/scrape` | Run scrapes, previously downloaded media, review similar files |
| Settings | `/settings` | Theme, display, hidden tags, viewer/scrape defaults; Viewer/Tags panels edit page-size option lists (live size still beside each list) |

## Development

UI with hot reload:

```bash
pip install -r requirements.txt
playwright install chromium
cd frontend
npm install
npm run dev
```

API server:

```bash
uvicorn backend.app.main:app --reload
```

### Auto-tests (order / tags / viewer list)

After changes to island ordering, tag/group reorder UI, or the viewer media list:

```bat
scripts\run_order_tests.bat
```

Covers `tests/test_order_islands.py`, `tests/test_media_list.py`, and the frontend mirrors `rowReorder.selftest.ts` / `pagination.selftest.ts`.

Dev UI: http://localhost:5173 · Built UI + API: http://127.0.0.1:8000

### Site adapters

Gallery site metadata is not built into the core catalog. The repo tracks only [`adapters/example/`](adapters/example/) (copy and change the JSON fields for a real site). Other packages under `adapters/` are gitignored. On the Scrape page use **Install …** or **Load adapters folder…** to copy into `data/adapters/` (gitignored). Until then Source is **Local** only.

CLI scrape (URL must match an *installed* adapter site):

```bash
python -m backend.scraper.pipeline --url "https://example.com/gallery" --limit 10 --sort date_desc
```

## Configuration

### `backend/app/config.py`

Paths and scrape knobs only (no site URLs; no tag blacklist). Installed site catalogs load from `data/adapters/`; session selection is in `data/session_settings.json`.

| Setting | Description |
|---------|-------------|
| `media_dir` / `database_url` / `data_dir` | File and SQLite paths |
| `frontend_dist` | Built UI directory served by FastAPI |
| `phash_threshold` | Hamming distance for similar-image detection (default 8). Identical uses 0–2 within this cap. Videos match identical only, from four frame hashes. |
| `scrape_pause_seconds` / `scrape_concurrency` / `scrape_navigation_retries` | Scrape pacing and retries |

### `data/app_settings.json`

Created/updated when you change app settings in the UI. Notable fields: `display_mode` (`browser` / `window`), viewer/scrape defaults, hidden tags/groups, tag-group color palette, `tags_untyped_group` (`unknown`|`default` for site tags without a type), `tags_sort_mode` (`name`|`order` for within-group tag listing), and `tags_auto_order_mode` (`by_name`|`end` for new tags/groups without an explicit order).

## Project structure

```
Run.bat                 Launch (`Run.bat`) or restart (`Run.bat restart`)
Update.bat              Download ZIP of latest main and merge (does not launch the app)
Scrap Download.exe      Windows launcher written by the first Run.bat install (gitignored)
VERSION                 Tracked app version (bump to force rebuild after update)
versioning.py           VERSION vs data/installed_version helpers
launcher.py             Install deps, uvicorn, tray, open viewer
adapters/               Dev site adapter packages (install into data/adapters/)
backend/                FastAPI, SQLite, scraper
frontend/               React viewer and settings UI
media/                  Downloaded files (gitignored)
data/app.db             SQLite database (gitignored)
data/adapters/          Installed site adapters (gitignored)
data/app_settings.json  UI app settings (gitignored)
data/server.log         Server log from launcher (gitignored)
```

## Database

SQLite file: `data/app.db`. Schema is created/updated on server startup via `init_db()` (`create_all` + lightweight column backfills).

### `tag_groups`

Tag categories (Copyright, Meta, AI, etc.) used for colors and sorting in the UI. Artist/Character are created when needed by a scrape, not on first install.

| Column | Type | Description |
|--------|------|-------------|
| `id` | integer | Primary key |
| `key` | string(64) | Stable identifier (e.g. `artist`, `ai`); unique |
| `label` | string(128) | Display name |
| `default_color` | string(16) | Hex color for tags in this group |
| `sort_order` | integer | Order in tag filter lists (lower = first; `unknown` defaults to 999) |
| `is_default` | boolean | Default group for new tags without an explicit group |

Seeded groups: artist, character, copyright, meta, system, ai, general, unknown.

### `tags`

Canonical tag names attached to media.

| Column | Type | Description |
|--------|------|-------------|
| `id` | integer | Primary key |
| `name` | string(256) | Normalized tag name; unique |
| `group_id` | integer FK → `tag_groups` | Primary group (first linked group; used for default color) |
| `color_override` | string(16) | Optional hex override |
| `is_deleted` | boolean | Soft delete (hidden from lists; name retained) |

### `tag_group_links`

Many-to-many: a tag can belong to multiple groups (e.g. AI + meta).

| Column | Type | Description |
|--------|------|-------------|
| `id` | integer | Primary key |
| `tag_id` | integer FK → `tags` | Tag |
| `group_id` | integer FK → `tag_groups` | Group |

Unique on (`tag_id`, `group_id`). Viewer hiding is settings-driven (`viewer_exclude_tags` / `viewer_exclude_tag_groups`), not a hardcoded AI filter.

### `tag_aliases`

Maps alias tags to a canonical tag (merged display and filtering).

| Column | Type | Description |
|--------|------|-------------|
| `id` | integer | Primary key |
| `alias_tag_id` | integer FK → `tags` | Alias tag; unique |
| `canonical_tag_id` | integer FK → `tags` | Canonical tag |

### `media_items`

One row per scraped (or imported) file.

| Column | Type | Description |
|--------|------|-------------|
| `id` | integer | Primary key |
| `source_post_id` | string(32) | Site post ID; unique |
| `source_url` | string(512) | Primary source post URL |
| `local_path` | string(1024) | Managed: relative under project root (e.g. `media/image/123.pic.jpg`). Linked: absolute PC path |
| `storage_kind` | string(16) | `managed` (copied under `media/`) or `linked` (original file left in place) |
| `media_type` | string(16) | `image`, `gif`, or `video` |
| `is_discarded` | boolean | Hidden from default viewer lists |
| `content_hash` | string(64) | SHA-256 of file bytes |
| `phash` | string(64) | Perceptual hash for similarity |
| `file_size` | integer | Bytes |
| `source_posted_at` | datetime | Post date from source site when available |
| `duplicate_of_id` | integer FK → `media_items` | Similar-file link (not exact duplicate) |
| `scraped_at` | datetime | When this row was created/updated |

### `media_source_urls`

Additional post URLs for the same file (different sites or mirrors).

| Column | Type | Description |
|--------|------|-------------|
| `id` | integer | Primary key |
| `media_id` | integer FK → `media_items` | Media row |
| `url` | string(512) | Full post URL |

Unique on (`media_id`, `url`). Primary URL is also stored on `media_items.source_url`.

### `media_tags`

Tags assigned to media (from scrape or manual edit).

| Column | Type | Description |
|--------|------|-------------|
| `id` | integer | Primary key |
| `media_id` | integer FK → `media_items` | Media row |
| `tag_id` | integer FK → `tags` | Tag |
| `is_manual` | boolean | `true` if added in UI; manual tags are not removed on re-scrape |

Unique on (`media_id`, `tag_id`).

### `users`

Rating authors (single local user seeded by default).

| Column | Type | Description |
|--------|------|-------------|
| `id` | integer | Primary key |
| `name` | string(128) | Username; unique |
| `is_local_default` | boolean | Local viewer user for star ratings |

### `ratings`

Per-user scores per media item.

| Column | Type | Description |
|--------|------|-------------|
| `id` | integer | Primary key |
| `media_id` | integer FK → `media_items` | Media row |
| `user_id` | integer FK → `users` | User |
| `score` | float | Half-star rating 0.5–5 |
| `updated_at` | datetime | Last change |

Unique on (`media_id`, `user_id`).

## API

Base URL: `http://127.0.0.1:8000/api`

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | `{ "status": "ok", "boot_id": "…" }` (new id each process start) |

### App

| Method | Path | Description |
|--------|------|-------------|
| GET | `/app/settings` | Display mode and app settings |
| PATCH | `/app/settings` | Update settings (`display_mode`) |
| GET | `/app/adapters` | Installed vs project adapter packages (Scrape page on) |
| POST | `/app/adapters/install` | Install adapter (`from_project` id or folder `path`) into `data/adapters/` |
| POST | `/app/restart` | Restart server (like `Run.bat restart`; skips opening a new viewer so in-app Reload can reuse the current window) |
| POST | `/app/shutdown` | Stop server and launcher |
| GET | `/app/info` | Paths and display mode |

### Media

| Method | Path | Description |
|--------|------|-------------|
| GET | `/media` | List/filter (`tags`, `tag_mode` `and`\|`or` default `and`, `exclude_tags`, `exclude_tag_groups`, `exclude_id`, `media_type`, `min_rating`, `sort`, `include_discarded`, pagination). Group keys are expanded server-side (aliases of hidden tags hide their media too); sorting and paging happen in SQL |
| GET | `/media/{id}` | Single item with tags, URLs, rating |
| PATCH | `/media/{id}/tags` | Add/remove tags (`add`, `remove` name lists) |
| PATCH | `/media/{id}/urls` | Add/remove source URLs |
| POST | `/media/{id}/refresh-tags` | Fetch tags from linked URLs (JSON API: curl_cffi→httpx→curl→Playwright, then HTML; no file re-download) |
| POST | `/media/{id}/rescrape` | Re-download file and metadata from primary URL |
| GET | `/media/{id}/file` | Serve file bytes by id (linked local files; also works for managed) |
| DELETE | `/media/{id}` | Delete library row; unlinks managed files only (linked PC files stay on disk) |
| DELETE | `/media/{id}/local-file` | Linked only: delete PC file and library row |
| PATCH | `/media/{id}/discard` | Soft hide/restore |
| PUT | `/media/{id}/rating` | Set half-star rating (0.5–5) |
| GET | `/media/duplicates` | Identical and similar groups for review |
| POST | `/media/duplicates/merge` | Merge identical files into one (union tags/URLs, pick rating, discard the rest) |
| POST | `/media/duplicates/keep` | Unlink `keep_ids` and discard the other ids in `scope_ids` |
| GET | `/media/{id}/duplicate-group` | Related files for the media detail panel |
| POST | `/media/{id}/related` | Mark local database ids as identical or similar to this file |
| POST | `/media/duplicates/mark` | Link selected ids as identical or similar (earliest id stays primary) |
| POST | `/media/bulk` | Bulk `discard` or `delete` (`ids`, 1–500) |
| POST | `/media/bulk-tags` | Add the same tag names to many media (`ids`, `add`) |
| POST | `/media/{id}/duplicate` | Discard a member, or unlink one child (`keep_both`) |

### Tags

| Method | Path | Description |
|--------|------|-------------|
| GET | `/tags` | List tags with groups and usage counts |
| POST | `/tags` | Create tag (`name`, optional `group_ids`) |
| PATCH | `/tags/{id}` | `group_id`, `add_group_ids`, `remove_group_ids`, `color_override` |
| DELETE | `/tags/{id}` | Soft delete |
| POST | `/tags/merge` | Merge tags into target |
| POST | `/tags/rename` | Rename tag |
| POST | `/tags/alias` | Set alias → canonical |
| POST | `/tags/alias-batch` | Set multiple aliases → one canonical |

### Tag groups

| Method | Path | Description |
|--------|------|-------------|
| GET | `/tag-groups` | List groups (sorted by `sort_order`) |
| POST | `/tag-groups` | Create group (`key`, `label`, `default_color`, `sort_order`) |
| POST | `/tag-groups/merge` | Merge source groups into target (moves tags, deletes sources) |
| POST | `/tag-groups/reindex-order` | Reset group `sort_order` alphabetically by label |
| PATCH | `/tag-groups/{id}` | Update label, color, sort order, default |
| DELETE | `/tag-groups/{id}` | Delete group (not `unknown`); tags stay |

### Scrape

| Method | Path | Description |
|--------|------|-------------|
| GET | `/scrape/session` | Selected source (site \| Local) + scraper agent, catalogs |
| PATCH | `/scrape/session` | Set source/site/scraper and/or Local `local_import_folders` / `local_import_files` / `local_import_recursive` |
| POST | `/scrape/run` | Start background scrape job |
| POST | `/scrape/import/pick-folder` | Native folder dialog → absolute paths |
| POST | `/scrape/import/pick-files` | Native multi-file dialog → absolute paths |
| POST | `/scrape/import/run` | Link local paths into the library (`paths`, `recursive`) |
| POST | `/scrape/cancel` | Cancel running scrape or local import |
| GET | `/scrape/status` | Progress, errors, hash backfill status, `recent_media_ids` |
| GET | `/scrape/recent-media` | Paged summaries (`scope=session` default or `scope=all` by `scraped_at`; optional `tags` with `tag_mode` `and`\|`or`, default `and`) |
| POST | `/scrape/clear-recent` | Clear session recent-media id list |

Static files: `/media/...` (downloads), `/assets/...` (built UI).
