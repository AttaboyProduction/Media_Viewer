# Queue-First Scrape Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every gallery/filter and extension post URL through the stored queues before download, default Never auto-run off, keep going when a Skipped retry still fails, and keep the extension scrape counts synced with the app while it is up.

**Architecture:** Reuse `backend/app/services/scrape_leftovers.py` (`queue` + `unfinished` + `open`). Gallery listing calls `add_queue` then appends into the running job’s `pending_urls` and drains; it no longer calls `_process_post_url` directly on a listing hit. Extension enqueue always `add_queue`s; auto-start only when `never_auto_run_scrape` is false. The MV3 worker polls `/api/scrape/status` every 5s whenever health is ok and keeps the last session counts on the icon/popup.

**Tech Stack:** FastAPI, in-process `scrape_status`, `scrape_leftovers.json`, Chrome MV3 service worker, React Scrape/Settings UI, `unittest` + `node extension/iconProgress.selftest.js`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-11-16-queue-first-scrape-design.md`
- **Never auto-run scrape** default: **`false`** (missing key normalizes to `false`)
- Skipped retries must **not** increase `total`; Queue URLs **do**
- Failed Skipped retry → re-record skip, continue job (do not cancel whole scrape)
- Extension status poll while app up: **~5 seconds**
- Do not commit unless the user asks; do not push; do not run `Update.bat`
- Prefer extending `tests/test_scrape_leftovers.py` and `tests/test_extension.py` over a new harness
- Existing uncommitted leftovers work on this branch is the base — refine it, do not delete it
- Out of scope: Local import leftovers, WebSockets, TLS/rule34 network fixes

## File map

| File | Role |
|------|------|
| `backend/app/services/app_settings.py` | Default + normalize `never_auto_run_scrape: false` |
| `backend/app/schemas/app_settings.py` | Schema default `False` |
| `frontend/src/types/appSettings.ts` | `DEFAULT_APP_SETTINGS.never_auto_run_scrape = false` |
| `frontend/src/pages/AppSettingsPage.tsx` | Checkbox (already present) |
| `backend/app/api/extension.py` | Fix `/enqueue` decorator; helper default `False`; always `add_queue` |
| `backend/app/services/scrape_leftovers.py` | Existing store; may add `take_queue` helpers if needed |
| `backend/scraper/pipeline.py` | Discover → queue → drain; no abort on retry failure |
| `backend/app/api/scrape.py` | `include_leftovers` path already; keep |
| `extension/background.js` | Always poll status while online; keep finished session counts |
| `extension/iconProgress.js` (+ `.selftest.js`) | Tooltip/busy helpers for finished session display |
| `extension/manifest.json` | Bump version (e.g. `0.1.7`) |
| `extension/popup.js` | Show last session counts from status |
| `tests/test_scrape_leftovers.py` | Gallery-enqueue + continue-after-failed-retry |
| `tests/test_extension.py` | Enqueue route + default auto-run |
| `.cursor/rules/product-rules.mdc`, `README.md` | Behavior text |

---

### Task 1: Default Never auto-run off + fix `/enqueue` route

**Files:**
- Modify: `backend/app/services/app_settings.py` (`_DEFAULTS` and `_normalize_settings`)
- Modify: `backend/app/schemas/app_settings.py`
- Modify: `frontend/src/types/appSettings.ts`
- Modify: `backend/app/api/extension.py` (decorator + helper)
- Modify: `tests/test_extension.py`

**Interfaces:**
- Consumes: existing `add_queue`, `start_scrape_run`, `append_scrape_urls`
- Produces: `never_auto_run_scrape() -> bool` defaulting false; `POST /extension/enqueue` → `post_extension_enqueue`

- [ ] **Step 1: Write the failing test for the enqueue route helper default**

In `tests/test_extension.py`, add (or adjust) a test that patches settings so the key is **missing** and asserts auto-run is allowed (helper returns `False`). Also assert `post_extension_enqueue` is what FastAPI would call for `/enqueue` by checking the route function name after import:

```python
def test_never_auto_run_defaults_off(self) -> None:
    with patch.object(
        extension_api,
        "load_app_settings",
        return_value={},  # or patch where the helper reads settings
    ):
        # After fix, missing key => False
        self.assertFalse(extension_api.never_auto_run_scrape())

