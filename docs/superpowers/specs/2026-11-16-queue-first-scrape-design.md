# Queue-first scrape and extension status sync

## Goal

Every post URL the app intends to download (gallery/filter discovery and extension links) goes through the stored queues first. Downloads only run by draining those queues. Failed Skipped retries must not abort the rest of the job. While the app is running, the extension always shows the same scrape counts as the Scrape page.

## Defaults

- **Never auto-run scrape** defaults to **off** (`never_auto_run_scrape: false`).
- With the setting off, an extension link still enters **Queue to scrape**, then a download may start immediately (same as “auto-run”).
- With the setting on, extension links only wait in **Queue to scrape** until the user presses **Run scrape**.

## Queues

Stored under `data/scrape_leftovers.json` (existing `scrape_leftovers` service):

| List | Meaning | Progress total |
|------|---------|----------------|
| **Skipped / unfinished** | Failed, cancelled, interrupted, still open when the app closed | Retry does **not** increase `total` |
| **Queue to scrape** | Waiting posts from the extension and from gallery/filter discovery | New entries **do** increase `total` when drained |
| **open** | In-flight pending URLs for crash recovery | Moved into unfinished on next launch |

Intentional skips (already in library, tag mismatch, identical, etc.) are not kept in unfinished.

## Run scrape (approach A)

One **Run scrape** does, in order:

1. Retry **Skipped** URLs (same total; do not double-count).
2. Drain **Queue to scrape** (these add to `total` when accepted).
3. If the form has gallery/filters (not leftovers-only), list matching posts and **append each found post URL into Queue to scrape**, then keep draining that queue in the **same** run until the download limit, gallery exhaustion, or Stop.

Extension URL filters and empty-form leftover-only runs stay URL jobs (`limit` ignored for those seeds).

### Failed Skipped retries

If a Skipped URL still cannot download (error / unavailable / cancelled mid-item):

- Record it again in Skipped with the new reason/detail.
- Count it as processed/skipped for that attempt.
- **Continue** to the next URL. Do not cancel the whole job because one leftover failed again.

## Extension → app queue

- `/extension/enqueue` and unsupported-site `/extension/save-file` always call `add_queue` so the Scrape page **Queue to scrape** list updates.
- When Never auto-run is off and nothing conflicting is running, the app may start (or append to) a drain job after enqueue.
- Fix the current bug where the `/enqueue` route decorator is bound to the `never_auto_run_scrape` helper instead of `post_extension_enqueue`.

## Extension status sync

While the app answers `/api/health`:

- Poll `/api/scrape/status` about every **5 seconds** (not only after the extension starts a job, and not only on a 30s idle wake).
- Icon tooltip, progress bar, and popup `Scrape: processed/total · downloaded · skipped` stay aligned with the Scrape page for the session after a scrape has run (`ran_this_session` / nonzero totals), including after the job finishes (e.g. `16/16 · downloaded 5 · skipped 11`).
- When the app is down, keep today’s offline queue behavior; do not invent progress.

## UI

- Scrape page already shows **Skipped** and **Queue to scrape**; keep both collapsed by default when empty lists stay hidden.
- Nested **Error** under a Skipped row must not close the parent Skipped details (already fixed; do not regress).
- Settings → Other → Scrape: **Never auto-run scrape** checkbox, default unchecked for new installs; existing `app_settings.json` values are respected (normalize missing key to `false`).

## Out of scope

- Reworking Local import into the same leftover file.
- Server-side push / WebSocket to the extension.
- Changing Hamming / identical skip rules.
- Fixing rule34.xyz TLS/handshake failures on the user’s network.

## Docs / rules

Update `.cursor/rules/product-rules.mdc` and `README.md` for: default Never auto-run off, queue-first discovery, continue-after-failed-retry, and always-on extension status poll while the app is up.
