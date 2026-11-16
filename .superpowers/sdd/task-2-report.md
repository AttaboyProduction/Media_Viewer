# Task 2 Report: Gallery Discovery Queue-First

## Summary

Implemented queue-first handling for gallery-discovered post URLs. Gallery listing now persists each discovered post through Queue to scrape via `enqueue_discovered_urls(urls, *, site_id)` and drains the pending queue in the same run instead of downloading the discovered URL directly.

Failed Skipped retries continue to behave as retryable failures: `_complete_skip(..., "error", ...)` keeps the URL unfinished, leaves the job running, and does not set cancellation state.

## TDD Notes

1. Added failing coverage in `tests/test_scrape_leftovers.py` before production code:
   - `test_discovered_post_is_stored_in_queue_before_download`
   - `test_complete_skip_on_retry_leaves_job_running`
2. Verified RED:
   - `.\.venv\Scripts\python.exe -m unittest tests.test_scrape_leftovers -v`
   - Failed because `backend.scraper.pipeline.enqueue_discovered_urls` did not exist.
3. Implemented minimal production change in `backend/scraper/pipeline.py`.
4. Verified GREEN with the required suites.

## Implementation Details

- Added `pipeline.enqueue_discovered_urls(urls, *, site_id)`.
- The helper calls `scrape_leftovers.add_queue` first, then appends stored URLs to the open scrape queue.
- Updated the gallery listing loop in `run_job` to enqueue each discovered post and immediately call `_drain_pending`.
- `stop_date` and `stop_cancel` outcomes from the drain still stop the gallery loop as before.

## Verification

- PASS: `.\.venv\Scripts\python.exe -m unittest tests.test_scrape_leftovers -v`
- PASS: `.\.venv\Scripts\python.exe -m unittest tests.test_extension -v`
- PASS: Cursor lints for `backend/scraper/pipeline.py` and `tests/test_scrape_leftovers.py`

## Concerns

- Existing working tree had unrelated uncommitted UI/docs/extension changes before this task. I preserved them and did not stage those unrelated files.
- The shell prints an existing startup warning, `Invoke-Expression: Missing '{' in configuration statement.`, before commands; tests still ran and passed.

## Critical Finding Fix

- Fixed `enqueue_discovered_urls` so URLs already accepted or pending in the current run are skipped before `scrape_leftovers.add_queue`.
- Added `test_discovered_post_already_accepted_is_not_queued_again` to prove a re-discovered accepted URL does not grow `scrape_leftovers.queue_urls()` or change pending.
- PASS: `.\.venv\Scripts\python.exe -m unittest tests.test_scrape_leftovers -v`