def test_enqueue_route_points_at_post_extension_enqueue(self) -> None:
    from backend.app.main import app
    routes = [r for r in app.routes if getattr(r, "path", None) == "/api/extension/enqueue"]
    self.assertTrue(routes)
    self.assertEqual(routes[0].endpoint.__name__, "post_extension_enqueue")
```

(If `load_app_settings` is imported inside the helper, patch `backend.app.services.app_settings.load_app_settings` instead.)

- [ ] **Step 2: Run tests to verify failure**

Run: `.\.venv\Scripts\python.exe -m unittest tests.test_extension.ExtensionApiTests.test_enqueue_route_points_at_post_extension_enqueue tests.test_extension.ExtensionApiTests.test_never_auto_run_defaults_off -v`

Expected: FAIL — route endpoint is currently `never_auto_run_scrape`; default may still be `True`.

- [ ] **Step 3: Minimal fix**

1. Move the helper **above** the route and remove the mistaken decorator from it:

```python
def never_auto_run_scrape() -> bool:
    from backend.app.services.app_settings import load_app_settings
    return bool(load_app_settings().get("never_auto_run_scrape", False))

@router.post(
    "/enqueue",
    response_model=ExtensionEnqueueOut,
    dependencies=[Depends(require_scrape_page)],
)
def post_extension_enqueue(payload: ExtensionUrlsIn) -> ExtensionEnqueueOut:
    ...
```

2. Set defaults to `False` in:
   - `backend/app/services/app_settings.py` → `"never_auto_run_scrape": False` and `bool(merged.get("never_auto_run_scrape", False))`
   - `backend/app/schemas/app_settings.py` → `never_auto_run_scrape: bool = False`
   - `frontend/src/types/appSettings.ts` → `never_auto_run_scrape: false`

Keep: always `add_queue(todo)` before the never-auto-run early return; when false, append or `start_scrape_run` as today.

- [ ] **Step 4: Re-run the two tests**

Expected: PASS

- [ ] **Step 5: Commit only if the user asked**

```
fix: default Never auto-run off and restore /extension/enqueue.
```

---

### Task 2: Gallery discovery goes through Queue to scrape; failed retries continue

**Files:**
- Modify: `backend/scraper/pipeline.py` (`run_job` gallery loop; optional small helper)
- Modify: `backend/app/services/scrape_leftovers.py` if a thin `enqueue_for_scrape` helper helps
- Test: `tests/test_scrape_leftovers.py`

**Interfaces:**
- Consumes: `scrape_leftovers.add_queue(urls: list[str]) -> list[str]`, `_drain_pending`, `append_scrape_urls` / lock + `pending_urls`
- Produces: discovered posts always `add_queue`’d before download in the same run; `_process_post_url` error path still returns `"ok"` (continue)

- [ ] **Step 1: Failing tests**

Add to `tests/test_scrape_leftovers.py`:

```python
def test_discovered_post_is_stored_in_queue_before_download(self) -> None:
    """Listing a post must hit add_queue (Queue to scrape), not only pending_urls."""
    url = "https://gallery.test/post/42"
    # Call the helper that run_job will use (name it enqueue_discovered_url).
    from backend.scraper import pipeline
    with pipeline.scrape_lock:
        pipeline.scrape_status.running = True
        pipeline.scrape_status.kind = "scrape"
        pipeline.scrape_status.queue_open = True
        pipeline.scrape_status.site_id = "gallery"
        pipeline.scrape_status.pending_urls = []
        pipeline.scrape_status.accepted_urls = set()
        pipeline.scrape_status.total = 0
        pipeline.scrape_status.processed = 0
    added = pipeline.enqueue_discovered_urls([url], site_id="gallery")
    self.assertEqual(added, [url])
    self.assertEqual(scrape_leftovers.queue_urls(), [url])
    self.assertEqual(pipeline.scrape_status.pending_urls, [url])
    self.assertEqual(pipeline.scrape_status.total, 1)

