// node extension/iconProgress.selftest.js
const {
  isBusy,
  isWatchDone,
  progressRatio,
  tooltipFor,
  busyDotGeometry,
  savedDotGeometry,
  BUSY_POLL_MS,
  QUEUE_DOT_MS,
  DEFAULT_TITLE,
} = require("./iconProgress.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(BUSY_POLL_MS === 5000, "busy poll is 5s");
assert(QUEUE_DOT_MS === 2000, "queue dot stays for 2s");
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
assert(tooltipFor({ running: false, total: 0, processed: 0 }) === DEFAULT_TITLE, "idle tooltip");
const dot16 = busyDotGeometry(16);
const dot32 = busyDotGeometry(32);
assert(dot16.diameter === 10, "16px dot is twice the previous mark");
assert(dot32.diameter === 16, "32px dot is twice the previous mark");
assert(dot32.x === 24 && dot32.y === 10, "red dot is nudged right, not up");
assert(dot32.x > 16 && dot32.y < 16, "dot sits in the top-right quadrant");
const saved32 = savedDotGeometry(32);
assert(saved32.diameter === dot32.diameter, "saved dot matches the busy dot");
assert(saved32.x === 8 && saved32.y === 8, "blue dot is nudged toward the top-left");
assert(saved32.x < 16 && saved32.y < 16, "saved dot sits in the top-left quadrant");

console.log("iconProgress.selftest: ok");
