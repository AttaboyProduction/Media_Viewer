# Browser extension scrape plan

The plan is ready. Below is the approach, tied to the current codebase.

## Overall approach: one MV3 extension for both browsers

Opera is Chromium-based and supports Manifest V3 with the same `chrome.*` API — so we ship **one codebase with no browser-specific branches**. Only install path and store differ:

- **Chrome:** Load unpacked in developer mode (`chrome://extensions`) or Chrome Web Store.
- **Opera:** Same flow (`opera://extensions` → Developer mode), or Opera Addons (separate signing; same zip is accepted).

Native messaging and separate builds are unnecessary — HTTP to the local backend is enough.

## `extension/` layout (plain JS, no bundler)

```
extension/
  manifest.json      # MV3
  background.js      # service worker: talks to the backend
  content.js         # injects the button on supported sites
  content.css        # button styles
  popup.html/js      # mini status panel
  icons/...
```

No TypeScript or build step — minimal repo diff, and it does not interfere with the frontend `npm run build`.

## How the button works

- **`manifest.json`:** `content_scripts.matches` are generated from supported sites — currently `https://rule34.xyz/*` (source of truth: `KNOWN_SITES` in `backend/scraper/sites.py:22`). When a site is added, extend the matches list by hand (dynamic inject via `<all_urls>` is a poor permissions UX).
- **Post page** (URL shape `/post/<id>`): the content script shows a floating **“Scrape this post”** button → sends that post URL.
- **Gallery / listing page:** **“Scrape this page”** → collects all `/post/\d+` links from the DOM and sends the list. The backend already supports multi-URL union: `ScrapeRunRequest.filters` with `type: "url"` (`backend/app/schemas/__init__.py:196`), and `compile_scrape_job` dedupes them into `seed_urls` and disables the quota (`ignore_download_limit=bool(urls)`, `backend/scraper/job.py:130`) — so “download everything selected, no quota” comes for free.
- **Feedback:** the button cycles state (“Sent…” → “✓ In library” / error); the extension icon shows a badge.

## Request flow

```
content.js → chrome.runtime.sendMessage → background.js (service worker)
           → fetch http://127.0.0.1:8000/api/...
```

- API calls run in the **service worker**, not the content script: with `host_permissions: ["http://127.0.0.1:8000/*"]`, CORS does not apply to the SW (content scripts are CORS-bound in MV3). The CORS allowlist in `backend/app/main.py` does not need to change.
- On start, the service worker pings `GET /api/health` and sets the badge (green = backend up, gray = down).
- Popup: current job status from `/api/scrape/status` (running / processed / downloaded / skipped) plus an “Open viewer” link to `http://127.0.0.1:8000/`.

## Backend addition

One light route, e.g. `POST /api/extension/enqueue`:

- Accepts `{ site_id, urls: [...] }`.
- Validates that `site_id` is in `KNOWN_SITES` and that each URL belongs to that site’s `base_url` (so foreign links never enter the pipeline).
- Builds a `ScrapeRunRequest` with URL filters and starts the same path as `post_scrape_run` (same lock and 409 “Scrape already running” — the extension just shows “job already running”).
- Must use `require_scrape_page` — project rule: all scrape tools refuse when the Scrape page is hidden.
- Optional: settings token (`X-Scrap-Token`). Today any page in the browser can POST to `127.0.0.1:8000` (CORS does not block “blind” requests); a token closes that. ~15 lines if enabled immediately.

Download, tags, SHA-256 dedupe, and “Downloaded previously” all reuse the existing pipeline unchanged.

## Edge cases already covered

- **Job already running (409)** → button shows “Scrape in progress” instead of a silent failure. A real queue can wait; for v1 an honest refuse is simpler.
- **Cloudflare / anti-bot is not a problem:** the extension downloads nothing itself — it only forwards URLs; the backend still downloads via Obscura/Playwright as usual.
- **Backend not running** → gray badge; button click shows “Start Scrap Download”.
- **Quota:** with URL filters the limit does not apply (already true in `job.py`), so “Scrape this page” downloads exactly the selection.

## User install

1. **Dev:** load the same `extension/` folder in `chrome://extensions` and `opera://extensions` (Developer mode → Load unpacked).
2. Later: Scripts/Scrape settings can show a short tip. Opening the extensions page as a normal URL from the UI is not possible, so keep it as written instructions.

---

If this plan looks good — start with the backend endpoint (small and testable), then the extension. Decide: enable token protection now? Gallery buttons in v1, or posts only?