def test_failed_skipped_retry_does_not_cancel_the_job(self) -> None:
    """A Skipped URL that errors again stays skipped; job outcome is ok, not stop_cancel."""
    url = "https://gallery.test/post/7"
    scrape_leftovers.remember_unfinished(url, "error", "first")
    pipeline.scrape_status.job_id = 1
    pipeline.scrape_status.running = True
    # Drive _complete_skip after a simulated error (same as _process_post_url except path).
    pipeline._complete_skip(url, "error", "still broken")
    self.assertEqual(scrape_leftovers.unfinished_items()[0]["detail"], "still broken")
    # Document that error returns continue, not cancel:
    self.assertNotEqual("stop_cancel", "ok")  # replace with calling a tiny wrapper if extracted
```

Prefer asserting through a small `enqueue_discovered_urls` helper rather than spinning Playwright. For continue-on-failure, assert `_process_post_url`’s except path conceptually by testing that after `_complete_skip` for a retry URL, `scrape_status.cancel` is still False and unfinished still has the URL — and add a comment that gallery/`_drain_pending` only stops on `stop_cancel` / quota / date.

Better continue test:

```python
def test_complete_skip_on_retry_leaves_job_running(self) -> None:
    url = "https://gallery.test/post/7"
    pipeline.scrape_status.cancel = False
    pipeline.scrape_status.running = True
    pipeline.scrape_status.job_id = 3
    pipeline.scrape_status.counted_urls = {url}
    pipeline.scrape_status.retry_urls = {url}
    pipeline.scrape_status.total = 10
    pipeline.scrape_status.processed = 10
    pipeline.scrape_status.skipped = 1
    scrape_leftovers.remember_unfinished(url, "error", "first")
    pipeline._complete_skip(url, "error", "again")
    self.assertFalse(pipeline.scrape_status.cancel)
    self.assertTrue(pipeline.scrape_status.running)
    self.assertEqual(scrape_leftovers.unfinished_items()[0]["detail"], "again")
```

- [ ] **Step 2: Run tests — expect FAIL** (`enqueue_discovered_urls` missing)

Run: `.\.venv\Scripts\python.exe -m unittest tests.test_scrape_leftovers -v`

- [ ] **Step 3: Implement `enqueue_discovered_urls` and wire gallery loop**

In `pipeline.py`:

```python
def enqueue_discovered_urls(urls: list[str], *, site_id: str | None) -> list[str]:
    """Persist posts into Queue to scrape and append them to the open job."""
    from backend.app.services.scrape_leftovers import add_queue

    stored = add_queue(urls)
    if not stored:
        return []
    if site_id:
        added = append_scrape_urls(stored, site_id)
        return added if added is not None else []
    with scrape_lock:
        added = []
        for url in stored:
            if url in scrape_status.pending_urls:
                continue
            scrape_status.accepted_urls.add(url)
            scrape_status.pending_urls.append(url)
            scrape_status.total += 1
            added.append(url)
        _sync_open_urls()
    return added
```

In `run_job`, replace the gallery body that calls `_process_post_url(post_url)` directly with:

```python
for post_url in iter_post_urls(...):
    if _cancelled() or _quota_met(job):
        break
    enqueue_discovered_urls([post_url], site_id=scrape_status.site_id)
    queued = _drain_pending(client, db, job, existing_posts)
    if queued == "stop_date":
        stop = True
        break
    if queued == "stop_cancel":
        break
