# Extension Icon Busy Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a red busy badge and bottom progress bar on the extension icon while a scrape/download runs, plus a matching tooltip, without opening the popup.

**Architecture:** Pure helpers in `extension/iconProgress.js` decide busy/done, ratio, and tooltip text. The service worker owns watch mode: start on successful queue calls or idle detection, poll `/api/scrape/status` every 5s while watching, paint canvas overlays onto green/red icons, and clear when `!running && processed >= total`.

**Tech Stack:** Chrome MV3 service worker, OffscreenCanvas, `chrome.action` badge/title/icon, `chrome.alarms` as a wake backup.

## Global Constraints

- Busy poll interval: **5 seconds** (not 1).
- Progress fill = `processed / total` from scrape status.
- Red badge = busy mark only (no fraction text on the badge).
- No new backend push channel.
- Keep existing green/red site icon meaning underneath the bar.

---

### Task 1: Pure progress helpers + selftest

**Files:**
- Create: `extension/iconProgress.js`
- Create: `extension/iconProgress.selftest.js`

**Interfaces:**
- Produces: `isBusy(status)`, `isWatchDone(status)`, `progressRatio(status)`, `tooltipFor(status)`, `BUSY_POLL_MS = 5000`

- [x] Add helpers matching the design spec edge cases (idle, running, finished 3/3, total 0).
- [x] Add node selftest; run until green.
- [ ] Commit helpers + selftest (when asked).

### Task 2: Watch loop, badge, tooltip, icon paint in background

**Files:**
- Modify: `extension/background.js`
- Modify: `extension/manifest.json` (add `alarms` if used)
- Modify: `.cursor/rules/product-rules.mdc`, `README.md` (one sentence each)

**Interfaces:**
- Consumes: helpers from Task 1; existing `api`, `paintTab`, queue result paths
- Produces: `startWatch()`, `stopWatch()`, progress-aware `paintTab` / default icon

- [x] `importScripts` iconProgress; start watch after successful enqueue/save/scrape.
- [x] While watching: poll every 5s; red badge; tooltip with `n/total`; draw bottom bar on 16/32/48 icons.
- [x] On done: clear badge/bar/tooltip; slower idle wake so app-started jobs still trigger watch.
- [x] Coordinate with existing offline `"off"` badge.
- [x] Update product-rules + README.
- [ ] Reload extension manually to verify; commit when asked.
