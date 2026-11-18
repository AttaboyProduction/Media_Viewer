// node extension/iconProgress.selftest.js
const {
  isBusy,
  isWatchDone,
  progressRatio,
  outcomeCounts,
  tooltipFor,
  busyDotGeometry,
  savedDotGeometry,
  panelForPage,
  formatMediaStatus,
  DOT_SAVED,
  DOT_QUEUED,
  BUSY_POLL_MS,
  DEFAULT_TITLE,
} = require("./iconProgress.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(BUSY_POLL_MS === 5000, "busy poll is 5s");
assert(!isBusy(null) && isWatchDone(null), "null status is idle");
assert(isBusy({ running: true, total: 0, processed: 0 }), "running is busy");
assert(isBusy({ running: false, total: 10, processed: 3 }), "unfinished queue is busy");
assert(!isBusy({ running: false, total: 10, processed: 10 }), "finished is not busy");
assert(isWatchDone({ running: false, total: 10, processed: 10 }), "finished ends watch");
assert(isWatchDone({ running: false, total: 0, processed: 0 }), "empty idle ends watch");
assert(!isWatchDone({ running: true, total: 1, processed: 1 }), "running never done");
assert(progressRatio({ total: 10, processed: 5 }) === 0.5, "half ratio");
assert(progressRatio({ total: 0, processed: 0 }) === null, "no bar without total");
assert(tooltipFor({ running: true, total: 10, processed: 3, downloaded: 2, skipped: 1 }).includes("3/10"), "tooltip fraction");
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
assert(tooltipFor({ running: false, total: 0, processed: 0 }) === DEFAULT_TITLE, "idle tooltip");
const mixed = {
  running: false,
  total: 5,
  processed: 5,
  downloaded: 0,
  skipped: 5,
  cancelled_urls: ["a", "b", "c", "d"],
  skipped_items: [
    { url: "a", reason: "cancelled" },
    { url: "b", reason: "cancelled" },
    { url: "c", reason: "cancelled" },
    { url: "d", reason: "cancelled" },
    { url: "e", reason: "error" },
  ],
};
assert(outcomeCounts(mixed).skipped === 1 && outcomeCounts(mixed).cancelled === 4, "cancelled is not inside skipped");
assert(tooltipFor(mixed).includes("skipped 1") && tooltipFor(mixed).includes("cancelled 4"), "tooltip splits skipped and cancelled");
const dot16 = busyDotGeometry(16);
const dot32 = busyDotGeometry(32);
assert(dot16.diameter === 10, "16px dot is twice the previous mark");
assert(dot32.diameter === 16, "32px dot is twice the previous mark");
assert(dot32.x === 24 && dot32.y === 8, "red dot is flush top-right, level with the blue dot");
assert(dot32.x > 16 && dot32.y < 16, "dot sits in the top-right quadrant");
const saved32 = savedDotGeometry(32);
assert(saved32.diameter === dot32.diameter, "saved dot matches the busy dot");
assert(saved32.x === 8 && saved32.y === 8, "blue dot is nudged toward the top-left");
assert(saved32.x < 16 && saved32.y < 16, "saved dot sits in the top-left quadrant");
assert(DOT_SAVED === "#6aa8ff" && DOT_QUEUED === "#c62828", "corner colors: blue saved, red queued");
const multi = {
  sources: [
    { key: "example", label: "Example", total: 4, processed: 1, downloaded: 1, skipped: 0, running: true },
    { key: "unsupported", label: "Unsupported", total: 2, processed: 2, downloaded: 1, skipped: 1, running: false },
  ],
};
assert(panelForPage(multi, "example").processed === 1, "supported page uses site panel");
assert(panelForPage(multi, "").key === "unsupported", "off-site page uses unsupported panel");
assert(panelForPage(multi, "missing").key === "missing", "unknown site returns empty panel for that key");
assert(formatMediaStatus({ saved: true, queues: [] }) === "In library", "saved only");
assert(
  formatMediaStatus({ saved: false, queues: ["Queue to scrape (Example)"] }) ===
    "In Queue to scrape (Example)",
  "queue only"
);
assert(
  formatMediaStatus({ saved: true, queues: ["Skipped (Example)", "Offline queue"] }) ===
    "In library · In Skipped (Example) · In Offline queue",
  "saved and queues"
);

console.log("iconProgress.selftest: ok");