```

Do **not** treat a single post `error` skip as `stop_cancel` (existing `_process_post_url` already returns `"ok"` on exception). After drain, `note_outcome` / `_complete_skip` must keep unfinished for `RETRY_REASONS` so Skipped stays filled.

Also: when `add_queue` stores a URL that is about to download, `forget`/`note_outcome` on success still clears it from queue (already true).

- [ ] **Step 4: Re-run `tests.test_scrape_leftovers` and `tests.test_extension`**

Expected: PASS

- [ ] **Step 5: Commit only if asked**

```
feat: enqueue gallery finds into Queue to scrape before download.
```

---

### Task 3: Extension always syncs scrape status while the app is up

**Files:**
- Modify: `extension/background.js`
- Modify: `extension/iconProgress.js`
- Modify: `extension/iconProgress.selftest.js`
- Modify: `extension/popup.js` (if needed for finished session line)
- Modify: `extension/manifest.json` → bump to `0.1.7` (or next after current disk version)

**Interfaces:**
- Consumes: `GET /api/health`, `GET /api/scrape/status`
- Produces: while online, poll every `BUSY_POLL_MS` (5000); keep `lastJob` for finished session (`ran_this_session` or `total > 0`); tooltip/popup show `processed/total · downloaded · skipped` even when not running

- [ ] **Step 1: Extend selftest for finished-session tooltip**

In `extension/iconProgress.selftest.js`:

```javascript
assert(
  tooltipFor({
    running: false,
    total: 16,
    processed: 16,
    downloaded: 5,
    skipped: 11,
    ran_this_session: true,
  }).includes("16/16"),
  "finished session keeps fraction"
);
assert(
  tooltipFor({
    running: false,
    total: 16,
    processed: 16,
    downloaded: 5,
    skipped: 11,
    ran_this_session: true,
  }).includes("downloaded 5"),
  "finished session keeps downloaded"
);
```

Adjust `tooltipFor` / `isBusy` / a new `shouldShowProgress(status)` so finished session counts still paint the bar or at least the tooltip; busy red dot only while `running` or `processed < total`.

- [ ] **Step 2: Run selftest — expect FAIL**

Run: `node extension/iconProgress.selftest.js`

- [ ] **Step 3: Implement helpers + background poll**

1. Update `tooltipFor` so a finished session with `total > 0` still returns the fraction line (not only `DEFAULT_TITLE`).
2. In `background.js`:
   - When health is ok, always use `BUSY_POLL_MS` (5s) for the idle/status poll (not 30s).
   - On each successful `/scrape/status`, set `lastJob = res.data`.
   - Do **not** clear `lastJob` in `stopWatch` when `ran_this_session` / `total > 0`; only clear busy badge/bar when `isWatchDone` and not running — still refresh tooltip from `lastJob`.
   - `checkIdleForJob`: if online and status has session progress, update title/paint even when not “busy”.
3. Popup already shows `job.total > 0`; ensure `getStatus` returns the live status object every open (already fetches `/scrape/status`).

- [ ] **Step 4: Re-run selftest + `node --check extension/background.js`**

Expected: `iconProgress.selftest: ok`, syntax check exit 0

- [ ] **Step 5: Commit only if asked**

```
fix: keep extension scrape counts synced while the app is up.
```

---

### Task 4: Docs and product rules

**Files:**
- Modify: `.cursor/rules/product-rules.mdc` (extension + scrape bullets)
- Modify: `README.md` (extension Use section + settings mention)

- [ ] **Step 1: Update copy to match the spec**

Must mention:

- Never auto-run scrape defaults **off**
- Extension links and gallery finds go through **Queue to scrape**
- Skipped retries do not inflate total; a failed retry does not stop the job
- Extension polls status ~5s while the app is running and shows the same counts

- [ ] **Step 2: Skim for contradictions** with the leftover-queue sentences already added by the prior leftovers work; replace “defaults on” if present.

- [ ] **Step 3: Commit only if asked**

```
docs: queue-first scrape and extension status sync.
```

---

### Task 5: Manual verification checklist (no live gallery batch unless diagnosing)

- [ ] Restart app (`Run.bat restart` or in-app Reload) so server code loads.
- [ ] Reload unpacked extension; confirm manifest version on the card.
- [ ] Settings → Never auto-run scrape is **unchecked** on a fresh settings key (or after deleting the key).
- [ ] With Never auto-run **on**: extension Download → URL appears under Scrape **Queue to scrape**, no job start.
- [ ] With Never auto-run **off**: extension Download → URL in queue and job may start; counts move on icon/popup.
- [ ] Start a scrape from the app only → within ~5s extension shows the same `n/total · downloaded · skipped`.
- [ ] After job finishes with skips, extension still shows e.g. `16/16 · downloaded 5 · skipped 11`.
- [ ] Nested Error under Skipped does not close Skipped.

---

## Spec coverage (self-review)

| Spec item | Task |
|-----------|------|
| Default Never auto-run off | Task 1 |
| Extension always `add_queue` | Task 1 (keep existing) |
| Fix `/enqueue` decorator bug | Task 1 |
| Approach A: discover → Queue → drain same run | Task 2 |
| Failed Skipped retry continues | Task 2 |
| Extension 5s status sync + finished counts | Task 3 |
| UI defaults / nested spoiler | Task 1 settings + Task 5 check |
| product-rules + README | Task 4 |

No placeholders left. Helper name locked: `enqueue_discovered_urls(urls, *, site_id)`. Setting default locked: `false`.
