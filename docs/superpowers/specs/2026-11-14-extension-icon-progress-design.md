# Extension icon busy badge + progress

## Goal

Show scrape/download activity on the toolbar icon without opening the popup: a red busy mark, a bottom progress bar (`processed / total`), and the same numbers in the icon tooltip.

## Behavior

### Start (show bar + red mark)

The extension enters **watch** mode when either:

1. It successfully starts or grows a job (`/extension/enqueue`, `/extension/save-file`, `/extension/scrape`, including context menu and F/P), or
2. An idle poll sees `running: true` on `/api/scrape/status` (scrape started in the app).

Chrome cannot receive a push from the local app; those two paths are the start signal.

### While watching

- Poll `/api/scrape/status` every **5 seconds**.
- **Badge:** small red top-right mark (Chrome action badge) while busy.
- **Icon:** keep green/red site coloring; draw a thin progress strip along the bottom. Fill = `processed / total` when `total > 0`; omit the strip if `total` is 0.
- **Tooltip (`action.setTitle`):** e.g. `MediaViewer · 3/10 · downloaded 2 · skipped 1`.

### Stop (hide bar + red mark)

Leave watch mode when status is not running and work is finished (`processed >= total`, or idle with nothing queued):

- Clear the red badge.
- Restore the plain site icon (no progress strip).
- Restore the short default tooltip.
- Stop the 5s busy poll; keep a slower idle check so an app-started job can still wake watch mode.

## Out of scope

- No new backend push / WebSocket channel.
- No numeric badge text (fraction lives in the tooltip and bar only).
- No separate error badge in this change.

## Implementation notes

- Service worker in `extension/background.js` owns watch state, polling, badge, title, and canvas/`ImageData` icon paints for 16/32/48.
- Re-apply the progress overlay whenever the base green/red icon would be set for a tab.
- After the extension’s own successful queue calls, start watch immediately (do not wait for the next idle poll).
