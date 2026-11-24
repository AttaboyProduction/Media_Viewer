# Adapter site API auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-site API User ID / key in Settings, stored in `data/adapters/<id>/secrets.json`, with a Scrape hint when credentials are missing.

**Architecture:** Adapter sites opt in via `requires_api_auth`. Secrets live beside the installed package; catalog merge + install preserve secrets. Dedicated `/app/adapters/site-auth` API; session sources expose `requires_api_auth` / `api_auth_configured` (no secrets). Settings Other→Scrape edits fields; Scrape shows hint only when unconfigured.

**Tech Stack:** FastAPI, adapter_loader, React Settings/Scrape, unittest.

## Global Constraints

- Secrets never in git or `adapter.json`.
- Adapters remain install-local under `data/adapters/`.
- Scrape hint only when `requires_api_auth && !api_auth_configured`.
- Do not bump VERSION while implementing; commit only if user asks.

---

### Task 1: Loader — flag, secrets merge, preserve on install

**Files:** `backend/scraper/adapter_loader.py`, `tests/test_gelbooru.py`

- [x] Parse `requires_api_auth` on sites; stop treating secrets in adapter.json as the preferred path (still accept for back-compat merge OR drop — prefer secrets only after migration).
- [x] Load/write `secrets.json`; merge into sites in `load_catalog_from_installed`; track `adapter_id` on site for writes.
- [x] `install_adapter_from_dir` preserves existing dest `secrets.json`.
- [x] Tests: merge, preserve on install, configured flag helper.

### Task 2: API + session flags

**Files:** `backend/app/api/app_control.py`, `backend/app/schemas/session_settings.py`, `backend/scraper/sites.py`

- [x] GET/PUT `/app/adapters/site-auth` (+ `/{site_id}`).
- [x] Expose `requires_api_auth` / `api_auth_configured` on `ScrapeSourceOut` / site list used by session.

### Task 3: Settings + Scrape UI

**Files:** `frontend/src/api/client.ts`, `frontend/src/types.ts`, `frontend/src/pages/AppSettingsPage.tsx`, `frontend/src/components/ScrapePanel.tsx`

- [x] Client helpers; Settings Source API credentials block; Scrape missing-auth hint.
- [x] Migrate local rule34_xxx keys from adapter.json → secrets.json; set `requires_api_auth` on local + any project gelbooru sample if present.
- [x] Brief product-rules / README note.

### Task 4: Verify

- [x] Run gelbooru / related tests; frontend build if needed.
